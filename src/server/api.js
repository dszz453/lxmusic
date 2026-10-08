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
import { openAudioStream, resolvePlayableUrl, resolveMusicUrlFast } from '../lib/stream.js'
import { outboundFetch } from '../lib/http.js'
import { generatePlaylist, loadAiConfig, chatOnce, AI_PROVIDERS } from '../lib/ai.js'
import { PLUGIN_SCORES } from '../generated/plugin-scores.js'
import { BUNDLED_PLUGINS } from '../generated/plugins.js'
import * as db from '../db.js'
import { importPlugin, removeImportedPlugin } from './plugin-import.mjs'
import { generateDaily, getDaily, pickPrimaryUser, todayBJ } from './daily.js'
import { HOME_KEYWORDS } from './keywords.js'
import { versionInfo } from '../version.js'

const SESSION_TTL = 30 * 24 * 3600 * 1000

/**
 * 读取「默认搜索源」配置（逗号分隔，如 "kg,wy,kw"），过滤出合法源。
 * 优先级：D1 settings `search.sources` > env `DEFAULT_SOURCES` > 全部平台。
 * 用户没选（空值）时返回 ALL_SOURCES，行为与旧版一致。
 */
const DEFAULT_SOURCES_SETTING = 'search.sources'

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

/** 把一串平台 key 归一化成 ALL_SOURCES 的完整排列（过滤非法值、补上缺失的新平台） */
function normalizeSourceOrder(raw) {
  const keys = String(raw || '').split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const out = []
  for (const k of keys) {
    if (ALL_SOURCES.includes(k) && !out.includes(k)) out.push(k)
  }
  for (const k of ALL_SOURCES) if (!out.includes(k)) out.push(k)
  return out
}

async function sourceOrder(env, db) {
  const raw = (await db.getSetting(env.DB, SOURCES_ORDER_SETTING, '')) || ''
  // 没配过就按 DEFAULT_SOURCES（或全部平台）的自然顺序排 —— 与「没改过」时的行为一致
  if (!String(raw).trim()) {
    const fromActive = (await db.getSetting(env.DB, DEFAULT_SOURCES_SETTING, '')) || ''
    const seed = fromActive || (env && env.DEFAULT_SOURCES ? String(env.DEFAULT_SOURCES) : '')
    return normalizeSourceOrder(seed)
  }
  return normalizeSourceOrder(raw)
}

async function searchSources(env, db) {
  const raw = ((await db.getSetting(env.DB, DEFAULT_SOURCES_SETTING, '')) || '').trim()
    || (env && env.DEFAULT_SOURCES ? String(env.DEFAULT_SOURCES) : '')
  if (!raw) return ALL_SOURCES.slice()
  const keys = raw.split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const valid = keys.filter(k => ALL_SOURCES.includes(k))
  return valid.length ? valid : ALL_SOURCES.slice()
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

const edgeCache = {
  async match(key) {
    const c = globalThis.caches && globalThis.caches.default
    if (c) { try { return await c.match(key) } catch { return undefined } }
    const hit = memEdgeCache.get(key.url)
    return hit ? hit.clone() : undefined
  },
  async put(key, res) {
    const c = globalThis.caches && globalThis.caches.default
    if (c) { try { return await c.put(key, res) } catch { return } }
    if (memEdgeCache.size > EDGE_CACHE_MAX) {
      for (const k of Array.from(memEdgeCache.keys()).slice(0, EDGE_CACHE_MAX / 2)) memEdgeCache.delete(k)
    }
    memEdgeCache.set(key.url, res.clone())
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

async function cachedToplists() {
  const key = new Request('https://lx.cache.internal/toplists/wy', { method: 'GET' })
  try {
    const hit = await edgeCache.match(key)
    if (hit) {
      const rec = await hit.json()
      if (rec && Array.isArray(rec.list) && rec.list.length
        && typeof rec.ts === 'number' && Date.now() - rec.ts < TOPLISTS_TTL_MS) {
        return rec.list
      }
    }
  } catch { /* 坏缓存当没命中，继续回源 */ }

  const list = await fetchToplists()
  if (Array.isArray(list) && list.length) {
    try {
      await edgeCache.put(key, new Response(JSON.stringify({ ts: Date.now(), list }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    } catch { /* 缓存写失败不影响本次返回 */ }
  }
  return list
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
    await applyPluginPrefs(env, db)

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
      let daily = null
      try { daily = await getDaily(env.DB) } catch { /* 表还没建等情况，走兜底 */ }

      if (daily && daily.songs.length) {
        // 当天已有 AI 推荐：直接用，首页秒开
        const [charts] = await Promise.all([cachedToplists()])
        return json({
          ok: true,
          keyword: daily.title || '每日推荐',
          charts: pickCharts(charts, 6),
          hot: daily.songs,
          platforms: ALL_SOURCES.map(k => ({ key: k, name: SOURCE_META[k].name, short: SOURCE_META[k].short })),
          errors,
          daily: { generator: daily.generator, generatedAt: daily.generatedAt, date: daily.date },
        })
      }

      // 当天还没有记录：先按旧逻辑给一版兜底结果（不等 AI，AI 生成要 30s+），
      // 同时后台触发生成 —— waitUntil 由 index.js 挂到 env 上，cron 没跑/没配也兜得住。
      const keyword = HOME_KEYWORDS[Math.floor(Date.now() / 86400000) % HOME_KEYWORDS.length]
      const [charts, parsed] = await Promise.all([
        cachedToplists(),
        Promise.resolve(parseQuery(keyword, await searchSources(env, db))),
      ])
      let hot = []
      try {
        const res = await searchOnline(parsed.keyword, { sources: parsed.sources, limit: 24, pluginPool: env.PLUGIN_POOL })
        hot = res.list
        errors.push(...res.errors)
      } catch (e) {
        errors.push(String((e && e.message) || e))
      }
      if (env.waitUntil) {
        try {
          env.waitUntil(generateDaily(env, env.DB, { userId: user.id, toWeb: songForWeb }).catch(() => { /* 后台失败静默，下次再试 */ }))
        } catch { /* 没有 waitUntil（某些替身环境）就跳过 */ }
      }
      return json({
        ok: true,
        keyword,
        charts: pickCharts(charts, 6),
        hot: hot.map(songForWeb),
        platforms: ALL_SOURCES.map(k => ({ key: k, name: SOURCE_META[k].name, short: SOURCE_META[k].short })),
        errors,
      })
    }

    /* ---- 每日推荐 ----
     * GET /daily           当天记录（ready=false 表示还没生成完，前端可提示稍候）
     * POST /daily/refresh  手动刷新：强制重生成（「换一批」按钮）。同步等结果，
     *                      AI 链路 30~90s 属正常，前端要有 loading 态。
     */
    if (path === '/daily' && method === 'GET') {
      const daily = await getDaily(env.DB)
      return json({
        ok: true,
        ready: !!(daily && daily.songs.length),
        title: daily ? daily.title : '',
        generator: daily ? daily.generator : '',
        generatedAt: daily ? daily.generatedAt : 0,
        date: todayBJ(),
        songs: daily ? daily.songs : [],
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
      const charts = await cachedToplists()
      return json({ ok: true, list: charts.filter(c => c.cover) })
    }

    /* ---- 榜单曲目（不落库，用于「排行榜」页直接播放） ---- */
    if (path === '/chart') {
      const id = url.searchParams.get('id') || ''
      const source = url.searchParams.get('source') || 'wy'
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 100) || 100, 300)
      if (!id) return bad('缺少榜单 id')
      const data = await fetchChart({ source, id }, limit)
      if (!data.songs.length) return bad('榜单为空或获取失败')
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

      const parsed = parseQuery(source ? `${source}:${q}` : q, await searchSources(env, db))
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
      const limit = Math.min(safeInt(url.searchParams.get('limit'), 200) || 200, 500)
      if (!source || !id) return bad('缺少 source 或 id')
      let data
      try {
        data = await fetchAlbumTracks(source, id, limit)
      } catch (e) {
        return bad(`专辑曲目获取失败：${(e && e.message) || e}`, 502)
      }
      if (!data.songs.length) return bad('该专辑没有可用曲目', 404)
      return json({
        ok: true,
        album: {
          source: data.source,
          sourceId: data.sourceId,
          name: data.name,
          cover: data.cover || '',
          total: data.songs.length,
          songs: data.songs.map(songForWeb),
        },
      })
    }

    if (path === '/suggest') {
      const q = url.searchParams.get('q') || ''
      if (!q) return json({ ok: true, list: [] })
      const res = await searchOnline(q, { sources: await searchSources(env, db), limit: 10, pluginPool: env.PLUGIN_POOL })
      return json({ ok: true, list: res.list.slice(0, 10).map(songForWeb) })
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
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      const quality = url.searchParams.get('q') || '320k'
      // fast=1：只解析直链、不做字节探测，浏览器直连播放用（必须秒回）。
      // 默认：逐候选真拉字节验证，服务端代理播放前先筛掉死链。
      const fast = url.searchParams.get('fast') === '1'
      const r = fast
        ? await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL)
        : await resolvePlayableUrl(song, quality, env.PLUGIN_POOL)
      if (!r.url) return json({ ok: false, error: '无可用播放地址', errors: r.tried }, 404)
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
        const pre = await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL).catch((e) => ({ error: String(e) }))
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
      const isFirstPull = !rangeHeader || /^bytes=0-$/i.test(rangeHeader.trim())
      let preferUrls = null
      if (isFirstPull) {
        try {
          const pre = await resolveMusicUrlFast(song, quality, env.PLUGIN_POOL)
          // 不论 verified 与否都把候选带上：它们已经被**并行**解析过了。
          // 不带的话下面会退回串行解析，实测同一份列表串行要 15.9 秒（空槽位各等 ~3 秒）。
          if (pre.urls && pre.urls.length) preferUrls = pre.urls
        } catch { /* 预筛失败就退化成原来的串行试错 */ }
      }
      const r = await openAudioStream(song, quality, env.PLUGIN_POOL, {
        rangeHeader,
        preferUrls,
        skipCandidateList: !!preferUrls,
      })
      if (!r.ok) return json({ ok: false, error: r.error, errors: r.errors }, 502)
      return r.response
    }

    if (path === '/lyric') {
      const song = decodeSongId(url.searchParams.get('id'))
      if (!song) return bad('无效歌曲 ID')
      const lyric = await resolveLyric(song, env.PLUGIN_POOL)
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
        const valid = []
        for (const k of keys) if (ALL_SOURCES.includes(k) && !valid.includes(k)) valid.push(k)
        if (keys.length && !valid.length) return bad(`未识别到有效音源（可用：${ALL_SOURCES.join('/')}）`)
        await db.setSetting(env.DB, DEFAULT_SOURCES_SETTING, valid.join(','))
        if (body.order != null) {
          await db.setSetting(env.DB, SOURCES_ORDER_SETTING, normalizeSourceOrder(body.order).join(','))
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
