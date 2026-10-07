#!/usr/bin/env node
/**
 * Docker / 自托管入口。
 *
 * 与 Cloudflare 版的关系：**同一份 src/**。区别只有「谁来当宿主」——
 *
 *   Cloudflare Worker            Docker
 *   ------------------------     ---------------------------
 *   平台路由 /api /rest          这个文件自己路由
 *   Static Assets 发 public/      server/static.mjs 发
 *   D1                            node:sqlite（server/d1-sqlite.mjs）
 *   wrangler.toml [vars]          环境变量（见 docker-compose.yml）
 *   模块顶层求值插件               一样（保持行为一致，别让两个宿主跑出两种结果）
 *
 * 为什么不是「另外写一个后端」：src/ 里的搜索聚合、插件运行时、取流链路、
 * Subsonic 协议都是纯 JS，换宿主不需要改一行。多写一份才是维护灾难。
 *
 * 用法：
 *   node server/index.mjs
 * 环境变量：
 *   LX_PORT            监听端口（默认 8787）
 *   LX_HOST            监听地址（默认 0.0.0.0）
 *   LX_DATA_DIR        数据目录（默认 ./data，容器里挂 /data）
 *   LX_SESSION_SECRET  会话签名密钥（不填则首次启动随机生成并存进库）
 *   DEFAULT_SOURCES    默认搜索源（kg,wy,kw,tx,xm）
 *   AI_PROVIDER / AI_API_KEY / AI_ACCOUNT_ID   AI 歌单的兜底配置
 */
import './boot-flags.mjs'   // ⚠️ 必须第一个：它负责让插件别在模块顶层求值
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import { handleApi } from '../src/server/api.js'
import { handleSubsonic } from '../src/server/subsonic.js'
import { versionInfo, versionLine, APP_VERSION } from '../src/version.js'
import { pluginPool, pluginBrief, evaluateOne, PLUGIN_MANIFEST } from '../src/plugins.js'
import { loadUserPlugins, setProbeRunner, setPluginHost } from '../src/server/plugin-import.mjs'
/*
 * 子进程预筛是纯 Node 能力，实现在 server/ 下 —— 由这里注入给 src/server/plugin-import.mjs。
 * 这样 src/ 侧就不会被 node:child_process / import.meta 污染（那些东西会打断 APK 打包，
 * 且 import.meta 在展平后的非模块脚本里是**语法错误**，产物一加载就炸）。
 * 必须在 loadUserPlugins / 处理导入请求**之前**注入。
 */
import { probePluginInChild } from './plugin-import-node.mjs'
import { ensureSchema, getSetting, setSetting } from '../src/db.js'
import { PLUGIN_SKIP } from '../src/generated/plugin-skip.js'
import { createD1, openDatabase } from './d1-sqlite.mjs'
import { createStaticServer } from './static.mjs'
import { installOutboundPool, poolDetail } from './outbound-pool.mjs'
import {
  createScheduler, parseInterval,
  RANK_SETTING, SCORES_SETTING, STATUS_SETTING,
} from './plugin-rescore.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = Number(process.env.LX_PORT || 8787)
const HOST = process.env.LX_HOST || '0.0.0.0'
const DATA_DIR = path.resolve(process.env.LX_DATA_DIR || path.join(ROOT, 'data'))
const DB_FILE = process.env.LX_DB_FILE || path.join(DATA_DIR, 'lxmusic.db')
const PUBLIC_DIR = process.env.LX_PUBLIC_DIR || path.join(ROOT, 'public')

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,range',
}

/* ---------------- 进程级兜底 ---------------- */

/**
 * 自己留一份真正的 console。
 *
 * 实测 pdone-sixyin 这个插件会在求值时**把 console.log 整个换掉**
 * （大概是想静音自己的日志），而它是一个模块级副作用 —— 换掉之后
 * 主进程后面所有的 console.log 都进不了日志，包括插件的加载结果、
 * 未处理拒绝的警告、请求异常。表现是「服务起来了但一行日志都没有」，
 * 排查时会以为日志被吞了、其实是被人替换了。
 *
 * 所以：加载插件之前先存一份，加载完立刻装回去。插件后续想打日志就打，
 * 但**我们的日志必须能出来**。
 */
const REAL_CONSOLE = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

function restoreConsole() {
  console.log = REAL_CONSOLE.log
  console.warn = REAL_CONSOLE.warn
  console.error = REAL_CONSOLE.error
}

/**
 * 未处理的 Promise 拒绝 —— 打个日志就算了，**不能让进程退出**。
 *
 * 这条是被真实崩溃逼出来的：插件初始化是异步的（先 fetch 远端配置再声明 sources），
 * 而那个 fetch 会抛（DNS 解析不到、被墙、对端 500）。插件自己不接这个错，
 * 于是变成一个 unhandledRejection —— Node 15 起默认**直接终止进程**。
 * 后果是容器起不来 / 无限重启，而现场只有一句 `TypeError: fetch failed`，
 * 看起来像服务端坏了，其实只是某个第三方音源的配置域名解析不了。
 *
 * 平台上为什么没暴露：Cloudflare 那边 DNS 正常，那台 fetch 成功了，压根没这条路径。
 *
 * 只兜 unhandledRejection，**不兜 uncaughtException**：
 * 后者意味着状态已经不可信，让它崩、让容器重启比带着坏状态继续服务更安全。
 *
 * 输出特意走 process.stderr.write：console 可能已被插件换掉（见上）。
 */
process.on('unhandledRejection', (reason) => {
  const msg = (reason && (reason.stack || reason.message)) || String(reason)
  process.stderr.write('[server] 未处理的 Promise 拒绝（多为插件异步初始化，不致命）: '
    + String(msg).split('\n').slice(0, 3).join(' | ') + '\n')
})

/* ---------------- 会话密钥 ---------------- */

/**
 * 签名密钥的取值顺序：环境变量 > 库里存过的 > 刚生成的（存回库）。
 *
 * 为什么要落库而不是每次都随机：密钥一变，所有已签发的 token 立刻失效 ——
 * 容器一重启就全员被登出。落库之后 `docker compose restart` 不影响登录态。
 * 也刻意不写死在代码里：那样任何拿到源码的人都能自己签一个管理员 token。
 */
async function resolveSessionSecret(db) {
  const fromEnv = process.env.LX_SESSION_SECRET || process.env.SESSION_SECRET
  if (fromEnv) return fromEnv
  const saved = await getSetting(db, 'session_secret', '')
  if (saved) return saved
  const fresh = crypto.randomBytes(32).toString('hex')
  await setSetting(db, 'session_secret', fresh)
  console.log('[server] 已生成会话密钥并写入数据库（下次启动继续沿用）')
  return fresh
}

/* ---------------- 请求 / 响应转换 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      // 这个后端没有上传接口，给个上限免得有人拿它当文件收件箱
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null))
    req.on('error', reject)
  })
}

/** Node 的 IncomingMessage → 标准 Request，好让 src/ 那套（Web 平台 API）原样跑 */
async function toRequest(req, url) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  }
  const method = (req.method || 'GET').toUpperCase()
  let body = null
  if (method !== 'GET' && method !== 'HEAD') body = await readBody(req)
  return new Request(url, { method, headers, body: body || undefined, duplex: body ? 'half' : undefined })
}

/** 标准 Response → Node 的 ServerResponse。音频必须流式转发，不能整体缓冲 */
async function sendResponse(res, response) {
  const headers = {}
  response.headers.forEach((v, k) => { headers[k] = v })
  for (const [k, v] of Object.entries(CORS)) if (!(k in headers)) headers[k] = v
  res.writeHead(response.status, headers)
  if (!response.body) { res.end(); return }
  Readable.fromWeb(response.body).pipe(res)
}

/* ---------------- 音源插件 ---------------- */

/**
 * 加载内置插件，跳过「求值即崩」的那几个。
 *
 * 为什么 Node 要单独做这件事：那些重度混淆的脚本求值时会直接杀死 JS 引擎
 * （不抛异常、try/catch 拦不住）。Cloudflare 上隔离区死了换一个继续，
 * 表现只是「这个插件不就绪」，所以线上一直没暴露；Android WebView 里是整页白屏；
 * **Node 里是进程直接退出，容器起不来**。
 *
 * 名单来自 tools/plugin-prescreen.mjs（一个插件一个子进程摸底），
 * 只收「进程被打死」这一种 —— 环境类加载失败一律保留，见那个文件的说明。
 *
 * 另外加了一道**自愈**：求值每个插件前先把它写进一个标记文件，
 * 求值完再清掉。万一名单漏了（换个 Node 大版本、插件更新）导致进程被杀，
 * 容器重启后就能从标记里读出「上次死在谁手上」，跳过它继续起，
 * 而不是无休止地崩-重启。日志里会说清楚，别让人以为是玄学。
 */
function loadPlugins() {
  // 这段日志跑在「插件可能已经换掉 console」之后，所以一律走 process.stdout
  const say = (s) => process.stdout.write(s + '\n')
  const pendingFile = path.join(DATA_DIR, '.plugin-eval-pending')
  const skip = new Set(PLUGIN_SKIP)
  for (const id of String(process.env.LX_PLUGIN_SKIP || '').split(',').map(s => s.trim()).filter(Boolean)) skip.add(id)

  try {
    const last = fs.readFileSync(pendingFile, 'utf8').trim()
    if (last) {
      skip.add(last)
      say(`[server] 上次启动在求值「${last}」时被杀死，本次跳过它。`
        + `确认它没问题可以删掉 ${pendingFile} 重来`)
    }
  } catch { /* 没有这个文件 = 上次走完了，正常 */ }

  let loaded = 0
  for (const item of PLUGIN_MANIFEST) {
    if (skip.has(item.id)) {
      // 跳过也要登记进池子：管理端 / 健康检查要能看见「有这么一个插件、为什么没上岗」
      pluginPool.add({
        ok: false, id: item.id, url: item.url || '',
        error: '已跳过：该脚本求值会杀死 JS 引擎（见 src/generated/plugin-skip.js）',
        meta: pluginBrief(item),
      })
      continue
    }
    try {
      fs.writeFileSync(pendingFile, item.id, 'utf8')
      /**
       * 「先打印再求值」：崩溃不抛异常、try/catch 拦不住，日志的**最后一行**
       * 就是凶手（配合上面那个标记文件，双重定位）。
       */
      say(`[server]   求值 ${item.id} … `)
      const r = evaluateOne(item)
      process.stdout.write((r.ok ? 'OK' : ('失败 ' + (r.error || ''))) + '\n')
      if (r.ok) loaded++
    } catch (e) {
      process.stdout.write('抛错 ' + String((e && e.message) || e) + '\n')
      pluginPool.add({
        ok: false, id: item.id, url: item.url || '',
        error: String((e && e.message) || e), meta: pluginBrief(item),
      })
    }
  }
  try { fs.unlinkSync(pendingFile) } catch { /* 已经清掉了 */ }

  const summary = pluginPool.summary()
  const sources = [...new Set(summary.filter(p => p.ok).flatMap(p => p.sources || []))]
  say(`[server] 音源插件 ${loaded}/${PLUGIN_MANIFEST.length} 可用`
    + (skip.size ? `，跳过 ${[...skip].join(',')}` : '')
    + `，平台 ${sources.length ? sources.join('/') : '无'}`)

  // 插件把我们的 console 换掉了（见 REAL_CONSOLE 的说明），装回来
  restoreConsole()

  /**
   * 把 skip 集合交出去 —— 用户导入的插件也要吃同一份黑名单。
   * 不返回的话，那个「上一次启动死在谁手上」的判断只对内置信，用户导入的
   * 那个 killer 每次重启都会被重新求值一遍，容器永远起不来（无限重启）。
   */
  return skip
}

/* ---------------- 运行时评分：结果落库与装载 ---------------- */

/**
 * 从库里读回上一次运行时评分的结果，并装进插件池。
 *
 * **为什么要从这里读，而不是直接用构建期那份：**
 * src/plugins.js 顶层已经装过 PLUGIN_RANK（构建期在**我的**机器上测的）。
 * 但容器跑在**用户的**网络下 —— 插件好不好用取决于那个出口。
 * 所以只要库里有一份运行时实测的结果（measuredFrom === 'runtime-host'），就用它覆盖构建期那份。
 *
 * 优先级：运行时实测 > 构建期实测 > 注册顺序。
 * 一份都没有时 setRank 会拿到空对象，池子退回注册顺序，功能不受影响。
 */
async function loadRuntimeRank(db) {
  let raw = ''
  try {
    // 注意口径：getSetting 是 src/db.js 里的独立函数，第一个参数才是连接对象。
    // 不是 db.getSetting(...) —— 那个 db 是 D1 适配层，只有 prepare/bind/first/run/batch。
    raw = await getSetting(db, RANK_SETTING, '') || ''
  } catch { /* 表还没建好 / 库刚初始化 —— 都不是致命问题 */ }
  if (!raw) return { applied: false, reason: '库里没有运行时评分结果' }
  let data = null
  try { data = JSON.parse(raw) } catch { return { applied: false, reason: '运行时评分结果解析失败' } }
  if (!data || typeof data !== 'object') return { applied: false, reason: '运行时评分结果格式不对' }

  /**
   * 两种形状都认 —— 这个宽容是**刻意的**：
   *
   *   ① 包装形 `{ generatedAt, measuredFrom, rank: { wy: [...] } }`（applyRescoreResult 写的）
   *   ② 裸排序表 `{ wy: [...], kg: [...] }`（手工塞进去的、或早期版本写的）
   *
   * 为什么值得写这段：判据只能看「值是不是数组」——排序表的每个值都是 plugin id 数组，
   * 而包装形里除 rank 之外的字段都是字符串/数组，混判会误伤。
   * 一开始只认 ①，结果库里有 ② 形状的数据时启动日志报「格式不对」，
   * 而排序表其实好好的、完全可用 —— 白丢一份实测结果，还让人以为是坏了。
   */
  const shape1 = data.rank && typeof data.rank === 'object' && Object.values(data.rank).every(Array.isArray)
  const shape2 = Object.values(data).every(Array.isArray)
  const rankMap = shape1 ? data.rank : (shape2 ? data : null)
  if (!rankMap || !Object.keys(rankMap).length) {
    return { applied: false, reason: '运行时评分结果里没有可用的排序表' }
  }

  const n = pluginPool.setRank(rankMap)
  const platforms = Object.keys(rankMap).filter(k => (rankMap[k] || []).length)
  return {
    applied: true,
    platforms: n,
    generatedAt: (shape1 && data.generatedAt) || null,
    detail: `运行时实测（${platforms.join('/') || '无平台'}${shape1 && data.generatedAt ? '，采样于 ' + data.generatedAt : ''}）`,
  }
}

/**
 * 一轮评分跑完后要做的事：写库 + 立刻生效。
 *
 * 顺序刻意是「先写库、再装池」：
 *  · 先写库 —— 万一装池那步抛了（池子是别的实现、方法缺失），结果至少没丢，重启还能用；
 *  · 再装池 —— 让**当前这轮请求之后**的取流立刻按新顺序走，不用重启容器。
 *
 * 只存三样：
 *   plugin.rank     排序表本体（取流用）
 *   plugin.scores   界面要展示的评分明细（不含 hits 里的完整 URL，体积小很多）
 *   plugin.rescore.status  上次跑的状态，管理端显示「上次什么时候测的、成没成」
 */
async function applyRescoreResult(db, payload) {
  const rank = {
    generatedAt: payload.generatedAt || null,
    measuredFrom: payload.measuredFrom || 'runtime-host',
    keywords: payload.keywords || [],
    unmeasured: payload.unmeasured || [],
    rank: payload.rank || {},
  }
  await setSetting(db, RANK_SETTING, JSON.stringify(rank))

  const scores = {
    generatedAt: payload.generatedAt || null,
    measuredFrom: payload.measuredFrom || 'runtime-host',
    keywords: payload.keywords || [],
    load: payload.load || {},
    byPlatform: payload.byPlatform || {},
  }
  await setSetting(db, SCORES_SETTING, JSON.stringify(scores))

  const n = pluginPool.setRank(payload.rank || {})
  return { platforms: n }
}

/** 把评分状态写进库（管理端在服务重启后也能看到上次的结果） */
function rescoreStatusStore(db) {
  return {
    async writeStatus(snap) {
      await setSetting(db, STATUS_SETTING, JSON.stringify(snap))
    },
  }
}

/* ---------------- 启动 ---------------- */

async function main() {
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    console.error('[server] 找不到前端目录:', PUBLIC_DIR)
    process.exit(1)
  }

  const db = createD1(openDatabase(DB_FILE))
  // 幂等建表：三个宿主共用同一段 SQL，谁都不用各自的迁移步骤（见 src/db.js 顶部）
  await ensureSchema(db)

  // 出站连接池：改动最小、对取流首跳收益最直接的一刀。
  // 拿不到 undici 就静默退回原生 fetch，功能不受影响（见 server/outbound-pool.mjs）。
  const pool = await installOutboundPool()
  console.log('[server] 出站连接：' + pool.detail)

  // 插件要在开始收请求之前就位 —— 池子空着的时候搜索会「成功但零结果」，
  // 那比启动失败更难排查
  const pluginSkip = loadPlugins()

  /**
   * 把「子进程预筛」和「插件池 + 求值器」注入给 src/server/plugin-import.mjs。
   * 必须赶在 loadUserPlugins（它内部会对每个插件调预筛与求值）之前。
   *
   * 为什么池子也要注入而不是让那边 import：src/plugins.js 顶层会求值内置插件，
   * 而 pdone-lx 求值即杀死 JS 引擎 —— 它一进 APK 打包产物，产物加载就整个消失。
   * 详见 src/server/plugin-import.mjs 里 setPluginHost 的说明。
   */
  setProbeRunner(probePluginInChild)
  setPluginHost({ pool: pluginPool, evaluate: evaluateOne })

  /**
   * 用户自己导入的插件（管理端 / App 的「导入插件」）。同样要在收请求前装好，
   * 理由和上面一样。黑名单与内置插件共用 —— 见 loadPlugins 末尾的说明。
   */
  await loadUserPlugins(db, pluginSkip)

  /**
   * 运行时评分的结果优先于构建期那份（见 loadRuntimeRank 的说明）。
   * 放在 loadPlugins 之后：那时池子才刚装好构建期的排序表，这里做的是**覆盖**。
   */
  const runtimeRank = await loadRuntimeRank(db)
  console.log(runtimeRank.applied
    ? `[server] 已启用运行时实测排序（${runtimeRank.platforms} 个平台，${runtimeRank.generatedAt || '时间未知'}）`
    : `[server] 沿用构建期排序（${runtimeRank.reason}）`)

  const env = {
    DB: db,
    PLUGIN_POOL: pluginPool,
    SESSION_SECRET: await resolveSessionSecret(db),
    DEFAULT_SOURCES: process.env.DEFAULT_SOURCES || '',
    AI_PROVIDER: process.env.AI_PROVIDER || '',
    AI_API_KEY: process.env.AI_API_KEY || '',
    AI_ACCOUNT_ID: process.env.AI_ACCOUNT_ID || '',
  }

  /**
   * 评分调度器 —— 「按时间间隔自动评分」的落点。
   *
   * 挂到 env 上而不是只放局部变量：/admin/plugin-rescore 那个接口要能
   * 手动触发一轮、也要能读到「上次什么时候跑的、成没成、下一轮什么时候」。
   *
   * LX_SCORE_INTERVAL 用 off/0/never 关掉自动（仍可手动）；
   * 不填默认 1d（一天一轮，见 parseInterval 的说明）。
   */
  const scoreInterval = parseInterval(process.env.LX_SCORE_INTERVAL)
  const scheduler = createScheduler({
    dataDir: DATA_DIR,
    intervalMs: scoreInterval,
    apply: (payload) => applyRescoreResult(db, payload),
    store: rescoreStatusStore(db),
    log: (s) => process.stdout.write(s + '\n'),
  })
  env.RESCORE = scheduler
  /**
   * 上次评分状态（重启后仍能看到）。
   *
   * ── 为什么不是「启动时读一次就存着」────────────────────────────
   * 最早是那么写的，理由是「/healthz 是高频路径，每次查库浪费」。**实测下来这是错的**：
   *
   *   · /healthz 每 30 秒才被 HEALTHCHECK 打一次，外面再加监控也就这个量级。
   *     settings 表按主键查一行，微秒级 —— 这个「优化」省掉的开销约等于零。
   *   · 而代价很实在：启动时库里还没有状态（新装、或刚清过库），这份缓存就一直是 null。
   *     调度器跑完一轮只把新状态**写进库**，不会回填这个闭包变量 ——
   *     于是管理端与 /healthz 一直显示「从没测过」，直到下次容器重启。
   *     一个 O(1) 的读换来一个「功能明明成功了界面说没跑」的故障，不划算。
   *
   * 现在改成 **2 秒 TTL 的读穿缓存**：既让状态最多迟 2 秒就可见，
   * 又保证连打 /healthz 也不会每次都落库。TTL 短到人眼看不出延迟，
   * 长到足以吸收监控/反代的连发探测。
   */
  let statusCache = { at: 0, value: null }
  async function readSavedStatus() {
    const now = Date.now()
    if (now - statusCache.at < 2000) return statusCache.value
    let value = statusCache.value
    try {
      const saved = await getSetting(db, STATUS_SETTING, '')
      if (saved) {
        try { value = JSON.parse(saved) } catch { /* 旧数据坏了就沿用上一份 —— 下一轮会覆盖 */ }
      }
    } catch { /* 读不到不影响服务，沿用上一份 */ }
    statusCache = { at: now, value }
    return value
  }
  // 启动时先读一次：让「容器刚起来、日志里就该有上次结果」这件事成立
  await readSavedStatus()
  scheduler.start()

  const assets = createStaticServer(PUBLIC_DIR)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const p = url.pathname

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }

      if (p === '/healthz') {
        const summary = pluginPool.summary()
        const snap = scheduler.snapshot()
        await sendResponse(res, Response.json({
          ok: true,
          mode: 'docker',
          // 版本号对外暴露一份，方便「这台机器上跑的是哪版」一眼可见
          // （反代/监控/用户提 issue 时全靠它，省得来回问）。
          version: versionInfo(),
          plugins: { total: summary.length, ready: summary.filter(x => x.ok).length },
          outbound: poolDetail(),
          /**
           * 评分状态给两份，口径不同、缺一不可（和 /admin/plugin-scores 里那个
           * readRescoreState 是同一套思路）：
           *   live —— 这次进程的实时状态（正在跑吗、下一轮什么时候）；
           *   last —— 库里存的上次结果，**跨重启**。容器重启后 live 全是 null，
           *          只有 last 还在，界面才不会显示成「从没测过」。
           *
           * last 走 readSavedStatus()（2 秒读穿缓存），**不能**再用启动时那份快照：
           * 那样一轮刚跑完、还没重启时，live 有值而 last 是空的，两边对不上。
           */
          rescore: { ...snap, last: await readSavedStatus(), supported: true },
          ts: new Date().toISOString(),
        }))
        return
      }

      if (p === '/rest' || p.startsWith('/rest/')) {
        await sendResponse(res, await handleSubsonic(await toRequest(req, url), env, url))
        return
      }

      if (p.startsWith('/api/') || p === '/api') {
        await sendResponse(res, await handleApi(await toRequest(req, url), env, url))
        return
      }

      const hit = assets.serve(req.method, p, req.headers)
      if (hit) {
        res.writeHead(hit.status, hit.headers)
        if (hit.stream) hit.stream.pipe(res)
        else res.end()
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    } catch (e) {
      console.error('[server] 未捕获异常:', (e && e.stack) || e)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...CORS })
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      } else {
        res.end()
      }
    }
  })

  // 长连接：/api/stream 会挂很久，默认 5s 的 keep-alive 不够用
  server.keepAliveTimeout = 65000
  server.headersTimeout = 70000

  server.listen(PORT, HOST, () => {
    console.log(`[server] ${versionLine()} 已启动 http://${HOST}:${PORT}`)
    console.log(`[server] 数据库 ${DB_FILE}`)
    console.log(`[server] 前端   ${PUBLIC_DIR}`)
    console.log(`[server] 管理员入口 /admin，健康检查 /healthz，版本 /api/version`)
    const snap = scheduler.snapshot()
    console.log(snap.intervalMs
      ? `[server] 插件评分 ${snap.intervalText}自动跑一轮（也可在管理端「立即重评」）`
      : `[server] 插件评分未开自动（可在管理端「立即重评」）`)
  })

  const shutdown = (sig) => {
    console.log(`[server] 收到 ${sig}，正在退出…`)
    // 先停调度器：不然定时器还挂着，评分子进程可能被留下变成孤儿
    try { scheduler.stop() } catch { /* 没起来过 */ }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((e) => {
  console.error('[server] 启动失败:', (e && e.stack) || e)
  process.exit(1)
})
