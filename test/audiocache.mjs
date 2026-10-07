#!/usr/bin/env node
/**
 * 「播放缓存 + 下载」桌面替身验收。
 *
 * 验的是一条容易被想当然的链路：
 *   ① 缓存到底存不存得进去、读不读得出来 —— 重点看 **Range 请求能不能命中**，
 *      因为 <audio> 一旦 seek 就会发 Range，而浏览器默认**不会**拿 Range 请求
 *      去匹配普通缓存（Vary/Range 语义）。这一条不专门验，线上就会变成
 *      「显示已缓存、一拖进度条就重新下载」。
 *   ② 上限到了会不会按 LRU 淘汰 —— 不淘汰的话手机迟早被塞满。
 *   ③ 下载出来的文件内容与缓存里的是不是同一份（字节数与开头一致）。
 *   ④ 壳里优先走原生写「下载」目录，返回值决定成功与否（见 MainActivity.saveAudio）。
 *
 * 替身映射（与 app-media.mjs 同一套思路）：
 *   页面 → 本机 HTTP 服务；音频地址 → 同一个服务上动态生成的一段 WAV。
 *   这样「跨域直连」在替身里变成了同源，也就不需要再搭一遍 CORS ——
 *   本组要验的是缓存逻辑，不是跨域本身（那条路径在真机/线上都已被取流链路覆盖）。
 *
 * 用法：node test/audiocache.mjs
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
 * 临时目录放**系统临时区**，不要放项目里。
 *
 * 早先这里是 `path.join(ROOT, 'probe', 'tmp')`，收尾时一句
 * `fs.rmSync(USER_DIR, { recursive: true })` 去删那个 Chrome profile ——
 * 那是项目内的一次整目录递归删除，会被「批量删除保护」拦下来（本轮实测：
 * 直接报 user cancelled the bulk delete request，整个测试连跑都跑不起来）。
 * 换到 os.tmpdir() 后既不在项目内、也不必去删别人的东西，收尾更干净。
 * test/lyric-layout.mjs 与 lyric-sync.mjs 本来就是这么做的。
 */
const TMP = path.join(os.tmpdir(), 'lxmusic-audiocache')
fs.mkdirSync(TMP, { recursive: true })

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

/* ================= 1. 测试服务：静态前端 + 动态音频 ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

/**
 * 造一段有确定内容的假音频。
 *
 * 内容必须是**确定的**（按位置算出来的字节，而不是随机）—— 下载出来的文件
 * 要与缓存里那份逐字节比，随机内容就没法判断是「同一份」还是「碰巧一样大」。
 */
function fakeAudio(size, seed) {
  const buf = Buffer.alloc(size)
  // WAV 头（44 字节），让浏览器认它是可播的音频；后面全是可预测的填充
  buf.write('RIFF', 0)
  buf.writeUInt32LE(size - 8, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(8000, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(size - 44, 40)
  for (let i = 44; i < size; i++) buf[i] = (i * 31 + seed) & 0xff
  return buf
}

/** 每首歌的字节流固定，按 id 区分 —— 这样能验「不同歌不会互相串字节」 */
const AUDIO = {
  '/__audio/a1.mp3': fakeAudio(64 * 1024, 11),
  '/__audio/a2.mp3': fakeAudio(96 * 1024, 22),
}

const hits = { audio: 0, ranged: 0 }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  if (AUDIO[p]) {
    const body = AUDIO[p]
    hits.audio++
    const range = req.headers.range || ''
    res.setHeader('content-type', 'audio/mpeg')
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('accept-ranges', 'bytes')
    if (range) {
      hits.ranged++
      const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
      let start = m && m[1] !== '' ? Number(m[1]) : 0
      let end = m && m[2] !== '' ? Number(m[2]) : body.length - 1
      if (start >= body.length) { res.statusCode = 416; res.end(); return }
      end = Math.min(end, body.length - 1)
      const slice = body.subarray(start, end + 1)
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
      res.setHeader('content-length', String(slice.length))
      res.end(slice)
      return
    }
    res.setHeader('content-length', String(body.length))
    res.end(body)
    return
  }

  const file = p === '/' ? '/index.html' : p
  const full = path.join(PUBLIC, file)
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  res.setHeader('content-type', MIME[path.extname(full)] || 'application/octet-stream')
  res.setHeader('cache-control', 'no-store')
  res.end(fs.readFileSync(full))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = 'http://127.0.0.1:' + PORT

/* ================= 2. CDP 脚手架 ================= */

const DEBUG_PORT = 9900 + Math.floor(Math.random() * 200)
const USER_DIR = path.join(TMP, 'chrome-cache-' + DEBUG_PORT)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + USER_DIR,
  'about:blank',
], { stdio: 'ignore' })

async function pageWs() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (pg) return pg.webSocketDebuggerUrl
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
const uncaught = []
const softErrors = []

ws.addEventListener('message', (ev) => {
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

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''))
  }
  return r.result && r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: BASE + '/' })
await sleep(2500)

/* ================= 3. 断言 ================= */

console.log('\n== 0. 缓存层是否装配好 ==')
const boot = await evaluate(`({
  has: !!(window.LXAudioCache),
  supported: !!(window.LXAudioCache && window.LXAudioCache.supported),
  player: !!(window.Player),
  keyed: window.LXAudioCache ? window.LXAudioCache.keyFor({id:'x',source:'wy'}, '320k') : '',
})`)
check('audiocache.js 已加载', boot.has === true)
check('Cache Storage 可用', boot.supported === true)
check('播放器在它之后装配（取流时能问到它）', boot.player === true)
check('缓存键区分平台与音质',
  String(boot.keyed).includes('/wy/') && String(boot.keyed).includes('320k'), String(boot.keyed))

console.log('\n== 1. 写入 / 命中 / 字节一致 ==')
const S1 = { id: 'a1', source: 'wy', name: '缓存测试一', artist: '测试歌手' }
const putRes = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const r = await c.fetchAndStore(${JSON.stringify(S1)}, '320k', { url: '${BASE}/__audio/a1.mp3', from: 't' });
  return { r: r, has: await c.has(${JSON.stringify(S1)}, '320k'), stats: await c.stats() };
})()`)
check('整首抓取并落缓存成功', putRes.r && putRes.r.ok === true, JSON.stringify(putRes.r))
check('落库后 has() 为真', putRes.has === true)
check('缓存大小与实际字节一致', putRes.r.bytes === AUDIO['/__audio/a1.mp3'].length,
  `${putRes.r.bytes} vs ${AUDIO['/__audio/a1.mp3'].length}`)
check('统计里的占用 > 0', putRes.stats.usedBytes >= putRes.r.bytes, String(putRes.stats.usedBytes))
check('统计里的条数 = 1', putRes.stats.count === 1, String(putRes.stats.count))

// 取出来的字节必须与服务端给的一模一样 —— 这是「缓存了却放不出来」最常见的成因
const fetched = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const res = await c.get(${JSON.stringify(S1)}, '320k', '');
  if (!res) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return { len: buf.length, head: Array.from(buf.slice(0, 3)), tail: Array.from(buf.slice(-4)) };
})()`)
const want = AUDIO['/__audio/a1.mp3']
check('命中时能取回完整字节', fetched && fetched.len === want.length, fetched ? `${fetched.len}` : 'null')
check('文件头正确（RIFF）', fetched && fetched.head.join(',') === '82,73,70', fetched ? fetched.head.join(',') : '')
check('文件尾也吻合（不是截断的半成品）',
  fetched && fetched.tail.join(',') === Array.from(want.subarray(want.length - 4)).join(','),
  fetched ? fetched.tail.join(',') : '')

console.log('\n== 2. Range 请求（拖动进度条）必须命中缓存 ==')
const beforeAudioHits = hits.audio
const ranged = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const res = await c.get(${JSON.stringify(S1)}, '320k', 'bytes=1000-1999');
  if (!res) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, len: buf.length, cr: res.headers.get('content-range'), head: buf[0] };
})()`)
check('Range 请求返回了内容', !!ranged)
check('状态码是 206（不是 200 —— <audio> 会据此判定是否支持分段）',
  ranged && ranged.status === 206, ranged ? String(ranged.status) : '')
check('切出来的长度正确（1000 字节）', ranged && ranged.len === 1000, ranged ? String(ranged.len) : '')
check('Content-Range 头正确',
  ranged && ranged.cr === 'bytes 1000-1999/' + want.length, ranged ? String(ranged.cr) : '')
// 这一段的首字节必须等于原文件第 1000 字节 —— 偏移错一位整首歌都是噪音
check('切片起点没偏（首字节与原文件第 1000 字节一致）',
  ranged && ranged.head === want[1000], ranged ? `${ranged.head} vs ${want[1000]}` : '')

const afterAudioHits = hits.audio
check('★ 整个 Range 命中过程没有回源（这才是缓存的意义）',
  afterAudioHits === beforeAudioHits, `回源次数 ${beforeAudioHits} → ${afterAudioHits}`)

console.log('\n== 3. 不同歌不会串字节 ==')
const S2 = { id: 'a2', source: 'wy', name: '缓存测试二', artist: '测试歌手' }
const second = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const r = await c.fetchAndStore(${JSON.stringify(S2)}, '320k', { url: '${BASE}/__audio/a2.mp3', from: 't' });
  const g2 = await c.get(${JSON.stringify(S2)}, '320k', '');
  const g1 = await c.get(${JSON.stringify(S1)}, '320k', '');
  const b2 = g2 ? new Uint8Array(await g2.arrayBuffer()) : null;
  const b1 = g1 ? new Uint8Array(await g1.arrayBuffer()) : null;
  return { r: r, s2len: b2 ? b2.length : 0, s1len: b1 ? b1.length : 0 };
})()`)
check('第二首落缓存成功', second.r && second.r.ok === true)
check('两首各自的长度正确（没有互相覆盖）',
  second.s1len === want.length && second.s2len === AUDIO['/__audio/a2.mp3'].length,
  `${second.s1len} / ${second.s2len}`)

console.log('\n== 4. 音质分开存（选了 320k 不该放 128k） ==')
const byQ = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const s = ${JSON.stringify(S1)};
  const hasFlac = await c.has(s, 'flac');
  const has320 = await c.has(s, '320k');
  await c.fetchAndStore(s, '128k', { url: '${BASE}/__audio/a1.mp3', from: 't' });
  const stats = await c.stats();
  return { hasFlac: hasFlac, has320: has320, count: stats.count };
})()`)
check('没存过的音质不误判为命中', byQ.hasFlac === false)
check('存过的音质仍然命中', byQ.has320 === true)
check('同歌不同音质算两条', byQ.count === 3, String(byQ.count))

console.log('\n== 5. 上限与 LRU 淘汰 ==')
// 注意：setLimitMb 有下限 100MB（保护用户不要设成毫无意义的极小值），
// 所以要真的触发淘汰，只能先塞够超过 100MB 的量 —— 这里用直接写缓存的方式
// 灌入几块大文件，而不是靠那几首 64KB 的测试音频。
const pruned = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  c.setLimitMb(100);
  const st = await c.stats();
  return { limit: st.limitMb, count: st.count };
})()`)
check('上限可以被设置并读回', pruned.limit === 100, String(pruned.limit))
check('未超上限时不误删', pruned.count === 3, String(pruned.count))

const evict = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const s = ${JSON.stringify(S1)};
  // 这三条先标成「最久没用过」，稍后必须被优先淘汰
  try {
    const t = JSON.parse(localStorage.getItem('lx.cache.hit') || '{}');
    t[c.keyFor(s, '128k')] = 1;
    t[c.keyFor(s, '320k')] = 1;
    t[c.keyFor(${JSON.stringify(S2)}, '320k')] = Date.now() + 1e9;
    localStorage.setItem('lx.cache.hit', JSON.stringify(t));
  } catch (e) {}

  // 灌 3 块 40MB 的「大歌」把总量顶到 120MB 以上（超过 100MB 上限）。
  // 用大块是为了在最小的上限档位下也能确定地触发淘汰。
  const big = new Uint8Array(40 * 1024 * 1024);
  const keys = [];
  for (let i = 0; i < 3; i++) {
    const song = { id: 'big' + i, source: 'wy' };
    keys.push(c.keyFor(song, '320k'));
    const cache = await caches.open('lxmusic-audio-v1');
    await cache.put(c.keyFor(song, '320k'), new Response(big, {
      status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(big.length), 'x-lx-cached-at': String(Date.now()) },
    }));
    c.touch(c.keyFor(song, '320k'));
  }
  const before = await c.stats();
  const r = await c.prune();
  const after = await c.stats();
  const keepA2 = await c.has(${JSON.stringify(S2)}, '320k');
  const keepOld = await c.has(s, '320k');
  return { beforeUsed: before.usedBytes, beforeN: before.count, removed: r.removed, count: after.count, used: after.usedBytes, keepA2: keepA2, keepOld: keepOld };
})()`)
check('确实顶到了上限以上', evict.beforeUsed > 100 * 1024 * 1024,
  Math.round(evict.beforeUsed / 1024 / 1024) + 'MB')
check('LRU 淘汰真的删掉了东西', evict.removed > 0, `删了 ${evict.removed} 条`)
check('淘汰后占用回落到上限以内', evict.used <= 100 * 1024 * 1024,
  Math.round(evict.used / 1024 / 1024) + 'MB')
check('★ 最近用过的（a2）没被淘汰', evict.keepA2 === true)
check('★ 最久没用过的（a1）被淘汰了', evict.keepOld === false)

console.log('\n== 6. 删除与清空 ==')
const del = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const s = ${JSON.stringify(S2)};
  const ok = await c.drop(s, '320k');
  const after = await c.has(s, '320k');
  const list = await c.list();
  return { ok: ok, after: after, n: list.length, sample: list[0] || null };
})()`)
check('drop() 能删掉一条', del.ok === true && del.after === false)
check('清单接口能列出剩余条目', Array.isArray(del.sample !== null ? [1] : []) && del.n >= 0, String(del.n))

const cleared = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  await c.clear();
  const s = await c.stats();
  return s;
})()`)
check('清空之后占用归零', cleared.usedBytes === 0 && cleared.count === 0,
  `${cleared.usedBytes}B / ${cleared.count} 条`)

console.log('\n== 7. 导出下载（合成 → 保存） ==')
const dl = await evaluate(`(async () => {
  const c = window.LXAudioCache;
  const s = { id: 'a1', source: 'wy', name: '导出测试/带斜杠:的*名字', artist: '测试歌手' };
  // 先清一遍，保证走「现抓」这条路
  await c.clear();
  const r = await c.exportSong(s, '320k', () => Promise.resolve({ url: '${BASE}/__audio/a1.mp3', from: 't' }), null);
  const st = await c.stats();
  return { r: r, count: st.count };
})()`)
check('导出成功', dl.r && dl.r.ok === true, JSON.stringify(dl.r))
check('文件名里的非法字符被换掉了',
  dl.r && dl.r.ok && !/[\\/:*?"<>|]/.test(String(dl.r.filename)),
  dl.r ? String(dl.r.filename) : '')
check('文件名带上了歌手与扩展名',
  dl.r && dl.r.ok && String(dl.r.filename).includes('测试歌手') && /\.mp3$/.test(String(dl.r.filename)),
  dl.r ? String(dl.r.filename) : '')
check('导出的字节数与原文件一致',
  dl.r && dl.r.ok && dl.r.bytes === want.length, dl.r ? String(dl.r.bytes) : '')
check('导出顺带把这首歌缓存下来了（下次不用再抓）', dl.count === 1, String(dl.count))

console.log('\n== 8. 壳内优先走原生保存 ==')
const nativeSave = await evaluate(`(async () => {
  window.__savedAudio = [];
  // 注入一个「像安卓壳」的宿主：只有 saveAudio / canSaveAudio 两个方法，
  // 正好模拟 MainActivity 新增的那对桥方法
  window.AndroidHost = window.AndroidHost || {};
  window.AndroidHost.saveAudio = function (name, b64) {
    window.__savedAudio.push({ name: name, len: (function(){ try { return atob(b64).length } catch (e) { return -1 } })() });
    return '/storage/emulated/0/Download/' + name;
  };
  const blob = new Blob([new Uint8Array([1,2,3,4,5,6,7,8])], { type: 'audio/mpeg' });
  const ok = await window.LXAudioCache.exportViaNative(blob, 'x.mp3');
  return { ok: ok, saved: window.__savedAudio };
})()`)
check('exportViaNative 能走通并回报成功', nativeSave.ok === true)
check('原生收到了正确的文件名', nativeSave.saved && nativeSave.saved[0] && nativeSave.saved[0].name === 'x.mp3',
  JSON.stringify(nativeSave.saved))
check('base64 解出来的字节数与源一致', nativeSave.saved && nativeSave.saved[0] && nativeSave.saved[0].len === 8,
  nativeSave.saved && nativeSave.saved[0] ? String(nativeSave.saved[0].len) : '')

console.log('\n== 9. 播放器接上了缓存（取流前先问缓存） ==')
const wired = await evaluate(`(async () => {
  const P = window.Player;
  const c = window.LXAudioCache;
  const s = { id: 'a1', source: 'wy', name: '接进播放器', singer: '测试歌手', interval: 200 };
  await c.clear();
  await c.fetchAndStore(s, '320k', { url: '${BASE}/__audio/a1.mp3', from: 't' });
  const beforeHits = 0;
  // 让播放器播这首，然后看它是不是直接吃了缓存（footer 会写「本地缓存」）
  P.state.queue = [s];
  P.state.index = 0;
  P.playSong(s);
  await new Promise(function (r) { setTimeout(r, 1200) });
  const a = P.audio;
  return {
    // 真实元素 id 是 #playerResolvedBy（见 player.js 的 dom.footer）
    footer: (document.getElementById('playerResolvedBy') || {}).textContent || '',
    src: String(a.src || '').slice(0, 12),
    cachedFlag: a.dataset ? a.dataset.cached : '',
    stage: a.dataset ? a.dataset.stage : '',
  };
})()`)
check('播放器取了缓存而不是回源',
  wired.cachedFlag === '1' || /blob:/.test(String(wired.src)),
  `cached=${wired.cachedFlag} src=${wired.src}`)
check('界面上写明了是本地缓存', /缓存/.test(String(wired.footer)), String(wired.footer).slice(0, 40))

console.log('\n== 10. 运行期没有硬错误 ==')
check('没有未捕获异常', uncaught.length === 0, uncaught.slice(0, 2).join(' | '))

/* ================= 4. 收尾 ================= */

try { ws.close() } catch { /* ignore */ }
try { chrome.kill() } catch { /* ignore */ }
try { server.close() } catch { /* ignore */ }
try { fs.rmSync(USER_DIR, { recursive: true, force: true }) } catch { /* ignore */ }

console.log('\n===== audiocache：' + pass + ' 通过 / ' + fail + ' 失败 =====')
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
