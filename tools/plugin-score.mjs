/**
 * 插件源综合评分 —— 实测每个内置插件在每个平台上的取流表现，产出排序表与报表。
 *
 * ── 为什么需要 ───────────────────────────────────────────────
 * 取流时只会试候选列表的**前 N 个**（resolveMusicUrlFast 的 maxTries=12、
 * openAudioStream 的 maxCandidates=6），而候选顺序原本等于「写进 build.mjs 的顺序」，
 * 与插件好坏毫无关系。池子里插件一多，排在后面的永远轮不到 —— 等于白装。
 *
 * 更糟的是，光看「能不能加载」并不能说明问题：实测 14 个内置插件里只有 5 个能初始化，
 * 而其中 1 个（SixYin）独占 332 KB（整个 bundle 的 65%）却自己抛错拒绝加载。
 * 没有实测数据，剪枝就只能靠猜。
 *
 * ── 评分口径 ─────────────────────────────────────────────────
 * 先过「能不能加载」这道硬门槛（一票否决，不过关直接 0 分、不进排序表），
 * 再按四个维度打分（每项 0~100）：
 *
 *   取流成功率  45%   每平台 3 首固定探针歌，musicUrl 返回 http(s) 直链算命中
 *   响应速度    25%   命中调用的耗时中位数：≤1.5s 满分，≥8s 归零，中间线性
 *   可播性      15%   对返回的直链发 Range 请求，按 content-type + 文件头魔数
 *                     判断是不是真音频（防「返回了个 HTML 错误页」这种假成功）
 *   覆盖广度    15%   声明支持的平台数 / 全部平台数
 *
 * 排序表是**按平台各自排**的：同一个插件可能网易云很稳、咪咕一塌糊涂，
 * 一个全局名次表达不了这种差异。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   node tools/plugin-score.mjs                 实测 + 写入排序表 + 出报表
 *   node tools/plugin-score.mjs --report        只出报表，不改排序表
 *   node tools/plugin-score.mjs --refresh       重新搜探针歌（默认复用缓存）
 *   node tools/plugin-score.mjs --only=cloud-kh,wsl-xinghai
 *   node tools/plugin-score.mjs --sources=wy,mg
 *   node tools/plugin-score.mjs --ephemeral --json=/path/out.json
 *       ↳ 容器内运行时评分用：**不改仓库文件**，结果写进 --json 指定的位置。
 *         由 server/plugin-rescore.mjs 调用，结果落库并由界面/接口消费。
 *
 * 产物：
 *   src/generated/plugin-rank.js    排序表（供 src/plugins.js 装载）
 *   src/generated/plugin-scores.js  评分明细（供 /api/plugin-scores 与界面展示）
 *   tools/.plugin-score.json        原始明细，便于复盘
 *   ⚠ --ephemeral 模式下以上三个都不写，改到 $LXP_DATA_DIR 或 --json 指定的位置。
 *
 * 两处「不能只信本机结论」的地方（写在这儿免得下次又踩）：
 *   ① 出口差异 —— 有些插件初始化时要先拉远端配置（raw.githubusercontent.com 的
 *      source-info、kstore.vip、lerd.dpdns.org 等），构建机 DNS 被污染拉不到，
 *      于是表现为「脚本未发送 inited 事件」。它们在 CF Worker 出口上可能是好的，
 *      所以判「该不该删」时**只能信「脚本自身抛错」**（如 pdone-sixyin 的版本校验），
 *      环境类失败一律保留、标 unmeasured。
 *   ② 双环境差异 —— 插件里常有 typeof require / typeof window 的环境探测，
 *      同一份脚本在 Node 与 Chrome 下结论会相反，必须两边都失败才算真不可用。
 *
 * 注意：这份脚本会真实调用各音乐平台与第三方音源，跑一轮几分钟，别放进构建流程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const ARGV = process.argv.slice(2)
const HAS = (flag) => ARGV.includes(flag)
const VAL = (name, def = '') => {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

const REPORT_ONLY = HAS('--report')
const REFRESH_PROBES = HAS('--refresh')
const ONLY = VAL('only').split(',').map(s => s.trim()).filter(Boolean)
const SOURCES = VAL('sources').split(',').map(s => s.trim()).filter(Boolean)

/**
 * 纯运行模式：**不写 src/generated/**、不碰仓库里的任何文件**，
 * 只把结果 JSON 打到 `--json=` 指定的位置（不给就打到 stdout 的最后一行）。
 *
 * 为什么需要：容器（Docker）要按**用户自己服务器的网络**实测一遍并把结果落库。
 * 容器里的 src/generated/ 是只读的镜像内容（也不该被改，改了下次重建就没了），
 * 而且写文件在多副本/只读根文件系统下会直接失败。所以运行时评分必须走这条
 * 「只算不写」的通道，由调用方（server/plugin-rescore.mjs）决定结果去哪。
 *
 * 顺带解决另一个问题：默认模式要写 3 个文件，而容器里只有 tools/ 是可写的
 * （DATA_DIR 才是持久卷），所以 --ephemeral 同时把探针缓存也挪到可写目录。
 */
const EPHEMERAL = HAS('--ephemeral')
const JSON_OUT = VAL('json')

const PROBE_FILE = process.env.LXP_PROBE_FILE
  || (EPHEMERAL
    ? path.join(process.env.LXP_DATA_DIR || ROOT, '.plugin-score-probes.json')
    : path.join(__dirname, '.plugin-score-probes.json'))
const OUT_FILE = process.env.LXP_DETAIL_FILE
  || (EPHEMERAL
    ? path.join(process.env.LXP_DATA_DIR || ROOT, '.plugin-score.json')
    : path.join(__dirname, '.plugin-score.json'))
const RANK_FILE = path.join(ROOT, 'src', 'generated', 'plugin-rank.js')
const SCORES_FILE = path.join(ROOT, 'src', 'generated', 'plugin-scores.js')
const BROWSER_REPORT = path.join(ROOT, 'probe', 'plugin-report.json')

const ALL_SOURCES = ['wy', 'kg', 'kw', 'tx', 'mg']
/** 探针关键词：每平台每词取 1 首，3 首里中 1 首即算该插件在该平台能取流 */
const PROBE_KEYWORDS = ['周杰伦 晴天', '陈奕迅 十年', '邓紫棋 泡沫']

const CALL_TIMEOUT = 10000      // 单次 musicUrl 调用的上限
const VERIFY_TIMEOUT = 8000     // 直链校验的上限
const CONCURRENCY = 6           // 组合间并发（同一插件内部串行，别把人家打挂）
const GLOBAL_DEADLINE = 12 * 60 * 1000

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/* ====================== 兜住第三方脚本的野指针 ====================== *
 *
 * 这批插件会在初始化时「顺手」发几个后台请求（拉远端配置、查更新），而且经常
 * 不带 catch。实测：K×H 一初始化就去摸 88.lxmusic.xn--fiqs8s/script?key=lxmusic，
 * 那条链一旦 ECONNRESET，整个评分进程直接死于 unhandledRejection ——
 * 前面十几分钟的实测数据全丢。
 *
 * 所以这里把两类未捕获异常降级成日志：跑的是别人的代码，不能让它的野指针
 * 决定我们的进程活不活。真出问题会在对应插件的 notes 里体现（调用返回空）。
 */
let strayErrors = 0
const onStray = (kind) => (err) => {
  strayErrors++
  if (strayErrors <= 20) {
    const msg = (err && (err.message || err.cause?.message)) || String(err)
    console.warn(`  [${kind}] 第三方脚本的未捕获异常已忽略：${String(msg).slice(0, 90)}`)
  }
}
process.on('unhandledRejection', onStray('unhandledRejection'))
process.on('uncaughtException', onStray('uncaughtException'))

/* ============================ 小工具 ============================ */

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19) }

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

/** 按文件头魔数判断是不是音频容器（对付「返回 HTML 错误页」这种假成功） */
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return ''
  const b = buf
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3(id3)'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4/m4a'
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska/webm'
  return ''
}

/** 校验一个直链是不是真的能出音频 */
async function verifyAudio(url) {
  const t0 = Date.now()
  let referer
  try { referer = new URL(url).origin + '/' } catch { referer = undefined }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-2047', ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT),
    })
    const ct = res.headers.get('content-type') || ''
    const buf = new Uint8Array(await res.arrayBuffer())
    const magic = sniffAudio(buf)
    const ok = (res.ok || res.status === 206) && (!!magic || /^audio\//i.test(ct))
    return { ok, status: res.status, contentType: ct, bytes: buf.length, magic, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, status: 0, contentType: '', bytes: 0, magic: '', ms: Date.now() - t0, error: (e && e.message) || String(e) }
  }
}

/* ====================== 阶段 A：能不能加载 ====================== */

/**
 * 浏览器（V8 / Android WebView）侧的加载结果，来自 probe/plugin-browser-check.mjs。
 *
 * 为什么必须看两份：插件里普遍带环境探测（typeof require / typeof window），
 * 混淆脚本据此走不同分支，于是**同一份脚本在两个环境下的结论会不一样**。
 * 实测：pdone-ikun 在 Node 下求值崩引擎、在 Chrome 下正常；pdone-lx 反过来；
 * pdone-sixyin 两边都崩。只看一份就会误剪。
 *
 * 判「该不该从 bundle 里删」必须两个环境都说不可用才算数。
 */
function loadBrowserReport() {
  try {
    const j = JSON.parse(fs.readFileSync(BROWSER_REPORT, 'utf8'))
    const map = new Map()
    for (const p of (j.plugins || [])) map.set(p.id, p)
    return { at: (j.at || '').slice(0, 19).replace('T', ' '), map, stale: false }
  } catch {
    return { at: null, map: new Map(), stale: true }
  }
}


/**
 * 在子进程里求值单个插件。
 *
 * 必须隔离 —— 有一批重度混淆脚本（自研字节码解释器）会把 JS 引擎直接搞死：
 * 不抛异常、try/catch 无效、连进程退出钩子都不触发。同进程求值会让整轮评分无输出。
 *
 * 结果走**临时文件**而不是 stdout：插件自己会在初始化时 console.log 一大堆东西
 * （K×H 那种一开机就刷十几行的），和标记文案抢 stdout 会导致 JSON 解析失败 ——
 * 实测就这样误判了两个其实能加载的插件（IKun / ChangQing）。
 */
const CHILD_SRC = `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const write = (o) => { try { fs.writeFileSync(process.env.LXP_OUT, JSON.stringify(o), 'utf8') } catch {} }
// 必须走 src/plugins.js 的 evaluateOne —— 它才是生产路径：会把 @name/@version/@author/@homepage
// 一并喂给脚本。有些插件（liuyun-jh 就是）会校验这些字段，缺了就拒绝初始化，
// 用精简的 scriptInfo 去探会把它们误判成「加载失败」。
globalThis.__LX_DEFER_PLUGIN_EVAL = true
const mod = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'src', 'plugins.js'))}).href)
const item = mod.PLUGIN_MANIFEST.find(p => p.id === process.env.LXP_ID)
if (!item) { write({ ok: false, error: '插件不存在' }); process.exit(0) }
// 静音插件的日志：评分只关心结论，不需要它们的开机横幅
const noop = () => {}
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = noop
let r
try { r = mod.evaluateOne(item) }
catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
const rec = mod.pluginPool.plugins.find(p => p.id === item.id)
write({
  ok: !!r.ok, error: r.error || null,
  meta: (rec && rec.meta) || null,
  sources: rec && rec.sources ? Object.keys(rec.sources) : [],
})
`

/**
 * 子进程回报文件放哪。
 *
 * --ephemeral（容器内）必须挪到可写目录：镜像里的 tools/ 属主是 root，
 * 而容器以 node 用户运行，在那里建目录会 EACCES。LXP_DATA_DIR 才是持久可写卷。
 */
const TMP_DIR = EPHEMERAL
  ? path.join(process.env.LXP_DATA_DIR || ROOT, '.score-tmp')
  : path.join(__dirname, '.score-tmp')

function probeLoadability(item) {
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const outFile = path.join(TMP_DIR, `${item.id}.json`)
  try { fs.unlinkSync(outFile) } catch { /* 无所谓 */ }
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SRC], {
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LXP_ID: item.id, LXP_OUT: outFile },
  })
  if (fs.existsSync(outFile)) {
    try { return JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch { /* 落到下面 */ }
  }
  return {
    ok: false,
    error: res.signal
      ? `求值时进程被信号 ${res.signal} 终止（脚本把 JS 引擎搞崩了）`
      : ((res.stderr || '').trim().split('\n').slice(-1)[0] || '求值无输出'),
    sources: [],
  }
}

/* ===================== 探针歌曲（固定 + 可缓存） ===================== */

async function buildProbes() {
  if (!REFRESH_PROBES && fs.existsSync(PROBE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'))
      if (cached && cached.songs && Object.keys(cached.songs).length) {
        console.log(`[probe] 复用探针歌曲缓存（${cached.builtAt}）`)
        return cached.songs
      }
    } catch { /* 重新建 */ }
  }
  console.log(`[probe] 重新搜集探针歌曲：${PROBE_KEYWORDS.join(' / ')}`)
  const { searchOnline } = await import(pathToFileURL(path.join(ROOT, 'src', 'providers', 'index.js')).href)
  const songs = {}
  for (const src of ALL_SOURCES) {
    songs[src] = []
    for (const kw of PROBE_KEYWORDS) {
      try {
        const res = await searchOnline(kw, { sources: [src], limit: 3 })
        const pick = (res.list || []).filter(s => s && s.name).slice(0, 1)
        if (pick.length) songs[src].push(pick[0])
        else console.log(`[probe] ${src} 搜「${kw}」无结果`)
      } catch (e) {
        console.log(`[probe] ${src} 搜「${kw}」失败：${(e && e.message) || e}`)
      }
    }
  }
  fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true })
  fs.writeFileSync(PROBE_FILE, JSON.stringify({ builtAt: nowIso(), keywords: PROBE_KEYWORDS, songs }, null, 2), 'utf8')
  return songs
}

/* ========================= 阶段 B：实测取流 ========================= */

/**
 * 「这是本机出口的问题，不是插件的锅」的判定。
 *
 * 为什么必须分开算：跑评分的这台机器和线上 CF Worker 出口不同。实测有一批插件
 * （liuyun-lxmusic / liuyun-nya / pdone-huibq / wsl-lxfree / wsl-zicheng）
 * 在五个平台上一律 `fetch failed` 或调用超时 —— 它们指向的上游在构建机上根本不通。
 * 把这算成「插件不行」会得出完全错误的结论：会把本来能用的源剪掉，
 * 也会把真正有问题的源（返回 HTML 错误页那种）掩盖掉。
 *
 * 所以：这类失败从成功率的分母里剔除，单列 `出口不可达` 计数，
 * 并在报表里明确标出来。真正计入分母的是「插件确实跑完并给了答复，
 * 只是答复不能用」——那才是插件自己的问题。
 */
const NETWORK_HINTS = /(fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|调用超时|请求超时|timed? ?out|abort)/i

/**
 * 「加载失败」的定性：是脚本自身的问题，还是本机出口够不到它要拉的东西？
 *
 * 只有前者才够格从 build.mjs 的清单里删掉。后者（尤其是「未发送 inited 事件」——
 * 插件在等一个拉不到的远端配置）在 CF Worker 出口上很可能是好的，删了就白丢能力。
 * 判断依据是实测出来的：flower/grass/yc 的 inited 依赖 raw.githubusercontent.com 上的
 * source-info，changqing 依赖 kstore.vip，juhe 依赖 lerd.dpdns.org。
 */
const ENV_LOAD_HINTS = /(未发送 inited|未声明 sources|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|超时)/i

function classifyLoadError(err) {
  if (!err) return null
  return ENV_LOAD_HINTS.test(String(err)) ? 'env' : 'script'
}

async function scoreOne(pool, record, source, probes, deadline) {
  const info = record.sources[source]
  const declared = (info && info.qualitys) || []
  const notes = []
  const hits = []
  let netFail = 0

  for (const song of probes) {
    if (Date.now() > deadline) { notes.push('全局超时，未测完'); break }
    const quality = declared.includes('320k') ? '320k' : (declared[0] || '320k')
    const t0 = Date.now()
    let r
    try {
      r = await withTimeout(
        pool.invokePlugin(record, source, 'musicUrl', { type: quality, musicInfo: song }),
        CALL_TIMEOUT + 500,
        '调用超时',
      )
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) }
    }
    const ms = Date.now() - t0
    if (!r.ok || !r.value) {
      const err = String((r && r.error) || '未返回地址')
      if (NETWORK_HINTS.test(err)) netFail++
      notes.push(`${song.name || '?'}: ${err}`.slice(0, 110))
      continue
    }
    let v
    try {
      v = await verifyAudio(r.value)
    } catch (e) {
      v = { ok: false, status: 0, contentType: '', bytes: 0, magic: '', ms: 0, error: (e && e.message) || String(e) }
    }
    hits.push({ song: song.name, quality, ms, url: r.value.slice(0, 120), ...v })
    if (!v.ok) notes.push(`${song.name || '?'}: 直链不可播 http=${v.status} ct=${v.contentType || '-'} magic=${v.magic || '-'}`.slice(0, 110))
  }

  const tries = probes.length
  const effective = Math.max(0, tries - netFail)
  const got = hits.length
  const playable = hits.filter(h => h.ok).length
  const latencies = hits.map(h => h.ms).sort((a, b) => a - b)
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null

  const successRate = effective ? got / effective : 0
  const playRate = got ? playable / got : 0
  // 速度分：≤1500ms 满分，≥8000ms 归零
  const speedScore = p50 == null ? 0 : p50 <= 1500 ? 1 : p50 >= 8000 ? 0 : 1 - (p50 - 1500) / 6500
  // 全部失败都是出口不可达 → 这次评分对它是无效的，标出来别让人当成「它不行」
  const unmeasured = effective === 0 && netFail > 0

  return {
    source,
    tries, effective, got, playable, netFail, unmeasured,
    successRate, playRate, p50,
    speedScore,
    score: 100 * (0.45 * successRate + 0.25 * speedScore + 0.15 * playRate),
    hits,
    notes,
  }
}

/* ============================== 主流程 ============================== */

async function main() {
  const t0 = Date.now()
  const dead = Date.now() + GLOBAL_DEADLINE

  // 延迟求值：crashers 会直接干掉进程，必须先摸清哪些能安全求值
  globalThis.__LX_DEFER_PLUGIN_EVAL = true
  const { pluginPool, evaluateOne, PLUGIN_MANIFEST } = await import(pathToFileURL(path.join(ROOT, 'src', 'plugins.js')).href)

  let items = PLUGIN_MANIFEST
  if (ONLY.length) items = items.filter(p => ONLY.includes(p.id))
  console.log(`[score] 待评插件 ${items.length} 个，平台 ${SOURCES.length ? SOURCES.join('/') : ALL_SOURCES.join('/')}`)

  /* --- 阶段 A --- */
  const browser = loadBrowserReport()
  console.log('\n===== 阶段 A：可加载性 =====')
  console.log(`  「服务端」= Node/V8（CF Worker 走这条）；「浏览器」= headless Chrome（WebView 同源）`
    + (browser.at ? `，后者取自 ${browser.at}` : '，后者缺数据 —— 先跑 node probe/plugin-browser-check.mjs'))
  const loadResults = []
  for (const item of items) {
    const r = probeLoadability(item)
    const web = browser.map.get(item.id)
    loadResults.push({ item, ...r, kind: r.ok ? null : classifyLoadError(r.error), web: web ? { ok: !!web.ok, error: web.error || null } : null })
    const srcs = (r.sources || []).join(',')
    const webMark = web ? (web.ok ? ' OK ' : ' ✗  ') : ' ?  '
    console.log('  服务端 ' + (r.ok ? 'OK  ' : '✗   ') + '| 浏览器 ' + webMark + ' '
      + item.id.padEnd(20)
      + String(Math.round(item.script.length / 1024) + 'KB').padStart(7) + '  '
      + (r.meta && r.meta.name ? r.meta.name : item.name).padEnd(20)
      + ' 源: ' + (srcs || '-')
      + (r.ok ? '' : '   └ ' + String(r.error).slice(0, 60)))
  }
  const loadable = loadResults.filter(r => r.ok)
  console.log(`\n服务端可加载 ${loadable.length} / ${loadResults.length}`)
  if (!browser.stale) {
    const webOk = loadResults.filter(r => r.web && r.web.ok).length
    console.log(`浏览器可加载 ${webOk} / ${loadResults.length}`)
    const neither = loadResults.filter(r => !r.ok && r.web && !r.web.ok)
    if (neither.length) {
      const scriptBad = neither.filter(r => r.kind === 'script')
      console.log(`两个环境都不可用 ${neither.length} 个：${neither.map(r => r.item.id).join(', ')}`)
      console.log(`  其中「脚本自身有问题」${scriptBad.length} 个：${scriptBad.length ? scriptBad.map(r => r.item.id).join(', ') : '（无）'}`
        + '；其余为「本机出口够不到远端配置」，不要据此删除')
    }
  }

  /* --- 把可加载的插件装进池子（用生产同一套 evaluateOne） --- */
  for (const r of loadable) evaluateOne(r.item)

  /* --- 探针 --- */
  const probesAll = await buildProbes()
  const targets = SOURCES.length ? SOURCES : ALL_SOURCES

  /* --- 阶段 B --- */
  console.log('\n===== 阶段 B：实测取流 =====')
  const jobs = []
  for (const r of loadable) {
    // 注意：loadable 里的 sources 是**数组**（子进程只回传 key 列表），
    // 别再套一层 Object.keys —— 那会得到 ['0','1',...] 下标，一个组合都匹配不上。
    for (const src of (Array.isArray(r.sources) ? r.sources : [])) {
      if (!targets.includes(src)) continue
      const rec = (pluginPool.bySource.get(src) || []).find(p => p.id === r.item.id)
      if (!rec) { console.log(`  [warn] ${r.item.id}@${src} 不在池中，跳过`); continue }
      jobs.push({ id: r.item.id, name: (r.meta && r.meta.name) || r.item.name, source: src, rec })
    }
  }
  const probeCount = {}
  for (const src of targets) probeCount[src] = (probesAll[src] || []).length
  console.log(`探针歌：${targets.map(s => `${s}=${probeCount[s]}`).join(' ')}`)
  console.log(`组合数 ${jobs.length}（每个组合最多 ${PROBE_KEYWORDS.length} 首探针歌）`)
  if (!jobs.length) {
    console.log('没有可测组合 —— 检查插件是否声明了这些平台。')
  }

  let done = 0
  const scored = await mapLimit(jobs, CONCURRENCY, async (job) => {
    const probes = (probesAll[job.source] || []).slice(0, PROBE_KEYWORDS.length)
    const out = probes.length
      ? await scoreOne(pluginPool, job.rec, job.source, probes, dead)
      : { source: job.source, tries: 0, got: 0, playable: 0, successRate: 0, playRate: 0, p50: null, speedScore: 0, score: 0, hits: [], notes: ['无探针歌'] }
    done++
    process.stdout.write(`\r  进度 ${done}/${jobs.length}  ${job.id}@${job.source} 得分 ${out.score.toFixed(0)}`.padEnd(70))
    return { ...job, ...out }
  })
  process.stdout.write('\n')

  /* --- 覆盖广度（全局属性，作为小幅加成） --- */
  const coverage = {}
  for (const r of loadable) coverage[r.item.id] = (Object.keys(r.sources || {}).length) / ALL_SOURCES.length

  /* --- 汇总：按平台各自排名 --- */
  const rank = {}
  const perSource = {}
  for (const src of targets) {
    const rows = scored.filter(s => s.source === src)
    for (const row of rows) {
      row.final = 0.85 * row.score + 0.15 * (coverage[row.id] || 0) * 100
    }
    rows.sort((a, b) => b.final - a.final || a.id.localeCompare(b.id))
    perSource[src] = rows
    rank[src] = rows.filter(r => r.final > 0).map(r => r.id)
  }

  /* --- 报表 --- */
  const srcName = { wy: '网易云', kg: '酷狗', kw: '酷我', tx: 'QQ音乐', mg: '咪咕' }
  console.log('\n===== 分平台排名（综合分 = 0.85×平台实测 + 0.15×覆盖广度）=====')
  console.log('  成功 = 拿到直链的次数 / 有效次数（已剔除「本机出口不可达」的次数）')
  console.log('  可播 = 直链经 Range 请求验证确实是音频的比例（防「返回 HTML 错误页」的假成功）')
  console.log('  ⚠出口 = 该平台上因本机网络不可达而没测成的次数；若等于总次数，本行评分无效')
  for (const src of targets) {
    const rows = perSource[src]
    console.log(`\n── ${srcName[src] || src} (${src}) ──`)
    if (!rows.length) { console.log('  （没有插件声明支持该平台）'); continue }
    console.log('  ' + '插件'.padEnd(20) + '综合'.padStart(6) + '成功'.padStart(7) + '可播'.padStart(7) + 'p50'.padStart(8) + '⚠出口'.padStart(7) + '  明细')
    for (const r of rows) {
      console.log('  ' + r.id.padEnd(20)
        + r.final.toFixed(1).padStart(6)
        + ((r.effective ? r.got + '/' + r.effective : '未测出').padStart(7))
        + ((r.got ? Math.round(r.playRate * 100) + '%' : '-').padStart(7))
        + ((r.p50 == null ? '-' : r.p50 + 'ms').padStart(8))
        + ((r.netFail ? String(r.netFail) : '').padStart(7))
        + '  ' + (r.unmeasured ? '⚠ 本机出口不可达，本次评分无效' : (r.hits[0] ? (r.hits[0].magic || r.hits[0].contentType.slice(0, 16)) : (r.notes[0] || ''))))
    }
  }

  /* --- 一句话结论 --- */
  const measured = scored.filter(s => !s.unmeasured)
  const unmeasuredIds = [...new Set(scored.filter(s => s.unmeasured).map(s => s.id))]
  const deadWeight = scored.filter(s => !s.unmeasured && s.got > 0 && s.playRate === 0)
  console.log('\n===== 结论 =====')
  const best = perSource[targets[0]] && perSource[targets[0]][0]
  if (best) console.log(`  综合最优：${best.id}（${srcName[targets[0]] || targets[0]} ${best.final.toFixed(1)} 分）`)
  if (unmeasuredIds.length) {
    console.log(`  评不出来（本机出口不可达，不代表它不行，需要换出口复测）：${unmeasuredIds.join(', ')}`)
  }
  if (deadWeight.length) {
    console.log(`  ⚠「假成功」——能拿到地址但地址不是音频，等于占着候选槽位不出声：`)
    for (const d of deadWeight) console.log(`      ${d.id}@${d.source}  成功率 ${d.got}/${d.effective}，可播 0%，拿回来的是 ${d.hits[0] ? d.hits[0].contentType : '-'}`)
  }

  /* --- 死插件清单 --- */
  const deadPlugins = loadResults.filter(r => !r.ok)
  if (deadPlugins.length) {
    const totalBytes = loadResults.reduce((a, r) => a + r.item.script.length, 0)

    // 两把尺子一起量才算「可删」：
    //   ① 失败原因必须是**脚本自身的**（kind === 'script'）——「未发送 inited」多半是
    //      拉不到远端配置，属于本机出口问题，删了等于砍掉 CF 上本来能用的源；
    //   ② 服务端 + 浏览器两边都得失败 —— 插件里常有 typeof require/window 探测，
    //      单边结论不可信。
    const prunable = deadPlugins.filter(r => r.kind === 'script' && r.web && !r.web.ok)
    const envBlocked = deadPlugins.filter(r => r.kind === 'env')
    const oneSided = deadPlugins.filter(r => r.kind !== 'env' && (!r.web || r.web.ok))

    console.log('\n===== 加载失败 A：脚本自身有问题（可考虑从 build.mjs 清单删掉）=====')
    if (!prunable.length) console.log('  （无）')
    for (const d of prunable) {
      console.log('  ' + d.item.id.padEnd(20) + String(Math.round(d.item.script.length / 1024) + 'KB').padStart(7) + '  ' + String(d.error).slice(0, 70))
    }
    if (prunable.length) {
      const pb = prunable.reduce((a, r) => a + r.item.script.length, 0)
      console.log(`  → 删掉可回收 ${(pb / 1024).toFixed(0)} KB / ${(totalBytes / 1024).toFixed(0)} KB（占 ${Math.round(pb / totalBytes * 100)}%）`)
    }

    console.log('\n===== 加载失败 B：本机出口够不到它要拉的远端配置（⚠ 一律保留）=====')
    console.log('  这类在构建机上必然失败，但 CF Worker 出口很可能拉到；删了就是白丢能力。')
    if (!envBlocked.length) console.log('  （无）')
    for (const d of envBlocked) {
      const web = !d.web ? '浏览器无数据' : (d.web.ok ? '浏览器 OK' : '浏览器也 ✗')
      console.log('  ' + d.item.id.padEnd(20) + String(Math.round(d.item.script.length / 1024) + 'KB').padStart(7) + '  ' + web.padEnd(14) + String(d.error).slice(0, 52))
    }

    console.log('\n===== 加载失败 C：单边失败（原因不明，先留着）=====')
    if (!oneSided.length) console.log('  （无）')
    for (const d of oneSided) {
      const where = !d.web ? '浏览器侧无数据' : '服务端不行、浏览器 OK'
      console.log('  ' + d.item.id.padEnd(20) + where.padEnd(22) + String(d.error).slice(0, 60))
    }
  }

  /* --- 供界面展示的精简明细 --- */
  // 体积敏感：这个对象要进 Worker 产物，所以只留「界面真的会显示」的字段，
  // 原始 hits（含完整 URL）只留在 tools/.plugin-score.json 里备查。
  const loadMap = {}
  for (const r of loadResults) {
    loadMap[r.item.id] = {
      name: (r.meta && r.meta.name) || r.item.name,
      kb: Math.round(r.item.script.length / 1024),
      sources: r.sources || [],
      serverOk: !!r.ok,
      serverError: r.ok ? null : String(r.error || '').slice(0, 120),
      browserOk: r.web ? !!r.web.ok : null,
      browserError: r.web && r.web.error ? String(r.web.error).slice(0, 120) : null,
      failKind: r.kind || null, // 'script' = 脚本自身有问题；'env' = 本机出口够不到远端配置
    }
  }
  const scoreRows = {}
  for (const src of targets) {
    scoreRows[src] = (perSource[src] || []).map(r => {
      const h = (r.hits && r.hits[0]) || null
      return {
        id: r.id,
        name: r.name,
        score: Number(r.final.toFixed(1)),
        got: r.got,
        effective: r.effective,
        playable: r.playable,
        rate: r.effective ? Math.round(r.got / r.effective * 100) : null,   // 取流成功率 %
        play: r.got ? Math.round(r.playRate * 100) : null,                   // 直链可播率 %
        p50: r.p50,
        netFail: r.netFail || 0,
        unmeasured: !!r.unmeasured,
        fake: !r.unmeasured && r.got > 0 && r.playRate === 0,
        note: h ? (h.magic || String(h.contentType || '').slice(0, 20)) : ((r.notes && r.notes[0]) || '').slice(0, 48),
      }
    })
  }

  /* --- 落盘 --- */
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: nowIso(),
    keywords: PROBE_KEYWORDS,
    load: loadResults.map(r => ({
      id: r.item.id, name: (r.meta && r.meta.name) || r.item.name, bytes: r.item.script.length,
      ok: r.ok, error: r.error || null, sources: r.sources || [],
      browserOk: r.web ? !!r.web.ok : null, browserError: r.web ? (r.web.error || null) : null,
    })),
    browserReportAt: browser.at,
    scores: scored.map(s => ({
      id: s.id, source: s.source, final: s.final, score: s.score,
      tries: s.tries, effective: s.effective, got: s.got, playable: s.playable,
      netFail: s.netFail, unmeasured: !!s.unmeasured, p50: s.p50, hits: s.hits, notes: s.notes,
    })),
    rank,
  }, null, 2), 'utf8')
  console.log(`\n[score] 明细已写入 ${path.relative(ROOT, OUT_FILE)}`)

  if (!REPORT_ONLY && !EPHEMERAL) {
    const body = Object.entries(rank).map(([src, ids]) =>
      `  ${JSON.stringify(src)}: [\n${ids.map(id => `    ${JSON.stringify(id)},`).join('\n')}\n  ],`
    ).join('\n')
    const content = `/**
 * 插件实测得分排序表（由 tools/plugin-score.mjs 自动生成，请勿手动修改）
 *
 * 结构：{ [平台]: [插件 id, ...] }，按该平台上的综合得分降序。
 * src/plugins.js 装载插件池后会调 pool.setRank(PLUGIN_RANK)，让「先试哪个插件」
 * 由实测结果决定，而不是 build.mjs 里的书写顺序。
 *
 * 生成时间：${nowIso()}
 * 评分口径：取流成功率 45% + 响应速度 25% + 直链可播性 15%（平台实测），
 *           另以覆盖广度 15% 加权；「能否加载」是一票否决的硬门槛。
 *           因本机出口不可达而没测成的插件，排在实测有效的插件之后。
 * 重新生成：node tools/plugin-score.mjs
 *
 * ⚠ 口径限制：分数是在**构建机**的网络上测的，与线上 Cloudflare Worker 出口不完全一致。
 *   「成功率高」可信；「成功率 0 且出口不可达」的条目只是没测到，不代表它不行。
 *   2026-10-01 实测对照：构建机 18/25 可加载，线上 /healthz 同样 18/25、失败的是同一批
 *   （六音 / 野花 / 独家音源 / 野草 / 聚合API(CF) / 长青SVIP），所以这份排序的覆盖率是完整的。
 */
export const PLUGIN_RANK = {
${body}
}

export const PLUGIN_RANK_META = {
  generatedAt: ${JSON.stringify(nowIso())},
  keywords: ${JSON.stringify(PROBE_KEYWORDS)},
  scorer: 'plugin-score/1',
  measuredFrom: 'build-host',
  unmeasured: ${JSON.stringify(unmeasuredIds)},
}
`
    fs.writeFileSync(RANK_FILE, content, 'utf8')
    console.log(`[score] 排序表已写入 ${path.relative(ROOT, RANK_FILE)}`)

    /* --- 评分明细（供 /api/plugin-scores 与「音源与插件」页展示） --- */
    const scoresContent = `/**
 * 插件评分明细（由 tools/plugin-score.mjs 自动生成，请勿手动修改）
 *
 * 给谁看：src/server/api.js 的 /api/plugin-scores 把它整包返回，
 *         前端「音源与插件」页据此展示每个平台各插件的得分与调度顺序。
 *
 * 结构：
 *   load        { [插件 id]: { name, kb, sources, serverOk, serverError,
 *                              browserOk, browserError, failKind } }
 *               failKind: 'script' = 脚本自身有问题（可考虑从清单删）；
 *                         'env'    = 本机出口够不到它的远端配置（勿据此删除）。
 *   byPlatform  { [平台]: [ { id, name, score, rate, play, p50, ... } ] }
 *               已按综合分降序，**顺序即自动模式下的调度顺序**。
 *   fake        该插件能拿到地址但地址不是音频（占着候选槽位不出声），界面要标出来。
 *   unmeasured  本机出口受限没测到（score 不可信），界面要标出来。
 *
 * 生成时间：${nowIso()}
 * 探针关键词：${PROBE_KEYWORDS.join(' / ')}
 * 重新生成：node tools/plugin-score.mjs
 */
export const PLUGIN_SCORES = ${JSON.stringify({
      generatedAt: nowIso(),
      measuredFrom: 'build-host',
      keywords: PROBE_KEYWORDS,
      load: loadMap,
      byPlatform: scoreRows,
    }, null, 1)}
`
    fs.writeFileSync(SCORES_FILE, scoresContent, 'utf8')
    console.log(`[score] 评分明细已写入 ${path.relative(ROOT, SCORES_FILE)}`)
  } else if (EPHEMERAL) {
    /**
     * 容器内评分：结果不落仓库文件，交给调用方。
     *
     * 落库需要三样东西，所以这里一次性给全（调用方不用再自己算）：
     *   rank         { [平台]: [插件 id, ...] }    —— 装进 pluginPool.setRank() 的那份
     *   byPlatform   { [平台]: [ {id, name, score, rate, play, p50, ...} ] } —— 界面展示
     *   load         { [插件 id]: { name, kb, sources, serverOk, serverError, ... } }
     *   measuredAt / keywords / unmeasured —— 界面要显示的「什么时候测的、准不准」
     *
     * 口径与构建期完全一致（同一份代码、同一套打分公式），只是**测的网络不一样** ——
     * 这正是容器内评分的价值：用户在什么网络下部署，就按那个网络的实际表现排序。
     */
    const payload = {
      ok: true,
      generatedAt: nowIso(),
      measuredFrom: 'runtime-host',   // 与构建期的 'build-host' 区分开，界面要能看出来
      keywords: PROBE_KEYWORDS,
      unmeasured: unmeasuredIds,
      rank,
      byPlatform: scoreRows,
      load: loadMap,
      // 供界面显示「哪些插件是脚本自身有问题、哪些只是本机出口够不到」
      prunable: loadResults.filter(r => !r.ok && r.kind === 'script').map(r => r.item.id),
      envBlocked: loadResults.filter(r => !r.ok && r.kind === 'env').map(r => r.item.id),
      elapsedMs: Date.now() - t0,
    }
    const text = JSON.stringify(payload)
    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
      fs.writeFileSync(JSON_OUT, text, 'utf8')
      // 文件写成功也要在 stdout 给个回执：调用方可能只看日志判断成败
      console.log(`[score] 结果已写入 ${JSON_OUT}（${(text.length / 1024).toFixed(0)}KB）`)
    } else {
      console.log('[score] ' + text)
    }
    console.log('[score] --ephemeral 模式：未改动 src/generated/ 下任何文件')
  } else if (REPORT_ONLY) {
    console.log('[score] --report 模式：排序表未改动')
  }

  console.log(`[score] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error('[score] 失败:', err)
  process.exit(1)
})
