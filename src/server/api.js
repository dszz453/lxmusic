/**
 * PWA 前端后端 API
 * 与 Subsonic 层共用同一套平台/插件能力，但返回更适合 Web 端的结构。
 */
import { md5 } from '../lib/crypto.js'
import { encodeSongId, decodeSongId, encodeAlbumId } from '../lib/songid.js'
import {
  searchOnline, searchAlbums, fetchAlbumTracks, resolveLyric, parseQuery, parsePlaylistRef, resolvePlaylistRef, importPlaylist,
  fetchToplists, fetchChart, fetchChartHead, buildChartHead, musicUrlCandidateList, getProvider,
  SOURCE_META, ALL_SOURCES,
} from '../providers/index.js'
import { songToSubsonic } from './subsonic.js'
import { safeInt } from '../lib/util.js'
import * as pluginStats from '../lib/plugin-stats.js'
import { openAudioStream, resolvePlayableUrl, resolveMusicUrlFast } from '../lib/stream.js'
import { outboundFetch, allowHttpAudio } from '../lib/http.js'
import { generatePlaylist, loadAiConfig, chatOnce, AI_PROVIDERS } from '../lib/ai.js'
import { PLUGIN_SCORES } from '../generated/plugin-scores.js'
import { BUNDLED_PLUGINS } from '../generated/plugins.js'
import * as db from '../db.js'
// 「生效的搜索源」只有一个口径来源（搜索 / 每日推荐 / 榜单都读它）。
// 早先它在本文件里私有，daily.js 只能另写一份写死的清单 —— 那正是
// 「默认搜索源改了不起作用」的根因，见 sources.js 顶部说明。
import { searchSources, pluginSearchSourceKeys, DEFAULT_SOURCES_SETTING } from './sources.js'
import { importPlugin, removeImportedPlugin } from './plugin-import.mjs'
import { generateDaily, getDaily, pickPrimaryUser, todayBJ, dailySourcesStale, requeryDailySources } from './daily.js'
import { HOME_KEYWORDS } from './keywords.js'
import { versionInfo } from '../version.js'

const SESSION_TTL = 30 * 24 * 3600 * 1000

/**
 * 后台「默认搜索源」列表的**展示顺序**（含未被勾选的平台）。
 *
 * 为什么不复用 search.sources：那一份只记「勾选了谁、按什么优先级」，
 * 被取消勾选的平台根本不在里面。而管理页要的是一份**完整排列** ——
 * 否则拖到一半取消勾选一个平台，它下次刷新就会自己蹦到队尾，
 * 用户会以为「拖了没保存」。两份数据各司其职：
 *   search.sources       —— 生效的搜索源与优先级（取流/搜索真正读的）
 *   search.sources.order —— 只是界面上这一列的排布，不影响搜索
 */
const SOURCES_ORDER_SETTING = 'search.sources.order'

/**
 * 把一串平台 key 归一化成完整排列（过滤非法值、补上缺失的新平台）。
 *
 * `extra` 是**插件专有源**（如 qsvip 汽水VIP）—— 它们不在 ALL_SOURCES 里，
 * 但管理页那一列要能排它们，所以校验名单必须带上。不自动追加到末尾：
 * 界面上是否渲染由调用方按插件清单决定，这里只负责「别把合法值当非法丢掉」。
 */
function normalizeSourceOrder(raw, extra = []) {
  const known = ALL_SOURCES.concat(extra)
  const keys = String(raw || '').split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const out = []
  for (const k of keys) {
    if (known.includes(k) && !out.includes(k)) out.push(k)
  }
  for (const k of ALL_SOURCES) if (!out.includes(k)) out.push(k)
  return out
}

/**
 * 插件专有源清单（不含内置平台）—— `/sources` 与 `/admin/search-sources` 共用一份。
 *
 * 只在这里定义一次：管理页画开关用的是它，前端显示来源名用的也是它，
 * 两处各写一遍就会重演本项目最隐蔽的那类 bug（「后台能勾、搜索不认」）。
 */
function pluginSourceList(env) {
  try {
    const pool = env && env.PLUGIN_POOL
    if (!pool || typeof pool.listSources !== 'function') return []
    return pool.listSources()
      .filter(s => !ALL_SOURCES.includes(s.key))
      .map(s => ({
        key: s.key,
        name: s.name,
        short: s.name,
        actions: s.actions,
        qualities: s.qualitys,
        plugins: s.plugins,
        searchable: s.actions.includes('musicSearch'),
      }))
  } catch {
    return []
  }
}

async function sourceOrder(env, db) {
  const raw = (await db.getSetting(env.DB, SOURCES_ORDER_SETTING, '')) || ''
  // 没配过就按 DEFAULT_SOURCES（或全部平台）的自然顺序排 —— 与「没改过」时的行为一致
  if (!String(raw).trim()) {
    const fromActive = (await db.getSetting(env.DB, DEFAULT_SOURCES_SETTING, '')) || ''
    const seed = fromActive || (env && env.DEFAULT_SOURCES ? String(env.DEFAULT_SOURCES) : '')
    return normalizeSourceOrder(seed, pluginSearchSourceKeys(env))
  }
  return normalizeSourceOrder(raw, pluginSearchSourceKeys(env))
}

/**
 * 插件加载信息，附上「构建清单里的可读名」。
 *
 * 为什么要这个：插件自报的 meta.name 有时没法看 —— 有的源把自己的名字写成
 * 𝖧౿ᥣᥣ𝗈 Ԝ𝗈𝗋ᥣᑯ（装饰性 Unicode），有的干脆就是「未命名音源」，界面上排成一列
 * 根本分不清谁是谁。build.mjs 清单里的 label（浮光音乐 / 全豆要聚合音源）才是
 * 给人看的那个名字，两边按 id 对上即可。
 */
const PLUGIN_LOAD = (() => {
  const label = {}
  for (const p of BUNDLED_PLUGINS) label[p.id] = p.name
  const out = {}
  for (const [id, v] of Object.entries(PLUGIN_SCORES.load || {})) {
    out[id] = { ...v, label: label[id] || null }
  }
  return out
})()

/* ---------------- 插件调度偏好（自动 / 人工） ---------------- */
/**
 * 「先试哪个插件」由谁说了算 —— 系统实测评分，还是管理员手工排的序。
 *
 * 存 D1 settings 一行 JSON，读的时候缓存 60 秒：取流是高频路径，
 * 没必要每个请求都去查一次库。管理员保存时会 force 刷新，所以「改完立刻生效」。
 */
const PLUGIN_PREFS_SETTING = 'plugin.prefs'
const PREFS_TTL = 60 * 1000
const DEFAULT_PREFS = { mode: 'auto', order: {}, disabled: [] }
let prefsCache = { ts: 0, data: null }

/**
 * 运行时实测评分的两个键 —— 由 server/plugin-rescore.mjs 写入，这里只读。
 *
 * 线上（CF Worker）永远是空的（跑不了子进程、没有可写文件系统），
 * 所以读取失败/读不到都当「没有」处理，退回构建期那份，不当错误。
 */
const RUNTIME_SCORES_SETTING = 'plugin.scores'
const RESCORE_STATUS_SETTING = 'plugin.rescore.status'

/** 归一化一份偏好，挡掉脏数据（手工写库 / 旧版本残留） */
function normalizePrefs(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
  const order = {}
  if (raw.order && typeof raw.order === 'object') {
    for (const [src, ids] of Object.entries(raw.order)) {
      const list = (Array.isArray(ids) ? ids : []).map(s => String(s)).filter(Boolean)
      if (list.length) order[src] = list
    }
  }
  return {
    mode: raw.mode === 'manual' ? 'manual' : 'auto',
    order,
    disabled: (Array.isArray(raw.disabled) ? raw.disabled : []).map(s => String(s)).filter(Boolean),
  }
}

async function readPluginPrefs(env, store, { force = false } = {}) {
  if (!force && prefsCache.data && Date.now() - prefsCache.ts < PREFS_TTL) return prefsCache.data
  let data = { ...DEFAULT_PREFS }
  try {
    const raw = await store.getSetting(env.DB, PLUGIN_PREFS_SETTING, '')
    if (raw) data = normalizePrefs(JSON.parse(raw))
  } catch { /* 读不到 / 解析不了就用默认的自动模式，功能不受影响 */ }
  prefsCache = { ts: Date.now(), data }
  return data
}

/** 把偏好装进插件池 —— 每个请求进 handleApi 时调一次，命中缓存就是纯内存操作 */
async function applyPluginPrefs(env, store) {
  const pool = env.PLUGIN_POOL
  if (!pool) return DEFAULT_PREFS
  const prefs = await readPluginPrefs(env, store)
  // 「装偏好」是插件池的**可选**能力：安卓壳的池是个精简适配器，测试用的空池更没有。
  // 这里必须容错 —— 踩过：App 侧的池没有这个方法，而这一行在 handleApi 里卡在登录之后，
  // 于是所有 /api/* 请求统统 500，整个 App 后端全挂。
  if (typeof pool.setUserPrefs === 'function') pool.setUserPrefs(prefs)
  return prefs
}

/* ---------------- 运行时评分（自托管优先，线上退回构建期） ---------------- */

/**
 * 读「运行时实测」的评分明细。
 *
 * 只有自托管（Docker）版会有 —— 它按 LX_SCORE_INTERVAL 定期实测并落库。
 * 线上 Cloudflare 版永远没有（跑不了子进程），返回 null 让调用方退回构建期那份。
 *
 * 读失败一律返回 null：这是**锦上添花**的数据，不能因为它把整个接口弄 500。
 */
async function readRuntimeScores(env, store) {
  try {
    const raw = await store.getSetting(env.DB, RUNTIME_SCORES_SETTING, '')
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    return data
  } catch { return null }
}

/**
 * 评分调度器状态。
 *
 * 两个来源要合起来看：
 *   · 进程活着 —— 直接问调度器，拿到的是**实时**状态（正在跑吗、下一轮什么时候）；
 *   · 进程刚重启 —— 调度器是全新的（rounds=0），但库里存着上次的结果，
 *     界面要能显示「上次是什么时候测的、成没成」，否则用户重启一次就以为记录丢了。
 *
 * ⚠️ 这里**必须每次都真查库**，不要用 `env.RESCORE_LAST` 那种进程内快照：
 * 调度器跑完一轮只写库，不会回填任何内存变量，于是快照会一直是启动时的值（多半是 null）。
 * 表现就是「手动重评明明成功了（live.lastOk=true），界面却说从没测过」——
 * 这个 bug 真出现过（/healthz 那边同款，见 server/index.mjs 里 readSavedStatus 的说明）。
 *
 * 代价可以忽略：settings 按主键查一行，且这个接口本来就不是高频路径。
 */
async function readRescoreState(env, store) {
  const live = env.RESCORE && typeof env.RESCORE.snapshot === 'function'
    ? env.RESCORE.snapshot()
    : null
  let saved = null
  try {
    const raw = await store.getSetting(env.DB, RESCORE_STATUS_SETTING, '')
    if (raw) saved = JSON.parse(raw)
  } catch { saved = null }
  const supported = !!(env.RESCORE && typeof env.RESCORE.run === 'function')
  return {
    supported,
    live,
    // 「上次结果」以库里那份为准（跨重启），实时状态补上 running/nextAt 这类瞬时值
    last: saved || null,
    note: supported
      ? null
      : '当前宿主不支持运行时评分（需要自托管/Docker 版）。'
        + '线上版请在本地跑 node tools/plugin-score.mjs 后重新部署。',
  }
}

/** 首页榜单栅格：取官方榜单里播放量最高的若干个 */
function pickCharts(list, count = 6) {
  if (!Array.isArray(list) || !list.length) return []
  const seen = new Set()
  return list
    .filter(c => c.cover && !seen.has(c.name) && seen.add(c.name))
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
    .slice(0, count)
}

/**
 * 平台体检：Cloudflare 出口对各家接口的封锁情况会随时间 / 机房变化，
 * 与其让用户猜「为什么 QQ 搜不到」，不如实测一把并缓存 10 分钟。
 */
const HEALTH_TTL = 10 * 60 * 1000
const healthStore = { ts: 0, rows: null }

async function platformHealth() {
  if (healthStore.rows && Date.now() - healthStore.ts < HEALTH_TTL) return healthStore.rows
  const rows = await Promise.all(ALL_SOURCES.map(async (key) => {
    const t0 = Date.now()
    try {
      const provider = getProvider(key)
      const res = await provider.search('测试', 1, 3)
      const n = (res.list || []).length
      return { key, name: SOURCE_META[key].name, short: SOURCE_META[key].short, ok: n > 0, count: n, ms: Date.now() - t0, error: n ? null : '返回空结果' }
    } catch (e) {
      return { key, name: SOURCE_META[key].name, short: SOURCE_META[key].short, ok: false, count: 0, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) }
    }
  }))
  healthStore.rows = rows
  healthStore.ts = Date.now()
  return rows
}

/**
 * 榜单头图缓存。
 *
 * 网易云把它全部榜单的封面都换成了纯色设计图，三列栅格铺开就是一屏色块。
 * 这里改成用「榜首单曲的专辑封面」当卡片图 —— 既是真图，也就是某位歌手的作品。
 * 代价是每个榜单要多一次上游请求，所以：
 *   · 缓存 12 小时（榜单第一名一天也不会换几次）
 *   · 单次请求最多 8 个 id，客户端分批拉，避免一次打满子请求配额
 * 用内存 Map 而不是 Cache API —— cache.put 需要 ctx.waitUntil，
 * 而 handleApi 拿不到 ctx；isolate 级内存缓存对本场景已经够用。
 */
const CHART_HEAD_TTL = 12 * 3600 * 1000
const CHART_HEAD_MAX_IDS = 8
const chartHeadCache = new Map()

function chartHeadGet(key) {
  const hit = chartHeadCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CHART_HEAD_TTL) { chartHeadCache.delete(key); return null }
  return hit.data
}

function chartHeadSet(key, data) {
  // 上限保护：榜单总共一百多个，超过就清掉最旧的一半，避免长期占内存
  if (chartHeadCache.size > 400) {
    const entries = Array.from(chartHeadCache.entries()).sort((a, b) => a[1].ts - b[1].ts)
    for (const [k] of entries.slice(0, 200)) chartHeadCache.delete(k)
  }
  chartHeadCache.set(key, { ts: Date.now(), data })
}

/** 解析 `wy:3778678,kg:519669` 形式的榜单引用 */
function parseChartRefs(raw, max) {
  const out = []
  for (const piece of String(raw || '').split(',')) {
    const s = piece.trim()
    if (!s) continue
    const m = s.match(/^([a-z]{2})[:：](\d+)$/i)
    if (!m) continue
    const key = `${m[1].toLowerCase()}:${m[2]}`
    if (!out.some(r => r.key === key)) out.push({ key, source: m[1].toLowerCase(), id: m[2] })
    if (out.length >= max) break
  }
  return out
}

/* ---------------- 会话 ---------------- */

function secret(env) {
  return env.SESSION_SECRET || 'lxmusic-default-secret-please-change'
}

function makeToken(env, userId) {
  const exp = Date.now() + SESSION_TTL
  const sig = md5(`${userId}.${exp}.${secret(env)}`)
  return `${userId}.${exp}.${sig}`
}

function verifyToken(env, token) {
  if (!token) return null
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  const [userId, exp, sig] = parts
  if (!userId || !exp || !sig) return null
  if (Number(exp) < Date.now()) return null
  if (md5(`${userId}.${exp}.${secret(env)}`) !== sig) return null
  return userId
}

async function currentUser(env, request) {
  const header = request.headers.get('authorization') || ''
  let token = header.replace(/^Bearer\s+/i, '').trim()
  if (!token) token = new URL(request.url).searchParams.get('token') || ''
  const userId = verifyToken(env, token)
  if (!userId) return null
  return db.findUserById(env.DB, userId)
}

/* ---------------- 工具 ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extraHeaders },
  })
}

function bad(message, status = 400) {
  return json({ ok: false, error: message }, status)
}

/**
 * 边缘缓存适配层。
 *
 * Worker 上有 Cache API（caches.default），缓存落在边缘节点，跨请求有效。
 * 安卓壳里没有这个 API —— 退化成进程内 Map，只求「同一张封面别回源两次」，
 * 语义对调用方完全一致，不需要在业务代码里分支。
 */
const memEdgeCache = new Map()
const EDGE_CACHE_MAX = 200

/**
 * 内部缓存 key 的 host 必须换成**本次请求的 origin**。
 *
 * ⚠ 这是 2026-10-23 才查出来的真问题，影响面比它看起来大得多：
 *
 * CF 的 `caches.default.put()` 要求 request 的 URL 属于**当前 zone**，
 * 不属于就直接抛异常。原来这里（以及 `cachedEdgeJson` / `cachedToplists` /
 * `cachedHomeFallback` / `streamUrlCache`）全用 `https://lx.cache.internal/…`
 * 当 key —— 那个 host 不属于任何 zone，于是 put **全部静默失败**
 * （异常被 `catch { return }` 吞掉，一点痕迹都不留）。
 *
 * 后果：**整个 edgeCache 从来没生效过**。判据（实测）：
 *   · 播放直链：`/url` 写入后等 5 秒，连打 4 次 `/url?fast=1` 全部未命中
 *     （`from` 还是插件名，每次 2.8~4.8 秒重新解析）；
 *   · chart / album / lyric / home 每次都回源，只有进程内 `once()` 单飞
 *     在同一个 isolate 内顶一下 —— 换一个 isolate 就等于没缓存。
 *
 * 用当前请求的 origin 拼 key 就合法了。`env.__origin` 由宿主注入
 * （CF 见 src/index.js）。Docker / 本地没有 `caches`，走 `memEdgeCache`，
 * 那里 key 只是个 Map 键，host 换成什么都无所谓。
 *
 * 路径加 `/__edgecache` 前缀只是为了让日志里一眼看出这是内部 key ——
 * `cache.put` 是显式写入，不受 zone 的 Cache Rules 影响，所以这个路径
 * 不需要真实存在。
 */
const CACHE_KEY_HOST = 'lx.cache.internal'

function cacheKey(env, key) {
  const origin = (env && env.__origin) || ''
  if (!origin || !key || key.url.indexOf(CACHE_KEY_HOST) < 0) return key
  const rest = key.url.slice(key.url.indexOf(CACHE_KEY_HOST) + CACHE_KEY_HOST.length)
  try {
    return new Request(origin + '/__edgecache' + rest, { method: 'GET' })
  } catch {
    return key   // origin 拼不出合法 URL（替身/测试）→ 用原 key
  }
}

/**
 * 兼容两种签名：`edgeCache.match(key)` 与 `edgeCache.match(env, key)`。
 *
 * 老调用点没传 env 时按原样用 key —— 行为与改造前完全一致，
 * 所以漏改一处也不会崩，只是那一处仍旧不生效（CF 上）。
 */
function edgeArgs(a, b) {
  return b === undefined ? [null, a] : [a, b]
}

const edgeCache = {
  async match(a, b) {
    const [env, key] = edgeArgs(a, b)
    const k = cacheKey(env, key)
    const c = globalThis.caches && globalThis.caches.default
    if (c) { try { return await c.match(k) } catch { return undefined } }
    const hit = memEdgeCache.get(k.url)
    return hit ? hit.clone() : undefined
  },
  async put(a, b, c2) {
    // 三参数 = (env, key, res)；两参数 = (key, res)
    const env = c2 === undefined ? null : a
    const key = c2 === undefined ? a : b
    const res = c2 === undefined ? b : c2
    const k = cacheKey(env, key)
    const c = globalThis.caches && globalThis.caches.default
    if (c) { try { return await c.put(k, res) } catch { return } }
    if (memEdgeCache.size > EDGE_CACHE_MAX) {
      for (const kk of Array.from(memEdgeCache.keys()).slice(0, EDGE_CACHE_MAX / 2)) memEdgeCache.delete(kk)
    }
    memEdgeCache.set(k.url, res.clone())
  },
  /**
   * 主动作废一条。
   *
   * 为什么需要它：缓存里存的是**会过期的东西**（播放直链），
   * 一旦确认它已经失效，就得能立刻丢掉 —— 否则接下来整个 TTL 内
   * 每个请求都会先试它一遍、白花一次往返。只用于「已知这条坏了」的场景，
   * 不做批量清空（那会把跨 isolate 的收益一起清掉）。
   */
  async delete(a, b) {
    const [env, key] = edgeArgs(a, b)
    const k = cacheKey(env, key)
    const c = globalThis.caches && globalThis.caches.default
    if (c) { try { return await c.delete(k) } catch { return } }
    memEdgeCache.delete(k.url)
  },
}

/**
 * 榜单列表的边缘缓存。
 *
 * `fetchToplists()` 每次都要回源上游（网易云的榜单接口），实测是 /api/home 里
 * 最贵的那一步 —— 而榜单是**全站同一份**（跟哪个用户无关），没道理每个请求都去问一次。
 * 缓存 15 分钟：榜单本来就不到分钟级变化。
 *
 * TTL 自己按时间戳算，不交给 Cache-Control：安卓壳里没有 Cache API，
 * edgeCache 会退化成进程内 Map，那时寿命完全由这里决定 ——
 * 两套宿主的行为才一致（否则「Worker 上 15 分钟、壳里永久」这种差异极难查）。
 *
 * 上游失败或返回空数组时**不写缓存**：否则一次抖动会把「没有榜单」钉住 15 分钟。
 */
const TOPLISTS_TTL_MS = 15 * 60 * 1000

/**
 * 给一段回源加**硬上限**。
 *
 * 为什么必须有：`wy.getToplists()` 内部不是一次请求 —— 它先打
 * music.163.com（retry: 1，即两遍），失败再退到 eapi，每一步都带自己的超时。
 * 上游「连得上但回得慢」时，光这一步就能吃掉十几秒；而它是 /api/home 的第一段，
 * 用户正等着看首页。超时**不算错误**：拿到什么算什么，页面先出来。
 *
 * 注意 Promise.race 只是让调用方不再等，被甩下的那次请求仍会跑完 —— 所以这里
 * 只用在「回源」上，不要用在有副作用的写操作上。
 */
function withDeadline(promise, ms, fallback) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 榜单回源的上限。榜单没出来首页照样能开，不值得为它等十几秒 */
const TOPLISTS_DEADLINE_MS = 2500

/**
 * 同刻同算合并（in-flight 单飞）。
 *
 * 为什么必须有（2026-10-09 老板报「Docker 版客户端重新登录之后，我的歌单是空白、
 * 加载要半天」）：一次登录会**把首页渲染好几遍**（页面侧的 hashchange 一波 +
 * boot() 的抢跑一波 + 结尾一波），前端那侧已经用 `public/js/api.js` 的 `once()`
 * 合成一次请求了；但服务端不能只指望前端 —— 同一时刻可能有浏览器、两个 App、
 * 一次冷启动同时在问同一份内容，而**这份内容是全站同一份**（关键词按天轮换、
 * 榜单与热歌跟哪个用户无关），把它算三遍纯属自残：自建实例上 CPU 与出网被占满，
 * 别的请求（`/api/playlists`、`/api/me`）跟着一起卡 —— 那就是「歌单空白转半天」。
 *
 * 键必须是**那份内容自己的缓存键**（带上天序号与音源清单），这样不同设置、
 * 不同天的计算不会被错误地合成一次。
 *
 * 失败**不留存**：结束就删，下一次请求该重算就重算（与缓存「失败不写」同一条纪律）。
 */
const singleFlight = new Map()
function once(key, run) {
  const hit = singleFlight.get(key)
  if (hit) return hit
  const p = Promise.resolve().then(run)
  singleFlight.set(key, p)
  p.then(() => { if (singleFlight.get(key) === p) singleFlight.delete(key) },
    () => { if (singleFlight.get(key) === p) singleFlight.delete(key) })
  return p
}

/* ---------------- 回源结果的边缘缓存（通用层） ---------------- */

/**
 * 「上游取回来的东西」的统一缓存 —— 榜单曲目 / 专辑曲目 / 歌词 / 导入匹配搜索。
 *
 * ══════════════ 为什么必须有这一层 ══════════════
 *
 * CF 版上「点开一张歌单/榜单要转圈」「同一首歌每次都要重新解析」的根因不是
 * 上游慢，而是**这些东西一次都没被缓存过**：
 *
 *   · `/api/chart`  每次打开都 `fetchChart()` 回源打一次平台接口（网易 100 首的
 *                   歌单详情要 1~3 秒）；
 *   · `/api/album`  同上；
 *   · `/api/lyric`  每首歌起播都问一次插件/平台；
 *   · `/api/suggest` 歌单导入时逐首匹配，N 首歌就是 N 次搜索。
 *
 * 而这些内容**跟哪个用户无关**，几分钟到几小时内也几乎不变 —— 让每个请求都
 * 各自回源一次，纯属把上游的延迟乘以并发数。
 *
 * ══════════════ 三条必须守住的边界 ══════════════
 *
 * 1. **缓存落在 `edgeCache`（CF 上是 Cache API），不是进程内 Map**。
 *    Worker 的 isolate 会被频繁回收，进程内 Map 的命中率低到没有意义 ——
 *    这正是 `streamCandCache` 那种「60 秒 Map」在 CF 上形同虚设的原因。
 *
 * 2. **TTL 按记录里的时间戳自己算，不交给 Cache-Control**。
 *    安卓壳里没有 Cache API，`edgeCache` 会退化成进程内 Map，那时寿命只能由
 *    时间戳决定 —— 两套宿主行为才一致（否则「CF 上 10 分钟、壳里永久」这种
 *    差异极难查）。同时把**实际用的 TTL 一起写进记录**，好让同一份缓存
 *    按内容给不同寿命（如「有歌词 12 小时 / 没歌词 5 分钟」）。
 *
 * 3. **失败与空结果不写**（由 `cacheable` 决定）。
 *    一次上游抖动不该被钉住一整个 TTL —— 这是本项目在 `cachedToplists` /
 *    `cachedHomeFallback` 上已经栽过的同一条纪律。
 *
 * 另外两个从既有实现里继承的做法：
 *   · 用 `once()` 合并**同一刻的并发**：冷缓存时浏览器、两个 App、一次冷启动
 *     可能同时在问同一份内容，算三遍等于把上游延迟乘三；
 *   · 可选的 SWR（`staleMs`）：过期但还在宽限期内 → 先返回旧的、后台重算，
 *     用户永远不为了「让时间戳变新」而干等。后台那一趟用 `env.waitUntil` 挂到
 *     请求生命周期上（壳内没有 waitUntil 就让它自由跑完）。
 *
 * @param {object}   env
 * @param {string}   keyUrl   缓存键（**只由内容本身决定**，绝不含 token/用户 id）
 * @param {number}   ttlMs    新鲜期
 * @param {Function} compute  回源函数
 * @param {object}   [opts]
 *        - staleMs   宽限期（相对 ttlMs）。0 = 不做 SWR
 *        - cacheable 收不收这份结果，默认「非 null/undefined 就收」
 *        - ttlFor    按内容给不同 TTL（配合记录里的 ttl 字段）
 */
const JSON_CACHE_BASE = 'https://lx.cache.internal/json/'

/**
 * 四类内容的 TTL。都是「跟哪个用户无关、几分钟到几小时不变」的东西。
 *
 *   CHART / ALBUM —— 10 分钟新鲜 + 12 小时宽限（SWR）。
 *                   榜单/歌单曲目偶尔有更新（新歌上榜、下架），10 分钟是
 *                   「用户察觉不到旧、又足够挡掉绝大多数重复回源」的位置。
 *   LYRIC         —— 歌词基本永不改，给 12 小时；但**「这首歌没歌词」只给 5 分钟**，
 *                    因为那多半是插件临时抽风，钉住半天会让用户以为歌词没了。
 *   SUGGEST       —— 导入歌单时逐首匹配用的搜索。10 分钟。
 */
const CHART_CACHE_TTL_MS = 10 * 60 * 1000
const CHART_CACHE_STALE_MS = 12 * 60 * 60 * 1000
const ALBUM_CACHE_TTL_MS = 10 * 60 * 1000
const ALBUM_CACHE_STALE_MS = 12 * 60 * 60 * 1000
const LYRIC_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const LYRIC_MISS_CACHE_TTL_MS = 5 * 60 * 1000
const SUGGEST_CACHE_TTL_MS = 10 * 60 * 1000


async function cachedEdgeJson(env, keyUrl, ttlMs, compute, opts = {}) {
  const staleMs = Math.max(0, Number(opts.staleMs) || 0)
  const cacheable = typeof opts.cacheable === 'function'
    ? opts.cacheable
    : (d) => d !== null && d !== undefined
  const ttlFor = typeof opts.ttlFor === 'function' ? opts.ttlFor : null
  const key = new Request(JSON_CACHE_BASE + keyUrl, { method: 'GET' })

  let stale = null
  let hasStale = false
  try {
    const hit = await edgeCache.match(env, key)
    if (hit) {
      const rec = await hit.json()
      if (rec && typeof rec.ts === 'number' && rec.data !== undefined) {
        const ttl = Number(rec.ttl) > 0 ? Number(rec.ttl) : ttlMs
        const age = Date.now() - rec.ts
        if (age < ttl) return rec.data
        if (staleMs && age < ttl + staleMs) { stale = rec.data; hasStale = true }
      }
    }
  } catch { /* 坏缓存当没命中，继续回源 */ }

  const run = () => once(key.url + '#compute', async () => {
    const data = await compute()
    if (cacheable(data)) {
      const rec = { ts: Date.now(), ttl: ttlFor ? ttlFor(data) : ttlMs, data }
      try {
        await edgeCache.put(env, key, new Response(JSON.stringify(rec), {
          headers: { 'Content-Type': 'application/json' },
        }))
      } catch { /* 缓存写失败不影响本次返回 */ }
    }
    return data
  })

  if (hasStale) {
    // ⚠️ 这里不能等它：要的是「让它完整跑完，只是不等」，所以走 waitUntil
    const work = run().catch(() => { /* 后台重算失败：旧内容继续顶着 */ })
    try { if (env && env.waitUntil) env.waitUntil(work) } catch { /* 自由跑完即可 */ }
    return stale
  }
  return run()
}

async function cachedToplists(env) {
  // ⚠ 必须包一层箭头函数：`once` 缓存的是 Promise，而 env 要透传给
  //    `cachedToplistsUncached`（它要用 env.__origin 拼 cache key）。
  return once('toplists/wy', () => cachedToplistsUncached(env))
}

async function cachedToplistsUncached(env) {
  const key = new Request('https://lx.cache.internal/toplists/wy', { method: 'GET' })
  try {
    const hit = await edgeCache.match(env, key)
    if (hit) {
      const rec = await hit.json()
      if (rec && Array.isArray(rec.list) && rec.list.length
        && typeof rec.ts === 'number' && Date.now() - rec.ts < TOPLISTS_TTL_MS) {
        return rec.list
      }
    }
  } catch { /* 坏缓存当没命中，继续回源 */ }

  const list = await withDeadline(fetchToplists(), TOPLISTS_DEADLINE_MS, [])
  if (Array.isArray(list) && list.length) {
    try {
      await edgeCache.put(env, key, new Response(JSON.stringify({ ts: Date.now(), list }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    } catch { /* 缓存写失败不影响本次返回 */ }
  }
  return list
}

/**
 * 首页兜底内容（关键词轮换那一版）的缓存。
 *
 * 这一版内容是**全站同一份**：关键词按天轮换、榜单与热歌都跟「哪个用户」无关。
 * 而它恰好是 /api/home 里最贵的两段回源 —— 抓榜单，再跨 6 个音源搜 24 首。
 * 早先只有 charts 那半截进了缓存，hot 那半截**每次打开都重算**，于是没有
 * AI 每日推荐的实例（自建 Docker 上很常见）每次进首页都要等好几秒。
 *
 * 三条边界：
 *   · 只在拿到**非空 hot** 时才写：空结果多半是上游抖动，钉住它会让首页空 20 分钟；
 *   · 榜单没拿到（charts 为空）时给**短 TTL**：榜单恢复后能很快补上，
 *     不为了「省一次回源」把半个空首页钉住；
 *   · TTL 按时间戳自己算、存在记录里，不交给 Cache-Control —— 安卓壳里 edgeCache
 *     会退化成进程内 Map，那时寿命只能由这里决定，两套宿主行为才一致。
 *
 * 缓存键里带上音源清单：清单取自**全站设置**（不是每个用户各一份），今天一样，
 * 但万一以后变成按用户配置，带上它就绝不会串台。
 */
const HOME_FALLBACK_TTL_MS = 20 * 60 * 1000
const HOME_FALLBACK_SHORT_TTL_MS = 2 * 60 * 1000

/**
 * 过期之后的**宽限期**：这中间的记录仍然可以直接交出去，同时在后台重算。
 *
 * 为什么需要它（2026-10-08 用户报「首页又要转好几秒」）：TTL 一到，下一次请求
 * 就得完整地走一遍「抓榜单 + 跨 6 源搜 24 首」，自建实例上那是好几秒。
 * 而兜底内容是**全站同一份**，当天更是一模一样 —— 没有任何理由为了让时间戳
 * 变新，让用户干等这几秒。先给旧的、后台补新的（SWR），用户那边永远是秒回。
 *
 * 上限不需要很大：缓存键里带着天序号，跨天本来就是重新算。
 */
const HOME_FALLBACK_STALE_MS = 12 * 60 * 60 * 1000

/** 把一条缓存记录整成 /home 要的形状 */
function homeFallbackFromCache(rec, keyword, stale) {
  return {
    keyword: typeof rec.keyword === 'string' ? rec.keyword : keyword,
    charts: Array.isArray(rec.charts) ? rec.charts : [],
    hot: rec.hot,
    errors: [],
    fromCache: true,
    stale: !!stale,
  }
}

async function cachedHomeFallback(env, db) {
  const dayIndex = Math.floor(Date.now() / 86400000)
  const keyword = HOME_KEYWORDS[dayIndex % HOME_KEYWORDS.length]
  const sources = await searchSources(env, db)
  const key = new Request(
    'https://lx.cache.internal/home-fallback/' + dayIndex + '/' + sources.join('-'),
    { method: 'GET' })
  return cachedHomeFallbackByKey(env, keyword, sources, key)
}

async function cachedHomeFallbackByKey(env, keyword, sources, key) {
  let stale = null
  try {
    const hit = await edgeCache.match(env, key)
    if (hit) {
      const rec = await hit.json()
      const ttl = (rec && rec.ttl) || HOME_FALLBACK_TTL_MS
      if (rec && typeof rec.ts === 'number'
        && Array.isArray(rec.hot) && rec.hot.length) {
        const age = Date.now() - rec.ts
        if (age < ttl) return homeFallbackFromCache(rec, keyword, false)
        // 过期但还在宽限期内 → 走下面「先返回、后台重算」
        if (age < HOME_FALLBACK_STALE_MS) stale = rec
      }
    }
  } catch { /* 坏缓存当没命中，继续回源 */ }

  const compute = async () => {
    const errors = []
    const [charts, parsed] = await Promise.all([
      cachedToplists(env),
      Promise.resolve(parseQuery(keyword, sources, pluginSearchSourceKeys(env))),
    ])

    let hot = []
    try {
      const res = await searchOnline(parsed.keyword, {
        sources: parsed.sources, limit: 24, pluginPool: env.PLUGIN_POOL,
      })
      hot = res.list || []
      errors.push(...(res.errors || []))
    } catch (e) {
      errors.push(String((e && e.message) || e))
    }

    if (hot.length) {
      const ttl = charts.length ? HOME_FALLBACK_TTL_MS : HOME_FALLBACK_SHORT_TTL_MS
      try {
        await edgeCache.put(env, key, new Response(JSON.stringify({ ts: Date.now(), ttl, keyword, charts, hot }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      } catch { /* 缓存写失败不影响本次返回 */ }
    }

    return { keyword, charts, hot, errors, fromCache: false, stale: false }
  }

  /**
   * 单飞的粒度**必须落在 compute 上**，不能落在整个函数上。
   *
   * 为什么：这份函数有三条出口，其中「命中且没过期」与「过期但还在宽限期内」两条
   * 都是**毫秒级返回**（只读一次缓存）。要是把整个函数包进单飞，那两条会瞬间结束、
   * 条目立刻被删掉 —— 紧接着到的第二个请求就找不到可复用的条目，于是各自再起一次
   * `compute()`，白忙一场。真正贵的、也是唯一值得合并的，是 `compute()` 本身
   * （抓榜单 + 跨 6 个音源搜 24 首），所以键也按它来。
   */
  const recompute = () => once(key.url + '#compute', compute)

  if (stale) {
    /**
     * 先把过期的那份交出去，重算甩到后台。
     *
     * ⚠️ 这里**不能**用 `withDeadline` 那种 Promise.race：`compute()` 带副作用
     * （要写缓存），被「不等了」甩下的那次仍会跑，但调用方已经返回 —— 那不是这里
     * 想要的语义。这里要的是「让它完整跑完，只是不等它」，所以用 waitUntil；
     * 没有 waitUntil 的环境（部分替身）就让它自由跑完。
     */
    const work = recompute().catch(() => { /* 后台重算失败：旧内容继续顶着 */ })
    try { if (env && env.waitUntil) env.waitUntil(work) } catch { /* 自由跑完即可 */ }
    return homeFallbackFromCache(stale, keyword, true)
  }

  return recompute()
}

/**
 * 从歌曲列表里挑第一张可用封面。
 *
 * 歌单封面为什么要单独挑：新建歌单 / AI 歌单这条路径原本不写 cover，
 * 于是「我的歌单」里它们是一块空灰格子，和导入来的歌单并排看非常刺眼。
 * 而歌单里第一首歌的专辑封面就是最像「这个歌单」的那张图（和首页榜单头图
 * 用榜首单曲封面是同一个道理）。
 *
 * 各平台字段名不统一（网易 al.picUrl、酷狗 img …），但到这一层都已经归一成 img。
 */
function firstSongCover(songs) {
  for (const s of songs || []) {
    const img = (s && (s.img || s.pic)) || ''
    if (img) return String(img)
  }
  return ''
}

export function songForWeb(song) {
  const id = encodeSongId(song)
  return {
    id,
    source: song.source,
    sourceName: (SOURCE_META[song.source] && SOURCE_META[song.source].name) || song.source,
    name: song.name,
    singer: song.singer,
    albumName: song.albumName,
    albumId: song.albumId ? encodeAlbumId(song.source, song.albumId, song.albumName, song.singer, song.img) : '',
    interval: safeInt(song.interval),
    img: song.img || '',
    qualities: (song.types || []).map(t => t.type),
  }
}

/* ---------------- 路由 ---------------- */

/**
 * 「音源设置变了 → 当天那份推荐立刻换源」的触发点。
 *
 * 背景见 `daily.js` 的 `dailySourcesStale`：`/api/home` 与 `/daily` 一看到当天有记录
 * 就直接返回（首页要秒开，这是对的），于是「改了默认搜索源」在**当天**永远不生效，
 * 用户只能等第二天 06:00 的 cron —— 表现仍然是「设置不起作用」。
 *
 * ⚠ 参数里**没有 `db`**，这不是图省事，是踩过坑：
 *   这个函数原先的签名是 `(env, db, record, userId, toWeb)`，而 api.js 作用域里的 `db`
 *   是 `import * as db from '../db.js'` 的**模块**（它上面的函数第一个参数才是句柄，
 *   例如 `db.ensureSchema(env.DB)`）。daily.js 内部却按 D1 句柄用 → `db.prepare is not
 *   a function` → 被 `catch` 吞成 null → 永远 `return false` → **线上怎么修都不生效**。
 *   现在句柄一律由被调用方从 `env.DB` 自取，参数形状回归「同一件事只有一种传法」。
 *
 * 默认**同步**（sync=true）：换源是「24 首并发重搜」，有硬预算，用户改完设置打开 App
 * 最多等十来秒就能看到新源 —— 比「后台算到一半被 CF 回收、永远不生效」好得多。
 * 传 `sync: false` 才走 `waitUntil`。
 *
 * 去重：同一 isolate 内复用进行中的任务；另加 20 秒冷却，避免用户连点首页时每点一次
 * 都等一轮。（只在同一 isolate 内有效 —— 够用，重叠窗口本来就只有那十几秒。）
 */
let dailyRegenAt = 0
let dailyRegenTask = null

/**
 * 换源预算。
 *
 * `HOME_REQUERY_BUDGET_MS` 现在是**后台任务**的预算（首页走 `sync: false`，见 /home 里的
 * ⚠ 说明），所以它不再影响首屏 —— 给 9 秒只是「一轮最多花这么久」的上限。
 * `DAILY_REQUERY_BUDGET_MS` 仍走同步等：「今日推荐」页是用户主动进来等结果的，14 秒合理。
 */
const HOME_REQUERY_BUDGET_MS = 9000
const DAILY_REQUERY_BUDGET_MS = 14000

function regenDailyIfStale(env, record, toWeb, { sync = true, budgetMs } = {}) {
  return dailySourcesStale(env, record)
    .then((stale) => {
      if (!stale) return false

      if (!sync) {
        /**
         * 后台重算：**没有 `waitUntil` 的宿主也必须真跑**。
         *
         * 这里原来写着 `if (!env.waitUntil) return true` —— 在 CF 上没问题（它一定有），
         * 但 Docker / 本机 node **没有** `env.waitUntil`，那一句在自建实例上等于
         * 「永远不重算」，签名也就永远记不上。而 `waitUntil` 的存在意义只是
         * 「保住响应返回后还要跑的任务不被回收」；Node 进程不会因为回了响应就把
         * 在途的 promise 掐掉，所以**把 promise 丢出去它就会跑完**，不需要 waitUntil。
         */
        const t0 = Date.now()
        if (t0 - dailyRegenAt < 60000) return true
        dailyRegenAt = t0
        const task = requeryDailySources(env, record, { toWeb, budgetMs })
          .catch(() => { /* 后台失败静默，下次访问再试 */ })
        if (env.waitUntil) {
          try { env.waitUntil(task) } catch { /* waitUntil 自己抛了也不能影响本次响应 */ }
        }
        return true
      }

      if (dailyRegenTask) return dailyRegenTask.then(() => true)
      const now = Date.now()
      if (now - dailyRegenAt < 20000) return true
      dailyRegenAt = now
      dailyRegenTask = requeryDailySources(env, record, { toWeb, budgetMs })
        .catch(() => ({ replaced: 0, total: 0, completed: false, saved: false }))
        .then((r) => { dailyRegenTask = null; return r })
      return dailyRegenTask.then(() => true)
    })
    .catch(() => false)
}

// 代理流短期候选缓存：浏览器加载音频时往往先发 HEAD 或 bytes=0- 拉取元数据，
// 随后立刻掐断并发起真实 Range 请求。缓存直链 60 秒，避免二次分片时退回 15 秒串行解析导致 CF 502。
const streamCandCache = new Map()
const STREAM_CAND_TTL = 60 * 1000

/**
 * 候选缓存的键。
 *
 * ⚠ `/url`（写）与 `/stream`（读）**必须用同一个函数**算这个键。
 * 早先两处各写一遍字符串拼接，看着一样其实差一点（有的带 songmid 有的不带），
 * 结果是「/url 明明解析过了、/stream 还是重新解析」—— 白等一轮。
 * 抽成一个函数，改一处就两边都跟着改。
 */
function streamCandKey(song, quality) {
  return `${song.source}:${song.songmid || song.id || ''}:${quality || '320k'}`
}

function getStreamCand(key) {
  const hit = streamCandCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > STREAM_CAND_TTL) { streamCandCache.delete(key); return null }
  /**
   * 返回**整条记录**（含 `verified`），不再只返回 urls。
   *
   * 调用方必须知道这批候选「探通过没有」：`/url?fast=1` 在预算耗尽时交出去的
   * 那批是**解析出来了但没来得及探**的地址，失败概率很高。拿它去关掉完整候选列表
   * 等于把一整首歌钉死在一批没验证过的地址上 —— 这正是「歌单前几首退到服务端就播不出来」
   * 的那个坑（V2.111 / 服务端 V2.15 修的）。
   */
  return hit
}

function setStreamCand(key, urls, verified) {
  if (!key || !urls || !urls.length) return
  if (streamCandCache.size > 100) {
    const oldest = Array.from(streamCandCache.entries()).sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) streamCandCache.delete(oldest[0])
  }
  streamCandCache.set(key, { ts: Date.now(), urls, verified: !!verified })
}

/* ---------------- 播放直链缓存（播放插件的结果） ---------------- */

/**
 * 「这条地址刚刚真的吐出了音频字节」的缓存 —— 也就是**播放插件解析结果**的缓存。
 *
 * ══════════════ 和上面那份 streamCandCache 的分工 ══════════════
 *
 *   streamCandCache  —— **60 秒、进程内**。它解决的是**一次播放内部**的交接：
 *                       前端先打 `/url?fast=1` 拿候选喂 <audio>，直连失败后
 *                       <audio> 掉到 `/api/stream`，服务端得知道刚才解析过什么，
 *                       否则从零冷解析 2~3 秒 → 撞 Worker 响应窗口 → 502。
 *                       它的候选是**没验证过**的（fast 模式不做字节探测）。
 *
 *   streamUrlCache  —— **5 分钟、跨 isolate（走 edgeCache）**。它解决的是
 *                       **两次播放之间**的重复劳动：同一首歌第二次点开时，
 *                       服务端早就知道哪个地址真的能出声了，没有任何理由
 *                       再把「插件池逐个解析 + 逐个 Range 探测」重跑一遍
 *                       （实测 0.6~3.5 秒，这正是「点开慢」的主要来源）。
 *                       只收**已经取到过字节**的地址，所以命中即可直接用。
 *
 * ══════════════ 为什么 TTL 只有 5 分钟 ══════════════
 *
 * 音乐源给的直链基本都带时效（几十分钟到几小时），且大量绑 IP / 绑 UA。
 * 缓存「解析出来的直链」本身就是在缓存一个会烂掉的东西，所以宁可短：
 * 5 分钟足够覆盖「同一首歌重播 / 来回切歌 / 拖动进度后重连」这些真实场景，
 * 又远短于绝大多数 CDN 的签名有效期。
 *
 * 而且**烂了也不会卡死**：命中之后仍要过 `tryCandidates` 的真拉字节那一步，
 * 死了就退回常规候选列表（`skipCandidateList: false`），只是白花一次请求。
 *
 * ══════════════ 为什么必须跨 isolate ══════════════
 *
 * 进程内 Map 在 CF 上会被 isolate 回收带走，命中率低到没有意义（见上面
 * cachedEdgeJson 的同一条说明）。所以写入走 `edgeCache`，并用 `env.waitUntil`
 * 把写操作挂到请求生命周期上 —— 不能让它拖慢本次响应，也不能不等它。
 * 内存 Map 留一份**只作为快速通道**（省掉一次 Cache API 往返）。
 */
const STREAM_URL_BASE = 'https://lx.cache.internal/stream-url/'
const STREAM_URL_TTL = 5 * 60 * 1000
const STREAM_URL_MAX = 200
const streamUrlMem = new Map()

function streamUrlMemSet(key, ts, url) {
  if (streamUrlMem.size > STREAM_URL_MAX) {
    for (const [k, v] of Array.from(streamUrlMem.entries()).sort((a, b) => a[1].ts - b[1].ts).slice(0, STREAM_URL_MAX / 2)) {
      streamUrlMem.delete(k)
    }
  }
  streamUrlMem.set(key, { ts, url })
}

async function getStreamUrl(env, key) {
  if (!key) return null
  const mem = streamUrlMem.get(key)
  if (mem) {
    if (Date.now() - mem.ts < STREAM_URL_TTL) return mem.url
    streamUrlMem.delete(key)
  }
  try {
    const hit = await edgeCache.match(env, new Request(STREAM_URL_BASE + key, { method: 'GET' }))
    if (hit) {
      const rec = await hit.json()
      if (rec && rec.url && typeof rec.ts === 'number' && Date.now() - rec.ts < STREAM_URL_TTL) {
        streamUrlMemSet(key, rec.ts, rec.url)
        return rec.url
      }
    }
  } catch { /* 坏缓存当没命中 */ }
  return null
}

function setStreamUrl(env, key, url) {
  if (!key || !url) return
  const ts = Date.now()
  streamUrlMemSet(key, ts, url)
  const put = edgeCache.put(env, new Request(STREAM_URL_BASE + key, { method: 'GET' }),
    new Response(JSON.stringify({ ts, url }), { headers: { 'Content-Type': 'application/json' } }))
    .catch(() => { /* 缓存写失败不影响播放 */ })
  try { if (env && env.waitUntil) env.waitUntil(put) } catch { /* 自由跑完即可 */ }
}

/** 确认缓存里那条已经取不到字节 → 立刻作废，别让它顶满整个 TTL */
function dropStreamUrl(env, key) {
  if (!key) return
  streamUrlMem.delete(key)
  const del = edgeCache.delete(env, new Request(STREAM_URL_BASE + key, { method: 'GET' }))
    .catch(() => { /* 删不掉也只是多试一次 */ })
  try { if (env && env.waitUntil) env.waitUntil(del) } catch { /* 自由跑完即可 */ }
}

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-max-age': '86400',
      },
    })
  }

  try {
    // 幂等建表：D1 / Docker 的 node:sqlite / 壳内设备 SQLite 三个宿主共用同一份
    // 建表语句，谁都不需要单独的迁移步骤。放在最前面，连 /setup-status 这种
    // 公开接口也能触发 —— 全新库的第一个请求就把表建好。
    await db.ensureSchema(env.DB)

    /**
     * 拉一次插件在线命中率的快照（跨 isolate，edgeCache 里那份）。
     *
     * 放在这里而不是取流函数里：`resolveMusicUrlFast` 的签名里没有 env，
     * 而统计需要 env 才能拼出合法的 edgeCache key（见 plugin-stats.js）。
     * `hydrate()` 自己带 60 秒节流，所以不是每个请求都真的去读缓存。
     *
     * 失败不影响任何东西：统计只用于**排序**，读不到就退回静态 rank。
     */
    try { await pluginStats.hydrate(env) } catch { }

    /* ---- 公开接口 ---- */
    if (path === '/setup-status') {
      return json({ ok: true, needsSetup: (await db.countUsers(env.DB)) === 0 })
    }

    /**
     * 版本号。三个宿主都从这里取，前端「关于」处也用它。
     * 公开、不需登录 —— 用户报问题时第一件事就是问「你跑的哪版」，
     * 要登录才能看会白白多一轮来回。
     *
     * ── host 字段是干什么的 ────────────────────────────────────────
     * 老板要求 Docker 版显示 LX-MUSIC、CF 版显示 music-edge，而两个客户端
     * **共用同一份前端资源**，所以「我是谁」必须由服务端告诉前端。
     * 前端拿到 host 才知道该显示哪个名字（见 public/js/brand.js）。
     *
     * 为什么不用响应头 / CDN 特征来判：那些都可能被反向代理、中间设备抹掉，
     * 而 host 是我们自己的代码写出去的字面量，最稳。
     *
     * 取值由宿主在启动时挂到 env 上（src/index.js 为 'cf'，server/index.mjs 为 'docker'）。
     * 没挂时不硬编码成某一个 —— 回 null，让前端走它自己的兜底判据，
     * 免得「不知道」被当成一个确定的答案。
     */
    if (path === '/version') {
      return json({ ok: true, ...versionInfo(), host: env.LX_HOST_KIND || null })
    }

    /**
     * 插件在线命中率快照（只读诊断口）。
     *
     * 存在的理由：这套统计是**运行期自己攒**的，攒不到就等于没接上 ——
     * 而它失效的样子非常安静（排序退回静态表，功能一切正常，只是没变快）。
     * 没有这个口子，线上根本没法判断「到底有没有在记」。
     *
     * 与 `/healthz` 同一档：不含任何用户数据，只有 `平台|插件id → 成功/失败次数`。
     * 插件名本来就在 `/url` 的 `from` 里回给客户端，不算新泄露。
     */
    if (path === '/plugin-stats') {
      // 强制读一次 edgeCache（跳过 60 秒节流）：诊断口可能落到一个刚起的
      // isolate 上，只查内存会看到空表，白白误判「统计没在记」。
      try { await pluginStats.hydrate(env, true) } catch { }
      const all = pluginStats.snapshot()
      const keys = Object.keys(all)
      const rows = keys
        .map((k) => {
          const [source, id] = k.split('|')
          const v = all[k] || {}
          const ok = v.ok || 0
          const fail = v.fail || 0
          const n = ok + fail
          return { source, id, ok, fail, samples: n, rate: n ? Number((ok / n).toFixed(3)) : null, ts: v.ts || 0 }
        })
        .sort((a, b) => a.source.localeCompare(b.source) || (b.samples - a.samples))
      const payload = { ok: true, total: keys.length, items: rows }
      // ?debug=1：把落盘状态一起吐出来。这套统计失效时毫无声响，
      // 没有这些数字（dirty / lastFlushOk / lastFlushErr）只能靠猜。
      /**
       * ?selftest=1：在这个请求里**真的记一条、真的落一次盘**，把结果原样吐出来。
       *
       * 为什么需要它：这套统计失效时一点声响都没有。线上排查时「排序好像没变」
       * 可能是 ① 没记上 ② 记上了没落盘 ③ 落盘了但读不回来 —— 三者从外面看
       * 一模一样。有了这个开关，一次请求就能把链路走通并把断点暴露出来。
       * 记的是 `__selftest|probe` 这种不可能与真实插件重名的键，不影响排序。
       */
      if (url.searchParams.get('selftest') === '1') {
        pluginStats.record('__selftest', 'probe', 'ok')
        const flushed = await pluginStats.flush(env, true)
        const back = await pluginStats.hydrate(env, true)
        payload.selftest = {
          flushed,
          hydrateDone: back !== undefined,
          debug: pluginStats.debugInfo(),
          sawSelfTestEntry: !!(pluginStats.snapshot()['__selftest|probe']),
        }
      }
      if (url.searchParams.get('debug') === '1') {
        payload.debug = {
          ...pluginStats.debugInfo(),
          hasOrigin: !!(env && env.__origin),
          hasCacheApi: !!(globalThis.caches && globalThis.caches.default),
          hasWaitUntil: typeof env.waitUntil === 'function',
        }
      }
      return json(payload)
    }

    if (path === '/setup' && method === 'POST') {
      if ((await db.countUsers(env.DB)) > 0) return bad('已初始化，禁止重复设置', 403)
      const body = await readJson(request)
      const username = String(body.username || '').trim()
      const password = String(body.password || '')
      if (!username || password.length < 4) return bad('用户名不能为空，密码至少 4 位')
      const user = await db.createUser(env.DB, { username, password, isAdmin: 1 })
      return json({ ok: true, token: makeToken(env, user.id), user: { id: user.id, username, isAdmin: true } })
    }

    if (path === '/login' && method === 'POST') {
      const body = await readJson(request)
      const user = await db.findUserByName(env.DB, String(body.username || '').trim())
      if (!user || user.password !== String(body.password || '')) return bad('用户名或密码错误', 401)
      return json({ ok: true, token: makeToken(env, user.id), user: { id: user.id, username: user.username, isAdmin: !!user.is_admin } })
    }

    /* ---- 以下需要登录 ---- */
    const user = await currentUser(env, request)
    if (!user) return bad('未登录或登录已过期', 401)

    /**
     * 管理端权限守卫，**只此一处**。
     *
     * 以前是每个管理写在各自分支里判一次 `user.is_admin` —— 那种写法的问题
     * 不是啰嗦，而是**漏判不报错**：新加一个管理接口忘了写判断，它就直接
     * 对全站开放了，而且没有任何测试会红。收敛成前缀判断之后，
     * 只要路径挂在 /admin/ 下就必然过这道闸，漏不掉。
     */
    if (path.startsWith('/admin/') && !user.is_admin) {
      return bad('需要管理员权限', 403)
    }

    // 插件调度偏好：命中 60s 缓存时纯内存操作，取流路径的开销可以忽略
    const pluginPrefs = await applyPluginPrefs(env, db)

    /**
     * 这个平台有没有**管理员手工排的序**（`plugin.prefs.order[src]`）。
     *
     * 有的话，取流时就不许再用在线命中率去重排 —— 手工序是老板亲手定的，
     * 优先级高于任何自动统计。判定放在这里、三处取流调用共用一份，
     * 免得哪天加第四个调用点又忘了传（忘了传 = 手工序静默失效，
     * 而界面上顺序看着还是对的，最难查）。
     *
     * ⚠ 不看 `mode`：`plugin.prefs.mode` 默认是 `auto`，而插件池只有
     * `manual` 才应用手工序 —— 这正是「排了序却不生效」的由来。
     * 只要 order 里有这个平台的非空数组，就认为他排过。
     */
    const hasPinnedOrder = (src) => {
      const o = pluginPrefs && pluginPrefs.order
      return !!(o && Array.isArray(o[src]) && o[src].length)
    }

    if (path === '/me') {
      return json({ ok: true, user: { id: user.id, username: user.username, isAdmin: !!user.is_admin } })
    }

    if (path === '/password' && method === 'POST') {
      const body = await readJson(request)
      if (String(body.oldPassword || '') !== user.password) return bad('原密码错误')
      const np = String(body.newPassword || '')
      if (np.length < 4) return bad('新密码至少 4 位')
      await db.updateUserPassword(env.DB, user.id, np)
      return json({ ok: true })
    }

    /* ---- 首页（推荐歌单 + 猜你喜欢） ----
     *
     * hot 的来源优先级：
     *   1. daily_recommend 当天记录（AI 按歌单名 + 播放记录生成的，cron 每天 06:00 / 手动刷新 / 首次访问 lazy 触发）
     *   2. 兜底：关键词轮换搜索（旧逻辑原样保留 —— AI 没配好、D1 没表、首次访问还没生成完时不能白屏）
     */
    if (path === '/home') {
      const errors = []
      const dbg = url.searchParams.get('debug') === '1' ? {} : null
      const t0 = Date.now()
      let daily = null
      try { daily = await getDaily(env.DB) } catch { /* 表还没建等情况，走兜底 */ }
      const tDaily = Date.now()

      if (daily && daily.songs.length) {
        // 当天已有 AI 推荐：直接用，首页秒开。
        // 顺手核对「这份是用当前设置的音源生成的吗」——不是就**换源**
        // （只换源、不重跑 AI，理由见 daily.js 的 requeryDailySources）。
        //
        // ⚠ `sync: false` —— 首页**绝不同步等**换源。2026-10-09 报障：「docker 每次
        // 重新打开，登录需要 10s，这个时候我的歌单加载不出来」、之后又报「打开 APP
        // 后 app 一直在重新登录后台」。根因就是这里原来写的 `sync: true` +
        // 9 秒预算串在响应里，弱网自建实例上跑不完 → 签名记不上 → **每次访问都等满
        // 9 秒**，而同一时刻的 `/api/me`、`/api/playlists` 全被压在这 9 秒后面。
        //
        // 换源是**优化**（让当天推荐尽快用上你新设的音源），不是首页能不能用的前提；
        // 为它押上首屏 9 秒是本末倒置。改到后台之后：本次响应照旧给当前内容，
        // 后台换完写库，下次访问自然就是新的（daily.js 的签名修复保证它只换一次）。
        // 用户主动点进「今日推荐」页时仍走同步等（`/daily` 的 14s 预算）——
        // 那一页是专门进来看推荐的，等得起。
        const [charts, dstale] = await Promise.all([
          cachedToplists(env),
          regenDailyIfStale(env, daily, songForWeb, { sync: false, budgetMs: HOME_REQUERY_BUDGET_MS }),
        ])
        if (dstale) {
          // 后台可能刚好在这一瞬写完了（上一发任务的尾巴）：重读一次，读到新的就用新的
          const fresh = await getDaily(env.DB).catch(() => null)
          if (fresh && fresh.songs && fresh.songs.length) daily = fresh
        }
        return json({
          ok: true,
          keyword: daily.title || '每日推荐',
          charts: pickCharts(charts, 6),
          hot: daily.songs,
          platforms: ALL_SOURCES.map(k => ({ key: k, name: SOURCE_META[k].name, short: SOURCE_META[k].short })),
          errors,
          daily: { generator: daily.generator, generatedAt: daily.generatedAt, date: daily.date },
          ...(dbg ? { debug: { daily: tDaily - t0, data: Date.now() - tDaily, fromCache: null, generator: daily.generator, stale: dstale } } : {}),
        })
      }

      /**
       * 当天还没有记录：给一版兜底结果（不等 AI，AI 生成要 30s+），
       * 同时后台触发生成 —— waitUntil 由 index.js 挂到 env 上，cron 没跑/没配也兜得住。
       *
       * 兜底内容整份走缓存（见 cachedHomeFallback）：抓榜单 + 跨源搜 24 首是
       * /api/home 里最贵的两段，而且跟「哪个用户」无关 —— 命中就一个字都不用回源。
       */
      const fb = await cachedHomeFallback(env, db)
      errors.push(...fb.errors)
      const tData = Date.now()

      if (env.waitUntil) {
        try {
          env.waitUntil(generateDaily(env, env.DB, { userId: user.id, toWeb: songForWeb }).catch(() => { /* 后台失败静默，下次再试 */ }))
        } catch { /* 没有 waitUntil（某些替身环境）就跳过 */ }
      }
      return json({
        ok: true,
        keyword: fb.keyword,
        charts: pickCharts(fb.charts, 6),
        hot: fb.hot.map(songForWeb),
        platforms: ALL_SOURCES.map(k => ({ key: k, name: SOURCE_META[k].name, short: SOURCE_META[k].short })),
        errors,
        ...(dbg ? { debug: { daily: tDaily - t0, data: tData - tDaily, total: tData - t0, fromCache: fb.fromCache, hot: fb.hot.length, charts: fb.charts.length, stale: !!fb.stale } } : {}),
      })
    }

    /* ---- 每日推荐 ----
     * GET /daily           当天记录（ready=false 表示还没生成完，前端可提示稍候）
     * POST /daily/refresh  手动刷新：强制重生成（「换一批」按钮）。同步等结果，
     *                      AI 链路 30~90s 属正常，前端要有 loading 态。
     */
    if (path === '/daily' && method === 'GET') {
      let daily = await getDaily(env.DB)
      // 同 /home：这份要是旧音源生成的，就**当场换源**（只换源，不重跑 AI）
      const stale = await regenDailyIfStale(env, daily, songForWeb, { sync: true, budgetMs: DAILY_REQUERY_BUDGET_MS })
      if (stale) {
        // 换过源就重读一次：进这个页面的用户就是来看推荐的，别让他再刷一遍
        const fresh = await getDaily(env.DB).catch(() => null)
        if (fresh && fresh.songs && fresh.songs.length) daily = fresh
      }
      return json({
        ok: true,
        ready: !!(daily && daily.songs.length),
        title: daily ? daily.title : '',
        generator: daily ? daily.generator : '',
        generatedAt: daily ? daily.generatedAt : 0,
        date: todayBJ(),
        songs: daily ? daily.songs : [],
        // true = 本次发现是旧音源、已按新设置换过源（内容此时已是新的）
        stale,
      })
    }

    if (path === '/daily/refresh' && method === 'POST') {
      let rec
      try {
        rec = await generateDaily(env, env.DB, { userId: user.id, force: true, toWeb: songForWeb })
      } catch (e) {
        return bad('每日推荐生成失败：' + String((e && e.message) || e))
      }
      return json({
        ok: true,
        ready: true,
        title: rec.title,
        generator: rec.generator,
        generatedAt: rec.generatedAt,
        date: rec.date,
        songs: rec.songs,
      })
    }

    /* ---- 全部榜单列表 ---- */
    if (path === '/charts') {
      const charts = await cachedToplists(env)
      return json({ ok: true, list: charts.filter(c => c.cover) })
    }

    /* ---- 榜单曲目（不落库，用于「排行榜」页直接播放） ---- */
    if (path === '/chart') {
      const id = url.searchParams.get('id') || ''
      const source = url.searchParams.get('source') || 'wy'
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 100) || 100, 300)
      if (!id) return bad('缺少榜单 id')
      /**
       * 榜单/歌单曲目**必须缓存**。
       *
       * 这是 CF 版「点开一张歌单要转圈」最大的那一笔：`fetchChart` 每次都要
       * 回源打一次平台接口（网易 100 首的歌单详情实测 1~3 秒），而它
       * **跟哪个用户无关**、10 分钟内几乎不变。缓存键只由「源 + 榜单 id + 条数」
       * 决定，绝不带 token/用户 id —— 带了就等于每人一份缓存，等于没缓存
       * （这一条在 /cover 的 cacheKey 注释里已经立过规矩）。
       *
       * 空结果不写缓存：一次上游抖动不该被钉住 10 分钟。
       */
      const data = await cachedEdgeJson(
        env, `chart/${source}/${id}/${limit}`, CHART_CACHE_TTL_MS,
        () => fetchChart({ source, id }, limit),
        { staleMs: CHART_CACHE_STALE_MS, cacheable: (d) => !!(d && Array.isArray(d.songs) && d.songs.length) })
      if (!data || !data.songs.length) return bad('榜单为空或获取失败')
      // 详情页头图与卡片图口径一致：都是「榜首歌手的头像，缺图退回专辑封面」。
      // 这里曲目已经全拿到了，不用再拉一次上游歌单，只补一次歌手头像查询（12 小时缓存）。
      const first = data.songs.find(s => s && (s.img || s.artistId))
      const headKey = `${source}:${id}`
      let head = chartHeadGet(headKey)
      if (!head && first) {
        try {
          head = await buildChartHead(source, first)
          if (head && head.cover) chartHeadSet(headKey, head)
        } catch { head = null }
      }
      return json({
        ok: true,
        chart: {
          source: data.source, id: data.sourceId, name: data.name, cover: data.cover,
          head: head || null,
        },
        list: data.songs.map(songForWeb),
      })
    }

    /* ---- 榜单卡片头图（批量，客户端分批调用） ---- */
    if (path === '/chart-covers') {
      const refs = parseChartRefs(url.searchParams.get('ids') || '', CHART_HEAD_MAX_IDS)
      if (!refs.length) return bad('缺少 ids，格式 wy:3778678,kg:519669')
      const covers = {}
      await Promise.all(refs.map(async (ref) => {
        const key = ref.key
        const hit = chartHeadGet(key)
        if (hit) { covers[key] = hit; return }
        try {
          const head = await fetchChartHead(ref)
          if (head && head.cover) { chartHeadSet(key, head); covers[key] = head }
        } catch { /* 单个榜单失败不影响其余 */ }
      }))
      return json({ ok: true, covers })
    }

    /* ---- 搜索 ---- */
    if (path === '/search') {
      const q = url.searchParams.get('q') || ''
      const source = url.searchParams.get('source') || ''
      const page = safeInt(url.searchParams.get('page'), 1) || 1
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 30) || 30, 100)

      // 第三个参数是「插件专有源」名单：`qsvip:xxx` 这种前缀也要能认出来（见 parseQuery）
      const parsed = parseQuery(source ? `${source}:${q}` : q, await searchSources(env, db), pluginSearchSourceKeys(env))
      const res = await searchOnline(parsed.keyword, {
        sources: parsed.sources, page, limit, pluginPool: env.PLUGIN_POOL,
      })
      if (parsed.keyword) await db.addSearchHistory(env.DB, user.id, parsed.keyword).catch(() => {})
      return json({
        ok: true,
        list: res.list.map(songForWeb),
        total: res.total,
        page,
        errors: res.errors,
      })
    }

    /* ---- 搜专辑（六平台聚合） ---- */
    if (path === '/search-albums') {
      const q = url.searchParams.get('q') || ''
      const source = url.searchParams.get('source') || ''
      const page = safeInt(url.searchParams.get('page'), 1) || 1
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 20) || 20, 60)
      if (!q) return bad('请输入搜索词')
      // 指定平台就只搜那个平台；否则跟随「默认搜索源」设置
      const targets = (source && SOURCE_META[source]) ? [source] : await searchSources(env, db)
      const res = await searchAlbums(q, { sources: targets, page, limit })
      return json({ ok: true, list: res.list, total: res.total, page, errors: res.errors })
    }

    /* ---- 专辑曲目：打开一张专辑 = 把它整张导入成歌单 ---- */
    if (path === '/album') {
      const source = url.searchParams.get('source') || ''
      const id = url.searchParams.get('id') || ''
      /*
       * 默认 500，上限 1000。
       *
       * 原来的默认值是 200，于是「234 首的专辑」点进去只剩 200 首 ——
       * 搜索卡片上明明写着 234 首（trackCount 来自平台搜索结果），
       * 详情页却只有 200 首，看着像凭空丢了 34 首。
       * 有声书 / 播客类专辑动辄几百上千集，200 这个数太容易撞上。
       */
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 500) || 500, 1000)
      if (!source || !id) return bad('缺少 source 或 id')
      let data
      try {
        // 专辑曲目与榜单曲目同一条纪律：跟哪个用户无关、10 分钟内不变 → 缓存
        // （见 /chart 的说明）。空结果不写，抛错也不写（异常会原样穿出来走 502）。
        data = await cachedEdgeJson(
          env, `album/${source}/${id}/${limit}`, ALBUM_CACHE_TTL_MS,
          () => fetchAlbumTracks(source, id, limit),
          { staleMs: ALBUM_CACHE_STALE_MS, cacheable: (d) => !!(d && Array.isArray(d.songs) && d.songs.length) })
      } catch (e) {
        return bad(`专辑曲目获取失败：${(e && e.message) || e}`, 502)
      }
      if (!data || !data.songs.length) return bad('该专辑没有可用曲目', 404)
      return json({
        ok: true,
        album: {
          source: data.source,
          sourceId: data.sourceId,
          name: data.name,
          cover: data.cover || '',
          /*
           * total = **专辑真实曲目数**（平台给的），fetched = 本次取回条数。
           *
           * 以前这里写的是 `total: data.songs.length` —— 那等于「我取到几首就说专辑有几首」，
           * limit 一截断就自我圆谎，前端永远发现不了自己少了歌。
           * 现在两者分开：total > songs.length 时前端能明确说「已载入 200 / 共 234」。
           */
          total: Number(data.total) || data.songs.length,
          fetched: data.songs.length,
          songs: data.songs.map(songForWeb),
        },
      })
    }

    if (path === '/suggest') {
      const q = url.searchParams.get('q') || ''
      if (!q) return json({ ok: true, list: [] })
      /**
       * 「按关键词找一首能播的歌」—— 歌单导入匹配（一次 N 首就是 N 次搜索）、
       * AI 歌单落库都走它。同一批关键词在 10 分钟内重复问的概率很高
       * （用户重试导入、导入同一张歌单），所以整份结果按关键词缓存。
       *
       * ⚠ 缓存键里带上**生效的搜索源清单**：用户改了「默认搜索源」之后，
       *   同一关键词的命中结果本来就该不一样，不带清单会串台
       *   （与 cachedHomeFallback 的键同一个理由）。
       */
      const sources = await searchSources(env, db)
      const res = await cachedEdgeJson(
        env, `suggest/${sources.join('-')}/${q}`, SUGGEST_CACHE_TTL_MS,
        () => searchOnline(q, { sources, limit: 10, pluginPool: env.PLUGIN_POOL }),
        // 空结果不写：多半是上游集体抽风，钉住 10 分钟会让「本来搜得到」的歌消失
        { cacheable: (d) => !!(d && Array.isArray(d.list) && d.list.length) })
      return json({ ok: true, list: (res.list || []).slice(0, 10).map(songForWeb) })
    }

    if (path === '/history') {
      if (method === 'DELETE') {
        const keyword = url.searchParams.get('keyword')
        if (keyword) {
          // 删单条（按关键词，只删当前用户的）
          await db.deleteSearchHistoryByKeyword(env.DB, user.id, keyword)
        } else {
          // 无 keyword 参数：清空当前用户全部搜索历史
          await db.clearSearchHistory(env.DB, user.id)
        }
        return json({ ok: true })
      }
      return json({ ok: true, list: await db.listSearchHistory(env.DB, user.id) })
    }

    /* ---- 播放进度 / 播放历史 ----
     *
     * 一张 play_progress 表两个用途，所以这里也只有两个接口：
     *   POST /progress   客户端上报（节流后每 5s 一次 + 暂停/切歌/播完各一次）
     *   GET  /progress   起播前问一句「上次听到哪了」，没有记录就从 0 开始
     *   GET  /play-history  列表（按最后播放时间倒序）
     *   DELETE /play-history 清空；带 ?id= 只删那一条
     *
     * 「算不算听过」由客户端判（累计播够阈值或播到结尾），服务端只记账 ——
     * 服务端拿不到播放器状态，判断只能靠客户端，放服务端反而是假的权威。
     */
    if (path === '/progress') {
      if (method === 'POST') {
        const body = await readJson(request)
        const song = decodeSongId(body.id)
        if (!song) return bad('无效歌曲 ID')
        await db.upsertPlayProgress(env.DB, user.id, body.id, song, {
          position: body.position,
          duration: body.duration,
          played: !!body.played,
        })
        return json({ ok: true })
      }
      const id = url.searchParams.get('id')
      if (!id) return bad('缺少 id')
      return json({ ok: true, progress: (await db.getPlayProgress(env.DB, user.id, id)) || null })
    }

    if (path === '/play-history') {
      if (method === 'DELETE') {
        await db.clearPlayHistory(env.DB, user.id, url.searchParams.get('id') || null)
        return json({ ok: true })
      }
      const limit = Number(url.searchParams.get('limit')) || 200
      return json({ ok: true, list: await db.listPlayHistory(env.DB, user.id, limit) })
    }

    /* ---- 播放地址（探测可用的直链，供客户端直接播放/下载） ---- */
    if (path === '/url') {
      // 诊断用起点（`?perf=1` 时把总耗时一起吐出来，见下面的 perf 分支）
      const perfT0 = Date.now()
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      const quality = url.searchParams.get('q') || '320k'
      // fast=1：只解析直链、不做字节探测，浏览器直连播放用（必须秒回）。
      // 默认：逐候选真拉字节验证，服务端代理播放前先筛掉死链。
      const fast = url.searchParams.get('fast') === '1'
      /**
       * `nocache=1`：这次请求**跳过直链缓存**，强制重新解析。
       *
       * 为什么必须有这个口子（而不是「反正缓存烂了也能兜住」）：
       * 缓存里那条地址一旦提前失效，客户端按常规流程重问 `/url` —— 如果还是先查缓存，
       * 就**又命中同一条死链**，客户端把它当「服务端给的唯一地址」试一遍再失败，
       * 整首歌就卡在这条死链上绕不出来。
       * `/stream` 早就有对应机制（`retry=1` 时跳过候选缓存），`/url` 这边现在才补齐。
       *
       * 客户端的用法：**首次**请求走缓存（命中就秒回），**重问**时带 `nocache=1`。
       */
      const noCache = url.searchParams.get('nocache') === '1'
      const candKey = streamCandKey(song, quality)
      /**
       * 先看「刚刚真的取到过音频字节」的那条直链缓存（跨 isolate，5 分钟）。
       *
       * 命中的意义：同一首歌第二次点开时，服务端已经知道哪个地址能出声，
       * 不必再把「插件池逐个解析 + 逐个 Range 探测」重跑一遍（实测 0.6~3.5 秒）。
       * 这正是「点开慢」里最实在的那一刀。
       *
       * 只回这一条（urls 为 null）：它是**验证过**的地址，客户端一级一条足够；
       * 万一已经过期，客户端的 plugin / server 两级兜底照旧接得住。
       */
      const cachedUrl = noCache ? null : await getStreamUrl(env, candKey)
      /**
       * ⚠ 只把**本宿主播得了的形态**交出去：网页里 http 直链会被浏览器当混合内容
       * 拦掉（见 http.js 的 allowHttpAudio），交出去等于让客户端白试一条、
       * 再降一级 —— 比不给还慢。判据复用同一个开关，不在这里另立一套。
       * （`/stream` 那条读取路径不受此限：字节由服务端代拉，http 无所谓。）
       *
       * ★ 2026-10-23 补 `http=1`（客户端主动声明能力）。
       *
       * `allowHttpAudio()` 看的是 `globalThis.LX_ALLOW_HTTP_AUDIO` —— 那个标志
       * **只有 WebView 壳里才置位**，CF 上恒为 false。于是缓存里那条
       * 「不带 fast、逐条 Range 探测通过」的 http 直链，读的时候一律被挡掉，
       * 安卓壳每次都要重新解析一遍 —— 缓存写了等于没写（实测就是这样：
       * `/url` 探测返回 http，紧接着 `/url?fast=1` 却没命中）。
       *
       * 而安卓壳完全能播 http：manifest 里 `usesCleartextTraffic="true"`，
       * 音频还走原生 AudioProxy（OkHttp 直接拉上游）。所以由客户端声明能力、
       * 服务端照办，比服务端猜 UA 可靠得多。
       */
      const allowHttp = allowHttpAudio() || url.searchParams.get('http') === '1'
      if (cachedUrl && (/^https:\/\//i.test(cachedUrl) || allowHttp)) {
        return json({ ok: true, url: cachedUrl, urls: null, from: '缓存直链', verified: true, tried: [] })
      }
      let r
      if (fast) {
        r = await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL, { pinnedOrder: hasPinnedOrder(song.source) })
      } else {
        r = await resolvePlayableUrl(song, quality, env.PLUGIN_POOL)
      }
      /**
       * ⚠ 把 /url 解析出来的候选**同时写进代理流的候选缓存**。
       *
       * 为什么这一条很重要（CF 版「歌单第一首歌播不出来」的根因之一）：
       * 播放一首歌时前端先打 `/url?fast=1`（direct 级），拿到候选直接喂 <audio>；
       * 直连因为防盗链 / 无 https 而失败时，<audio> 落到下一级——远程模式下就是
       * `/api/stream`。此刻服务端如果**不知道**刚才 /url 已经解析出哪些候选，
       * 就会从零开始重新解析一遍（冷态 2~3 秒，正好踩过 Worker 的响应窗口），
       * 于是 502 / 静音。
       *
       * 写缓存之后，/stream 直接复用这一份，几乎瞬时就能建流。
       * 缓存键与 /stream 里的完全一致（见 streamCandKey），两边天然对得上。
       */
      // 第三个参数是「这批候选探通过没有」：fast 模式下 `unverified` 为真，
      // 记下来给 /stream 判断能不能拿它当唯一候选（见 /stream 的 preferVerified）。
      if (r.url) setStreamCand(candKey, r.urls && r.urls.length ? r.urls : [{ url: r.url, from: r.from }], !r.unverified)
      if (!r.url) return json({ ok: false, error: r.error || '无可用播放地址', errors: r.tried }, 404)
      /**
       * `?perf=1`：把这次解析的**分阶段耗时**一起吐出来。
       *
       * 为什么要有：`/url?fast=1` 是客户端起播的第一跳，「点开要等几秒」时
       * 光看一个总数没法判断是插件慢、跨源搜索慢、还是探测超时在空等。
       * 与 `/stream?debug=1` 是同一套思路 —— 不靠猜。
       *
       * 只加一个字段，不影响任何既有调用方（不带 `perf` 时行为完全不变）。
       */
      if (url.searchParams.get('perf') === '1') {
        return json({
          ok: true, url: r.url, urls: r.urls || null, from: r.from,
          verified: !r.unverified, tried: r.tried,
          perf: {
            totalMs: Date.now() - perfT0,
            ...(r.perfMs || {}),
            ...(r.crossPerf ? { crossSearchMs: r.crossPerf.search, crossResolveMs: r.crossPerf.resolve, crossProbeMs: r.crossPerf.probe } : {}),
          },
        })
      }
      /**
       * ★ 把这条直链写进 5 分钟缓存 —— 也就是「让 `/url` 也享受 `/stream` 的待遇」。
       *
       * 以前只有 `/stream` **真拉到音频字节**后才写（见下方 setStreamUrl 的调用），
       * 而 `/url` 这条最常走的路径从不写。可 V2.114 起客户端走本地 `AudioProxy`
       * 直连 CDN，基本不碰 `/stream` —— 结果这条缓存**几乎永远不会被写入**，
       * 每首歌每次都把「插件池解析」重跑一遍（实测 2~4 秒）。
       *
       * ⚠ 条件必须带 `!r.unverified`：`fast=1` 模式下服务端**一个字节都没探过**，
       * 写进去等于让下一次直接拿到一条死链 —— 那比不缓存更糟（客户端会把它当
       * 唯一地址试，然后才降级，白白多花一轮）。只有不带 fast 那一趟
       * （`resolvePlayableUrl` 逐条 Range 探测通过）才配写。
       */
      if (!r.unverified) setStreamUrl(env, candKey, r.url)
      return json({ ok: true, url: r.url, urls: r.urls || null, from: r.from, verified: !r.unverified, tried: r.tried })
    }

    // 代理播放：直接给 <audio> 用，规避跨域与 IP 绑定；逐个候选取流，任何一个源可用即可播
    if (path === '/stream') {
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      const quality = url.searchParams.get('q') || '320k'
      const rangeHeader = request.headers.get('range') || ''
      // 诊断开关：?debug=1 时不返回音频，而是把「候选解析 + 逐个拉流」的耗时明细吐出来。
      // 起播慢的时候不靠猜，直接看是哪一级、哪一个源在拖。
      if (url.searchParams.get('debug') === '1') {
        const t0 = Date.now()
        const marks = []
        const trace = []
        const pre = await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL, { pinnedOrder: hasPinnedOrder(song.source) }).catch((e) => ({ error: String(e) }))
        marks.push({ step: 'resolveMusicUrlFast', ms: Date.now() - t0, unverified: pre.unverified, urls: (pre.urls || []).map(u => ({ from: u.from, size: u.size, url: u.url.slice(0, 90) })) })
        const thunks = musicUrlCandidateList(song, quality, env.PLUGIN_POOL)
        marks.push({ step: '候选总数', n: thunks.length })
        let ts = Date.now()
        for (let i = 0; i < thunks.length; i++) {
          const s0 = Date.now()
          let cand = null
          try { cand = await thunks[i]() } catch (e) { cand = { url: null, err: String(e) } }
          const dt = Date.now() - s0
          ts += dt
          if (cand && cand.url) trace.push({ i, from: cand.from, resolveMs: dt, url: cand.url.slice(0, 90) })
        }
        marks.push({ step: '串行解析全部候选', ms: Date.now() - t0, candidates: trace })
        return json({ ok: true, song: { name: song.name, source: song.source, id: song.id }, marks })
      }
      const candKey = streamCandKey(song, quality)
      /**
       * `retry=1` 表示这次请求是**降级重试**（浏览器首次 Range 探测失败后重连）。
       *
       * 此时缓存里那份候选已经被试过一遍且失败了 —— 再拿同一份只会同样失败，
       * 还会白耗一次预算。所以重试时跳过缓存、重新解析一轮。
       * ⚠ 重试这一轮**不写回缓存**：这份新候选同样没经过验证，钉进缓存只会让
       * 接下来 60 秒的请求都取它，把一次偶发失败放大成一段时间的持续失败。
       *
       * 这是 CF 版「第一首歌播不出来」的第二道保险：第一次失败往往是因为
       * 候选恰好是条死链/防盗链地址，换一批通常就好了。
       */
      const isRetry = url.searchParams.get('retry') === '1'
      const candHit = isRetry ? null : getStreamCand(candKey)
      let preferUrls = candHit ? candHit.urls : null
      /**
       * 这批候选**探通过没有**。
       *
       * 只有 verified 才配关掉完整候选列表（`skipCandidateList`）——
       * 未验证的候选是「解析出来了、但预算到点没来得及探」，失败概率很高；
       * 拿它当唯一候选，等于把一整首歌钉死在一批没验证过的地址上。
       *
       * 这正是「歌单前几首退到服务端就播不出来」的那一半原因：客户端把
       * `/url?fast=1` 给的未验证候选逐条试败 → 退到 `/stream` → `/stream` 又从
       * 60 秒缓存里读到**同一批** → 并且因为「有 preferUrls」把完整候选列表关掉 →
       * 一条活路都没有，只能 502。现在未验证的一批只当「先试一下」，试不通照样
       * 铺开完整候选列表（重新解析 + 逐个真拉字节）。
       */
      let preferVerified = candHit ? candHit.verified === true : false
      /**
       * 第二优先：**跨 isolate** 的「已经吐过音频字节」直链缓存（5 分钟）。
       *
       * 与上面那份 60 秒候选缓存的分工见 streamUrlCache 的说明 —— 简单说：
       * 那份解决「一次播放内部的 /url → /stream 交接」，这份解决
       * 「同一首歌第二次播放时的重复解析」。
       *
       * ⚠ 命中它时 `skipCandidateList` **必须是 false**：这份地址可能已经过期，
       *   死了要能退回常规候选列表，而不是直接掉进跨源兜底（那是另一个语义）。
       */
      let fromUrlCache = false
      if (!isRetry && !preferUrls) {
        const hitUrl = await getStreamUrl(env, candKey)
        if (hitUrl) {
          preferUrls = [{ url: hitUrl, from: '缓存直链' }]
          fromUrlCache = true
        }
      }
      /**
       * 这次预筛**有没有真的跑过跨源**。
       *
       * `resolveMusicUrlFast` 自带跨源兜底（V2.19 起，见 lib/stream.js 的
       * `crossSourceResolveFast`）。预筛已经跑过跨源，`openAudioStream` 里
       * 再跑一次就是纯重复 —— 多一次全平台搜索换同样的结果。
       *
       * ⚠ 判据必须是 `pre.crossTried`，**不能是「预筛跑过了」**。
       * 预筛也可能压根没触发跨源（本平台候选看着还行、只是没探通），
       * 这时下游要是也不许跨，这首歌就彻底没有跨源机会了 ——
       * 2026-10-24 在 Docker 上实测到的正是这个：`/url` 把假中转站交出去，
       * 客户端播不出退到 `/stream`，而 `/stream` 因为「预筛跑过了」不再跨源，
       * 于是一路 502。用户看到的就是「同一首歌时好时坏」。
       */
      let preCrossTried = false
      if (!preferUrls) {
        try {
          const pre = await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL, { pinnedOrder: hasPinnedOrder(song.source) })
          preCrossTried = pre.crossTried === true
          if (pre.urls && pre.urls.length) {
            preferUrls = pre.urls
            preferVerified = !pre.unverified
            if (!isRetry) setStreamCand(candKey, preferUrls, preferVerified)
          }
        } catch { /* 预筛失败退化成原逻辑 */ }
      }
      const r = await openAudioStream(song, quality, env.PLUGIN_POOL, {
        rangeHeader,
        preferUrls,
        // 预筛已真的跨过源 → 下游不必再跨（见 preCrossTried 的说明）
        allowCrossSource: !preCrossTried,
        // ⚠ 只有**已验证**的候选才配关掉完整候选列表。
        // 已验证 = 服务端真的探通过字节，这批地址的命中率高，再铺一遍候选列表
        // 只是把预算花在重复解析上 —— 那正是 CF 上 502 的来源。
        // 未验证的一批（/url?fast=1 预算到点交出去的）不关：它失败概率高，
        // 关掉就等于把整首歌钉死在一批没探过的地址上。
        // 「跨 isolate 的直链缓存」也不关 —— 它可能过期，要留退路（见 fromUrlCache）。
        skipCandidateList: !!preferUrls && !fromUrlCache && preferVerified,
      })
      if (!r.ok) {
        // 缓存那条死了 → 把烂缓存丢掉，下一次请求走正常解析，别让坏地址顶满 5 分钟
        if (fromUrlCache) dropStreamUrl(env, candKey)
        return json({ ok: false, error: r.error, errors: r.errors }, 502)
      }
      /**
       * 真的取到音频字节了 → 记下这条地址。
       *
       * 这是「播放插件缓存」的写入点：只有**已经被验证过能出声**的地址才配进缓存，
       * 没验证过的候选（/url?fast=1 那一批）不进 —— 否则等于把一个可能已经烂掉的
       * 地址钉住 5 分钟，把一次偶发失败放大成一段时间的持续失败。
       */
      if (r.url) setStreamUrl(env, candKey, r.url)
      return r.response
    }

    if (path === '/lyric') {
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      /**
       * 歌词缓存。
       *
       * 前端**每加载一首歌都会问一次**（public/js/player.js 的 loadLyric），
       * 而歌词是「同一首歌永远同一份」的东西 —— 不缓存等于每次起播都白跑一趟
       * 插件 + 平台接口。
       *
       * ⚠ TTL 分两档（`ttlFor`）：
       *   有歌词 → 12 小时。歌词基本不会变。
       *   没歌词 → 5 分钟。这个 null 多半是插件临时抽风（而不是真的没有），
       *            钉住半天会让用户以为「这首歌的歌词没了」。
       *   所以「没歌词」也写缓存（否则每次都要重新问一遍），但只写短 TTL。
       *
       * 缓存键用「源 + 平台内 id」：song.id 是本项目自己编的（含源前缀），
       * 拿它当键更稳，但同一首歌在不同音质下 id 相同 —— 歌词与音质无关，正合适。
       */
      const lyric = await cachedEdgeJson(
        env, `lyric/${song.source}/${song.songmid || song.id || ''}`, LYRIC_CACHE_TTL_MS,
        () => resolveLyric(song, env.PLUGIN_POOL),
        {
          cacheable: () => true,
          ttlFor: (d) => (d ? LYRIC_CACHE_TTL_MS : LYRIC_MISS_CACHE_TTL_MS),
        })
      return json({ ok: true, lyric: lyric || null })
    }

    if (path === '/cover') {
      const song = decodeSongId(url.searchParams.get('id'))
      const target = url.searchParams.get('url')
      let src = target || (song && song.img)
      if (!src) return bad('无封面', 404)
      let parsedSrc
      try { parsedSrc = new URL(src) } catch { return bad('封面地址非法', 400) }
      if (!/^https?:$/.test(parsedSrc.protocol)) return bad('封面地址非法', 400)
      if (isBlockedHost(parsedSrc.hostname)) return bad('目标地址被禁止', 403)

      // 网易云支持官方缩略图参数：800x800 原图 150KB+，200x200 只剩 10KB 左右，
      // 观感没差别但传输量差一个数量级。
      const size = safeInt(url.searchParams.get('size'), 0)
      if (size > 0 && size <= 1200 && /music\.126\.net/i.test(src)) {
        src += (src.indexOf('?') >= 0 ? '&' : '?') + 'param=' + size + 'y' + size
      }

      // 边缘缓存：同一张封面第二次访问直接命中，不再回源。
      // cacheKey 只用源地址构造（不含 token），否则每个会话一份缓存等于没缓存。
      const cache = edgeCache
      const cacheKey = new Request('https://cover.cache.internal/' + encodeURIComponent(src), { method: 'GET' })
      const cached = await cache.match(cacheKey)
      if (cached) return cached

      /**
       * 取图：https 失败就换 http 再试一次。
       *
       * 国内图床的证书烂掉是常态 —— 实测 kuwo 的 img2.sycdn.kuwo.cn
       * 从 Cloudflare 出口请求直接返回 **526（源站证书无效）**，
       * 同一张图换成 http 就是 200。以前的写法只 fetch 一次，
       * 于是这些封面在网页端永远破图（直连 526 → 退到代理 → 代理也 526）。
       * 服务端取图不存在混合内容限制，降协议这件事在这儿做最合适。
       *
       * 另外把异常也兜住：以前 fetch 抛错会冒到最外层变成 500
       * 「internal error」，排查时完全看不出是哪个域名的问题。
       */
      async function fetchCover(url) {
        try {
          return await outboundFetch(url, { headers: { Referer: parsedSrc.origin + '/' } })
        } catch {
          return null
        }
      }
      let upstream = await fetchCover(src)
      if (!upstream || !upstream.ok) {
        const downgraded = src.replace(/^https:/i, 'http:')
        if (downgraded !== src) {
          const retry = await fetchCover(downgraded)
          if (retry && retry.ok) upstream = retry
        }
      }
      if (!upstream || !upstream.ok) {
        return bad('封面获取失败（源站 ' + (upstream ? 'HTTP ' + upstream.status : '不可达') + '）', 502)
      }
      const res = new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=604800',
          'Access-Control-Allow-Origin': '*',
        },
      })
      await cache.put(cacheKey, res.clone())
      return res
    }

    /* ---- AI 歌单 ---- */

    // 读 AI 配置状态（脱敏，不返回 apiKey 明文；用于前端展示/判断是否已配置）
    if (path === '/admin/ai-config' && method === 'GET') {
      const cfg = await loadAiConfig(env, env.DB)
      return json({
        ok: true,
        configured: cfg.configured,
        provider: cfg.provider,
        protocol: cfg.protocol,
        baseURL: cfg.baseURL,
        model: cfg.model,
        accountId: cfg.accountId,
        hasKey: !!cfg.apiKey,
        providers: Object.values(AI_PROVIDERS).map(p => ({ key: p.key, name: p.name, protocol: p.protocol })),
      })
    }

    // 保存 AI 配置（写 D1 settings；apiKey 只存 D1，不写回响应）
    if (path === '/admin/ai-config' && method === 'POST') {
      const body = await readJson(request)
      const sets = {}
      if (body.provider != null) sets['ai.provider'] = String(body.provider).trim()
      if (body.base_url != null) sets['ai.base_url'] = String(body.base_url).trim()
      if (body.model != null) sets['ai.model'] = String(body.model).trim()
      if (body.account_id != null) sets['ai.account_id'] = String(body.account_id).trim()
      if (body.api_key != null && String(body.api_key).trim() !== '') sets['ai.api_key'] = String(body.api_key).trim()
      for (const [k, v] of Object.entries(sets)) await db.setSetting(env.DB, k, v)
      return json({ ok: true, saved: Object.keys(sets) })
    }

    // AI 连通性测试：用当前配置发一条最小对话，返回成功/失败与耗时
    if (path === '/admin/ai-test' && method === 'POST') {
      const t0 = Date.now()
      try {
        const content = await chatOnce(env, env.DB, {
          messages: [{ role: 'user', content: '请只回复两个字：正常' }],
          temperature: 0.3,
          timeout: 20000,
        })
        return json({ ok: true, reply: String(content).slice(0, 200), latency: Date.now() - t0 })
      } catch (e) {
        return json({ ok: false, error: (e && e.message) || String(e), latency: Date.now() - t0 }, 500)
      }
    }

    // 生成歌单（第一步）：AI 理解意图 → 只输出「歌名 + 歌手」列表。
    // 不在服务端逐首搜索落库 —— 那会让单个请求长达数分钟（AI 生成 + N 首串行搜索），
    // 中间任何一层（浏览器/代理/Worker）都可能中途掐断，用户只看到一句「操作被中止」。
    // 改为前端拿到列表后逐首调 /suggest 匹配（带进度、每个请求都短），最后走 POST /playlist 落库。
    if (path === '/ai-playlist' && method === 'POST') {
      const body = await readJson(request)
      const prompt = String(body.prompt || '').trim()
      if (!prompt) return bad('请输入描述（关键字或一句话）')
      const count = Math.max(1, Math.min(Number(body.count) || 20, 100))

      const generated = await generatePlaylist(env, env.DB, { prompt, count })
      if (!generated.songs.length) return bad('AI 未能生成有效歌单，请换个描述试试')

      return json({
        ok: true,
        title: generated.title,
        songs: generated.songs,
        requested: generated.songs.length,
      })
    }

    /* ---- 歌单 ---- */
    if (path === '/playlists' && method === 'GET') {
      return json({ ok: true, list: await db.listPlaylists(env.DB, user.id) })
    }

    if (path === '/playlist' && method === 'GET') {
      const pl = await db.getPlaylist(env.DB, url.searchParams.get('id'), user.id)
      if (!pl) return bad('歌单不存在', 404)
      return json({ ok: true, playlist: { ...pl, songs: pl.songs.map(songForWeb) } })
    }

    if (path === '/playlist/import' && method === 'POST') {
      const body = await readJson(request)
      const raw = String(body.url || '').trim()
      // 短链（网易 163cn.tv、汽水 qishui.douyin.com/s/…）要联网展开才知道真正的 id，
      // 所以这里用 resolvePlaylistRef 而不是同步的 parsePlaylistRef。
      const ref = await resolvePlaylistRef(raw, body.source || null)
      if (!ref) return bad('无法识别歌单链接或 ID')
      if (ref.expandFailed) {
        return bad('这个分享链接已经失效或打不开（分享短链通常几天就过期）。请在 App 里重新复制一条最新链接再试。')
      }
      // 输入问题（贴的是单曲链接 / 歌单没公开 …）按 400 回并带上人话；
      // 上游真炸了（页面结构变了、网络断了）仍然抛出去走 500 —— 两者要能分开看。
      let data
      try {
        data = await importPlaylist(ref)
      } catch (e) {
        if (e && e.userError) return bad(e.message)
        throw e
      }

      /*
        汽水音乐这一类「只有曲目、没有可播直链」的歌单走**两段式**。
        
        它给不出我们能播的 id（我们没有汽水的取流链路），所以不能在这里直接落库 ——
        真存进去，用户得到的是一个每首点开都放不出声的歌单，比「导入失败」更糟。
        改为把「歌名 + 歌手」清单交回前端，由前端逐首调 /suggest 在现有音源里匹配
        （与 AI 歌单完全同一条路径：带进度、每首一个短请求），匹配完再建歌单。
        
        落库这一步刻意放在前端，不是为了省事：匹配 N 首要发 N 个请求，
        塞进这一个请求里就会变成一个长请求，中途被掐断就全丢了 —— AI 歌单当初
        就是被这个坑逼成两段式的。
      */
      if (data.matchNeeded) {
        if (!data.songs.length) return bad('歌单为空或解析失败')
        return json({
          ok: true,
          matchNeeded: true,
          detected: ref,
          source: data.source,
          name: String(data.name || '').slice(0, 120),
          cover: data.cover || '',
          songs: data.songs.map(s => ({ name: s.name, singer: s.singer || '', albumName: s.albumName || '' })),
          total: data.songs.length,
        })
      }

      if (!data.songs.length) return bad('歌单为空或解析失败')
      const playlist = await db.createPlaylist(env.DB, {
        userId: user.id,
        name: String(body.name || data.name).slice(0, 120),
        // 平台给的歌单封面优先（那是歌单自己的设计图），没有就退回第一首歌的专辑封面
        cover: data.cover || firstSongCover(data.songs),
        source: data.source,
        sourceId: data.sourceId,
        songs: data.songs,
      })
      return json({
        ok: true,
        playlist: { ...playlist, songs: playlist.songs.map(songForWeb) },
        detected: ref,
        total: data.songs.length,
      })
    }

    if (path === '/playlist' && method === 'POST') {
      const body = await readJson(request)
      const name = String(body.name || '新建歌单').slice(0, 120)
      const songs = Array.isArray(body.songs) ? body.songs.map(s => decodeSongId(s.id || s)).filter(Boolean) : []
      // 封面：调用方给了就用，没给就拿第一首歌的专辑封面 —— 见 firstSongCover 的注释
      const cover = String(body.cover || '').trim() || firstSongCover(songs)
      const playlist = await db.createPlaylist(env.DB, { userId: user.id, name, cover, songs })
      return json({ ok: true, playlist: { ...playlist, songs: playlist.songs.map(songForWeb) } })
    }

    if (path === '/playlist/add' && method === 'POST') {
      const body = await readJson(request)
      const pl = await db.getPlaylist(env.DB, body.playlistId, user.id)
      if (!pl) return bad('歌单不存在', 404)
      const ids = Array.isArray(body.songIds) ? body.songIds : [body.songId]
      const songs = ids.map(i => decodeSongId(i)).filter(Boolean)
      await db.appendSongs(env.DB, body.playlistId, songs)
      return json({ ok: true, added: songs.length })
    }

    if (path === '/playlist' && method === 'DELETE') {
      await db.deletePlaylist(env.DB, url.searchParams.get('id'), user.id)
      return json({ ok: true })
    }

    // 重命名（自建歌单）
    if (path === '/playlist/rename' && method === 'POST') {
      const body = await readJson(request)
      const name = String(body.name || '').trim().slice(0, 120)
      if (!name) return bad('歌单名不能为空')
      const pl = await db.getPlaylist(env.DB, body.playlistId, user.id)
      if (!pl) return bad('歌单不存在', 404)
      await db.renamePlaylist(env.DB, body.playlistId, user.id, name)
      return json({ ok: true, name })
    }

    /**
     * 调整歌单内某首歌的位置（自建歌单的手动排序）。
     *
     * 用**下标**而不是歌曲 ID：一张自建歌单里同一首歌被加两次是合法的，
     * 按 ID 定位会把两行指向同一处、越拖越乱。下标天然区分重复项。
     * 收的是「从 from 挪到 to」，服务端自己算出完整新顺序再整表重写 ——
     * 客户端不必把整个列表传上来（列表长了也不会超请求体，且不会因为
     * 客户端手里的列表过期而把歌单写坏）。
     */
    if (path === '/playlist/move' && method === 'POST') {
      const body = await readJson(request)
      const pl = await db.getPlaylist(env.DB, body.playlistId, user.id)
      if (!pl) return bad('歌单不存在', 404)
      const from = Number(body.from)
      const to = Number(body.to)
      const arr = pl.songs.slice()
      const okIndex = (n) => Number.isInteger(n) && n >= 0 && n < arr.length
      if (!okIndex(from) || !okIndex(to)) return bad('位置无效，请刷新后重试')
      if (from !== to) {
        const [item] = arr.splice(from, 1)
        arr.splice(to, 0, item)
        await db.replacePlaylistSongs(env.DB, body.playlistId, arr)
      }
      return json({ ok: true, songs: arr.map(songForWeb) })
    }

    if (path === '/playlist/remove-song' && method === 'POST') {
      const body = await readJson(request)
      const pl = await db.getPlaylist(env.DB, body.playlistId, user.id)
      if (!pl) return bad('歌单不存在', 404)
      await db.removePlaylistSong(env.DB, body.playlistId, body.index)
      return json({ ok: true })
    }

    /* ---- 收藏 ---- */
    if (path === '/favorites') {
      return json({ ok: true, list: (await db.listFavorites(env.DB, user.id)).map(songForWeb) })
    }

    if (path === '/favorite' && method === 'POST') {
      const body = await readJson(request)
      const song = decodeSongId(body.id)
      if (!song) return bad('无效歌曲 ID')
      await db.addFavorite(env.DB, user.id, body.id, song)
      return json({ ok: true, favorited: true })
    }

    if (path === '/favorite' && method === 'DELETE') {
      const id = url.searchParams.get('id')
      await db.removeFavorite(env.DB, user.id, id)
      return json({ ok: true, favorited: false })
    }

    /* ---- 平台体检（实测各平台在当前出口是否可用） ---- */
    /* ---- 管理员：平台体检 ---- */
    if (path === '/admin/health') {
      const rows = await platformHealth()
      return json({ ok: true, list: rows, checkedAt: new Date(healthStore.ts).toISOString() })
    }

    /* ---- 音源 / 插件 ---- */
    if (path === '/sources') {
      const summary = env.PLUGIN_POOL.summary()
      const bySource = {}
      for (const p of summary) {
        if (!p.ok) continue
        for (const s of p.sources) {
          if (!bySource[s]) bySource[s] = { plugins: [], qualities: [] }
          bySource[s].plugins.push(p.name)
          const q = env.PLUGIN_POOL.qualityMap(s)
          for (const item of q) if (!bySource[s].qualities.includes(item)) bySource[s].qualities.push(item)
        }
      }
      /**
       * 插件专有源 —— 不在 ALL_SOURCES 里、由插件自己注册的源（如 qsvip 汽水VIP）。
       *
       * 管理页的「默认搜索源」要把它们画出来，否则用户根本没法把汽水勾上；
       * 前端也靠这份名单把 `qsvip` 显示成「汽水VIP」，而不是一串字母 id。
       * `searchable` 只说「能不能被搜」；取流能力看 actions 里有没有 musicUrl。
       */
      const pluginSources = pluginSourceList(env)
      return json({
        ok: true,
        active: await searchSources(env, db),
        // order 必须跟着一起给。
        //
        // 管理页的「默认搜索源」列表就是拿这个接口的结果画的，而列表的**排布**来自
        // search.sources.order（含未勾选的平台）。这里漏给过一次：POST 明明写进 D1 了，
        // 页面取回来却没有 order 可用，于是每次都退回 platforms 的自然顺序 ——
        // 用户看到的现象就是「拖完一保存，刷新还是原样」，而接口日志全是 200。
        // 只要这个列表还从 /sources 画，order 就不能省。
        order: await sourceOrder(env, db),
        platforms: ALL_SOURCES.map(k => ({
          key: k,
          name: SOURCE_META[k].name,
          short: SOURCE_META[k].short,
          pluginSupported: !!bySource[k],
          plugins: (bySource[k] && bySource[k].plugins) || [],
          qualities: (bySource[k] && bySource[k].qualities) || [],
        })),
        pluginSources,
      })
    }

    /* ---- 插件评分与调度（管理端「音源与插件」页用） ---- */
    //
    // 三份数据一起给，因为它们的口径不同、互相补位：
    //   load/byPlatform —— 构建机实测（tools/plugin-score.mjs 产出），决定自动模式的顺序；
    //   plugins         —— 线上这次 isolate 里的真实加载结果（可能与构建机不同：出口不同）；
    //   live            —— 应用「停用」过滤后，当前真正会按什么顺序去试。
    // 只给其中任意一份，界面都会出现「明明写成功却说加载失败」这类自相矛盾的显示。
    if (path === '/admin/plugin-scores') {
      const live = {}
      for (const k of ALL_SOURCES) {
        live[k] = env.PLUGIN_POOL.musicUrlPlugins(k, 'musicUrl').map(p => p.id)
      }
      /**
       * 评分的来源有二，优先级：**运行时实测 > 构建期实测**。
       *
       * 构建期那份是在我的机器上测的，容器/其他出口跑起来未必一致；
       * 而 Docker 版会自己定期重评并落库（见 server/plugin-rescore.mjs）。
       * 有运行时那份就用它 —— 否则界面上显示的是「构建机的成绩」，
       * 却拿它来解释「你服务器上为什么先试这个插件」，两边对不上。
       */
      const runtime = await readRuntimeScores(env, db)
      const useRuntime = !!(runtime && runtime.byPlatform)
      const srcMeta = useRuntime ? runtime : PLUGIN_SCORES
      const load = useRuntime ? (runtime.load || {}) : PLUGIN_LOAD
      return json({
        ok: true,
        meta: {
          generatedAt: srcMeta.generatedAt || null,
          measuredFrom: srcMeta.measuredFrom || null,
          keywords: srcMeta.keywords || [],
          // 让界面能标出「这份成绩是在哪台机器上测的」—— 构建机 ≠ 你的服务器
          source: useRuntime ? 'runtime' : 'build',
          unmeasured: srcMeta.unmeasured || [],
        },
        prefs: await readPluginPrefs(env, db),
        load,
        byPlatform: srcMeta.byPlatform || {},
        live,
        rescore: await readRescoreState(env, db),
        plugins: env.PLUGIN_POOL.summary().map(p => ({
          id: p.id, name: p.name, ok: !!p.ok, error: p.error || null,
          // origin：builtin = 构建期内置；user = 用户在管理端/App 里导入的。
          // 界面据此只给「用户导入」的那些显示删除按钮。
          origin: p.origin || 'builtin',
          sources: p.sources || [], version: p.version || null,
          bytes: p.bytes || 0,
        })),
        platforms: ALL_SOURCES.map(k => ({ key: k, name: SOURCE_META[k].name, short: SOURCE_META[k].short })),
      })
    }

    /**
     * 插件评分：查状态 / 手动触发一轮。
     *
     * 这个接口**只在自托管（Docker）下真正能跑** —— 评分要起子进程、要写数据目录，
     * Cloudflare Worker 两样都没有（请求时长上限几分钟、文件系统只读且无子进程）。
     * 所以那边如实返回 `supported: false` + 一句能指导下一步的理由，
     * 而不是假装支持然后 500。用户看到「换个宿主才行」比看到 500 有用得多。
     *
     * ── 为什么默认「受理即返回」而不是等它跑完 ────────────────────────
     * 一轮评分要真打各音乐平台，**几分钟**。如果 POST 一直挂着等结果：
     *  · 用户界面上按钮转几分钟，中途刷新/切页签就断了，他会以为失败然后重点；
     *  · 反代（Lucky / Nginx）默认 60s 就会掐断长请求，用户拿到 504；
     *  · 而服务端那轮其实**还在跑**，两边状态彻底不一致。
     * 所以默认行为改成：立刻回 202（已经开始），界面上**轮询** /admin/plugin-rescore
     * 看 live.running 与上轮结果。想要同步语义（脚本/命令行）加 `?wait=1`。
     */
    if (path === '/admin/plugin-rescore') {
      if (method === 'POST') {
        const sch = env.RESCORE
        if (!sch || typeof sch.run !== 'function') {
          return bad('当前宿主不支持运行时评分（需要自托管/Docker 版）；'
            + '线上版请用 `node tools/plugin-score.mjs` 在本地实测后重新部署', 501)
        }
        // 已经在跑：这不是错误，也不该再起一轮 —— 409 让前端就地去轮询状态
        if (sch.running) {
          return json({ ok: false, skipped: true, reason: '已有一轮评分正在进行中', status: await readRescoreState(env, db) }, 409)
        }

        const wait = url.searchParams.get('wait') === '1'
        if (wait) {
          const r = await sch.run('manual')
          if (r.skipped) return json({ ok: false, skipped: true, reason: r.reason, status: await readRescoreState(env, db) }, 409)
          return json({
            ok: !!r.ok, error: r.error || null, elapsedMs: r.elapsedMs || null,
            status: await readRescoreState(env, db),
          })
        }

        /**
         * 受理即返回。**故意不 await** —— 但也不能把 reject 丢掉：
         * 调度器内部已经保证 run() 永不 reject，这里再挂个 catch 是双保险
         * （将来谁改了调度器，也不会变成未处理拒绝把 Node 弄崩）。
         */
        sch.run('manual').catch(() => { /* 调度器内部已兜底并记状态 */ })
        return json({ ok: true, accepted: true, status: await readRescoreState(env, db) }, 202)
      }
      return json({ ok: true, status: await readRescoreState(env, db) })
    }

    // 读写插件调度偏好（管理端）
    if (path === '/admin/plugin-prefs') {
      if (method === 'POST') {
        const body = await readJson(request)
        const next = normalizePrefs({ mode: body.mode, order: body.order, disabled: body.disabled })
        await db.setSetting(env.DB, PLUGIN_PREFS_SETTING, JSON.stringify(next))
        const applied = typeof env.PLUGIN_POOL.setUserPrefs === 'function'
          ? env.PLUGIN_POOL.setUserPrefs(next)
          : null
        prefsCache = { ts: Date.now(), data: next } // 不等缓存过期，保存即生效
        return json({ ok: true, prefs: next, applied })
      }
      return json({ ok: true, prefs: await readPluginPrefs(env, db) })
    }

    // 读写「默认搜索源」（逗号分隔，如 "kg,wy,kw"）。管理端。
    //
    // 一次收两种信息：sources=勾选了谁（生效），order=整列的排布（仅展示）。
    // 只传 sources 也照常工作 —— 老版本前端、只改勾选的场景都不用动。
    if (path === '/admin/search-sources') {
      if (method === 'POST') {
        const body = await readJson(request)
        const raw = String(body.sources || '').trim()
        const keys = raw ? raw.split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean) : []
        // 去重：重复的 key 会让同一个平台被搜两次（结果里出现两份去重前的重复项），
        // 界面上正常点不出来，但手工调接口 / 旧数据里是有的。
        const known = ALL_SOURCES.concat(pluginSearchSourceKeys(env))
        const valid = []
        for (const k of keys) if (known.includes(k) && !valid.includes(k)) valid.push(k)
        if (keys.length && !valid.length) return bad(`未识别到有效音源（可用：${known.join('/')}）`)
        await db.setSetting(env.DB, DEFAULT_SOURCES_SETTING, valid.join(','))
        if (body.order != null) {
          await db.setSetting(env.DB, SOURCES_ORDER_SETTING, normalizeSourceOrder(body.order, pluginSearchSourceKeys(env)).join(','))
        }
        return json({
          ok: true,
          active: valid.length ? valid : ALL_SOURCES,
          order: await sourceOrder(env, db),
        })
      }
      return json({
        ok: true,
        active: await searchSources(env, db),
        order: await sourceOrder(env, db),
        all: ALL_SOURCES,
        pluginSources: pluginSourceList(env),
      })
    }

    if (path === '/admin/plugins') {
      return json({ ok: true, list: env.PLUGIN_POOL.summary() })
    }

    /**
     * 手动导入 / 删除音源插件（管理端）。
     *
     * 这是「用户端为什么没有导入按钮」这个问题的正面回答：服务器模式下插件跑在
     * 服务端，用户端的插件区只写了一句「需要增删请到管理端」—— 而管理端此前根本
     * 没有这个功能。现在补上，两处都能用：
     *   · 管理端网页（/admin → 音源与插件）
     *   · App 的设置页（远程模式下直接打到这几个接口，见 public/js/app.js）
     *
     * 只在自托管下有真实现：求值插件要 new Function，Cloudflare Worker 只允许
     * 在启动阶段用，请求阶段一律禁止。所以那边如实回 501 并给一句可执行的替代方案。
     */
    if (path === '/admin/plugins/import') {
      if (method === 'POST') {
        if (!env.RESCORE) {
          return bad('当前宿主不支持运行时导入插件（需要自托管/Docker 版）；'
            + '线上版请把插件脚本写进仓库的 plugins/ 目录后重新部署', 501)
        }
        const body = await readJson(request)
        const rawUrl = String(body.url || '').trim()
        if (rawUrl) {
          let host = ''
          try { host = new URL(rawUrl).hostname } catch { return bad('url 不合法') }
          if (isBlockedHost(host)) return bad('目标地址被禁止', 403)
        }
        try {
          const r = await importPlugin(env.DB, { url: rawUrl, script: body.script, name: body.name })
          return json({ ok: true, ...r, list: env.PLUGIN_POOL.summary() })
        } catch (e) {
          // 输入问题（URL 不通、内容不像插件、脚本加载失败）一律回 400 并带原因，
          // 不回 500 —— 这类错误是用户能自己改的，500 只会让人以为是服务端坏了
          if (e && e.userError) return bad(e.message, e.status || 400)
          throw e
        }
      }
      // 删掉必须是 DELETE 语义 —— 早期想到过用 POST 加 action 参数，但那样
      // 反代和日志里「删插件」与「读列表」长得一模一样，误操作没有任何痕迹
      if (method === 'DELETE') {
        if (!env.RESCORE) return bad('当前宿主不支持运行时删除插件（需要自托管/Docker 版）', 501)
        try {
          const r = await removeImportedPlugin(env.DB, url.searchParams.get('id'))
          return json({ ok: true, ...r, list: env.PLUGIN_POOL.summary() })
        } catch (e) {
          if (e && e.userError) return bad(e.message, e.status || 400)
          throw e
        }
      }
      return bad('不支持的方法', 405)
    }

    /**
     * CORS 代理：供浏览器端插件运行时调用（浏览器直接请求音乐平台会被 CORS 拦）。
     * 出于安全，仅允许已登录用户调用，且做协议与响应体大小限制。
     */
    if (path === '/proxy') {
      const target = url.searchParams.get('url')
      if (!target) return bad('缺少 url 参数')
      let parsed
      try { parsed = new URL(target) } catch { return bad('非法 url') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return bad('仅支持 http/https')
      if (isBlockedHost(parsed.hostname)) return bad('目标地址被禁止', 403)

      let options = {}
      if (method === 'POST') {
        const body = await readJson(request, true)
        options = body && body.options ? body.options : {}
      } else {
        const o = url.searchParams.get('options')
        if (o) { try { options = JSON.parse(o) } catch { /* ignore */ } }
      }

      const headers = { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) }
      delete headers['host']
      delete headers['Host']
      let payload
      if (options.form) {
        payload = new URLSearchParams(options.form).toString()
        if (!headers['content-type'] && !headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      } else if (options.body !== undefined && options.body !== null) {
        payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
        if (!headers['content-type'] && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20000)
      try {
        const upstream = await outboundFetch(parsed.toString(), {
          method: options.method || (payload ? 'POST' : 'GET'),
          headers,
          body: payload,
          redirect: 'follow',
          signal: controller.signal,
        })
        const buf = await upstream.arrayBuffer()
        if (buf.byteLength > 8 * 1024 * 1024) return bad('响应体过大', 413)
        return new Response(buf, {
          status: upstream.status,
          headers: {
            'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
            'access-control-allow-origin': '*',
            'x-proxy-status': String(upstream.status),
          },
        })
      } finally {
        clearTimeout(timer)
      }
    }

    /* ---- 管理员：取流诊断（逐个候选源体检） ---- */
    if (path === '/admin/diag') {
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      const quality = url.searchParams.get('q') || '320k'
      const thunks = musicUrlCandidateList(song, quality, env.PLUGIN_POOL)
      const rows = []
      for (let i = 0; i < thunks.length; i++) {
        const row = { idx: i, from: null, url: null, status: 0, contentType: '', bytes: 0, note: '' }
        const t0 = Date.now()
        try {
          const cand = await thunks[i]()
          if (!cand) { row.note = '未返回地址'; rows.push({ ...row, ms: Date.now() - t0 }); continue }
          row.from = cand.from
          row.url = cand.url
          const headers = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Range: 'bytes=0-1023' }
          try { headers.Referer = new URL(cand.url).origin + '/' } catch { /* ignore */ }
          const res = await outboundFetch(cand.url, { headers, redirect: 'follow' })
          row.status = res.status
          row.contentType = res.headers.get('content-type') || ''
          const ab = await res.arrayBuffer()
          row.bytes = ab.byteLength
          const head = new TextDecoder().decode(new Uint8Array(ab.slice(0, 60)))
          row.note = /^[\x20-\x7e\s]*$/.test(head) ? head.replace(/\s+/g, ' ').trim().slice(0, 60) : '（二进制）'
        } catch (e) {
          row.note = 'ERR ' + ((e && e.message) || e)
        }
        rows.push({ ...row, ms: Date.now() - t0 })
      }
      return json({ ok: true, song: { name: song.name, singer: song.singer, source: song.source }, quality, count: rows.length, rows })
    }

    /* ---- 管理员 ----
     *
     * 权限守卫在上面统一做过了（path 以 /admin/ 开头就会过闸），这里不再重复判断。
     */
    if (path.startsWith('/admin/')) {
      if (path === '/admin/stats' && method === 'GET') {
        return json({
          ok: true,
          counts: await db.adminCounts(env.DB),
          plugins: {
            total: env.PLUGIN_POOL.summary().length,
            ready: env.PLUGIN_POOL.summary().filter(p => p.ok).length,
          },
        })
      }

      if (path === '/admin/users' && method === 'GET') {
        return json({ ok: true, list: await db.listUsers(env.DB) })
      }
      if (path === '/admin/users' && method === 'POST') {
        const body = await readJson(request)
        const username = String(body.username || '').trim()
        const password = String(body.password || '')
        if (!username || password.length < 4) return bad('用户名不能为空，密码至少 4 位')
        if (await db.findUserByName(env.DB, username)) return bad('用户名已存在')
        const created = await db.createUser(env.DB, { username, password, isAdmin: body.isAdmin ? 1 : 0 })
        return json({ ok: true, user: { id: created.id, username, isAdmin: !!body.isAdmin } })
      }
      if (path === '/admin/users' && method === 'PATCH') {
        const body = await readJson(request)
        const id = String(body.id || '')
        const target = await db.findUserById(env.DB, id)
        if (!target) return bad('用户不存在', 404)
        if (body.password != null && String(body.password) !== '') {
          const np = String(body.password)
          if (np.length < 4) return bad('新密码至少 4 位')
          await db.updateUserPassword(env.DB, id, np)
        }
        return json({ ok: true })
      }
      if (path === '/admin/users' && method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (id === user.id) return bad('不能删除自己')
        await db.deleteUser(env.DB, id)
        return json({ ok: true })
      }

      // 播放记录：看全站谁在听什么
      if (path === '/admin/play-history' && method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 200
        return json({ ok: true, list: await db.listAllPlayHistory(env.DB, limit) })
      }
      // 清空某个用户的播放记录（必须显式指定 user，避免手滑清全站）
      if (path === '/admin/play-history' && method === 'DELETE') {
        const uid = url.searchParams.get('user')
        if (!uid) return bad('需要 ?user= 指定要清理的用户')
        await db.clearPlayHistory(env.DB, uid)
        return json({ ok: true })
      }
    }

    return bad(`未知接口: ${path}`, 404)
  } catch (e) {
    console.error('[api] 处理失败:', path, e && e.stack || e)
    return bad(String((e && e.message) || e), 500)
  } finally {
    /**
     * 把这一轮攒下的插件在线命中率刷进 edgeCache（跨 isolate 共享）。
     *
     * 放在 `finally` 里而不是某个 return 之前：`/url` 和 `/stream` 各有七八个
     * 出口（缓存命中、perf、错误……），逐个加必然漏。
     *
     * `flush()` 自己判断「攒够 20 次没有」，没攒够就是空操作，所以每个请求
     * 都调一遍没有成本。真正要落盘时走 `env.waitUntil` —— **不能 await**，
     * 那会让响应多等一次 Cache API 往返（Docker 上无所谓，CF 上有 20~40ms）。
     * 没有 waitUntil 的宿主（壳内 / 单测）就让它自己飘着，失败也不影响响应。
     */
    try {
      const p = pluginStats.flush(env)
      if (p && typeof p.then === 'function') {
        if (typeof env.waitUntil === 'function') env.waitUntil(p)
        else p.catch(() => {})
      }
    } catch { }
  }
}

async function readJson(request, optional = false) {
  try {
    const text = await request.text()
    if (!text) return optional ? null : {}
    return JSON.parse(text)
  } catch {
    if (optional) return null
    throw new Error('请求体不是合法 JSON')
  }
}

/** 阻止内网/元数据地址，避免代理被滥用为 SSRF 跳板 */
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')) return true
  if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (h.endsWith('.internal') || h === 'metadata.google.internal') return true
  return false
}

export { currentUser, makeToken, verifyToken }
