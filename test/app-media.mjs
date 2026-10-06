#!/usr/bin/env node
/**
 * 安卓壳「原生媒体会话」桌面替身验收。
 *
 * 验的是什么：
 *   装了原生媒体层之后，壳里那条链路是两端各说一半 —— 页面负责如实汇报
 *   「在放什么」，原生的 MediaSession 负责把它变成通知栏 / 锁屏 / 控制中心能认的东西，
 *   再把用户按的键送回页面。这个脚本就是把这两半都跑起来对一遍：
 *
 *     ① 页面 → 原生：播放状态变化有没有推到 AndroidHost.mediaReport，字段对不对
 *        （少一个 duration，通知栏就是一条没有长度的进度；封面给了相对路径，
 *          原生侧 new URL 会直接抛，通知里就是一块白板）
 *     ② 原生 → 页面：窗.____nativeMedia.onCommand（Java 侧真正会调的入口）
 *        能不能把 play / pause / seek / next / prev 落到播放器上
 *
 * 替身映射（与 app-native.mjs 同一套）：
 *   assets/www → 本机 HTTP 服务      AndroidHost → 注入的 JS 桩
 *   __lxFetch  → Node 转发真实请求    __lxDB     → node:sqlite
 *   而「原生媒体层」这一侧则用一个数组把上报收下来 —— 真机上它会变成
 *   MediaSession + Notification，这里我们只关心它收到的东西对不对。
 *
 * 用法：node --experimental-sqlite test/app-media.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const TMP = path.join(ROOT, 'probe', 'tmp')

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
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

/* ================= 1. 资源层 / 数据桥 / 一块测试音频 ================= */

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

function dbQuery(sql, args) {
  return JSON.stringify(db.prepare(sql).all(...(args || [])))
}
function dbExec(sql, args) {
  const st = db.prepare(sql)
  const head = sql.trim().toUpperCase()
  if (head.startsWith('INSERT') || head.startsWith('REPLACE')) {
    try { st.run(...(args || [])); return 1 } catch { return 0 }
  }
  if (head.startsWith('UPDATE') || head.startsWith('DELETE')) {
    return Number(st.run(...(args || [])).changes || 0)
  }
  st.run(...(args || []))
  return 1
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => { chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 5 秒 440Hz 单声道 WAV。测试要一个「真的能播」的源，才能产生 timeupdate 与 duration */
function makeToneWav(seconds = 5, rate = 8000) {
  const n = seconds * rate
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // 单声道
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 4000), 44 + i * 2)
  }
  return buf
}
const TONE = makeToneWav()

/**
 * 带 Range 的响应。
 *
 * 这一步不能省：媒体元素要靠 Range 请求确认「这一段能不能跳」。
 * 服务端只会 200 整包、从不回 206 的话，Chrome 会认为该资源不可 seek ——
 * 于是 `currentTime = 3` 被静默忽略，测试里表现为「拖了进度条没反应」，
 * 而真机上的音频 CDN 都是支持 Range 的，症状根本不会出现。
 * 换句话说：不实现 Range，测的就不是客户端的行为。
 */
function serveBuffer(req, res, buf, mime) {
  const range = req.headers.range
  if (!range) {
    res.writeHead(200, {
      'content-type': mime, 'content-length': buf.length,
      'accept-ranges': 'bytes', 'cache-control': 'no-store',
    })
    res.end(buf)
    return
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range)
  let start = m && m[1] ? parseInt(m[1], 10) : 0
  let end = m && m[2] ? parseInt(m[2], 10) : buf.length - 1
  if (!Number.isFinite(start)) start = 0
  if (!Number.isFinite(end) || end >= buf.length) end = buf.length - 1
  if (start > end || start >= buf.length) {
    res.writeHead(416, { 'content-range': `bytes */${buf.length}` })
    res.end()
    return
  }
  res.writeHead(206, {
    'content-type': mime,
    'content-range': `bytes ${start}-${end}/${buf.length}`,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  })
  res.end(buf.subarray(start, end + 1))
}

/** 1×1 的 PNG，当作封面图床 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  // HTTP 桥：转发真实请求
  if (url.pathname === '/__bridge/http' && req.method === 'POST') {
    let out
    try {
      const spec = JSON.parse(await readBody(req))
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
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }

  if (url.pathname === '/__bridge/sql' && req.method === 'POST') {
    const { sql, args } = JSON.parse(await readBody(req))
    let out = '[]'
    try { out = dbQuery(sql, args) } catch { /* 表没建好时退回空集 */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(out)
    return
  }
  if (url.pathname === '/__bridge/exec' && req.method === 'POST') {
    const { sql, args } = JSON.parse(await readBody(req))
    let n = 0
    try { n = dbExec(sql, args) } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(String(n))
    return
  }

  // 测试素材
  if (url.pathname === '/__test/tone.wav') {
    serveBuffer(req, res, TONE, 'audio/wav')
    return
  }
  if (url.pathname === '/__test/cover.png') {
    serveBuffer(req, res, PNG, 'image/png')
    return
  }
  // 音源站一律假装不通：本组用例不验取流，验的是「状态变化有没有如实上报」
  if (url.pathname.startsWith('/api/stream')) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"error":"sandbox"}')
    return
  }

  // 静态资源（等价于 shouldInterceptRequest → assets）
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
const BASE = `http://127.0.0.1:${server.address().port}`
console.log(`资源服务: ${BASE}`)

/* ================= 2. 原生桥替身（比 app-native.mjs 多一个 mediaReport） ================= */

const BRIDGE_STUB = `
(function () {
  function syncPost(p, body) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', p, false);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.send(body);
    return xhr.status === 200 ? xhr.responseText : '';
  }
  // 真机上这里会变成 MediaBridge.report → MediaSession → 通知栏。
  // 替身只做一件事：把每一条上报原样存下来，供断言逐字段检查。
  window.__mediaReports = [];
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
    mediaReport: function (json) {
      try { window.__mediaReports.push(JSON.parse(json)) } catch (e) {}
    },
    // 真机形态：设置页的「系统播放控制」诊断卡会查这一份
    mediaStatus: function () {
      return JSON.stringify({
        ok: true, sdk: 34, brand: 'stub', android: '14',
        notifGranted: 3, notifEnabled: true, channel: 'low',
        native: {
          service: true, session: true, foreground: true, notifiedAgoMs: 800,
          reports: (window.__mediaReports || []).length, reportAgoMs: 700,
          lastCmd: 'next', cmdAgoMs: 1200,
          startError: '', coverError: '', hasTrack: true, playing: true,
          title: 'stub', coverOk: true, errors: [],
        },
      })
    },
    askNotificationPermission: function () { window.__askedNotif = true },
    openAppSettings: function () { window.__openedSettings = true },
  };
})();
`

/* ================= 3. CDP 脚手架 ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const DEBUG_PORT = 9700 + Math.floor(Math.random() * 200)
const USER_DIR = path.join(TMP, 'chrome-media-' + DEBUG_PORT)
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
/** 真正的未捕获异常：会打断脚本执行，脚本必须零容忍 */
const uncaught = []
/**
 * console.error：只作参考。
 * 后端的 outboundFetch 在拿不到上游时（沙箱出不了网）会 console.error 一条，
 * 那是环境噪音，不是这次的代码有问题 —— 把它算进失败会让这组用例永远红。
 */
const softErrors = []

ws.addEventListener('message', ev => {
  let m
  try { m = JSON.parse(ev.data) } catch { return }
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    softErrors.push((m.params.args || []).map(a => (a.value != null ? String(a.value) : (a.description || ''))).join(' '))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    uncaught.push((d.exception && d.exception.description) || d.text || 'unknown')
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

async function waitFor(expr, timeout = 15000, step = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true } catch { /* 导航中 */ }
    await sleep(step)
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_STUB })
await send('Page.navigate', { url: BASE + '/' })

/* ================= 4. 断言 ================= */

const SONGS = [
  { id: 't1', name: '夜航测试曲', singer: '测试歌手', albumName: '测试专辑', interval: 5, img: BASE + '/__test/cover.png' },
  { id: 't2', name: '第二首测试曲', singer: '另一位歌手', albumName: '测试专辑', interval: 180, img: BASE + '/__test/cover.png' },
  { id: 't3', name: '第三首测试曲', singer: '测试歌手', albumName: '测试专辑', interval: 200, img: BASE + '/__test/cover.png' },
]

console.log('\n== 1. 页面装载与媒体会话装配 ==')
await sleep(2500)
const boot = await evaluate(`({
  native: !!window.LX_NATIVE,
  app: !!window.App,
  player: !!window.Player,
  media: !!(window.__nativeMedia && typeof window.__nativeMedia.onCommand === 'function'),
  reports: (window.__mediaReports || []).length,
})`)
check('壳环境已识别', boot.native === true)
check('播放器已就绪', boot.player === true)
check('原生媒体入口 __nativeMedia.onCommand 已暴露', boot.media === true)
// armed 机制：没播过就不该打扰系统，否则一进 App 就冒一张「暂停中」的媒体卡片
check('未开始播放时不产生任何上报', boot.reports === 0, `已上报 ${boot.reports} 条`)

console.log('\n== 2. 页面 → 原生：起播上报 ==')
/**
 * 不走 Player.playList —— 那会真的去取流（沙箱里音源站不可达），
 * 而本组要验的是「播放状态变了有没有如实上报」，与取流无关。
 * 直接把队列塞进播放器状态，再让 <audio> 播一段本地生成的音，链路就是真的。
 */
await evaluate(`(() => {
  const P = window.Player;
  P.state.queue = ${JSON.stringify(SONGS)};
  P.state.index = 0;
  P.state.mode = 'order';
  P.emit('song', P.current());
  P.emit('queue', P.state.queue);
  return true;
})()`)
await evaluate(`(() => {
  const a = window.Player.audio;
  a.loop = true;
  a.src = '/__test/tone.wav';
  return a.play().then(function () { return 'ok' }, function (e) { return String((e && e.message) || e) });
})()`)
await sleep(1400)

const first = await evaluate(`(function(){
  var r = window.__mediaReports || [];
  return r.length ? r[r.length - 1] : null;
})()`)
check('起播后有上报', !!first)
if (first) {
  check('track = true', first.track === true)
  check('曲名正确', first.title === '夜航测试曲', String(first.title))
  check('歌手正确', first.artist === '测试歌手', String(first.artist))
  check('专辑带上', first.album === '测试专辑', String(first.album))
  check('playing = true', first.playing === true)
  check('队列信息完整（第 1 首 / 共 3 首）', first.index === 0 && first.total === 3, `${first.index}/${first.total}`)
  check('时长已解析（毫秒）', first.duration > 4000 && first.duration < 6000, `${first.duration}ms`)
  check('进度在走', first.position > 0, `${first.position}ms`)
  // 封面必须是可以直接下载的绝对地址：原生侧拿它 new URL()，相对路径会当场抛
  check('封面是绝对地址', /^https?:\/\//.test(String(first.cover || '')), String(first.cover).slice(0, 60))
}

console.log('\n== 3. 上报节流：不能每次 timeupdate 都往桥上灌 ==')
await evaluate('window.__mediaReports.length = 0; true')
await sleep(2600)
const burst = await evaluate('(window.__mediaReports || []).length')
// 播放中 timeupdate 约 4Hz，节流后 1 秒最多 1 条多点，再加一条兜底心跳
check('2.6 秒内的上报条数合理（≤5）', burst <= 5, `${burst} 条`)

console.log('\n== 4. 原生 → 页面：播放键 ==')
await evaluate('window.__mediaReports.length = 0; true')
await evaluate(`window.__nativeMedia.onCommand('pause', 0)`)
await sleep(500)
const paused = await evaluate(`(function(){
  var r = window.__mediaReports || [];
  return { playing: !!(r.length && r[r.length-1].playing), audioPaused: window.Player.audio.paused };
})()`)
check('暂停命令让 <audio> 真的停了', paused.audioPaused === true)
check('暂停也被如实上报', paused.playing === false)

await evaluate(`window.__nativeMedia.onCommand('play', 0)`)
await sleep(700)
const resumed = await evaluate(`(function(){
  var r = window.__mediaReports || [];
  return { playing: !!(r.length && r[r.length-1].playing), audioPaused: window.Player.audio.paused };
})()`)
check('播放命令让 <audio> 恢复', resumed.audioPaused === false)
check('恢复播放被如实上报', resumed.playing === true)

console.log('\n== 5. 原生 → 页面：锁屏拖动进度 ==')
await evaluate('window.__mediaReports.length = 0; true')
// Java 侧 MediaSession.onSeekTo 给的是毫秒
await evaluate(`window.__nativeMedia.onCommand('seek', 3000)`)
await sleep(500)
const sought = await evaluate(`(function(){
  var a = window.Player.audio;
  var r = window.__mediaReports || [];
  return { cur: a.currentTime, reported: (r.length ? r[r.length-1].position : -1) };
})()`)
check('拖动进度落到 <audio>.currentTime（秒）', Math.abs(sought.cur - 3) < 0.6, `${sought.cur.toFixed(2)}s`)
check('新进度被回报给原生（毫秒）', Math.abs(sought.reported - sought.cur * 1000) < 900, `${sought.reported}ms`)

console.log('\n== 6. 原生 → 页面：上一首 / 下一首 ==')
/**
 * 这两个按钮会真的推进队列并触发一次取流。取流在沙箱里必然失败（音源站不可达），
 * 但本组要验的是「系统按键有没有打到 Player 的公开方法上」—— 绕过去就会出现
 * 「通知栏切的歌不计入播放历史」。所以这里换成探针，把调用与参数记下来。
 */
await evaluate(`(() => {
  const P = window.Player;
  window.__spy = {};
  ['next','prev'].forEach(function (k) {
    window.__spy[k] = [];
    P[k] = function (a) { window.__spy[k].push(a); };
  });
  return true;
})()`)

await evaluate(`window.__nativeMedia.onCommand('next', 0)`)
await evaluate(`window.__nativeMedia.onCommand('prev', 0)`)
const spy = await evaluate('window.__spy')
check('“下一首”调到了 Player.next', Array.isArray(spy.next) && spy.next.length === 1, JSON.stringify(spy.next))
check('“下一首”标记为手动（manual=true）', spy.next[0] === true, JSON.stringify(spy.next))
check('“上一首”调到了 Player.prev', Array.isArray(spy.prev) && spy.prev.length === 1, JSON.stringify(spy.prev))

console.log('\n== 7. 队列清空 → 通知该收摊了 ==')
await evaluate(`window.__nativeMedia.onCommand('pause', 0)`)
await sleep(400)
await evaluate('window.__mediaReports.length = 0; true')
await evaluate(`(() => {
  const P = window.Player;
  P.state.queue = [];
  P.state.index = -1;
  P.emit('song', null);
  P.emit('queue', []);
  return true;
})()`)
await sleep(500)
const emptied = await evaluate(`(function(){
  var r = window.__mediaReports || [];
  return r.length ? r[r.length-1] : null;
})()`)
check('清空后上报 track=false（原生的收摊依据）', !!emptied && emptied.track === false && emptied.playing === false,
  JSON.stringify(emptied && { track: emptied.track, playing: emptied.playing }))

console.log('\n== 8. 设置页的「系统播放控制」诊断卡 ==')
/**
 * 这一节是为了回答「真机上不生效时怎么定位」。
 *
 * 1.8 那次翻车（服务压根没被启动）暴露的问题不是某个函数写错，而是
 * **整条链路静默失效**：没有报错、没有异常，用户只说「控制不了」。
 * 所以设置页必须能把每一层摊开。这里验的就是那张卡真的渲染出来了、
 * 而且「测试上报」按钮真的能穿过 JS → 原生 的桥。
 */
await evaluate(`window.__lx && window.__lx.go('#/settings'); true`)
await sleep(900)
const card = await evaluate(`(function(){
  var b = document.getElementById('mediaBlock');
  return {
    exists: !!b,
    text: b ? b.textContent : '',
    rows: b ? b.querySelectorAll('div[style*="border-bottom"]').length : 0,
    pushBtn: !!(b && b.querySelector('[data-act="media-test-push"]')),
  };
})()`)
check('设置页渲染了诊断卡', card.exists === true)
check('诊断卡列出了逐层状态（≥8 行）', card.rows >= 8, `实际 ${card.rows} 行`)
check('诊断卡包含「系统播放控制」标题', /系统播放控制/.test(card.text))
check('诊断卡逐层字段齐全（服务/会话/前台/通知/权限）',
  ['播放服务', '媒体会话', '前台服务', '通知', '通知权限', '上报'].every(k => card.text.includes(k)))
check('诊断卡有「测试上报」按钮', card.pushBtn === true)

// 「测试上报」要真的穿过桥：点一下，替身收到的上报数必须增加
await evaluate(`window.__mediaReports.length = 0; true`)
const beforePush = await evaluate(`(window.__mediaReports || []).length`)
await evaluate(`(function(){
  var b = document.getElementById('mediaBlock');
  var btn = b && b.querySelector('[data-act="media-test-push"]');
  if (btn) btn.click();
  return true;
})()`)
await sleep(600)
const afterPush = await evaluate(`(window.__mediaReports || []).length`)
check('点「测试上报」真的产生了一条上报', afterPush > beforePush,
  `${beforePush} → ${afterPush}`)

// 诊断出口本身
const diag = await evaluate(`(function(){
  var d = (typeof window.__lxMediaDiag === 'function') ? window.__lxMediaDiag() : null;
  return d ? { js: !!d.js, host: !!(d.host && d.host.ok), service: d.host && d.host.native && d.host.native.service } : null;
})()`)
check('__lxMediaDiag 能取到页面侧与原生侧两份状态',
  !!diag && diag.js === true && diag.host === true && diag.service === true,
  JSON.stringify(diag))

// 可选：SHOT=名字 时，把当前页面按手机视口整体截一张（交付时给用户看效果）
if (process.env.SHOT) {
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    })
    // App 是「一屏固定壳 + 内部滚动容器」，captureBeyondViewport 抓不到滚出去的部分，
    // 得先把目标滚进视口；顺带等一拍，让上一步的 toast 散掉，别糊在卡片上
    await evaluate(`(function(){
      var b = document.getElementById('mediaBlock');
      if (b && b.scrollIntoView) b.scrollIntoView({ block: 'start' });
      return true;
    })()`)
    await sleep(2400)
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const outDir = path.join(ROOT, 'shots')
    fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, process.env.SHOT + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('   截图 →', file)
  } catch (e) {
    console.log('   截图失败：' + ((e && e.message) || e))
  }
}

console.log('\n== 9. 运行期没有硬错误 ==')
check('页面没有未捕获异常', uncaught.length === 0, uncaught.slice(0, 2).join(' | '))
if (softErrors.length) {
  // 出不了网导致的上游失败属于环境噪音，只提示不判失败
  console.log(`  · （参考）页面打了 ${softErrors.length} 条 console.error，首条：${softErrors[0].slice(0, 90)}`)
}

/* ================= 5. 收尾 ================= */

try { ws.close() } catch { /* ignore */ }
try { chrome.kill() } catch { /* ignore */ }
server.close()

console.log(`\n===== app-media：${pass} 通过 / ${fail} 失败 =====`)
if (fail) {
  console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
process.exit(0)
