/**
 * 浏览器端落雪插件运行时体检
 *
 * 要回答的问题：public/js/lxplugin.js + lxworker.js 这套「客户端插件取流」到底能不能用？
 * player.js 的降级链第一级是 'plugin'，如果插件压根没 ready，这一级就是无声跳过的。
 *
 * 用法：
 *   LX_PASS='密码' node test/lx-runtime-probe.mjs            # 打线上
 *   LX_BASE=http://127.0.0.1:8787 LX_PASS='密码' node ...    # 打本地
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HOST = 'music.zyplnn.dpdns.org'
const IP = process.env.CF_IP || '2606:4700:3030::6815:ada'
const BASE = process.env.LX_BASE || `https://${HOST}`
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)
const ORIGIN = BASE.replace(/\/$/, '')
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || ''
const lib = LOCAL ? http : https

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
function ok(name, pass, extra) {
  results.push(!!pass)
  console.log((pass ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''))
}

/* ---------- 登录取 token ---------- */
function loginOnce() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: USER, password: PASS })
    const req = lib.request(LOCAL
      ? { host: '127.0.0.1', port: Number(new URL(BASE).port || 80), path: '/api/login', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 30000 }
      : { host: IP, port: 443, servername: HOST, path: '/api/login', method: 'POST',
          headers: { Host: HOST, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          rejectUnauthorized: false, timeout: 60000 }, (res) => {
      const c = []
      res.on('data', d => c.push(d))
      res.on('end', () => {
        let token = ''
        try { token = JSON.parse(Buffer.concat(c).toString('utf8')).token || '' } catch {}
        resolve({ status: res.statusCode, token })
      })
    })
    req.on('error', (e) => resolve({ status: 0, token: '', error: e.message }))
    req.write(payload); req.end()
  })
}
async function apiLogin() {
  for (let i = 0; i < 6; i++) {
    const r = await loginOnce()
    if (r.token) return r.token
    if (r.status && r.status !== 0) return ''
    await sleep(1000 + i * 800)
  }
  return ''
}

/* ---------- 起 Chrome ---------- */
const PORT = 9300 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxrt-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  ...(LOCAL ? [] : [`--host-resolver-rules=MAP ${HOST} ${IP}`]),
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

// 必须连**页面级** target：/json/version 给的是浏览器级端点，它不认 Page.enable。
let ws
{
  const target = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
        if (p) return p.webSocketDebuggerUrl
      } catch { /* 未就绪 */ }
      await sleep(250)
    }
    return ''
  })()
  if (!target) { chrome.kill(); throw new Error('Chrome 调试端口未就绪') }
  ws = new WebSocket(target)
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const consoleErrors = []
const failedReqs = []

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value || a.description || a.type).join(' ').slice(0, 260))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {}
    consoleErrors.push('[异常] ' + ((d.exception && d.exception.description) || d.text || '').slice(0, 260))
  }
  if (m.method === 'Network.loadingFailed') {
    failedReqs.push(`${m.params.type} ${m.params.errorText} blocked=${m.params.blockedReason || '-'}`)
  }
}

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) } }, 90000)
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const token = await apiLogin()
  console.log('BASE =', ORIGIN, ' token =', token ? token.slice(0, 16) + '…' : '（登录失败）')
  if (!token) throw new Error('登录失败')

  await send('Page.navigate', { url: ORIGIN + '/' })
  await sleep(3500)
  await evaluate(`API.setToken(${JSON.stringify(token)}); true`)

  console.log('\n== 1. 静态依赖是否存在 ==')
  const deps = await evaluate(`(async () => {
    const urls = ['/js/lxworker.js', '/js/lib/crypto.js', '/js/lib/util.js']
    const out = {}
    for (const u of urls) {
      try { const r = await fetch(u, { method: 'HEAD' }); out[u] = r.status } catch (e) { out[u] = 'ERR ' + e.message }
    }
    return out
  })()`)
  for (const [u, s] of Object.entries(deps)) console.log(`   ${String(s).padStart(4)}  ${u}`)
  ok('lxworker.js 的依赖全部可达', deps['/js/lib/crypto.js'] === 200 && deps['/js/lib/util.js'] === 200,
    `crypto=${deps['/js/lib/crypto.js']} util=${deps['/js/lib/util.js']}`)

  console.log('\n== 2. Worker 能不能起来（直接建一个，听 error） ==')
  const wk = await evaluate(`new Promise((resolve) => {
    const w = new Worker('/js/lxworker.js', { type: 'module' })
    let done = false
    const fin = (r) => { if (!done) { done = true; resolve(r) } }
    w.onerror = (e) => fin({ ok: false, err: String(e.message || e.type || 'error') })
    w.onmessage = (e) => { if (e.data && e.data.type === 'ready') fin({ ok: true }) }
    setTimeout(() => fin({ ok: false, err: '3s 内既没 ready 也没 error' }), 3000)
  })`)
  console.log('   结果:', JSON.stringify(wk))
  ok('lxworker.js 能加载并 ready', wk && wk.ok, wk && wk.err)

  console.log('\n== 3. LXP 初始化后的插件状态 ==')
  const st = await evaluate(`(async () => {
    try { await LXP.init() } catch (e) { return { initError: String(e && e.message || e) } }
    return {
      count: LXP.plugins.length,
      summary: LXP.summary(),
      details: LXP.plugins.map(p => ({ name: p.name, enabled: p.enabled, url: String(p.url || '').slice(0, 60) })),
    }
  })()`)
  console.log('   ', JSON.stringify(st, null, 2).split('\n').join('\n    '))
  const enabled = (st.details || []).filter(p => p.enabled).length
  ok('至少导入了一个插件', (st.count || 0) > 0, `共 ${st.count || 0} 个，启用 ${enabled} 个`)

  console.log('\n== 4. 装一个插件进去，看它能不能变 ready（关键） ==')
  if ((st.count || 0) === 0) {
    console.log('   （库里没有插件，跳过 —— 页面上没有一个可用的插件源）')
  }
  const ready = await evaluate(`(() => {
    const s = LXP.summary()
    return s
  })()`)
  console.log('   summary:', JSON.stringify(ready))

  console.log('\n== 5. player.js 的 plugin 级取流实际返回什么 ==')
  const plug = await evaluate(`(async () => {
    if (!window.LXP) return { err: 'window.LXP 不存在' }
    const song = { source: 'wy', id: '186016', name: '晴天', singer: '周杰伦' }
    try {
      const r = await LXP.resolveMusicUrl(song, '320k')
      return { got: r ? (r.url || '').slice(0, 90) : null, from: r && r.from }
    } catch (e) { return { err: String(e && e.message || e) } }
  })()`)
  console.log('   结果:', JSON.stringify(plug))
  ok('客户端插件取流能返回 URL', !!(plug && plug.got), plug && (plug.got || plug.err))

  console.log('\n--- 控制台错误 ---')
  console.log(consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 10).join('\n') : '（无）')
  console.log('\n--- 失败请求（前 12 条）---')
  console.log(failedReqs.length ? [...new Set(failedReqs)].slice(0, 12).join('\n') : '（无）')

  const passed = results.filter(Boolean).length
  console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`)
} finally {
  try { ws.close() } catch {}
  chrome.kill()
}
