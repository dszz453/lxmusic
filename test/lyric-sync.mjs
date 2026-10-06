/**
 * 歌词同步验收（需要本地 dev server + 能拿到歌词）
 *
 *   LX_BASE=http://127.0.0.1:8787 LX_PASS='密码' node test/lyric-sync.mjs
 *   可选：SRC=kg|wy|kw|tx|kg Q='晴天' SECS=20
 *
 * 做三件事：
 *  1. 页内 rAF 高频采样 `{ audio.currentTime, 当前高亮行的 data-i }`，
 *     反推每次「换行」发生在哪个 currentTime → 得到真实提前量。
 *  2. 断言「提前量不为负」—— 这是 1.5 的核心修复点。
 *     旧代码写死了 `lines[n].t <= time + 0.15`，提前量恒为 −0.13s 左右，
 *     叠加蓝牙耳机 200~400ms 出声延迟后，看到的永远比听到的早。
 *  3. 断言校准控件（`−` / `+` / 点数值复位）方向正确、会持久化。
 *
 * 为什么不用固定 sleep 判高亮：rAF 的相位跟设备负载有关，
 * 只采样少数几个点会漏掉换行。这里全程采样、事后统计，结论与帧率无关。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = process.env.LX_BASE || 'http://127.0.0.1:8787'
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const SONG = process.env.Q || '晴天'
const SOURCE = process.env.SRC || 'wy'
const SECONDS = Number(process.env.SECS || 20)
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

/* --- 登录 --- */
let token
try {
  const lr = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  })
  token = (await lr.json()).token
} catch (e) {
  console.log('❌ 连不上 ' + BASE + '：' + e.message)
  console.log('   先起 dev server：npx wrangler dev --port 8787')
  process.exit(1)
}
if (!token) { console.log('❌ 登录失败（检查 LX_PASS）'); process.exit(1) }

/* --- Chrome --- */
const PORT = 9300 + Math.floor(Math.random() * 400)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxlyric-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Chrome 未就绪')
}

const ws = new WebSocket(await target())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
async function ev(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
  return r.result.value
}
function bail(msg) { console.log('\n' + msg); ws.close(); chrome.kill(); process.exit(1) }

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: BASE + '/' })
await sleep(1200)
await ev(`API.setToken(${JSON.stringify(token)}); true`)
await ev(`location.hash = '#/'; __lx.reload(); true`)
await sleep(2500)

/* --- 搜歌并播放 --- */
await ev(`location.hash = '#/search?q=' + encodeURIComponent(${JSON.stringify(SONG)}) + '&source=' + ${JSON.stringify(SOURCE)}; true`)
await sleep(4000)
const found = await ev(`document.querySelectorAll('#view .songlist .song').length`)
if (!found) bail(`❌ 搜索「${SONG}」(${SOURCE}) 没有结果，无法测同步`)

await ev(`document.querySelector('#view .songlist .song').click(); true`)
await sleep(3000)
await ev(`document.querySelector('#miniplayer').click(); true`)
await sleep(600)
await ev(`document.querySelector('#playerStage').click(); true`)
await sleep(400)

const info = await ev(`(() => {
  const a = document.querySelector('#audio');
  return { paused: a.paused, dur: a.duration, t: a.currentTime,
           lines: (Player.state.lines||[]).length,
           showLyric: document.querySelector('#playerStage').classList.contains('show-lyric'),
           nodes: document.querySelectorAll('#lyricScroll .lyric-line').length }
})()`)
if (!info.lines || info.nodes < 2) bail('❌ 页面里没有歌词行，无法测同步（歌词链路可能坏了）')

/* --- 回 0 秒，从第一句开始采样 --- */
await ev(`(() => { const a = document.querySelector('#audio'); a.currentTime = 0; return true })()`)
await sleep(500)

await ev(`(() => {
  const a = document.querySelector('#audio');
  const scroll = document.querySelector('#lyricScroll');
  window.__trace = [];
  const tick = () => {
    const active = scroll.querySelector('.lyric-line.is-active');
    window.__trace.push({ t: +a.currentTime.toFixed(3), idx: active ? Number(active.dataset.i) : -1 });
    window.__raf = requestAnimationFrame(tick);
  };
  window.__raf = requestAnimationFrame(tick);
  return true;
})()`)

console.log(`★ 采样 ${SECONDS}s（源 ${SOURCE}，曲目「${SONG}」，歌词 ${info.lines} 行）…\n`)
await sleep(SECONDS * 1000)

const out = await ev(`(() => {
  cancelAnimationFrame(window.__raf);
  const lines = Player.state.lines;
  const tr = window.__trace;
  const changes = [];
  let prev = null;
  for (const r of tr) { if (r.idx !== prev) { changes.push(r); prev = r.idx } }
  const delay = Player.lyricDelay || 0;
  let mismatch = 0;
  for (const r of tr) {
    let want = -1;
    for (let n = 0; n < lines.length; n++) { if (lines[n].t <= r.t - delay) want = n; else break }
    if (want !== r.idx) mismatch++;
  }
  return {
    samples: tr.length,
    delay,
    mismatch,
    changes: changes.map(c => ({ t: c.t, idx: c.idx, lineT: c.idx >= 0 ? lines[c.idx].t : null,
                                 lag: c.idx >= 0 ? +(c.t - lines[c.idx].t).toFixed(3) : null })),
    firstT: tr.length ? tr[0].t : null,
    lastT: tr.length ? tr[tr.length - 1].t : null,
  };
})()`)

console.log('===== 换行事件 =====')
console.log('  t(切)      idx   该行时间戳   提前量(t − 行 t)')
for (const c of out.changes) {
  console.log('  ' + String(c.t).padEnd(10) + String(c.idx).padEnd(7) + String(c.lineT).padEnd(13) +
    (c.lag === null ? '—（回到无高亮）' : c.lag.toFixed(3) + 's'))
}
// 只统计真实换行：排除 idx===0 —— 采样是在 t≈0.5s 才开始的，
// 那一刻「第 0 行已高亮」是采样起点造成的伪滞后，不是播放器的问题。
const lags = out.changes.filter(c => c.lag !== null && c.idx > 0).map(c => c.lag)
console.log('')

// ① 渲染层跟手：模型算出的应有下标 与 实际高亮 必须逐帧一致
ok('rAF 采样期间高亮与模型零偏差', out.mismatch === 0,
  `采样 ${out.samples} 点 / 不一致 ${out.mismatch}`)

// ② 不提前点亮：提前量不得为负（允许 −0.02s 的帧相位抖动）
if (!lags.length) {
  ok('采到至少一次换行事件', false, `区间 ${out.firstT}s→${out.lastT}s 内无换行，SECS 调大些`)
} else {
  const min = Math.min(...lags), max = Math.max(...lags)
  const avg = lags.reduce((a, b) => a + b, 0) / lags.length
  ok('换行不早于时间戳（没有提前点亮）', min >= -0.02,
    `提前量 ${min.toFixed(3)} ~ ${max.toFixed(3)}s，均值 ${avg.toFixed(3)}s，样本 ${lags.length}`)
  ok('换行不严重滞后（rAF 没有丢帧）', max <= 0.12, `最大滞后 ${max.toFixed(3)}s`)
}

/* --- 校准控件 --- */
console.log('\n===== 校准控件 =====')
const calUi = await ev(`(() => {
  const v = document.querySelector('#lyricCalVal');
  return { exists: !!v, text: v && v.textContent,
           btns: !!document.querySelector('#lyricCalMinus') && !!document.querySelector('#lyricCalPlus') }
})()`)
ok('歌词页有校准控件（−/+ 数值）', calUi.exists && calUi.btns, JSON.stringify(calUi))

/**
 * 校准的判定是 `at = t − lyricDelay`（见 player.js 的 syncLyric）。
 * 要验的就是这条换算本身，所以最直接的测法是**同一行在多大的 t 上被点亮**：
 * 偏移 +d 时，第 k 行的点亮时刻应当整体后移 d 秒。
 *
 * 这里曾经写成「固定取 t=10，看 +2s 后高亮行有没有换到下一行」—— 那是错的选点。
 * 晴天前奏约 22s，10s 处整段都落在第 1 行里，±2s 根本跨不过下一行，
 * 于是「高亮没变」被判成失败，而实现其实是对的。**行距属于曲目，不能当测试下限**：
 * 换一首行距更疏的歌，这条用例还会再红一次。
 */
const det = await ev(`(() => {
  const a = document.querySelector('#audio');
  try { a.pause() } catch {}
  const pick = () => {
    const el = document.querySelector('#lyricScroll .lyric-line.is-active');
    return el ? Number(el.dataset.i) : -1;
  };
  const STEP = 0.25;
  const LIMIT = 90;
  // 第 k 行第一次被点亮时的 t。扫描时音频是暂停的，歌词 rAF 循环不会来抢 DOM。
  function minT(k, delay) {
    Player.setLyricDelay(delay);
    for (let t = 0; t <= LIMIT; t += STEP) {
      Player.syncLyric(t);
      if (pick() === k) return t;
    }
    return null;
  }
  const K = 1;
  const base = minT(K, 0);
  const plus2 = minT(K, 2);
  const minus1 = minT(K, -1);
  Player.setLyricDelay(0);
  return { base, plus2, minus1 };
})()`)
console.log(`  第 1 行点亮时刻：偏移 0 → ${det.base}s；+2s → ${det.plus2}s；−1s → ${det.minus1}s`)
ok('偏移 +2s → 歌词整体延后 2s',
  det.base != null && det.plus2 != null && Math.abs((det.plus2 - det.base) - 2) <= 0.5,
  `${det.base}s → ${det.plus2}s（差 ${det.plus2 != null && det.base != null ? (det.plus2 - det.base).toFixed(2) : '?'}s）`)
ok('偏移 −1s → 歌词整体提前 1s',
  det.base != null && det.minus1 != null && Math.abs((det.base - det.minus1) - 1) <= 0.5,
  `${det.base}s → ${det.minus1}s（差 ${det.base != null && det.minus1 != null ? (det.minus1 - det.base).toFixed(2) : '?'}s）`)

// 持久化：步进由 LYRIC_DELAY_STEP 决定（当前 0.2s），这里不写死步长，
// 只验证「每次步进一致」+「落盘的值跟内存里的一致」。
await ev(`document.querySelector('#lyricCalVal').click(); true`)
await sleep(150)
await ev(`document.querySelector('#lyricCalPlus').click(); true`)
await sleep(150)
const one = await ev(`({ d: Player.lyricDelay, stored: localStorage.getItem('lx.lyricDelay') })`)
for (let i = 0; i < 4; i++) await ev(`document.querySelector('#lyricCalPlus').click(); true`)
await sleep(250)
const five = await ev(`({ d: Player.lyricDelay, stored: localStorage.getItem('lx.lyricDelay'), text: document.querySelector('#lyricCalVal').textContent })`)
ok('连点 + 线性递增（步进一致）', one.d > 0 && Math.abs(five.d - one.d * 5) < 1e-9,
  `1 次 → ${one.d}s，5 次 → ${five.d}s，显示「${five.text}」`)
ok('偏移落盘到 localStorage', five.stored === String(five.d), `stored=${five.stored} vs ${five.d}`)

await ev(`document.querySelector('#lyricCalVal').click(); true`)
await sleep(200)
const reset = await ev(`({ d: Player.lyricDelay, stored: localStorage.getItem('lx.lyricDelay') })`)
ok('点数值复位回 0', reset.d === 0, `Player.lyricDelay=${reset.d} stored=${reset.stored}`)

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
ws.close()
chrome.kill()
process.exit(fail ? 1 : 0)
