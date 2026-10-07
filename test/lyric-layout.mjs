/**
 * 歌词「视觉定位」验收（本地 dev server + 真 Chrome，headless）
 *
 *   LX_BASE=http://127.0.0.1:8787 LX_PASS='密码' node test/lyric-layout.mjs
 *   可选：SRC=tx Q='晴天'
 *
 * 为什么和 test/lyric-sync.mjs 分开：
 *   那份验的是「换行**时刻**与时间戳是否一致」（时间轴对不对）；
 *   这一份验的是「高亮行**画在屏幕哪个位置**」（空间对不对）。
 *   两件事互相独立 —— 曾经时间轴完全正确、空间却整整偏掉 860px。
 *
 * 它守的是三个已经真实踩过的坑：
 *   ① 高亮行必须在歌词可视区**正中**。
 *      坑：`.lyric-scroll` 带 transform ⇒ 它成了后代的 offsetParent ⇒
 *      `active.offsetTop` 变成「相对歌词列表自己」的坐标，与「相对可视区」
 *      的坐标系混用，位移偏掉「列表高度的一半」。63 行时高亮行跑到可视区上方
 *      860px —— 屏幕上读到的永远比在唱的晚好几行，就是用户说的「对照不住」。
 *   ② 播放器**关了再打开**，第一帧就得在正确位置。
 *      坑：播放器隐藏时可视区高度为 0，歌词 rAF 循环照跑并一路按 0 算位移；
 *      再打开时行号没变，syncLyric 的「行没变就短路」让它永不重算。
 *   ③ **拖动进度条时歌词要跟着走**。
 *      坑：timeupdate 里有一道 `if (state.seeking) return`，而它正是平时唯一
 *      驱动歌词的东西 —— 拖动期间歌词完全冻结。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = process.env.LX_BASE || 'http://127.0.0.1:8787'
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const SONG = process.env.Q || '晴天'
const SOURCE = process.env.SRC || 'tx'
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

let token
try {
  const lr = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  token = (await lr.json()).token
} catch (e) {
  console.log('❌ 连不上 ' + BASE + '：' + e.message)
  process.exit(1)
}
if (!token) { console.log('❌ 登录失败（检查 LX_PASS）'); process.exit(1) }

const PORT = 9500 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxlylay-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    if (p) wsUrl = p.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { console.log('❌ Chrome 未就绪'); chrome.kill(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
  return r.result.value
}
function bail(msg) { console.log('\n' + msg); ws.close(); chrome.kill(); process.exit(1) }

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: BASE + '/' })
await sleep(1500)
await ev(`API.setToken(${JSON.stringify(token)}); true`)
await ev(`location.hash = '#/'; __lx.reload(); true`)
await sleep(2500)

await ev(`location.hash = '#/search?q=' + encodeURIComponent(${JSON.stringify(SONG)}) + '&source=' + ${JSON.stringify(SOURCE)}; true`)
await sleep(4500)
if (!(await ev(`document.querySelectorAll('#view .songlist .song').length`))) {
  bail(`❌ 搜索「${SONG}」(${SOURCE}) 无结果`)
}
await ev(`document.querySelector('#view .songlist .song').click(); true`)
await sleep(3500)
await ev(`document.querySelector('#miniplayer').click(); true`)
await sleep(700)
await ev(`document.querySelector('#playerStage').click(); true`)
await sleep(600)

const info = await ev(`({
  lines: (Player.state.lines || []).length,
  show: document.querySelector('#playerStage').classList.contains('show-lyric'),
})`)
if (info.lines < 5 || !info.show) bail('❌ 没有歌词行 / 歌词页没打开，无法测定位')
console.log(`★ 曲目「${SONG}」（${SOURCE}），歌词 ${info.lines} 行\n`)

/** 量「高亮行中心」与「歌词可视区中心」的偏差（px） */
const MEASURE = `(() => {
  const box = document.querySelector('#playerLyric');
  const act = document.querySelector('#lyricScroll .lyric-line.is-active');
  const br = box.getBoundingClientRect();
  const ar = act && act.getBoundingClientRect();
  return {
    boxH: Math.round(br.height),
    boxMid: Math.round(br.top + br.height / 2),
    actMid: ar ? Math.round(ar.top + ar.height / 2) : null,
    idx: act ? Number(act.dataset.i) : -1,
  };
})()`

/* ---------- ① 正中定位 ---------- */
console.log('== 1. 高亮行居中 ==')
// 挑一个「不在开头」的位置量，避免刚好赶上第一行/无高亮
await ev(`document.querySelector('#audio').currentTime = 40; true`)
await sleep(1500)
const m1 = await ev(MEASURE)
const dev1 = m1.actMid === null ? null : Math.abs(m1.actMid - m1.boxMid)
ok('高亮行落在歌词可视区正中（偏差 ≤ 6px）',
  dev1 !== null && dev1 <= 6,
  `可视区中心 ${m1.boxMid} / 高亮行中心 ${m1.actMid}（第 ${m1.idx} 行，偏 ${dev1}px）`)
// 曾经这里是 −860px：高亮行整行在可视区上方外面
ok('歌词列表不是「零位移」状态（证明确实算过位移）',
  (await ev(`document.querySelector('#lyricScroll').style.transform`)) !== 'translateY(0px)',
  await ev(`document.querySelector('#lyricScroll').style.transform`))

/* ---------- ② 关掉再打开要立刻归位 ---------- */
console.log('\n== 2. 播放器关→开，立刻归位 ==')
await ev(`Player.closePlayer(); true`)
await sleep(5000)                        // 让它在「高度为 0」的状态下跑一段
const hidden = await ev(`(() => {
  const b = document.querySelector('#playerLyric').getBoundingClientRect();
  return { h: Math.round(b.height), tf: document.querySelector('#lyricScroll').style.transform };
})()`)
ok('播放器关闭时歌词区高度为 0', hidden.h === 0, `h=${hidden.h}，tf=${hidden.tf}`)
const tfWhileHidden = hidden.tf

await ev(`document.querySelector('#miniplayer').click(); true`)
await sleep(1300)                        // 等入场动画走完
const m2 = await ev(MEASURE)
const dev2 = m2.actMid === null ? null : Math.abs(m2.actMid - m2.boxMid)
ok('重新打开后高亮行回到正中（偏差 ≤ 6px）',
  dev2 !== null && dev2 <= 6,
  `可视区中心 ${m2.boxMid} / 高亮行中心 ${m2.actMid}（偏 ${dev2}px）`)
ok('重新打开后位移被真正重算过（不是沿用隐藏时的值）',
  (await ev(`document.querySelector('#lyricScroll').style.transform`)) !== tfWhileHidden,
  `${tfWhileHidden} → ${await ev(`document.querySelector('#lyricScroll').style.transform`)}`)

/* ---------- ③ 拖动进度条，歌词跟着走 ---------- */
console.log('\n== 3. 拖动进度条时歌词跟随 ==')
/** 在页面里算出「当前时刻应有的高亮行」并和实际高亮行比对 */
const DRAG_CHECK = (ratio, pause) => `(() => {
  const a = document.querySelector('#audio');
  ${pause ? 'a.pause();' : ''}
  Player.state.seeking = true;
  Player.seekRatio(${ratio});
  Player.state.seeking = false;
  const act = document.querySelector('#lyricScroll .lyric-line.is-active');
  const i1 = act ? Number(act.dataset.i) : -1;
  const lines = Player.state.lines;
  const delay = Player.lyricDelay || 0;
  let want = -1;
  for (let n = 0; n < lines.length; n++) { if (lines[n].t <= a.currentTime - delay) want = n; else break }
  return { i1, want, t: +a.currentTime.toFixed(2), dur: +(a.duration || 0).toFixed(2) };
})()`

const d1 = await ev(DRAG_CHECK(0.85, false))
ok('播放中拖进度条 → 歌词跟上',
  d1.dur > 0 && d1.i1 === d1.want && d1.want > 3,
  `t=${d1.t}s 高亮 ${d1.i1} / 应为 ${d1.want}`)

const d2 = await ev(DRAG_CHECK(0.2, true))
ok('暂停中拖进度条 → 歌词跟上',
  d2.i1 === d2.want,
  `t=${d2.t}s 高亮 ${d2.i1} / 应为 ${d2.want}`)

const d3 = await ev(`(() => {
  const a = document.querySelector('#audio');
  a.pause();
  // 走真实拖动入口（seekRatioPreview），而不是公开的 seekRatio
  Player.state.seeking = true;
  const r = document.querySelector('#progressRange');
  const rect = r.getBoundingClientRect();
  r.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height / 2, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + rect.width * 0.6, bubbles: true }));
  Player.state.seeking = false;
  const act = document.querySelector('#lyricScroll .lyric-line.is-active');
  const i1 = act ? Number(act.dataset.i) : -1;
  const lines = Player.state.lines;
  let want = -1;
  for (let n = 0; n < lines.length; n++) { if (lines[n].t <= a.currentTime - (Player.lyricDelay || 0)) want = n; else break }
  return { i1, want, t: +a.currentTime.toFixed(2) };
})()`)
ok('真实拖动进度条（pointer 事件）→ 歌词跟上',
  d3.i1 === d3.want,
  `t=${d3.t}s 高亮 ${d3.i1} / 应为 ${d3.want}`)

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
ws.close()
chrome.kill()
process.exit(fail ? 1 : 0)
