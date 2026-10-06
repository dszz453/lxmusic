/**
 * 客户端落雪插件取流 —— 端到端实测
 *
 * 背景：public/js/lxplugin.js + lxworker.js 这套「浏览器内跑落雪插件」的实现
 * 因为 lxworker.js 的两个 import 一直 404，从来没真正跑起来过。
 * 本脚本把插件源码从本地 plugins/ 目录注入页面，验证：
 *   1) Worker 能不能起来
 *   2) 插件能不能变成 ready
 *   3) lx.request（经 /api/proxy 中转）能不能拿到响应
 *   4) 最终能不能解析出一个可播放的 URL
 *
 * 用法：
 *   LX_PASS='密码' node test/lx-plugin-local.mjs                          # 打本地 8787
 *   LX_PASS='密码' LX_PLUGIN=plugins/pdone-flower.js node ...            # 指定插件
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LX_BASE || 'http://127.0.0.1:8787'
const ORIGIN = BASE.replace(/\/$/, '')
const PORT_N = Number(new URL(BASE).port || 80)
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || ''
const PLUGIN_FILE = process.env.LX_PLUGIN || 'plugins/pdone-flower.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
function ok(name, pass, extra) {
  results.push(!!pass)
  console.log((pass ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''))
}

function loginOnce() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: USER, password: PASS })
    const req = http.request({
      host: '127.0.0.1', port: PORT_N, path: '/api/login', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 20000,
    }, (res) => {
      const c = []
      res.on('data', d => c.push(d))
      res.on('end', () => {
        let token = ''
        try { token = JSON.parse(Buffer.concat(c).toString('utf8')).token || '' } catch {}
        resolve({ status: res.statusCode, token })
      })
    })
    req.on('error', e => resolve({ status: 0, token: '', error: e.message }))
    req.write(payload); req.end()
  })
}
async function apiLogin() {
  for (let i = 0; i < 6; i++) {
    const r = await loginOnce()
    if (r.token) return r.token
    await sleep(1200)
  }
  return ''
}

/* ---------- Chrome ---------- */
const PORT = 9300 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxpl-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

let ws
{
  const target = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
        if (p) return p.webSocketDebuggerUrl
      } catch {}
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

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value || a.description || a.type).join(' ').slice(0, 300))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {}
    consoleErrors.push('[异常] ' + ((d.exception && d.exception.description) || d.text || '').slice(0, 300))
  }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) } }, 120000)
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const script = fs.readFileSync(PLUGIN_FILE, 'utf8')
  console.log(`BASE = ${ORIGIN}   插件 = ${PLUGIN_FILE} (${script.length} 字节)`)
  const token = await apiLogin()
  console.log('token =', token ? token.slice(0, 16) + '…' : '（登录失败）')
  if (!token) throw new Error('登录失败')

  await send('Page.navigate', { url: ORIGIN + '/' })
  await sleep(3500)
  await evaluate(`API.setToken(${JSON.stringify(token)}); true`)

  console.log('\n== 1. 依赖文件是否可达 ==')
  const deps = await evaluate(`(async () => {
    const out = {}
    for (const u of ['/js/lxworker.js', '/js/lib/crypto.js', '/js/lib/util.js']) {
      try { out[u] = (await fetch(u, { method: 'HEAD' })).status } catch (e) { out[u] = 'ERR' }
    }
    return out
  })()`)
  for (const [u, s] of Object.entries(deps)) console.log(`   ${String(s).padStart(4)}  ${u}`)
  ok('lxworker 依赖全部 200', deps['/js/lib/crypto.js'] === 200 && deps['/js/lib/util.js'] === 200)

  console.log('\n== 2. 注入插件并等它 ready ==')
  const imp = await evaluate(`(async () => {
    try {
      await LXP.init()
      const r = await LXP.importFromText(${JSON.stringify(script)}, 'local://test')
      return { ok: true, name: r && (r.name || (r.meta && r.meta.name)), sources: Object.keys((r && r.sources) || {}) }
    } catch (e) { return { ok: false, err: String(e && e.message || e) } }
  })()`)
  console.log('   导入:', JSON.stringify(imp))
  ok('插件导入成功', imp && imp.ok, imp && (imp.name || imp.err))
  if (imp && imp.ok && imp.sources) console.log('   声明支持的平台:', imp.sources.join(', '))

  // 等 ready（Worker 模块加载 + 脚本执行 + inited）
  let ready = null
  for (let i = 0; i < 30; i++) {
    ready = await evaluate(`(() => {
      const inst = (LXP.summary() || [])
      return { summary: inst, plugins: LXP.plugins.map(p => ({ name: p.name, enabled: p.enabled })) }
    })()`)
    const anyReady = JSON.stringify(ready.summary).includes('"ready":true') || (await evaluate(`LXP.summary().some(s => s.ready === true)`))
    if (anyReady) break
    await sleep(500)
  }
  const detail = await evaluate(`LXP.summary()`)
  console.log('   summary:', JSON.stringify(detail))
  const isReady = Array.isArray(detail) && detail.some(s => s.ready)
  ok('Worker 起来且插件 ready', isReady,
    Array.isArray(detail) ? detail.map(s => `${s.name}:ready=${s.ready}${s.error ? ' err=' + s.error : ''}`).join(' | ') : '')

  console.log('\n== 3. 插件经 /api/proxy 发 HTTP（回投递链路）==')
  const relay = await evaluate(`(async () => {
    const inst = LXP.plugins.find(p => p.enabled)
    if (!inst) return { err: '没有启用的插件' }
    try {
      const url = await LXP.resolveMusicUrl({ source: 'wy', id: '186016', name: '晴天', singer: '周杰伦' }, '320k')
      // resolveMusicUrl 失败时返回的是 { url: null, errors: [...] }，必须把 errors 打出来，
      // 否则只知道「没拿到 URL」，分不清是插件返回空、请求失败还是调用超时。
      return {
        url: (url && typeof url.url === 'string' ? url.url : '').slice(0, 110),
        from: url && url.from,
        errors: (url && url.errors) || [],
      }
    } catch (e) { return { err: String(e && e.message || e) } }
  })()`)
  console.log('   结果:', JSON.stringify(relay, null, 2).split('\n').join('\n    '))
  ok('插件取流返回了 URL', !!(relay && relay.url && /^https?:\/\//.test(relay.url)), relay && (relay.url || relay.err))

  console.log('\n--- 控制台错误 ---')
  console.log(consoleErrors.length ? [...new Set(consoleErrors)].slice(0, 8).join('\n') : '（无）')

  const passed = results.filter(Boolean).length
  console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`)
} finally {
  try { ws.close() } catch {}
  chrome.kill()
}
