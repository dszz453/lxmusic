#!/usr/bin/env node
/**
 * 边缘缓存层（回源结果 + 播放直链）—— 行为 + 接线审计
 *
 * ── 为什么单独一份测试 ──────────────────────────────────────────────
 *
 * 2026-10-15 老板报「CF 版，歌单加载慢，建议增加缓存，包括播放插件的缓存，
 * 整体点开慢」。查下来是**这些东西一次都没被缓存过**：
 *
 *   · /api/chart   每次打开都回源打一次平台接口（1~3 秒）
 *   · /api/album   同上
 *   · /api/lyric   每首歌起播都问一次插件/平台
 *   · /api/suggest 歌单导入逐首匹配，N 首歌 = N 次搜索
 *   · 播放直链      同一首歌第二次点开仍把「插件池解析 + 逐个 Range 探测」重跑
 *
 * 缓存这种东西的 bug 有个共同形状：**不报错，也不生效**。
 * 函数写好了、测试里调用它对，可某个分支根本没走到它，线上一切照旧 ——
 * 日志干干净净，用户还在转圈。所以这里两层都要验：
 *
 *   1. **行为**：把 `cachedEdgeJson` 的**真身**从源码里抽出来跑（不是另写一套），
 *      验命中 / 过期 / SWR / 失败不写 / 同刻合并这五条边界。
 *   2. **接线**：四个接口与两个播放入口到底有没有真的读它、在哪个分支写它、
 *      有没有一条路径会绕过它。
 *
 * 跑法：node test/edge-cache.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

const API_SRC = read('src/server/api.js')
const STREAM_SRC = read('src/lib/stream.js')
const PLAYER_SRC = read('public/js/player.js')

/**
 * 去注释副本 —— 所有「**不包含**」型断言必须用它。
 * 源码注释里必然写着反面写法的字面量（本项目已经在这上面栽过两次），
 * 拿带注释的正文去做否定断言，等于断言「注释里没写那句话」。
 *
 * ⚠ 它**不认正则字面量**：`/^https:\/\//i` 里那个 `\/\/` 会被当成行注释开头，
 *   把整行后半截吃掉。所以「某个含 `\/\/` 的写法在不在」这类断言要用
 *   **带注释的原文**（`API_SRC`），别用这份。见下面那条协议筛选断言。
 */
function deComment(s) {
  const src = String(s)
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === c) { j++; break }
        j++
      }
      out += src.slice(i, j); i = j; continue
    }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue }
    out += c; i++
  }
  return out
}
const API = deComment(API_SRC)
const STREAM = deComment(STREAM_SRC)

/* ══════════════ 1. cachedEdgeJson 的真身行为 ══════════════ */

console.log('\n== 1. cachedEdgeJson 行为（抽真身跑，不是另写一套） ==')

/** 从源码抽一段函数体；找不到就抛 —— 改名了要让测试**红**，而不是静默变空 */
function extractBody(re, label) {
  const m = API_SRC.match(re)
  if (!m) throw new Error(`没能在 src/server/api.js 里抽到 ${label} —— 是不是改名/改签名了？`)
  return m[1]
}

const JSON_CACHE_BASE = /const JSON_CACHE_BASE = '([^']+)'/.exec(API_SRC)
if (!JSON_CACHE_BASE) throw new Error('没找到 JSON_CACHE_BASE')
const CACHE_BASE = JSON_CACHE_BASE[1]

const ONCE_BODY = extractBody(/function once\(key, run\) \{([\s\S]*?)\n\}/, 'once')
const CACHED_BODY = extractBody(
  /async function cachedEdgeJson\(env, keyUrl, ttlMs, compute, opts = \{\}\) \{([\s\S]*?)\n\}/,
  'cachedEdgeJson')

// 抽出来的长度必须对得上量级 —— 空壳会让下面所有行为断言「全过」
ok('抽到的 cachedEdgeJson 函数体不是空壳', CACHED_BODY.length > 600, `${CACHED_BODY.length} 字符`)
ok('抽到的 once 函数体不是空壳', ONCE_BODY.length > 150, `${ONCE_BODY.length} 字符`)

function buildEnv() {
  const singleFlight = new Map()
  const once = new Function('singleFlight', `return function once(key, run) {${ONCE_BODY}}`)(singleFlight)
  const store = new Map()
  const edgeCache = {
    store,
    async match(key) {
      const body = store.get(key.url)
      if (body === undefined) return undefined
      return new Response(body, { headers: { 'Content-Type': 'application/json' } })
    },
    async put(key, res) { store.set(key.url, await res.text()) },
    async delete(key) { store.delete(key.url) },
  }
  const cachedEdgeJson = new Function(
    'edgeCache', 'once', 'JSON_CACHE_BASE', 'Request', 'Response',
    `return async function cachedEdgeJson(env, keyUrl, ttlMs, compute, opts = {}) {${CACHED_BODY}}`
  )(edgeCache, once, CACHE_BASE, Request, Response)
  return { cachedEdgeJson, edgeCache, store, singleFlight }
}

/** 把所有缓存记录的 ts 往前拨 ms 毫秒，用来造「过期」 */
function age(store, ms) {
  for (const [k, v] of store) {
    const rec = JSON.parse(v)
    rec.ts -= ms
    store.set(k, JSON.stringify(rec))
  }
}

// ---- 1a. 命中新鲜缓存：不回源
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => { calls++; return { v: calls } }
  const a = await cachedEdgeJson(null, 'k/fresh', 60000, compute)
  const b = await cachedEdgeJson(null, 'k/fresh', 60000, compute)
  ok('新鲜缓存命中时**不回源**', calls === 1 && a.v === 1 && b.v === 1, `compute 被调用 ${calls} 次`)
  const rec = JSON.parse(store.get(CACHE_BASE + 'k/fresh'))
  ok('记录里同时存了 ts 与 ttl（TTL 自算，不交给 Cache-Control）',
    typeof rec.ts === 'number' && rec.ttl === 60000)
}

// ---- 1b. 超过 TTL：回源
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => ({ v: ++calls })
  await cachedEdgeJson(null, 'k/ttl', 60000, compute)
  age(store, 61000)
  const r = await cachedEdgeJson(null, 'k/ttl', 60000, compute)
  ok('超过 TTL 后重新回源', calls === 2 && r.v === 2, `compute 被调用 ${calls} 次`)
}

// ---- 1c. 过期但在宽限期内：先给旧的 + 后台重算（SWR）
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => ({ v: ++calls })
  await cachedEdgeJson(null, 'k/swr', 60000, compute)
  age(store, 61000)
  const bg = []
  const env = { waitUntil: (p) => bg.push(p) }
  const r = await cachedEdgeJson(env, 'k/swr', 60000, compute, { staleMs: 3600000 })
  ok('宽限期内**立即**返回旧内容（不干等重算）', r.v === 1, `拿到 v=${r.v}`)
  ok('重算被挂到 waitUntil 上（响应先回、后台补新）', bg.length === 1)
  await Promise.all(bg)
  ok('后台那一趟确实重算了', calls === 2, `compute 被调用 ${calls} 次`)
  const after = await cachedEdgeJson(null, 'k/swr', 60000, compute, { staleMs: 3600000 })
  ok('后台重算后缓存已是新内容', after.v === 2)
}

// ---- 1d. 宽限期外：老老实实等回源
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => ({ v: ++calls })
  await cachedEdgeJson(null, 'k/old', 60000, compute)
  age(store, 3600000 + 61000)
  const bg = []
  const r = await cachedEdgeJson({ waitUntil: (p) => bg.push(p) }, 'k/old', 60000, compute, { staleMs: 3600000 })
  ok('超出宽限期就不再用旧内容，直接等新结果', r.v === 2 && bg.length === 0)
}

// ---- 1e. cacheable 说不要，就不写（失败/空结果不钉住一整个 TTL）
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => { calls++; return [] }
  await cachedEdgeJson(null, 'k/empty', 60000, compute, { cacheable: (d) => d.length > 0 })
  await cachedEdgeJson(null, 'k/empty', 60000, compute, { cacheable: (d) => d.length > 0 })
  ok('cacheable 为 false 时**不写缓存**（下次仍回源）', calls === 2 && store.size === 0, `compute ${calls} 次 / 缓存 ${store.size} 条`)
}

// ---- 1f. 抛错不留存
{
  const { cachedEdgeJson, store } = buildEnv()
  let calls = 0
  const compute = async () => { calls++; throw new Error('上游炸了') }
  await cachedEdgeJson(null, 'k/err', 60000, compute).catch(() => {})
  await cachedEdgeJson(null, 'k/err', 60000, compute).catch(() => {})
  ok('回源抛错时**不写缓存**且异常照常上抛', calls === 2 && store.size === 0)
}

// ---- 1g. 同刻并发合并成一次回源
{
  const { cachedEdgeJson } = buildEnv()
  let calls = 0
  const compute = async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { v: calls } }
  const [a, b, c] = await Promise.all([
    cachedEdgeJson(null, 'k/burst', 60000, compute),
    cachedEdgeJson(null, 'k/burst', 60000, compute),
    cachedEdgeJson(null, 'k/burst', 60000, compute),
  ])
  ok('同一刻三个请求只回源一次（单飞）', calls === 1 && a.v === b.v && b.v === c.v, `compute 被调用 ${calls} 次`)
}

// ---- 1h. ttlFor：同一份缓存按内容给不同寿命
{
  const { cachedEdgeJson, store } = buildEnv()
  const hit = { ok: 1 }
  await cachedEdgeJson(null, 'k/ttlfor/hit', 12 * 3600000, async () => hit, { cacheable: () => true, ttlFor: (d) => (d ? 12 * 3600000 : 5 * 60000) })
  await cachedEdgeJson(null, 'k/ttlfor/miss', 12 * 3600000, async () => null, { cacheable: () => true, ttlFor: (d) => (d ? 12 * 3600000 : 5 * 60000) })
  const a = JSON.parse(store.get(CACHE_BASE + 'k/ttlfor/hit'))
  const b = JSON.parse(store.get(CACHE_BASE + 'k/ttlfor/miss'))
  ok('ttlFor 生效：有内容 12h / 无内容 5min', a.ttl === 12 * 3600000 && b.ttl === 5 * 60000)
  ok('null 也是合法缓存内容（否则「没歌词」每次都回源）', b.data === null)
}

// ---- 1i. 缓存键里绝不允许出现用户身份
ok('缓存键只由内容决定（JSON_CACHE_BASE 下拼的键不含 token/user）',
  !/JSON_CACHE_BASE\s*\+\s*[^\n]*token/.test(API) && !/JSON_CACHE_BASE\s*\+\s*[^\n]*user\.id/.test(API))

/* ══════════════ 2. 四个接口的接线 ══════════════ */

console.log('\n== 2. /chart /album /lyric /suggest 都真的走了缓存 ==')

function sectionOf(name) {
  const i = API.indexOf(`if (path === '${name}'`)
  if (i < 0) throw new Error(`没找到 ${name} 分支`)
  const j = API.indexOf('\n    if (path ===', i + 10)
  return API.slice(i, j < 0 ? API.length : j)
}

const chartSec = sectionOf('/chart')
const albumSec = sectionOf('/album')
const lyricSec = sectionOf('/lyric')
const suggestSec = sectionOf('/suggest')

ok('/chart 走 cachedEdgeJson（榜单/歌单曲目不再每次回源）', /cachedEdgeJson\(/.test(chartSec))
ok('/chart 的缓存键是「源 + 榜单 id + 条数」', /`chart\/\$\{source\}\/\$\{id\}\/\$\{limit\}`/.test(chartSec))
ok('/chart 空结果不写缓存', /cacheable:[\s\S]{0,120}songs\.length/.test(chartSec))
ok('/chart 带 SWR 宽限', /staleMs:\s*CHART_CACHE_STALE_MS/.test(chartSec))

ok('/album 走 cachedEdgeJson', /cachedEdgeJson\(/.test(albumSec))
ok('/album 的缓存键是「源 + 专辑 id + 条数」', /`album\/\$\{source\}\/\$\{id\}\/\$\{limit\}`/.test(albumSec))
ok('/album 保留了「上游抛错 → 502」的原有语义', /catch \(e\) \{[\s\S]{0,160}502/.test(albumSec))

ok('/lyric 走 cachedEdgeJson', /cachedEdgeJson\(/.test(lyricSec))
ok('/lyric 的键用「源 + 平台内 id」（不含音质）', /`lyric\/\$\{song\.source\}\/\$\{song\.songmid \|\| song\.id \|\| ''\}`/.test(lyricSec))
ok('/lyric 用 ttlFor 分两档（有词 12h / 无词 5min）',
  /ttlFor:/.test(lyricSec) && /LYRIC_CACHE_TTL_MS\s*:\s*LYRIC_MISS_CACHE_TTL_MS/.test(lyricSec))
ok('/lyric 连「没歌词」也写缓存（否则每次起播都白跑一趟）', /cacheable:\s*\(\)\s*=>\s*true/.test(lyricSec))

ok('/suggest 走 cachedEdgeJson（导入歌单逐首匹配不再重复搜）', /cachedEdgeJson\(/.test(suggestSec))
ok('/suggest 的键带上生效的搜索源清单（改了默认源不该串台）', /`suggest\/\$\{sources\.join\('-'\)\}\/\$\{q\}`/.test(suggestSec))
ok('/suggest 空结果不写缓存', /cacheable:[\s\S]{0,120}list\.length/.test(suggestSec))

ok('四类 TTL 都是常量而不是散落的魔法数字',
  /const CHART_CACHE_TTL_MS = /.test(API) && /const ALBUM_CACHE_TTL_MS = /.test(API)
  && /const LYRIC_CACHE_TTL_MS = /.test(API) && /const SUGGEST_CACHE_TTL_MS = /.test(API))

/* ══════════════ 3. 播放直链缓存（播放插件的结果） ══════════════ */

console.log('\n== 3. 播放直链缓存：跨 isolate、只收验证过的、坏了能作废 ==')

ok('直链缓存有独立 TTL 常量', /const STREAM_URL_TTL = \d+ \* 60 \* 1000/.test(API))
{
  const ttl = Number(/const STREAM_URL_TTL = (\d+) \* 60 \* 1000/.exec(API)[1])
  ok('TTL 控制在 30 分钟以内（直链会过期，缓存久了等于缓存坏地址）', ttl > 0 && ttl <= 30, `${ttl} 分钟`)
}
ok('直链缓存走 edgeCache（跨 isolate），不是只活在进程内',
  /STREAM_URL_BASE/.test(API) && /edgeCache\.match\(new Request\(STREAM_URL_BASE/.test(API)
  && /edgeCache\.put\(new Request\(STREAM_URL_BASE/.test(API))
ok('写缓存挂在 waitUntil 上（不拖慢本次响应、也不会不等它）',
  /setStreamUrl[\s\S]{0,700}env\.waitUntil\(put\)/.test(API))
ok('内存 Map 有容量上限（不许无限涨）', /STREAM_URL_MAX = \d+/.test(API) && /streamUrlMem\.size > STREAM_URL_MAX/.test(API))

ok('edgeCache 支持主动作废（坏了要能立刻丢，不然顶满整个 TTL）', /async delete\(key\)/.test(API))
ok('/stream 在**真的取到字节之后**才写直链缓存', /if \(r\.url\) setStreamUrl\(env, candKey, r\.url\)/.test(API))
ok('/stream 缓存那条失败时立刻作废', /if \(fromUrlCache\) dropStreamUrl\(env, candKey\)/.test(API))
ok('/url 先读直链缓存（命中即秒回，不再解析一遍）',
  /const cachedUrl = noCache \? null : await getStreamUrl\(env, candKey\)/.test(API))
ok('⚠ /url 支持 nocache=1 强制跳过缓存（缓存那条死了要能绕出来）',
  /const noCache = url\.searchParams\.get\('nocache'\) === '1'/.test(API))
ok('⚠ /url 命中缓存时仍按宿主能力筛协议（网页里 http 会被混合内容拦掉，交了等于白试）',
  // 这条断言看**带注释的原文**：deComment 不认正则字面量，
  // `\/\/` 会被它当成行注释开头，把整行后半截吃掉（见下方 DECOMMENT 说明）。
  API_SRC.includes("if (cachedUrl && (/^https:\\/\\//i.test(cachedUrl) || allowHttp))"))
ok('★ 宿主能力可由客户端声明（http=1）—— 否则 CF 上缓存里的 http 直链永远读不出来',
  /const allowHttp = allowHttpAudio\(\) \|\| url\.searchParams\.get\('http'\) === '1'/.test(API))
ok('/stream 也读它，且 retry=1 时不吃（降级重试要换一批）',
  /if \(!isRetry && !preferUrls\) \{[\s\S]{0,200}getStreamUrl\(env, candKey\)/.test(API))
ok('⚠ 命中直链缓存时**不**跳过常规候选列表（它可能已过期，要留退路）',
  /skipCandidateList: !!preferUrls && !fromUrlCache/.test(API))
ok('tryCandidates 回传实际用的地址（否则无从写入缓存）', /url: cand\.url,/.test(STREAM))
ok('player.js 的降级重试标记仍在（retry=1 是这条链的第二道保险）', /if \(attempt\) qs\.set\('retry', '1'\)/.test(PLAYER_SRC))

// ---- 负向：未验证的候选不许进直链缓存
ok('⚠ 未验证的候选（/url?fast=1 那一批）不进直链缓存',
  !/setStreamUrl\(env, candKey, r\.urls/.test(API)
  && /if \(!r\.unverified\) setStreamUrl\(env, candKey, r\.url\)/.test(API))

/**
 * ★ /url 也必须写直链缓存（2026-10-23）。
 *
 * 以前只有 `/stream` 真拉到字节后才写，可 V2.114 起客户端走本地 AudioProxy
 * 直连 CDN，基本不碰 `/stream` —— 那条缓存**几乎永远不会被写入**，
 * 每首歌每次都重跑插件（实测 2~4 秒）。这条断言就是钉住「/url 也写」。
 */
ok('★ /url 解析成功后也写直链缓存（否则 AudioProxy 直连链路永远不写它）',
  /if \(!r\.unverified\) setStreamUrl\(env, candKey, r\.url\)/.test(API))

console.log('\n===== edge-cache：' + pass + ' 通过 / ' + fails.length + ' 失败 =====')
if (fails.length) console.log('失败项：\n  - ' + fails.join('\n  - '))
process.exit(fails.length ? 1 : 0)
