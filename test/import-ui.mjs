/**
 * 「导入歌单」页的浏览器端到端验收（本地 dev，headless Chrome + CDP）。
 *
 * 为什么单测/接口测不够，还要这一层：
 *   汽水这类歌单是**两段式**的 —— 服务端只回一份「歌名 + 歌手」，真正建歌单发生在前端
 *   逐首匹配之后。这一段全在浏览器里，接口测试看不见它。而且它最容易出的错不是报错，
 *   是「悄悄少了歌」或「建出一个空歌单」——只有走完整个页面流程才验得到。
 *
 * 用法：node test/import-ui.mjs
 *   LX_BASE=http://127.0.0.1:8787  （默认）
 *   LX_PASS=密码
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LX_BASE || 'http://127.0.0.1:8787'
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const OUT = path.resolve('shots')
fs.mkdirSync(OUT, { recursive: true })

// 实测有效的汽水歌单分享短链（2 首）；失效时换一条
const QISHUI_LIVE = process.env.QS_LIVE || 'https://qishui.douyin.com/s/ix9JA2oW'
const NETEASE_DEAD = 'https://163cn.tv/KYUDUJAZ'
const NETEASE_LIVE = 'https://music.163.com/#/playlist?id=3778678'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (name, cond, extra) => {
  results.push({ name, pass: !!cond })
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  → ' + extra : ''))
}

const loginRes = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const token = ((await loginRes.json()) || {}).token
if (!token) { console.error('登录失败，先启动 wrangler dev'); process.exit(1) }

const PORT = 9500 + Math.floor(Math.random() * 300)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lximport-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  '--window-size=430,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { console.error('Chrome 未就绪'); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const pageErrors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {}
    pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown')
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
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
async function waitFor(expr, { timeout = 40000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try { last = await evaluate(expr) } catch { last = null }
    if (last) return last
    await sleep(interval)
  }
  return last
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
const api = async (p, opts = {}) => {
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {})
  let body = opts.body
  if (body && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
  const res = await fetch(BASE + '/api' + p, { method: opts.method || 'GET', headers, body })
  return { status: res.status, data: await res.json().catch(() => null) }
}

/** 打开导入页并填链接（不点提交） */
async function openImport(url) {
  await evaluate(`location.hash = '#/import'; true`)
  await waitFor(`!!document.querySelector('#importUrl')`)
  await sleep(400)
  await evaluate(`(() => {
    const i = document.querySelector('#importUrl')
    i.value = ${JSON.stringify(url)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#importName').value = ''
    return true
  })()`)
}

async function clickImport() {
  await evaluate(`document.querySelector('#btnImport').click(); true`)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: BASE + '/' })
  await sleep(2500)
  await evaluate(`API.setToken(${JSON.stringify(token)}); location.reload(); true`)
  await sleep(3500)

  /* ---------- 1. 页面入口 ---------- */
  console.log('\n--- 1. 导入页入口')
  await evaluate(`location.hash = '#/import'; true`)
  await waitFor(`!!document.querySelector('#importUrl')`)
  const pageInfo = await evaluate(`(() => ({
    input: !!document.querySelector('#importUrl'),
    btn: (document.querySelector('#btnImport') || {}).textContent || '',
    tips: (document.querySelector('#view') || {}).textContent || '',
  }))()`)
  ok('导入页有链接输入框与按钮', pageInfo.input && /开始导入/.test(pageInfo.btn), pageInfo.btn)
  ok('说明里提到了汽水与分享链接会过期', /汽水/.test(pageInfo.tips) && /过期/.test(pageInfo.tips),
    '提示文案已带上汽水')
  await shot('I1-导入页')

  /* ---------- 2. 汽水：两段式导入（服务端出清单 + 前端逐首匹配） ---------- */
  console.log('\n--- 2. 汽水歌单：短链 → 逐首匹配 → 建歌单')
  await openImport(QISHUI_LIVE)
  await clickImport()

  // 等服务端把清单读回来（进度块出现）
  const reading = await waitFor(`/已读取/.test((document.querySelector('#importResult')||{}).textContent||'')`, { timeout: 45000 })
  ok('读到了汽水歌单并进入匹配阶段', !!reading)

  // 等匹配跑完（出现「查看歌单」或「没匹配到」）
  const done = await waitFor(`(() => {
    const t = (document.querySelector('#importResult')||{}).textContent||''
    if (/查看歌单/.test(t)) return 'ok'
    if (/没有一首能在现有音源里搜到/.test(t)) return 'none'
    return null
  })()`, { timeout: 90000 })
  ok('匹配流程跑完', done === 'ok', done === 'ok' ? '全部匹配成功' : '匹配阶段结束：' + done)

  const resultText = await evaluate(`(document.querySelector('#importResult')||{}).textContent||''`)
  const mCount = resultText.match(/已匹配\s*(\d+)\s*\/\s*(\d+)/)
  ok('结果里给出了「已匹配 X / Y」', !!mCount, mCount ? mCount[0] : resultText.slice(0, 120))
  if (mCount) {
    ok('匹配到的数量与歌单曲目数一致（没有悄悄少歌）', Number(mCount[1]) === Number(mCount[2]),
      mCount[1] + '/' + mCount[2])
    ok('匹配数量 > 0', Number(mCount[1]) > 0, mCount[1] + ' 首')
  }

  const plHref = await evaluate(`(() => {
    const a = [...document.querySelectorAll('#importResult a')].find(x => /playlist\\?id=/.test(x.getAttribute('href')||''))
    return a ? a.getAttribute('href') : ''
  })()`)
  ok('给出了「查看歌单」链接', !!plHref, plHref)
  await shot('I2-汽水导入结果')

  // 落库结果要是**可播的**曲目，不是空的
  const plId = decodeURIComponent((plHref.match(/id=([^&]+)/) || [])[1] || '')
  if (plId) {
    const pl = (await api('/playlist?id=' + plId)).data
    const songs = (pl && pl.playlist && pl.playlist.songs) || []
    ok('歌单已落库且曲目数正确', songs.length > 0, songs.length + ' 首')
    ok('落库的每首都有可播的平台与 id',
      songs.length > 0 && songs.every(s => s.source && s.id),
      JSON.stringify(songs[0] || {}).slice(0, 150))
    await evaluate(`location.hash = '#/playlist?id=' + encodeURIComponent(${JSON.stringify(plId)}); true`)
    await sleep(2500)
    const shown = await evaluate(`document.querySelectorAll('#view .songlist .song').length`)
    ok('打开歌单能看到曲目', shown > 0, shown + ' 首')
    await shot('I3-导入后的歌单')
    // 清理
    await api('/playlist?id=' + plId, { method: 'DELETE' })
  }

  /* ---------- 3. 汽水单曲链接要拒绝 ---------- */
  console.log('\n--- 3. 汽水单曲链接（不是歌单）')
  await openImport('https://qishui.douyin.com/s/iXxJcC99/')
  await clickImport()
  const trackMsg = await waitFor(`(() => {
    const t = (document.querySelector('#toast')||{}).textContent || ''
    return /不是歌单/.test(t) ? t : null
  })()`, { timeout: 45000 })
  ok('单曲链接给出「不是歌单」的提示而不是静默成功', !!trackMsg, String(trackMsg || '').slice(0, 80))

  /* ---------- 4. 失效短链要说清是过期 ---------- */
  console.log('\n--- 4. 失效分享短链')
  await openImport(NETEASE_DEAD)
  await clickImport()
  const deadMsg = await waitFor(`(() => {
    const t = (document.querySelector('#toast')||{}).textContent || ''
    return /过期/.test(t) ? t : null
  })()`, { timeout: 45000 })
  ok('失效短链提示「已过期」', !!deadMsg, String(deadMsg || '').slice(0, 90))
  const noBogus = await evaluate(`!document.querySelector('#importResult a[href*="playlist?id="]')`)
  ok('失效链接不会留下一个空歌单', noBogus)
  await shot('I4-失效链接提示')

  /* ---------- 5. 网易经典链接（一段式，直接可播） ---------- */
  console.log('\n--- 5. 网易云经典链接：一段式直接建歌单')
  await openImport(NETEASE_LIVE)
  await clickImport()
  const went = await waitFor(`location.hash.includes('/playlist?id=')`, { timeout: 60000 })
  ok('导入后直接跳进歌单详情', !!went, await evaluate('location.hash'))
  if (went) {
    await sleep(2000)
    const n = await evaluate(`document.querySelectorAll('#view .songlist .song').length`)
    ok('歌单里有曲目', n > 5, n + ' 首')
    const id = decodeURIComponent((String(await evaluate('location.hash')).match(/id=([^&]+)/) || [])[1] || '')
    if (id) await api('/playlist?id=' + id, { method: 'DELETE' })
    await sleep(500)
    const gone = await evaluate(`(async () => {
      const r = await fetch('/api/playlist?id=' + encodeURIComponent(${JSON.stringify(id)}), { headers: { Authorization: 'Bearer ' + API.getToken() } })
      return r.status
    })()`)
    ok('验收歌单已删除', gone === 404, 'status=' + gone)
  }

  ok('全程没有页面 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (e) {
  ok('脚本执行未中断', false, String(e && e.message || e))
} finally {
  try { chrome.kill() } catch { /* ignore */ }
}

const failed = results.filter(r => !r.pass)
console.log('\n===== ' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败 =====')
if (failed.length) console.log('失败项：\n - ' + failed.map(f => f.name).join('\n - '))
process.exit(failed.length ? 1 : 0)
