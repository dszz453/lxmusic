/**
 * 播放链路验收（真实 Chrome + CDP）
 *
 * 本机沙箱 Chrome 出不了外网（--no-proxy-server），因此它**恰好模拟了
 * 「源站直连不通」的网络环境** —— 正好用来验证多候选降级链能不能兜住：
 *   直连候选 × N → 浏览器插件 → 服务端代理
 * 只要最终能出声且 footer 落到某一级，说明降级逻辑成立。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOST = 'music.zyplnn.dpdns.org'
const IP = process.env.CF_IP || '104.21.10.218'
const PASS = process.env.LX_PASS || ''
if (!PASS) console.warn('[warn] 未设置 LX_PASS，需要登录的接口会 401')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = path.join(process.cwd(), 'shots')
fs.mkdirSync(OUT, { recursive: true })

const PORT = 9500 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxplay-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--ignore-certificate-errors',
  `--host-resolver-rules=MAP ${HOST} ${IP}`,
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

const ws = new WebSocket(await findTarget())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const media = []
const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); return
  }
  if (m.method === 'Network.requestWillBeSent' && (m.params.type === 'Media' || /\.(mp3|m4a|flac)/i.test(m.params.request.url))) {
    media.push(`SEND ${m.params.type} ${m.params.request.url.slice(0, 120)}`)
  }
  if (m.method === 'Network.responseReceived' && /\.(mp3|m4a|flac)/i.test(m.params.response.url)) {
    media.push(`RESP ${m.params.response.status} ${m.params.response.mimeType} range=${m.params.response.headers['content-range'] || '-'} ${m.params.response.url.slice(0, 100)}`)
  }
  if (m.method === 'Network.loadingFailed') media.push(`FAIL ${m.params.type} ${m.params.errorText} blocked=${m.params.blockedReason || '-'}`)
  if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails?.text || '').slice(0, 200))
}

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) } }, 120000)
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}

const snap = () => ev(`(function(){
  var a = document.querySelector('#audio');
  return {
    footer: (document.querySelector('#playerResolvedBy')||{}).textContent || '',
    stage: a && a.dataset ? a.dataset.stage : '-',
    readyState: a ? a.readyState : -1,
    t: a ? +(a.currentTime||0).toFixed(2) : -1,
    dur: a ? +(a.duration||0).toFixed(1) : -1,
    paused: a ? a.paused : null,
    err: a && a.error ? a.error.code : 0,
    src: a && a.src ? a.src.slice(0, 110) : '',
    title: (document.querySelector('#playerTitle')||{}).textContent || ''
  }
})()`)

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.navigate', { url: 'https://' + HOST + '/' })
  await sleep(5000)

  const st = await ev(`JSON.stringify({url:location.href,title:document.title,len:document.body?document.body.innerHTML.length:-1,api:typeof API,player:typeof Player})`)
  console.log('页面状态:', st)

  // 登录
  const login = await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:${JSON.stringify(PASS)}})}).then(r=>r.json()).then(d=>{var t=d.token||(d.data&&d.data.token)||'';if(t){API.setToken(t);return 'token-ok'}return JSON.stringify(d).slice(0,120)})`)
  console.log('登录:', login)

  // 直接走内核：拿真实搜索结果喂给 Player.playList，绕过 UI 交互的不确定性
  const PREF = process.env.LX_SRC || 'kw'
  const picked = await ev(`(async function(){
    var t = API.getToken();
    var r = await fetch('/api/search?q=' + encodeURIComponent('告白气球') + '&limit=12', {headers:{Authorization:'Bearer '+t}});
    var d = await r.json();
    var list = d.list || [];
    var song = list.find(function(s){return s.source===${JSON.stringify(PREF)}}) || list[0];
    if (!song) return {err:'无搜索结果', got:list.length};
    Player.playList([song], 0);
    return {name:song.name, singer:song.singer, source:song.source, total:list.length};
  })()`)
  console.log('播放曲目:', JSON.stringify(picked))

  console.log('\n--- 播放状态时间线 ---')
  let lastKey = ''
  for (let i = 0; i < 45; i++) {
    await sleep(1000)
    const s = await snap()
    const key = `stage=${s.stage} rs=${s.readyState} paused=${s.paused} err=${s.err} | ${s.footer}`
    const line = `t=${String(i + 1).padStart(2)}s ${key} cur=${s.t} dur=${s.dur}`
    if (key !== lastKey) { console.log('  ' + line); lastKey = key }
    else if (i % 5 === 0) console.log('  ' + line)
    if (!s.paused && s.t > 3) { console.log('  ✅ 已稳定播放 >3s'); break }
    if (s.err && s.err !== 4) console.log('  (err=' + s.err + ')')
  }

  const fin = await snap()
  console.log('\n--- 最终 ---')
  console.log(JSON.stringify(fin, null, 2))
  console.log('\n--- 媒体请求 ---')
  for (const m of media.slice(-25)) console.log('  ' + m)
  console.log('\n--- 页面异常 ---', errs.length ? errs.slice(0, 5) : '无')

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'play-fallback.png'), Buffer.from(shot.data, 'base64'))
  console.log('\n截图 → shots/play-fallback.png')
} catch (e) {
  console.log('测试异常:', e.message)
} finally {
  try { chrome.kill() } catch {}
}
