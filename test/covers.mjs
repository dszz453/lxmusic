/**
 * 封面体检：检查「发现页 / 排行榜」里每张卡片到底有没有图、图有没有真的加载出来。
 * 无依赖，用 Node 22 内置 WebSocket 直连 Chrome DevTools Protocol。
 *
 * 用法：
 *   LX_PASS='密码' node test/covers.mjs                     # 打线上
 *   LX_PASS='密码' LX_BASE=http://127.0.0.1:8787 node test/covers.mjs   # 打本地 wrangler dev
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LX_BASE || ''
const LOCAL = !!BASE
const HOST = LOCAL ? new URL(BASE).host : 'music.zyplnn.dpdns.org'
const IP = process.env.CF_IP || '2606:4700:3030::6815:ada'
const ORIGIN = BASE || `https://${HOST}`
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || ''
const OUT = path.resolve('shots')
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/* ---------- 取 token ---------- */
function loginOnce() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: USER, password: PASS })
    const lib = LOCAL ? http : https
    const opts = LOCAL
      ? { host: '127.0.0.1', port: Number(new URL(BASE).port || 80), path: '/api/login', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 60000 }
      : { host: IP, port: 443, servername: HOST, path: '/api/login', method: 'POST',
          headers: { Host: HOST, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          rejectUnauthorized: false, timeout: 60000 }
    const req = lib.request(opts, (res) => {
      const c = []
      res.on('data', d => c.push(d))
      res.on('end', () => {
        let out = { status: res.statusCode, token: '' }
        try { out.token = JSON.parse(Buffer.concat(c).toString('utf8')).token || '' } catch {}
        resolve(out)
      })
    })
    req.on('error', e => resolve({ status: 0, token: '', error: String(e.message) }))
    req.write(payload); req.end()
  })
}
async function apiLogin() {
  for (let i = 0; i < 6; i++) {
    const r = await loginOnce()
    if (r.token) return r.token
    if (r.status !== 0) break
    await sleep(1000 + i * 800)
  }
  return ''
}

/* ---------- Chrome ---------- */
const PORT = 9300 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxcov-'))
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  '--window-size=390,844', '--hide-scrollbars',
]
// 线上要手动把域名解到可用边缘 IP（本机 DNS 到 CF 不稳）；本地直连 127.0.0.1
if (!LOCAL) chromeArgs.push(`--host-resolver-rules=MAP ${HOST} ${IP}`)
chromeArgs.push('about:blank')
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' })

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch { /* 未就绪 */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

const ws = new WebSocket(await findTarget())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const consoleErrors = []
const imgFailed = []

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value || a.description || a.type).join(' ').slice(0, 240))
  }
  if (m.method === 'Network.loadingFailed') {
    const t = m.params.type
    if (t === 'Image') imgFailed.push(`${m.params.errorText} blocked=${m.params.blockedReason || '-'}`)
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

async function shot(name, full = true) {
  // 长页面（63 个榜单 > 16000px）用 captureBeyondViewport 会被 Chrome 缩放/裁切，
  // 截图就不代表真实观感了。这种只截首屏，短页面才整页截。
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  console.log('   截图 →', path.join(OUT, name + '.png'))
}

/* 采集页面里所有卡片/歌曲的封面状态 */
const PROBE_CARDS = `(() => {
  const pick = (img) => img ? {
    src: img.getAttribute('src') || '',
    nat: img.naturalWidth || 0,
    done: img.complete,
    fb: img.dataset ? (img.dataset.fallbackUsed ? 'used' : (img.dataset.fallback ? 'has' : '-')) : '-',
    op: img.style.opacity || '',
  } : null
  const cards = Array.from(document.querySelectorAll('#view .grid3 .card')).map(c => ({
    title: (c.querySelector('.card__title') || {}).textContent || '?',
    sub: (c.querySelector('.card__sub') || {}).textContent || '',
    head: c.dataset.headDone || '',
    chart: c.dataset.chart || '',
    img: pick(c.querySelector('.card__cover img')),
  }))
  const songs = Array.from(document.querySelectorAll('#view .songlist .song')).slice(0, 6).map(c => ({
    title: (c.querySelector('.song__name') || {}).textContent || '?',
    img: pick(c.querySelector('.song__cover img')),
  }))
  return { cards, songs, grids: document.querySelectorAll('#view .grid3 .card').length }
})()`

/**
 * 等当前视图里的榜单卡片全部处理完（每批 8 个串行拉，63 个榜要 8 批）。
 * 判据是 [data-head-done] 数量追平 .card 数量 —— 拿不到封面的也会被标记，
 * 所以「拉完」不等于「全成功」，最终成败仍由 report 逐张核对。
 */
async function waitHeadSettle(maxMs = 90000) {
  const t0 = Date.now()
  let last = -1, stable = 0
  while (Date.now() - t0 < maxMs) {
    const s = await evaluate(`(() => {
      const cards = document.querySelectorAll('#view .grid3 .card')
      return { total: cards.length, done: document.querySelectorAll('#view .grid3 .card[data-head-done]').length }
    })()`)
    if (s.total > 0 && s.done >= s.total) return { ...s, ms: Date.now() - t0 }
    if (s.done === last && s.done > 0) { stable++; if (stable >= 6) return { ...s, ms: Date.now() - t0 } }  // 12s 没动静就放弃
    else stable = 0
    last = s.done
    await sleep(2000)
  }
  const s = await evaluate(`(() => {
    const cards = document.querySelectorAll('#view .grid3 .card')
    return { total: cards.length, done: document.querySelectorAll('#view .grid3 .card[data-head-done]').length }
  })()`)
  return { ...s, ms: Date.now() - t0, timeout: true }
}

const results = []
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond })
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''))
}

let totalUpgraded = 0
let totalCards = 0

function report(label, d) {
  console.log(`\n== ${label} ==  卡片 ${d.grids} 张`)
  let up = 0
  for (const c of d.cards) {
    totalCards++
    const isUp = !!c.head
    if (isUp) { up++; totalUpgraded++ }
    if (!c.img) { console.log(`   ✗ 无 img 节点  ${c.title}`); continue }
    const okImg = c.img.nat > 0
    console.log(`   ${okImg ? '✓' : '✗'} ${String(c.img.nat).padStart(5)}px ${isUp ? '[已换歌手图]' : '[官方设计图]'}  ${c.title}${c.sub ? '   ' + c.sub : ''}`)
    if (!okImg) console.log(`         src=${c.img.src.slice(0, 130)}`)
  }
  for (const s of d.songs) {
    if (!s.img) { console.log(`   ✗ 无图(歌曲)  ${s.title}`); continue }
    console.log(`   ${s.img.nat > 0 ? '✓' : '✗'} ${String(s.img.nat).padStart(5)}px  ${s.title}`)
  }
  return up
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const token = await apiLogin()
  console.log(`目标 ${ORIGIN}   token:`, token ? token.slice(0, 20) + '…' : '（登录失败）')
  if (!token) throw new Error('登录失败，无法体检')

  /* 首页 */
  await send('Page.navigate', { url: `${ORIGIN}/` })
  await sleep(3000)
  await evaluate(`API.setToken(${JSON.stringify(token)}); location.hash='#/'; __lx.reload(); true`)
  for (let i = 0; i < 30; i++) {
    const n = await evaluate(`document.querySelectorAll('#view .grid3 .card').length`)
    if (n > 0) break
    await sleep(700)
  }
  const homeSettled = await waitHeadSettle(30000)   // 首页 6 个榜 = 1 批
  const homeUp = report('发现页（首页）', await evaluate(PROBE_CARDS))
  ok('首页榜单卡片换成榜首歌手头像', homeUp >= Math.ceil(homeSettled.total * 0.95), `${homeUp}/${homeSettled.total} 张`)
  await shot('cov-01-home')

  /* 排行榜列表 */
  await evaluate(`location.hash='#/charts'; true`)
  for (let i = 0; i < 30; i++) {
    const n = await evaluate(`document.querySelectorAll('#view .grid3 .card').length`)
    if (n > 0) break
    await sleep(700)
  }
  // 63 个榜按 8 个一批串行拉，线上要 30~60s。固定 sleep 会让数字随网络抖动飘，
  // 改成「等到全部卡片都被处理过」再判定，超时上限 90s。
  const settled = await waitHeadSettle()
  console.log(`   （封面批次已拉完 ${settled.done}/${settled.total}，等待 ${(settled.ms / 1000).toFixed(1)}s）`)
  const chartUp = report('排行榜列表', await evaluate(PROBE_CARDS))
  const chartTotal = (await evaluate(`document.querySelectorAll('#view .grid3 .card').length`))
  ok('排行榜卡片换成榜首歌手头像', chartUp >= Math.ceil(chartTotal * 0.95), `${chartUp}/${chartTotal} 张`)
  await shot('cov-02-charts', false)

  /* 榜单详情（热歌榜） */
  await evaluate(`location.hash='#/chart?id=3778678&source=wy'; true`)
  await sleep(8000)
  const detail = await evaluate(`(() => {
    const img = document.querySelector('#view .block img')
    const notes = Array.from(document.querySelectorAll('#view .block .note')).map(e => e.textContent)
    return { name: (document.querySelector('#view .block div div') || {}).textContent || '',
      img: img ? { src: img.getAttribute('src'), nat: img.naturalWidth || 0 } : null,
      notes, rows: document.querySelectorAll('#view .songlist .song').length }
  })()`)
  console.log('\n== 榜单详情（热歌榜） ==')
  console.log('   标题:', detail.name, ' 曲目行:', detail.rows)
  console.log('   头图:', detail.img ? `${detail.img.nat}px  ${String(detail.img.src).slice(0, 120)}` : '无')
  for (const n of detail.notes) console.log('   说明:', n)
  ok('详情页头图加载成功', !!(detail.img && detail.img.nat > 0), detail.img ? detail.img.nat + 'px' : '无图')
  ok('详情页显示榜首歌手', detail.notes.some(n => n.indexOf('榜首') === 0),
    detail.notes.find(n => n.indexOf('榜首') === 0) || '（无）')
  await shot('cov-03-chart-detail')

  console.log('\n--- 图片加载失败记录 ---')
  console.log(imgFailed.length ? imgFailed.slice(0, 10).join('\n') : '（无）')
  console.log('\n--- 控制台错误 ---')
  console.log(consoleErrors.length ? consoleErrors.slice(0, 8).join('\n') : '（无）')

  const fail = results.filter(r => !r.pass).length
  console.log(`\n=== 汇总：换新 ${totalUpgraded}/${totalCards} 张卡片，断言 ${results.length - fail}/${results.length} 通过 ===`)
  process.exitCode = fail ? 1 : 0
} finally {
  try { ws.close() } catch {}
  chrome.kill()
}
