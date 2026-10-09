/**
 * 登录链路的真浏览器取证 —— 回答的是「登录之后到底发生了什么」。
 *
 * 为什么要单独做这一件（而不是继续读代码猜）：
 *
 * 老板 2026-10-09 报「Docker 版客户端**重新登录**之后，我的歌单是空白、加载要半天，
 * 这时候点『我的』发现未登录，大概 10 秒才能登录」。服务端接口实测都是毫秒级
 * （`/playlists` 3.9ms、`/me` 19.6ms），所以「慢」和「显示未登录」一定在客户端/前端这条链上。
 * 而这条链上恰好有三个各自都能独立造成症状的坏形状，必须用仪器分开量：
 *
 *   ① **一次登录会渲染好几遍首页** —— 浏览器里 `location.hash='#/'` 会派一次 hashchange
 *      → route()，`boot()` 里还有「首帧抢跑」的 route() 与结尾的 `await route()`。
 *      三遍渲染 = 三个 `/api/home`。而 `/api/home` 在冷缓存上要「抓榜单 + 跨 6 源搜 24 首」，
 *      服务端**没有单飞去重**（cachedHomeFallback 每次都真算）→ 一台刚起的自建实例被打三份，
 *      别的请求（`/api/playlists`、`/api/me`）跟着一起卡 —— 「歌单空白、加载半天」的观感。
 *
 *   ② **登录成功后的身份会被第二趟 `/api/me` 覆盖** —— `pageLogin` 已经把
 *      `App.user = res.user`（登录响应本身就是可信的），可紧接着 `boot()` 又去问一次
 *      `/api/me`；那一趟要是慢/失败，身份就被降级成「未确认」甚至 null →
 *      「我的」页 `esc(u.username || '未登录')` 显示未登录。
 *
 *   ③ **补确认成功之后不重画** —— `confirmIdentityLater()` 把身份修正回内存，但注释里
 *      明确写了「不重新路由」；于是身份已经对了，用户屏幕上那句「未登录」还挂着，
 *      要等他自己再点一下才消失 —— 正是「大概 10 秒才能登录」的形状。
 *
 * 用法：
 *   node tools/login-flow-probe.mjs                 # 正常链路：数请求、看渲染次数
 *   node tools/login-flow-probe.mjs --me-fail       # 让 /api/me 失败 3 次（模拟桥慢/断网）→ 看身份降级
 *   node tools/login-flow-probe.mjs --stale-device  # 令牌在、本机没记住用户名 + /api/me 失败 → 复现「显示未登录」
 *   node tools/login-flow-probe.mjs --port 8792
 *
 * 前置：本地跑着一个自建宿主（默认 8792），且账号已建好（probe / probe1234）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}
const LX = 'http://127.0.0.1:' + flag('port', '8792')
const CDP_PORT = Number(flag('cdpPort', '9333'))
const ME_FAIL = args.includes('--me-fail')
const STALE = args.includes('--stale-device')
const INTERCEPT_ME = ME_FAIL || STALE
const SETTLE_MS = Number(flag('settle', '16000'))
/**
 * 前几次 /api/me 当成「问不到」失败掉。
 *
 * 默认 2：等于「启动那一趟 + 补确认的第一发」都没够着。
 * 调到 3 以上就能验证补确认的**后几档**与「确认回来之后屏幕自愈」——
 * 这正是老板报的「大概 10 秒才能登录」那一段。
 */
const FAIL_FIRST = Number(flag('fail-first', '2'))

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.error('找不到 Chrome / Edge，无法取证')
  process.exit(2)
}

const profileDir = mkdtempSync(join(tmpdir(), 'lx-login-'))
const chrome = spawn(chromePath, [
  '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profileDir,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--mute-audio',
  // 后台页会被 Chrome 掐定时器（3s/6s 的退避补确认会测不出来），必须关掉
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // 直连：本机探测不该被系统代理拦一道（本机 127.0.0.1 走代理会 ERR_CONNECTION_REFUSED）
  '--no-proxy-server', '--proxy-bypass-list=*',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')
      if (res.ok) return
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口没起来')
}

/** 极简 CDP 客户端：send() 返回 Promise，事件走 on() */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const waiting = new Map()
    const listeners = []
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const id = ++seq
        return new Promise((res, rej) => {
          waiting.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params: params || {} }))
        })
      },
      on(fn) { listeners.push(fn) },
      close() { try { ws.close() } catch { /* ignore */ } },
    }))
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id) {
        const w = waiting.get(msg.id)
        if (!w) return
        waiting.delete(msg.id)
        if (msg.error) w.rej(new Error(msg.method + ': ' + msg.error.message))
        else w.res(msg.result)
        return
      }
      for (const fn of listeners) fn(msg)
    })
  })
}

const reqs = []          // { url, t, status }
const pageErrors = []
let t0 = 0
let meFails = 0

const cdp = await (async () => {
  await waitChrome()
  const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
  const target = list.find((t) => t.type === 'page') || list[0]
  return connect(target.webSocketDebuggerUrl)
})()

await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Network.enable')

cdp.on((msg) => {
  if (msg.method === 'Network.requestWillBeSent') {
    const u = msg.params.request.url
    if (u.indexOf('/api/') >= 0) reqs.push({ url: u.replace(LX, ''), t: Date.now() - t0 })
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(String(msg.params.exceptionDetails.text || ''))
  }
})

// /api/me 拦截：模拟客户端里「桥慢 / 断网」那一趟（前提 ②③ 的触发条件）
if (INTERCEPT_ME) {
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/me*', requestStage: 'Request' }],
  })
  cdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return
    const id = msg.params.requestId
    if (String(msg.params.request.url).indexOf('/api/me') < 0) {
      try { await cdp.send('Fetch.continueRequest', { requestId: id }) } catch { /* ignore */ }
      return
    }
    // 前 FAIL_FIRST 次当成「问不到」失败掉（超时/断网），之后放行
    meFails++
    try {
      if (meFails <= FAIL_FIRST) await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'ConnectionFailed' })
      else await cdp.send('Fetch.continueRequest', { requestId: id })
    } catch { /* ignore */ }
  })
}

const evalJs = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r && r.result ? r.result.value : undefined
}

const viewText = () => evalJs("(document.getElementById('view')||{innerText:''}).innerText.replace(/\\s+/g,' ').slice(0,90)")

console.log('▶ 模式：' + (STALE ? '令牌在、无 lastUser + /api/me 前 ' + FAIL_FIRST + ' 次失败（复现「显示未登录」）'
  : ME_FAIL ? '/api/me 前 ' + FAIL_FIRST + ' 次失败（模拟桥慢）' : '正常链路'))
console.log('▶ 目标：' + LX)

t0 = Date.now()
await cdp.send('Page.navigate', { url: LX + '/' })
await sleep(2500)

let midMine = null
let afterMine = null
let recoveredMine = null

if (STALE) {
  /**
   * 令牌有效、但设备上没有 `lx.lastUser` —— 客户端里这是很常见的一态：
   * 换档案 / 换服务器 / 从老版本升上来时，token 与用户名不是一起写的。
   * 此时 `boot()` 的 meRes.error 分支里 `who = lastUserName()` 为空 → `App.user = null`
   * → 「我的」页印出「未登录」。
   */
  const res = await fetch(LX + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'probe', password: 'probe1234' }),
  })
  const tok = await res.json()
  await evalJs('localStorage.setItem("lx.token", ' + JSON.stringify(JSON.stringify(tok.token)) + ')')
  await evalJs('localStorage.removeItem("lx.lastUser")')
  meFails = 0
  reqs.push({ url: '=== 重载（带令牌、无 lastUser、me 前两次失败）===', t: null })
  t0 = Date.now()
  await cdp.send('Page.reload')
  await sleep(1200)

  await evalJs("location.hash='#/mine'")
  await sleep(900)
  midMine = await viewText()                 // 期待：未登录

  await sleep(9000)                          // 等 3s/6s 两次补确认跑完
  recoveredMine = await viewText()           // 关键：屏幕上是否**自己**变对了
  afterMine = JSON.stringify(await evalJs(`(function(){
    var u = (window.App && window.App.user) || null
    return u ? { username: u.username, isAdmin: !!u.isAdmin, unconfirmed: !!u.unconfirmed } : null
  })()`))
} else {
  // —— 登录页：填表 + 点登录（走真实 UI 路径，不直接调 API）
  let loginSeen = await evalJs("!!document.getElementById('btnLogin')")
  for (let i = 0; i < 12 && !loginSeen; i++) {
    await sleep(1000)
    loginSeen = await evalJs("!!document.getElementById('btnLogin')")
  }
  if (!loginSeen) {
    const diag = await evalJs(`JSON.stringify({
      ready: document.readyState,
      hash: location.hash,
      hasApp: typeof window.App,
      hasAPI: typeof window.API,
      view: (document.getElementById('view')||{}).innerText || '',
      body: document.body.innerText.replace(/\\s+/g,' ').slice(0,200),
    })`)
    console.error('✗ 没有停在登录页 —— 现场：' + diag)
    console.error('  （请求记录：' + JSON.stringify(reqs.map(r => r.url)) + '）')
    cdp.close(); try { chrome.kill() } catch { /* ignore */ }
    process.exit(3)
  }
  reqs.push({ url: '=== 点登录 ===', t: null })

  await evalJs("document.getElementById('loginUser').value='probe'")
  await evalJs("document.getElementById('loginPwd').value='probe1234'")
  t0 = Date.now()
  await evalJs("document.getElementById('btnLogin').click()")
  await sleep(SETTLE_MS)
}

// —— 取现场：此刻「我的」会显示什么
const snapshot = await evalJs(`(function(){
  var u = (window.App && window.App.user) || null
  return {
    hash: location.hash,
    user: u ? { username: u.username, isAdmin: !!u.isAdmin, unconfirmed: !!u.unconfirmed } : null,
    offline: !!(window.App && window.App.offline),
    lastUser: (function(){ try { return JSON.parse(localStorage.getItem('lx.lastUser')||'""') } catch(e){ return null } })(),
    tokenLen: (function(){ try { return String(JSON.parse(localStorage.getItem('lx.token')||'""')||'').length } catch(e){ return -1 } })(),
  }
})()`)

let mineText = await viewText()
let libText = ''
if (STALE) {
  // 屏幕上那句「未登录」在 STALE 模式里就是 recoveredMine（刻意不导航，才看得出有没有自愈）
  mineText = recoveredMine
}
await evalJs("location.hash='#/library'")
await sleep(500)
libText = await viewText()

// —— 报告
const apiReqs = reqs.filter((r) => r.url.indexOf('/api/') === 0)
const byUrl = {}
for (const r of apiReqs) {
  const k = r.url.replace(/\?.*$/, '')
  byUrl[k] = (byUrl[k] || 0) + 1
}

console.log('\n── 载入这一轮的全部 /api 请求 ──')
for (const [u, n] of Object.entries(byUrl).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(n).padStart(2) + '×  ' + u + (n > 1 ? '   ⚠ 重复' : ''))
}
const meLine = apiReqs.filter((r) => r.url.indexOf('/api/me') >= 0)
  .map((r) => (r.t == null ? '?' : (r.t / 1000).toFixed(1) + 's')).join(' → ')
console.log('  /api/me 时间线：' + (meLine || '（无）'))
console.log('\n── 现场 ──')
console.log('  hash        : ' + snapshot.hash)
console.log('  App.user    : ' + JSON.stringify(snapshot.user))
console.log('  App.offline : ' + snapshot.offline)
console.log('  lx.lastUser : ' + JSON.stringify(snapshot.lastUser))
console.log('  token 长度  : ' + snapshot.tokenLen)
console.log('  我的页正文  : ' + JSON.stringify(mineText))
console.log('  歌单页正文  : ' + JSON.stringify(libText))
if (pageErrors.length) console.log('  页面异常    : ' + pageErrors.slice(0, 3).join(' | '))

const dupHome = byUrl['/api/home'] || 0
console.log('\n── 结论 ──')
console.log('  /api/home 次数 = ' + dupHome + (dupHome > 1 ? '（应只有 1 次）' : ' ✔'))
if (INTERCEPT_ME) console.log('  /api/me 被拦失败次数 = ' + meFails)
if (STALE) {
  console.log('  刚进「我的」      : ' + JSON.stringify(midMine) + (midMine && midMine.indexOf('未登录') >= 0 ? '   ⚠ 显示未登录' : ' ✔'))
  console.log('  等 7s 后（未导航）: ' + JSON.stringify(recoveredMine)
    + (recoveredMine && recoveredMine.indexOf('未登录') >= 0 ? '   ⚠ 屏幕没自愈（内存已修正但不重画）' : ' ✔'))
  console.log('  此刻内存身份      : ' + afterMine)
}

cdp.close()
try { chrome.kill() } catch { /* ignore */ }
await sleep(300)
try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(0)
