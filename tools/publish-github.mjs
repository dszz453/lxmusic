/**
 * 把工作区发布到 GitHub（绕开 git 协议）。
 *
 * ── 什么时候用它 ──────────────────────────────────────────────
 * 正常当然用 `git push`。但如果所处的网络对 `git-receive-pack` 的响应流有干扰，
 * 会反复报：
 *
 *     send-pack: unexpected disconnect while reading sideband packet
 *     error: failed to push some refs
 *
 * 这时换 REST API 就好了 —— 它是一串普通 HTTP 请求，对中间代理友好得多。
 * （实测：git push 连续失败 4 次；本脚本 242 个文件一次成功，中途 7 次断连全被重试兜住。）
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *   GH_TOKEN=ghp_xxx node tools/publish-github.mjs            # 发布
 *   GH_TOKEN=ghp_xxx node tools/publish-github.mjs --dry      # 只看清单，不发布
 *
 * token 需要 `repo` + `write:packages` 权限。
 * 仓库默认 dszz453/lxmusic，可用环境变量 GH_REPO 换。
 *
 * ── 实现要点（都踩过）────────────────────────────────────────
 *  · **空仓库不能直接用 blob API**：会报 409 "Git Repository is empty"。
 *    必须先有至少一次提交（脚本不会自动做，见下面「首次发布」）。
 *  · 读 ref 时空仓库返的是 **409 不是 404**，只判 404 会把它当真错误抛出去。
 *  · tree 的 `mode` 必须是**字符串** `"100644"`。写成数字 `0o100644` 会被序列化成
 *    十进制 33188，GitHub 直接 422 `Must supply a valid tree.mode`。
 *  · 240+ 个 blob 连着发必然断几次，所以：并发压到 4 路 + 指数退避重试 +
 *    每 20 个把 sha 落盘（tools/.ghcache.json），重跑时复用 —— 否则断在第 200 个就得从头来。
 *
 * ── 首次发布（仓库还是空的时候）──────────────────────────────
 * 先用 Contents API 建一个占位文件：
 *
 *   curl -X PUT -H "Authorization: token $GH_TOKEN" \
 *     https://api.github.com/repos/dszz453/lxmusic/contents/README.md \
 *     -d '{"message":"init","content":"'$(printf '# init' | base64 -w0)'","branch":"main"}'
 *
 * 之后本脚本就能正常在 main 上追加提交了。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const TOKEN = process.env.GH_TOKEN
const REPO = process.env.GH_REPO || 'dszz453/lxmusic'
const ROOT = path.resolve(import.meta.dirname, '..')
const DRY = process.argv.includes('--dry')

if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(1) }

/**
 * 请求 GitHub API，带重试。
 *
 * 这里必须重试：本机到 GitHub 走的是中间代理，240+ 个 blob 连着发，
 * 中间必然遇到几次连接被掐（fetch failed / ECONNRESET）——
 * 不重试的话整次发布会在第 80 个文件上白费掉。
 *
 * 只重试**可恢复**的错误：
 *   · 网络类（fetch failed、超时、5xx）→ 退避后重试
 *   · 403/429 二级限流 → 等久一点再试（GitHub 会带 retry-after）
 *   · 4xx 里除限流外的（422 校验失败之类）→ 立刻抛，重试没意义
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const api = async (method, url, body, { retries = 5 } = {}) => {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) {
      const wait = Math.min(1000 * 2 ** attempt, 20000)
      process.stdout.write(`  · 第 ${attempt} 次重试（等 ${wait / 1000}s）：${lastErr && lastErr.message}\n`)
      await sleep(wait)
    }
    try {
      const r = await fetch('https://api.github.com' + url, {
        method,
        headers: {
          authorization: 'Bearer ' + TOKEN,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'lxmusic-publish',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { j = { __raw: t.slice(0, 300) } }

      if (r.ok) return j

      const e = new Error(`${method} ${url} → ${r.status}: ${(j && (j.message || j.__raw)) || t.slice(0, 200)}`)
      e.status = r.status
      // 403/429 既可能是限流，也可能是真的没权限。看 GitHub 的提示区分。
      const rateLimited = (r.status === 403 || r.status === 429)
        && /rate limit|secondary/i.test(String((j && j.message) || ''))
      if (r.status >= 500 || rateLimited) {
        const ra = Number(r.headers.get('retry-after') || 0)
        if (ra) await sleep(Math.min(ra * 1000, 60000))
        lastErr = e
        continue
      }
      throw e
    } catch (e) {
      // 只有网络层错误（没有 status）才重试
      if (e.status) throw e
      lastErr = e
    }
  }
  throw lastErr || new Error('未知失败')
}

/**
 * 用 git 列出该提交实际跟踪的文件（尊重 .gitignore，也避免把工作区杂物带上）。
 *
 * 加了重试：`git ls-files` 偶尔会报 EBUSY —— 上一个 git 进程还没彻底放手
 * （这台机器上刚跑完一次失败的 push，索引文件仍被持有）。
 * 这属于瞬时状态，退一步就好，不值得让整次发布失败。
 */
function listFiles() {
  let lastErr = null
  for (let i = 0; i < 5; i++) {
    try {
      const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.toString('utf8').split('\0').filter(Boolean)
    } catch (e) {
      lastErr = e
      // 同步退避：这是脚本开头的一次性调用，用 Atomics.wait 就能停住主线程
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800 * (i + 1))
    }
  }
  throw lastErr
}

const main = async () => {
  const files = listFiles()
  console.log(`待发布 ${files.length} 个文件`)

  // 提交信息取本地 HEAD 的，保证「仓库里的历史」和本地一致
  let msg = ''
  try {
    msg = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim()
  } catch { /* 取不到就用兜底的 */ }
  const commitMsg = msg || `lxmusic V1.0（${files.length} 个文件）`

  if (DRY) {
    let total = 0
    for (const f of files) total += fs.statSync(path.join(ROOT, f)).size
    console.log(`dry-run：共 ${(total / 1024 / 1024).toFixed(2)} MB，commit 信息前 80 字：`)
    console.log(commitMsg.slice(0, 80))
    return
  }

  // 1) 当前 main 指向哪
  //
  // 空仓库这里返回的是 **409 "Git Repository is empty"** 而不是 404 ——
  // 只判 404 会把它当成真错误抛出去（实测踩到）。两种都按「从零建」处理。
  let parentSha = null
  let baseTree = null
  try {
    const ref = await api('GET', `/repos/${REPO}/git/ref/heads/main`)
    parentSha = ref.object.sha
    const c = await api('GET', `/repos/${REPO}/git/commits/${parentSha}`)
    baseTree = c.tree.sha
    console.log(`已有 main：${parentSha.slice(0, 8)}（在其上追加）`)
  } catch (e) {
    const empty = e.status === 404 || e.status === 409 || /is empty/i.test(e.message)
    if (empty) console.log('仓库还没有 main，从零建')
    else throw e
  }

  // 2) 逐个建 blob
  //
  // 并发 4 路。为什么不是更高：本机到 GitHub 要过中间代理，
  // 并发 6 时实测每 80 个文件左右会被掐一次连接；4 路明显更稳。
  // 加上 api() 里的退避重试，240+ 个文件基本能一次跑完。
  //
  // 断点续传：每建好一个 blob 就把 sha 追加进 tools/.ghcache.json，
  // 重跑时直接用缓存里的 sha，不重复上传。这是被网络逼出来的 ——
  // 没有它的话，第 200 个文件断一次就得从第 1 个重来。
  const CACHE = path.join(ROOT, 'tools', '.ghcache.json')
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) } catch { cache = {} }
  // 缓存只在「同一个 commit」内有效，否则会把旧内容当成新内容
  if (cache.__commit !== commitMsg) cache = { __commit: commitMsg }

  const tree = []
  let done = 0
  let skipped = 0
  const CONC = 4
  let idx = 0
  const worker = async () => {
    while (idx < files.length) {
      const i = idx++
      const rel = files[i]
      const buf = fs.readFileSync(path.join(ROOT, rel))
      // 用「路径 + 内容摘要」做键，内容变了自然失效
      const key = rel + ':' + buf.length + ':' + crypto
        .createHash('sha1').update(buf).digest('hex').slice(0, 12)
      let sha = cache[key]
      if (sha) {
        skipped++
      } else {
        const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
          content: buf.toString('base64'),
          encoding: 'base64',
        })
        sha = blob.sha
        cache[key] = sha
        // 每 20 个落一次盘 —— 太频繁会拖慢，太久断了白干
        if (Object.keys(cache).length % 20 === 0) {
          try { fs.writeFileSync(CACHE, JSON.stringify(cache)) } catch { /* 写不了不影响 */ }
        }
      }
      // mode 必须是**字符串** "100644"。
      // 写成数字 0o100644 会被 JSON 序列化成十进制的 33188，
      // GitHub 直接 422 `Must supply a valid tree.mode`（实测踩到）。
      // 顺便：可执行文件（.sh）要 100755，否则 clone 下来没有执行位。
      const isExec = /\.sh$/.test(rel)
      tree.push({ path: rel, mode: isExec ? '100755' : '100644', type: 'blob', sha })
      done++
      if (done % 25 === 0 || done === files.length) {
        process.stdout.write(`  已处理 ${done}/${files.length}（复用缓存 ${skipped}）\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)) } catch { /* 忽略 */ }

  // 3) 建 tree。base_tree 让「只改了几个文件」也走增量，
  //    但首次发布没有 base，就整棵建。
  const treeRes = await api('POST', `/repos/${REPO}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree,
  })
  console.log(`tree：${treeRes.sha.slice(0, 8)}`)

  // 4) 建 commit 并移动 ref
  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: commitMsg,
    tree: treeRes.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  })
  console.log(`commit：${commit.sha.slice(0, 8)}`)

  if (parentSha) {
    await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commit.sha, force: false })
  } else {
    await api('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
  }
  console.log(`✓ 已发布到 https://github.com/${REPO}`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
