/**
 * 「放 30 秒就没了 / 播不出来」的防回归断言（Docker 与 CF 共用同一条播放链路）。
 *
 * 这几条都是**源码模式断言**，盯的是具体写法，不是行为 —— 因为它们盯的正是
 * 「以前那样写会错」的地方。改播放链路时如果把它们改没了，这里必须精确报红。
 *
 * 背景（2026-10-18 排查结论）：
 *   ① 试听片段是**正常播完**（`ended`，不是 `error`），原来和整首播完走同一条路，
 *      直接 `next()` 跳下一首 —— 用户听到的就是「放 30 秒就没了」。
 *   ② `maybeStoreToCache()` 注释写「整首听完才落缓存」，代码里却没有任何时长校验，
 *      而自动缓存默认开着。片段一旦被存成整首，之后每次只播 30 秒，
 *      且命中缓存时 `warnIfSnippet` 直接 return —— 连提示都没有。
 *   ③ `server` 级只给 1 条候选，`attempt` 又读的是**上一级**的 `curPos`
 *      （`advance` 先调 `stageCandidates` 后写 pos）→ `/stream` 只有一次机会，
 *      502 之后无路可走，直接跳歌。
 *   ④ `resolveBudget()` 只认 `LX_NATIVE`，而 Docker 服务端是 Node、从不设这个标志
 *      → 一直在跑「网页」那档紧预算。
 *
 * 运行：node test/stream-snippet.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const PLAYER = read('public/js/player.js')
const HTTP = read('src/lib/http.js')

let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fails.push(name + (extra ? '  [' + extra + ']' : '')); console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/* ---------------------------------------------------------------- 1. ended */
console.log('\n== 1. 片段播完不能当整首播完 ==')
{
  // 取 ended 监听器那一段（到下一个 addEventListener 之前）
  const m = PLAYER.match(/addEventListener\('ended',[\s\S]{0,2600}?\n  \}\)\n/)
  const body = m ? m[0] : ''
  ok('取到了 ended 监听器（防止断言退化成空串假绿灯）', body.length > 200, 'len=' + body.length)
  ok('ended 里会判「这一次是不是片段」', /endedAsSnippet\(\)/.test(body))
  ok('是片段就先重试（advance），而不是直接 next', /if \(endedAsSnippet\(\) && snippetRetry < SNIPPET_MAX_RETRY\)/.test(body))
  ok('重试后仍会落到 next(false) 收尾', /next\(false\)/.test(body))
  ok('有重试上限，不会无限重试', /SNIPPET_MAX_RETRY\s*=\s*\d+/.test(PLAYER))
  ok('重试计数按歌曲重置，换音质重载时不重置', /if \(snippetRetryFor !== song\.id\) \{ snippetRetryFor = song\.id; snippetRetry = 0 \}/.test(PLAYER))
  ok('换音质那条路会强制续播（forcePlay）', /setQuality\(nextQ, true\)/.test(body))
}

/* ---------------------------------------------------------------- 2. 缓存 */
console.log('\n== 2. 片段不许写进本地缓存 ==')
{
  const m = PLAYER.match(/function maybeStoreToCache\(\)[\s\S]{0,1400}?\n  \}/)
  const body = m ? m[0] : ''
  ok('取到了 maybeStoreToCache（防止空串假绿灯）', body.length > 100, 'len=' + body.length)
  ok('落缓存前先拦掉片段', /if \(endedAsSnippet\(\)\) return/.test(body))
  ok('缓存命中（dataset.cached=1）仍然跳过', /if \(audio\.dataset\.cached === '1'\) return/.test(body))
}

/* ---------------------------------------------------------- 3. server 级 */
console.log('\n== 3. 代理级要有第二次机会 ==')
{
  ok('不再用上一级的 curPos 猜 attempt', !/const attempt = curPos > 0 \? 1 : 0/.test(PLAYER))
  ok('server 级给两条候选（0 = 复用缓存，1 = retry 重解析）',
    /serverStreamUrl\(song, 0\)/.test(PLAYER) && /serverStreamUrl\(song, 1\)/.test(PLAYER))
  // 两条候选必须在同一个 return 数组里，否则 advance 仍然只能看到一条
  ok('两条候选在同一个数组里返回',
    /return \[\s*\{ url: serverStreamUrl\(song, 0\)[\s\S]{0,220}?serverStreamUrl\(song, 1\)[\s\S]{0,120}?\]/.test(PLAYER))
  ok('retry 参数确实会拼进 URL', /if \(attempt\) qs\.set\('retry', '1'\)/.test(PLAYER))
}

/* ------------------------------------------------------------- 4. 预算 */
console.log('\n== 4. Node（Docker 服务端）要算自家后端 ==')
{
  const m = HTTP.match(/export function resolveBudget\(\)[\s\S]{0,600}?\n\}/)
  const body = m ? m[0] : ''
  ok('取到了 resolveBudget（防止空串假绿灯）', body.length > 80, 'len=' + body.length)
  ok('Node 宿主也走宽预算', /process\.versions\.node/.test(body))
  ok('宽预算仍是 3500 / 1500 / 3800', /deadline: 3500, probeDeadline: 1500, totalBudget: 3800/.test(body))
  ok('网页档仍是 3200 / 1500 / 3600', /deadline: 3200, probeDeadline: 1500, totalBudget: 3600/.test(body))
  ok('backend.bundle.js 已同步（否则内置模式还是旧预算）',
    /process\.versions\.node/.test(read('public/js/backend.bundle.js')))
}

console.log('\n' + '='.repeat(60))
console.log(fails.length ? '结果: FAIL  通过 ' + pass + ' / 失败 ' + fails.length : '结果: PASS  通过 ' + pass + ' / 失败 0')
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
