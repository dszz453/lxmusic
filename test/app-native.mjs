/**
 * 安卓壳的「桌面替身」验证 —— 在没有手机的情况下把整个 App 跑一遍。
 *
 * 思路：
 *   壳子和网页之间的契约只有两个原生桥（HTTP、SQLite）加一个资源提供方。
 *   这里把这三样用本机等价物顶上，就成了一个能跑的桌面版壳：
 *     · 资源      → 本机起 HTTP server 直接服务 public/
 *     · HTTP 桥   → 转发给 Node 的 fetch（真实网络，且不受 CORS 限制，与原生一致）
 *     · SQLite 桥 → 用 node:sqlite（就是真的 SQLite，不是模拟）
 *   于是 headless Chrome 里跑的就是「App 里的那份 JS」，能验证真机之外的一切：
 *   页面是否白屏、自动开户是否成功、/api/* 是否被本地后端接管、搜索能不能出结果、
 *   封面是否走了直连、插件是否被灌进 Worker。
 *
 * 与真机的差异（已知，不算失败）：
 *   · 音频播放依赖真实解码器与音频设备，这里只看取流链路是否返回了可播地址；
 *   · Android 特有的 WebView 配置（混合内容放开等）在这里由 Chrome 默认策略代替，
 *     所以 http 音频在浏览器里仍会被拦，属于环境差异。
 *
 * 用法：node test/app-native.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
/**
 * 临时目录放**系统临时区**，不要放项目里 —— 理由同 test/audiocache.mjs：
 * 收尾时删项目内的 Chrome profile 会撞上「批量删除保护」，测试直接跑不起来。
 */
const TMP = path.join(os.tmpdir(), 'lxmusic-app-native')

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find(p => fs.existsSync(p))

if (!CHROME) {
  console.error('找不到 Chrome，请用 CHROME_PATH 指定')
  process.exit(1)
}

let DatabaseSync = null
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (e) {
  console.error('需要 node:sqlite（用 --experimental-sqlite 运行）:', e.message)
  process.exit(1)
}

/* ================= 1. 桌面版壳的资源层与两个桥 ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
}

const db = new DatabaseSync(':memory:')
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8').replace(/--.*$/gm, ''))

/** 与 StoreBridge 的 SQLite 语义一致：SELECT 走 query，写走 run */
function dbQuery(sql, args) {
  const st = db.prepare(sql)
  return JSON.stringify(st.all(...(args || [])))
}
function dbExec(sql, args) {
  const st = db.prepare(sql)
  const head = sql.trim().toUpperCase()
  if (head.startsWith('INSERT') || head.startsWith('REPLACE')) {
    try { st.run(...(args || [])); return 1 } catch { return 0 }
  }
  if (head.startsWith('UPDATE') || head.startsWith('DELETE')) {
    const r = st.run(...(args || []))
    return Number(r.changes || 0)
  }
  st.run(...(args || []))
  return 1
}

/**
 * 收请求体。
 * 必须按 Buffer 拼接再统一解码 —— 直接 `data += chunk` 会在 chunk 边界
 * 切断多字节字符（搜索词、歌名全是中文，请求体里到处是中文），
 * 造成偶发 JSON.parse 失败，看起来像"网络错误"，其实是我们自己拆坏的。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => { chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 出站请求失败记录：用来把「fetch failed」定位到具体目标地址，而不是停在猜 */
const outboundFails = []

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  // —— HTTP 桥：转发真实请求（原生侧就是这么做的，且天然不受同源策略约束）
  if (url.pathname === '/__bridge/http' && req.method === 'POST') {
    let out
    let spec = null
    try {
      spec = JSON.parse(await readBody(req))
      const init = { method: spec.method || 'GET', headers: spec.headers || {}, redirect: 'follow' }
      if (spec.body != null && !/^(GET|HEAD)$/i.test(init.method)) init.body = spec.body
      const r = await fetch(spec.url, init)
      const ct = r.headers.get('content-type') || ''
      const binary = !/^(text\/|application\/(json|javascript|xml))/.test(ct)
      const headers = {}
      r.headers.forEach((v, k) => { headers[k] = v })
      out = {
        status: r.status,
        headers,
        url: r.url,
        enc: binary ? 'base64' : 'text',
        body: binary ? Buffer.from(await r.arrayBuffer()).toString('base64') : await r.text(),
      }
    } catch (e) {
      out = { error: String((e && e.message) || e) }
      outboundFails.push({ url: (spec && spec.url || '').slice(0, 120), err: out.error })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }

  // —— SQLite 桥
  if (url.pathname === '/__bridge/sql' && req.method === 'POST') {
    const { sql, args } = JSON.parse(await readBody(req))
    let out = '[]'
    try { out = dbQuery(sql, args) } catch (e) { console.error('[sql] 查询失败', sql, e.message) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(out)
    return
  }
  if (url.pathname === '/__bridge/exec' && req.method === 'POST') {
    const { sql, args } = JSON.parse(await readBody(req))
    let n = 0
    try { n = dbExec(sql, args) } catch (e) { console.error('[sql] 写入失败', sql, e.message) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(String(n))
    return
  }

  // —— 静态资源（等价于壳里的 shouldInterceptRequest → assets）
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'
  const file = path.join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(file))
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
console.log(`资源服务: ${BASE}`)

/* ================= 1.5 假「远程服务器」（第 9 节用） ================= */

/**
 * 远程模式测的是**壳这一侧**的行为：地址归一、`/api/*` 改道、进了远程就本机不再开户。
 * 所以这里不需要真跑一遍 server/index.mjs —— 那要逐个求值 20 多个插件，光启动就一分多钟，
 * 而本组用例真正想看见的事实只有一个：「请求到底打到了哪一边」。桩能把这件事记清楚，
 * 顺带把耗时从分钟级压到秒级。
 */
const remoteHits = []
const remoteSrv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  remoteHits.push(url.pathname)
  const json = (o, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(o))
  }
  // 刻意报「还没初始化」。这样壳一旦真的把请求打到远端，就会被路由到「创建管理员」页，
  // 与「本机已经有 local 账号、本机模式会直接进首页」形成互斥判据 —— 光看有没有网络
  // 请求会被缓存和重试搅浑，看页面落在哪一页才骗不了人。
  if (url.pathname === '/api/setup-status') return json({ needsSetup: true, version: 'stub-remote-1' })
  if (url.pathname === '/api/setup' || url.pathname === '/api/login') {
    return json({ token: 'stub-token', user: { username: 'remoteadmin', is_admin: 1 } })
  }
  if (url.pathname === '/api/me') return json({ user: { username: 'remoteadmin', is_admin: 1 } })
  if (url.pathname === '/api/sources') return json({ platforms: [] })
  return json({ ok: true, list: [] })
})
await new Promise(r => remoteSrv.listen(0, '127.0.0.1', r))
const REMOTE_BASE = `http://127.0.0.1:${remoteSrv.address().port}`
console.log(`远程桩服务: ${REMOTE_BASE}`)

/* ================= 2. 注入原生桥替身 ================= */

/** 等价于 MainActivity 里 addJavascriptInterface(new Host(), "AndroidHost") */
const BRIDGE_STUB = `
(function () {
  function syncPost(p, body) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', p, false);           // 同步：@JavascriptInterface 的调用语义就是这样
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.send(body);
    return xhr.status === 200 ? xhr.responseText : '';
  }
  window.AndroidHost = {
    httpRequest: function (id, reqJson) {
      fetch('/__bridge/http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: reqJson })
        .then(function (r) { return r.text() })
        .then(function (t) { window.__LXB_HTTP(id, t) })
        .catch(function (e) { window.__LXB_HTTP(id, JSON.stringify({ error: String((e && e.message) || e) })) });
    },
    dbQuery: function (sql, argsJson) {
      try { return syncPost('/__bridge/sql', JSON.stringify({ sql: sql, args: JSON.parse(argsJson || '[]') })) } catch (e) { return '[]' }
    },
    dbExec: function (sql, argsJson) {
      try { return parseInt(syncPost('/__bridge/exec', JSON.stringify({ sql: sql, args: JSON.parse(argsJson || '[]') })), 10) || 0 } catch (e) { return 0 }
    },
    log: function (tag, msg) { console.log('[bridge/' + tag + '] ' + msg) },
    // 原生媒体会话的上报口（见 test/app-media.mjs 的专项验收）。
    // 这个文件不验媒体，收下即可 —— 但桩要跟真机的 AndroidHost 长得一样，
    // 少一个方法会让 native.js 里的 typeof 判定走另一条分支，测出来的就不是真机行为。
    mediaReport: function () {},
    mediaStatus: function () {
      return JSON.stringify({
        ok: true, sdk: 34, brand: 'stub', android: '14',
        notifGranted: 3, notifEnabled: true, channel: 'low',
        native: {
          service: true, session: true, foreground: true, notifiedAgoMs: 500,
          reports: 1, reportAgoMs: 500, lastCmd: '', cmdAgoMs: -1,
          startError: '', coverError: '', hasTrack: false, playing: false,
          title: '', coverOk: false, errors: [],
        },
      })
    },
    askNotificationPermission: function () {},
    openAppSettings: function () {},
  };
})();
`

/* ================= 3. CDP ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const DEBUG_PORT = 9300 + Math.floor(Math.random() * 400)
const USER_DIR = path.join(TMP, 'chrome-app-' + DEBUG_PORT)
fs.mkdirSync(TMP, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + USER_DIR,
  'about:blank',
], { stdio: 'ignore' })

async function pageWs() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  throw new Error('CDP 未就绪')
}

const ws = new WebSocket(await pageWs())
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let msgId = 0
const waiting = new Map()
const consoleLogs = []
const pageErrors = []
// 整页重载在 CDP 里不会通知「当前这个 evaluate 上下文没了」，只会安静地换掉执行环境。
// 所以远程模式那一段必须靠 Page.loadEventFired 来判断「页面确实重新加载过」，
// 否则「刚点完切换就读状态」读到的是旧页面，测出来的全是假的通过。
let loadCount = 0

ws.addEventListener('message', ev => {
  let m
  try { m = JSON.parse(ev.data) } catch { return }
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result)
    return
  }
  if (m.method === 'Page.loadEventFired') { loadCount++; return }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => (a.value != null ? String(a.value) : (a.description || ''))).join(' ')
    consoleLogs.push({ type: m.params.type, text })
    if (m.params.type === 'error') pageErrors.push(text)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    pageErrors.push('UNCAUGHT: ' + ((d.exception && d.exception.description) || d.text))
  }
})

function send(method, params) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

const evaluate = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description))
  return r.result && r.result.value
}

/** 等下一次整页加载事件（用计数比较，避免「事件比等待先到」这种竞态） */
async function nextLoad(timeout = 30000) {
  const base = loadCount
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (loadCount > base) return true
    await sleep(100)
  }
  return false
}

/** 轮询某个表达式为真。表达式会抛（上下文切换中）时视为「还没好」而不是失败 */
async function waitFor(expr, timeout = 15000, step = 300) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true } catch { /* 导航中 */ }
    await sleep(step)
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
// 必须在导航前注入，否则页面首脚本跑起来时桥还不存在
await send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_STUB })
await send('Page.navigate', { url: BASE + '/' })

/* ================= 4. 断言 ================= */

console.log('\n== 1. 页面装载 ==')
await sleep(1500)
const title = await evaluate('document.title')
check('页面已渲染', typeof title === 'string' && title.length > 0, title)

const loaded = await evaluate('({native: !!window.LX_NATIVE, backend: !!window.LXBackend, plugins: (window.LX_PLUGIN_DATA||[]).length, app: !!window.App, lxp: typeof window.LXP})')
check('native.js 识别到壳环境', loaded.native === true)
check('backend.bundle.js 已挂载', loaded.backend === true)
check('插件数据已加载', loaded.plugins > 0, `${loaded.plugins} 个`)
check('前端主体已初始化', loaded.app === true)

// 等自动开户 + 首屏路由完成
await sleep(6000)

console.log('\n== 2. 自动开户（单机 App 不该出现登录页） ==')
const boot = await evaluate(`({
  hash: location.hash,
  user: (window.App && window.App.user && window.App.user.username) || null,
  token: !!(window.API && API.getToken()),
  chromeHidden: !!document.querySelector('#loginView, .login-view, [data-view=login]')
})`)
check('未跳登录页', boot.hash.indexOf('login') < 0 && boot.hash.indexOf('setup') < 0, 'hash=' + (boot.hash || '(空)'))
check('已自动登录', !!boot.user, 'user=' + boot.user)
check('本地已握有 token', boot.token === true)

const userRows = dbQuery('SELECT username, is_admin FROM users', [])
check('SQLite 里已落库本机账号', JSON.parse(userRows).length === 1, userRows)

console.log('\n== 3. 本地后端接管 /api/* ==')
const apiProbe = await evaluate(`(async () => {
  const r = await fetch('/api/admin/health').then(x => x.json()).catch(e => ({ err: String(e) }))
  return { keys: r ? Object.keys(r) : [], err: r && r.err }
})()`, true)
check('fetch(/api/...) 被本地后端接管', apiProbe.keys.includes('list') || apiProbe.keys.includes('ok'), JSON.stringify(apiProbe).slice(0, 140))

console.log('\n== 4. 真实检索（走原生桥出网） ==')
const search = await evaluate(`(async () => {
  try {
    const r = await API.search('周杰伦', { limit: 10 })
    const list = (r && r.list) || []
    return { n: list.length, first: list[0] ? list[0].name + ' - ' + list[0].singer : null, src: list[0] ? list[0].source : null }
  } catch (e) { return { err: String((e && e.message) || e) } }
})()`, true)
check('搜索能出结果', search.n > 0, `${search.n} 首 · ${search.first || search.err}`)

const charts = await evaluate(`(async () => {
  try { const r = await API.charts(); return { n: (r.list || []).length } } catch (e) { return { err: String(e) } }
})()`, true)
check('榜单接口可用', charts.n > 0, `${charts.n} 个榜单`)

console.log('\n== 5. 取流解析（不出音频，只看能否拿到可播地址） ==')
const stream = await evaluate(`(async () => {
  const r = await API.search('告白气球', { limit: 3 })
  const song = (r.list || [])[0]
  if (!song) return { err: '没搜到歌' }
  const token = (window.API && API.getToken && API.getToken()) || ''
  const call = async (extra) => {
    const t0 = Date.now()
    const r = await fetch('/api/url?id=' + encodeURIComponent(song.id) + '&q=320k&' + extra + '&token=' + encodeURIComponent(token))
      .then(async x => ({ status: x.status, body: await x.json().catch(() => null) }))
      .catch(e => ({ err: String((e && e.message) || e) }))
    r.ms = Date.now() - t0
    return r
  }
  const pick = (o) => {
    if (!o || !o.body) return null
    const b = o.body
    if (b.url) return { url: b.url, from: b.from, verified: b.verified !== false }
    if (b.urls && b.urls.length) return { url: b.urls[0].url, from: b.urls[0].from, verified: b.verified !== false }
    return null
  }
  const fast = await call('fast=1')
  const slow = fast.body && fast.body.url ? fast : await call('')
  // 冷启动判据：失败后热一遍再打一次 fast。若第二次成功，说明是首次调用
  // 太冷（插件 Worker 首次走 /proxy 要建链），而不是预算给小了。
  let fastWarm = null
  let fastWarmMs = null
  if (!pick(fast)) {
    const w = await call('fast=1')
    const hit = pick(w)
    if (hit) { fastWarm = hit.url.slice(0, 72); fastWarmMs = w.ms }
  }
  // fast 失败时把服务端诊断口的明细取回来（列了每个阶段的耗时与候选数）。
  // 只看「404 无可用播放地址」是不够的 —— 那句话把两种完全不同的原因
  // （候选全是 http / 候选压根没解析出来）说成同一句，必须看明细才分得清。
  let dbg = null
  if (!pick(fast)) {
    dbg = await fetch('/api/stream?id=' + encodeURIComponent(song.id) + '&q=320k&debug=1&token=' + encodeURIComponent(token))
      .then(x => x.json()).catch(() => null)
  }
  return {
    song: song.name, source: song.source,
    allowHttp: window.LX_ALLOW_HTTP_AUDIO === true,
    fastStatus: fast.status,
    fastMs: fast.ms,
    fastHit: !!pick(fast),
    fastErr: fast.body && fast.body.error,
    tried: fast.body && fast.body.tried,
    dbg: dbg && dbg.marks,
    fastWarm,
    fastWarmMs,
    hit: pick(slow),
    how: slow === fast ? 'fast' : '完整探测',
  }
})()`, true)
/*
 * 这一组断言刻意分成「硬要求」和「测量值」两类：
 *
 *   · 用户要的是「点歌能拿到可播地址」，这是硬要求，必须为真；
 *   · 「direct 级（fast=1）能出地址」只是优化项。它的冷启动耗时受本机到第三方源站的
 *     网络影响很大（同一天实测 1.62s → 2.92s → 3.51s 都出现过），拿它当合格线，
 *     等于让测试跟着网络抖动红绿，最后没人再看这条断言。所以只报数，不判定。
 *   · 真正需要死守的是那个 bug 的特征：壳内不许再把 http 候选判成「无法直连」
 *     （这正是能力标志名写岔时的表现），这条与网络无关，可以严格断言。
 */
const httpRejected = (stream.tried || []).some(t => /仅 http/.test(t))
check('取址链路能拿到可播地址', !!stream.hit,
  stream.hit ? `${stream.how} · ${stream.hit.url.slice(0, 72)} · ${stream.hit.from || ''}` : `无 · ${stream.fastErr || ''}`)
check('壳内放行 http 音频（否则会白丢一批源）', stream.allowHttp === true)
check('未把 http 候选误判为不可直连', !httpRejected,
  httpRejected ? 'tried 里出现了「仅 http，无法直连」：' + JSON.stringify(stream.tried).slice(0, 200) : '无此项')
console.log(`  · 测量值 direct 级（fast=1）：冷 ${stream.fastMs}ms → ${stream.fastHit ? '出地址' : '未出地址'}`
  + (stream.fastWarm ? `；热 ${stream.fastWarmMs}ms → 出地址` : ''))
if (!stream.fastHit && stream.tried) console.log(`      tried = ${JSON.stringify(stream.tried).slice(0, 260)}`)
if (!stream.fastHit && stream.dbg) {
  for (const m of stream.dbg) console.log(`      · ${JSON.stringify(m).slice(0, 300)}`)
}

console.log('\n== 6. 歌单 / 收藏读写（走 SQLite） ==')
const pl = await evaluate(`(async () => {
  try {
    const before = (await API.playlists()).list.length
    await API.createPlaylist('桌面验证歌单', [])
    const after = (await API.playlists()).list.length
    return { before, after }
  } catch (e) { return { err: String((e && e.message) || e) } }
})()`, true)
check('歌单可写入并可读回', pl.after === (pl.before || 0) + 1, `${pl.before} → ${pl.after}${pl.err ? ' ' + pl.err : ''}`)

console.log('\n== 7. 插件灌入 Worker ==')
await sleep(8000)
const pluginState = await evaluate(`(async () => {
  if (!window.LXP) return { err: '没有 LXP' }
  const s = LXP.summary()
  const pool = window.LXApp && window.LXApp.pool ? window.LXApp.pool.summary() : []
  return {
    total: s.length,
    ready: s.filter(p => p.ready).length,
    names: s.filter(p => p.ready).map(p => p.name).slice(0, 8),
    // 没就绪的连同原因一起带出来：多数是源站不可达（本机出口问题），
    // 但若不列出来，就看不出「插件根本没装上」和「装机了但连不上源站」的区别。
    notReady: s.filter(p => !p.ready).map(p => ({ name: p.name, id: p.id, error: p.error || p.reason || '' })),
    poolReady: pool.filter(p => p.ok).length,
  }
})()`, true)
check('插件已灌入 Worker', pluginState.total > 0, `共 ${pluginState.total}，就绪 ${pluginState.ready}${pluginState.names && pluginState.names.length ? ' · ' + pluginState.names.join('/') : ''}`)
if (pluginState.notReady && pluginState.notReady.length) {
  console.log(`  · 未就绪 ${pluginState.notReady.length} 个：`)
  for (const p of pluginState.notReady) console.log(`      ${p.name} [${p.id}] — ${String(p.error).slice(0, 110)}`)
}
check('插件池适配器能读到状态', pluginState.poolReady > 0, `pool ready=${pluginState.poolReady}`)

console.log('\n== 8. 远程模式（手机端服务器地址可配置） ==')

// —— 8a. 地址归一 ——
// 用户写地址的形态很随意，归一错了会变成「测试连接能过、保存后连不上」这种最难查的故障。
const normOut = await evaluate(`(() => {
  const f = window.LXApp && window.LXApp.normalizeServer
  if (typeof f !== 'function') return { err: 'LXApp.normalizeServer 不存在' }
  const cases = ['192.168.1.9:8080', 'localhost:8787', 'music.abc.com', 'https://a.com/api/',
                 'http://a.com//', '  10.0.0.2/api  ', 'nas', '']
  return { out: cases.map(c => [c, f(c)]) }
})()`)
if (normOut.err) {
  check('LXApp.normalizeServer 可用', false, normOut.err)
} else {
  const got = Object.fromEntries(normOut.out)
  const want = {
    '192.168.1.9:8080': 'http://192.168.1.9:8080',   // IP → http（内网一般没证书）
    'localhost:8787': 'http://localhost:8787',       // localhost 同理
    'music.abc.com': 'https://music.abc.com',        // 域名 → https
    'https://a.com/api/': 'https://a.com',           // 顺手吃掉多写的 /api 与尾斜杠
    'http://a.com//': 'http://a.com',
    '  10.0.0.2/api  ': 'http://10.0.0.2',           // 空白字符不该出现在基址里
    'nas': 'http://nas',                             // 单段名 = 内网主机名
    '': '',
  }
  const bad = Object.keys(want).filter(k => got[k] !== want[k])
  check('地址归一（8 种写法）', bad.length === 0,
    bad.length ? bad.map(k => `${JSON.stringify(k)} → ${JSON.stringify(got[k])}（应为 ${JSON.stringify(want[k])}）`).join('；')
      : normOut.out.map(([a, b]) => `${a || '(空)'}→${b}`).join('  '))
}

// —— 8b. 连通性自检的三种失败形态 ——
// 这一组是「填错地址时用户能看懂」的前提：空地址、指到一个非本应用的站点、端口没人听。
const tEmpty = await evaluate('window.LXApp.testServer("")', true)
check('空地址被拦下', tEmpty && tEmpty.ok === false, tEmpty && tEmpty.error)

const tWrong = await evaluate(`window.LXApp.testServer(${JSON.stringify(BASE)})`, true)
check('指向非本应用站点时如实报错', tWrong && tWrong.ok === false && /不是本应用/.test(tWrong.error || ''),
  tWrong && (tWrong.error || JSON.stringify(tWrong)))

const tDead = await evaluate(`window.LXApp.testServer('http://127.0.0.1:1')`, true)
check('端口无人监听时如实报错', tDead && tDead.ok === false, tDead && tDead.error)

const tStub = await evaluate(`window.LXApp.testServer(${JSON.stringify(REMOTE_BASE)})`, true)
check('连通自检能读到对端状态', !!(tStub && tStub.ok && tStub.needsSetup === true),
  tStub && (tStub.ok ? `${tStub.base} · ${tStub.ms}ms · version=${tStub.version}` : tStub.error))

// —— 8c. 真的切过去 ——
const usersBefore = JSON.parse(dbQuery('SELECT username FROM users ORDER BY username', []))
const hitsBefore = remoteHits.filter(p => p === '/api/setup-status').length

await evaluate(`window.LXApp.applyServer(${JSON.stringify(REMOTE_BASE + '/api/')}, 'someone')`)
check('切服务器会整页重载（不做热切换）', await nextLoad())
await waitFor('!!document.querySelector("[data-act=\'open-server\']")', 12000)

const remoteState = await evaluate(`({
  remote: window.LX_REMOTE === true,
  isRemote: !!(window.LXApp && window.LXApp.isRemote),
  base: (window.LXApp && window.LXApp.serverBase) || '',
  user: (window.LXApp && window.LXApp.serverUser) || '',
  stored: (function () { try { return JSON.parse(localStorage.getItem('lx.serverBase') || '""') } catch (e) { return null } })(),
  storedUser: (function () { try { return JSON.parse(localStorage.getItem('lx.serverUser') || '""') } catch (e) { return null } })(),
  hash: location.hash,
  setupEntry: !!document.querySelector("[data-act='open-server']"),
  presetUser: (document.querySelector('#setupUser') || {}).value || null,
  token: !!(window.API && API.getToken()),
  plugins: (window.LX_PLUGIN_DATA || []).length,
})`)
check('LX_REMOTE 已置位', remoteState.remote === true, 'base=' + remoteState.base)
check('地址按归一结果落盘', remoteState.base === REMOTE_BASE && remoteState.stored === REMOTE_BASE,
  `base=${remoteState.base} stored=${remoteState.stored}`)
check('登录用户名已随地址一起落盘', remoteState.user === 'someone' && remoteState.storedUser === 'someone',
  `user=${JSON.stringify(remoteState.user)} stored=${JSON.stringify(remoteState.storedUser)}`)
// 配了用户名就该在「创建管理员」页预填 —— 不然用户还得自己想一遍叫什么
check('配置的用户名在初始化页预填', remoteState.presetUser === 'someone',
  `setupUser=${JSON.stringify(remoteState.presetUser)}`)
check('换服务器后旧 token 被清掉', remoteState.token === false)

const hitsAfter = remoteHits.filter(p => p === '/api/setup-status').length
check('/api/* 确实改道到了配置的服务器', hitsAfter > hitsBefore,
  `桩收到 /api/setup-status ${hitsAfter} 次`)

// 这条是本组最关键的一条：远程模式下**不能**再跑本机开户。
// 否则「服务器上还没账号」会被一个本机 local 账号悄悄盖掉，用户按本机那套操作、
// 数据全进了手机，界面看起来一切正常。
const usersAfterRemote = JSON.parse(dbQuery('SELECT username FROM users ORDER BY username', []))
check('远程模式下不再本机开户', JSON.stringify(usersAfterRemote) === JSON.stringify(usersBefore),
  `${JSON.stringify(usersBefore)} → ${JSON.stringify(usersAfterRemote)}`)

// 桩报 needsSetup=true，所以壳应当停在「创建管理员」页，而不是本机模式那样直接进首页
check('按服务器状态引导（未初始化 → 创建管理员页）', /setup/.test(remoteState.hash),
  'hash=' + (remoteState.hash || '(空)'))
check('登录/初始化页留有「服务器设置」退路', remoteState.setupEntry === true)

// —— 8d. 切回本机模式 ——
const hitsBeforeBack = remoteHits.length
await evaluate(`window.LXApp.applyServer('')`)
check('切回本机模式同样整页重载', await nextLoad())
const backOk = await waitFor(`!!(window.App && window.App.user && window.App.user.username)`, 20000)
const localState = await evaluate(`({
  remote: window.LX_REMOTE === true,
  isRemote: !!(window.LXApp && window.LXApp.isRemote),
  base: (window.LXApp && window.LXApp.serverBase) || '',
  user: (window.App && window.App.user && window.App.user.username) || null,
  preset: (window.LXApp && window.LXApp.serverUser) || '',
  token: !!(window.API && API.getToken()),
  hash: location.hash,
  setupForm: !!document.querySelector('#btnSetup'),
})`)
check('切回后 LX_REMOTE 复位', localState.remote === false && localState.isRemote === false,
  'base=' + JSON.stringify(localState.base))
// 回本机模式没有「用哪个账号登录」这回事，配的用户名得跟着清掉，
// 否则下次误以为本机模式也在用它
check('切回本机模式后预填用户名一并清掉', localState.preset === '', `serverUser=${JSON.stringify(localState.preset)}`)
check('切回后自动登录回本机账号', backOk && localState.user === 'local',
  `user=${localState.user} hash=${localState.hash}`)
// hash 是跟着 URL 活过重载的，不清掉就会把上一套后端的视图带过来：
// 远程那边停在 #/setup（那台服务器还没建管理员），切回本机后仍渲染「初始化」页，
// 而本机账号明明早就有了 —— 用户点「创建并进入」还会被服务端拒掉。
check('切回后不被上一套的视图劫持（不落在初始化页）',
  localState.hash !== '#/setup' && localState.setupForm === false,
  `hash=${JSON.stringify(localState.hash)} setupForm=${localState.setupForm}`)
check('切回后 /api/* 不再打扰远端', remoteHits.length === hitsBeforeBack,
  `桩新增请求 ${remoteHits.length - hitsBeforeBack} 次`)

console.log('\n== 9. 控制台健康度 ==')
// 分三级断言，避免把「第三方源站在本机出口不可达」误判成代码缺陷：
//   · 未捕获异常 —— 页面崩溃级，必须为 0；
//   · /proxy 之外的错误日志 —— 说明业务逻辑出错，必须为 0；
//   · /proxy 网络失败 —— 允许存在，但必须能对应到一条真实的出站失败记录
//     （即错误是被桥如实上报的，而不是凭空冒出来的）。
const uncaught = pageErrors.filter(e => e.startsWith('UNCAUGHT:'))
const consoleErrs = pageErrors.filter(e => !e.startsWith('UNCAUGHT:'))
const noise = e => /favicon|Failed to load resource.*404|ERR_/.test(e)
const proxyErr = e => /处理失败: \/proxy/.test(e)
const otherErrs = consoleErrs.filter(e => !proxyErr(e) && !noise(e))
const proxyErrs = consoleErrs.filter(proxyErr)

check('无未捕获异常（页面崩溃级）', uncaught.length === 0, uncaught.length ? uncaught.slice(0, 3).join(' | ') : '干净')
check('无 /proxy 之外的错误日志', otherErrs.length === 0, otherErrs.length ? otherErrs.slice(0, 3).join(' | ') : '干净')
check('/proxy 失败可归因到真实出站失败',
  proxyErrs.length === 0 || outboundFails.length > 0,
  proxyErrs.length === 0 ? '无失败' : `${proxyErrs.length} 条 / 出站失败 ${outboundFails.length} 次`)

if (outboundFails.length) {
  // 出站失败多为源站不可达（本机出口 vs 手机出口），不是代码问题；
  // 但必须把目标地址亮出来，否则无法区分「源站挂了」和「桥写错了」。
  const uniq = [...new Map(outboundFails.map(f => [f.url, f])).values()]
  console.log(`  · 出站失败 ${outboundFails.length} 次 / ${uniq.length} 个不同地址（源站侧，非代码）：`)
  for (const f of uniq.slice(0, 8)) console.log(`      ${f.err} ← ${f.url}`)
}

/* ================= 5. 收尾 ================= */

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  · ' + f)
}
if (process.env.SHOW_LOGS) {
  console.log('\n--- 页面日志 ---')
  for (const l of consoleLogs.slice(-60)) console.log(`[${l.type}] ${l.text}`)
}

try { ws.close() } catch { /* ignore */ }
try { chrome.kill() } catch { /* ignore */ }
server.close()
try { remoteSrv.close() } catch { /* ignore */ }
try { fs.rmSync(USER_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
