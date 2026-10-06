/**
 * App 后端 bundle 自检：在 Node 里把 backend.bundle.js 真跑一遍。
 *
 * 为什么需要：
 *   安卓壳没法在 CI / 本机跑起来（本机没有 Android 环境），但 bundle 里的
 *   后端逻辑是纯 JS，只要有 fetch / Response / SQLite 就能执行。
 *   所以这里用 Node 模拟 WebView 的运行时，把「桥」换成 Node 自己的实现，
 *   就能在没有手机的情况下验证：
 *     · 打包是否正确（模块图、导出是否齐）
 *     · 14 个内置插件在「无 CF 顶层 I/O 限制」的环境里是否全部加载成功
 *     · /api/* 端到端是否通（setup → login → search → 榜单）
 *
 * 与真机的差异：网络出口是构建机而不是手机，所以源站可用性可能不同；
 * 本脚本只断言「结构性正确」，不断言第三方源当时的可用性。
 *
 * 用法：node test/app-bundle.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BUNDLE = path.join(ROOT, 'public', 'js', 'backend.bundle.js')

let pass = 0
let fail = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

/**
 * 记下 bundle 里的 console.warn。
 * 目前只为一件事：src/db.js 的 ensureSchema 失败时只 warn 不抛（老库缺张表不该让
 * 每个请求都 500），这本身是对的，但在这套替身里它**永远失败**——于是那行警告成了
 * 常驻噪声，真出 schema 故障时没人看得见。所以要断言它一次都不该出现。
 */
const warns = []
const realWarn = console.warn
console.warn = (...a) => { warns.push(a.map(x => String(x)).join(' ')); realWarn.apply(console, a) }

/* ---------------- 桥的 Node 侧替身 ---------------- */

// bundle 与 plugins.data.js 都是给浏览器写的，挂载点是 window
globalThis.window = globalThis

/** fetch 桥：直接转给 Node 的 fetch（语义与 Java 桥一致：发请求、回响应） */
globalThis.__lxFetch = (url, opts) => fetch(url, opts)

/**
 * SQLite 桥的 Node 替身。
 * Java 侧是 android.database.sqlite；这里用内存表模拟，只实现本项目 schema
 * 用到的 SQL 形态（SELECT/INSERT/UPDATE/DELETE + COUNT/COALESCE/MAX + 占位符）。
 * 目的不是复刻 SQLite，而是让 /api/* 的调用链能真正跑通。
 */
const tables = {
  users: [], playlists: [], playlist_songs: [], favorites: [], settings: [], search_history: [],
  plugins: [], play_progress: [], daily_recommend: [],
}
let seq = 0

function exec(sql, args) {
  const s = sql.replace(/\s+/g, ' ').trim()
  const up = s.toUpperCase()

  /**
   * DDL / 事务控制直接放行。
   * 真实 SQLite 里 CREATE TABLE / CREATE INDEX 是幂等建表；这个替身按表名索引行集合，
   * 本来就不需要它们。不显式放行的话，`CREATE TABLE x (...)` 会掉进下面的 SELECT 分支
   * 去访问一张还不存在的表，抛出一个跟真因毫无关系的 TypeError（"reading 'filter'"），
   * 让 ensureSchema 报出一串假失败。
   */
  if (/^(CREATE|PRAGMA|BEGIN|COMMIT|ROLLBACK|DROP|ALTER)\b/.test(up)) {
    return { rows: [], changes: 0 }
  }

  // 表名取「最后一个 FROM 后」的那个 —— 形如
  // `SELECT p.*, (SELECT COUNT(*) FROM playlist_songs s WHERE ...) AS n FROM playlists p WHERE ...`
  // 子查询的 FROM 在前，主表的 FROM 在后，取最后一个才是主表。
  const froms = [...s.matchAll(/\bFROM\s+([a-z_]+)/gi)]
  let tbl = froms.length ? froms[froms.length - 1][1].toLowerCase() : ''
  if (!tbl) {
    const m2 = s.match(/\b(?:INTO|UPDATE)\s+([a-z_]+)/i)   // INSERT INTO / UPDATE
    tbl = m2 ? m2[1].toLowerCase() : ''
  }
  // 缺表就明确报出来，而不是让 `tables[tbl].filter` 抛一个跟真因无关的 TypeError。
  // 这套替身只覆盖本项目 schema 用到的表，将来新增表而忘了在这里登记时，
  // 需要的正是「一眼看出是哪张表没登记」，不是「Cannot read properties of undefined」。
  if (!tables[tbl]) throw new Error(`替身未登记的表: ${tbl || '(未解析出表名)'} ← ${s.slice(0, 100)}`)

  if (up.startsWith('INSERT OR REPLACE') || up.startsWith('INSERT')) {
    const cols = (s.match(/\(([^)]+)\)\s*VALUES/i) || [, ''])[1].split(',').map(x => x.trim().toLowerCase())
    const row = {}
    cols.forEach((c, i) => { row[c] = args[i] })
    if (cols.includes('id')) {
      const idx = tables[tbl].findIndex(r => r.id === row.id)
      if (idx >= 0) tables[tbl][idx] = row
      else tables[tbl].push(row)
    } else {
      tables[tbl].push(row)
    }
    return { rows: [], changes: 1 }
  }
  if (up.startsWith('UPDATE')) {
    const sets = (s.match(/SET (.*?) (?:WHERE|$)/i) || [, ''])[1].split(',').map(x => x.trim())
    const whereCol = (s.match(/WHERE\s+([a-z_]+)\s*=\s*\?/i) || [])[1]
    const whereVal = whereCol ? args[args.length - 1] : null
    let n = 0
    for (const r of tables[tbl]) {
      if (whereCol && r[whereCol] !== whereVal) continue
      sets.forEach((pair, i) => {
        const m = pair.match(/^([a-z_]+)\s*=/i)
        if (m) r[m[1].toLowerCase()] = args[i]
      })
      n++
    }
    return { rows: [], changes: n }
  }
  if (up.startsWith('DELETE')) {
    const whereCol = (s.match(/WHERE\s+([a-z_]+)\s*=\s*\?/i) || [])[1]
    const before = tables[tbl].length
    tables[tbl] = whereCol ? tables[tbl].filter(r => r[whereCol] !== args[0]) : []
    return { rows: [], changes: before - tables[tbl].length }
  }
  if (up.startsWith('SELECT COUNT')) {
    const whereCol = whereCol_(s)
    const rows = tables[tbl].filter(r => !whereCol || r[whereCol] === args[0])
    return { rows: [{ c: rows.length, ...(rows[0] || {}) }], changes: 0 }
  }
  // 其余 SELECT：返回该表全部行（够本项目用）
  const whereCol = whereCol_(s)
  const rows = tables[tbl].filter(r => !whereCol || r[whereCol] === args[0])
  return { rows, changes: 0 }
}

/** 取 WHERE 列名，去掉表别名前缀（`p.user_id` → `user_id`） */
function whereCol_(s) {
  const m = s.match(/WHERE\s+(?:[a-z_]+\.)?([a-z_]+)\s*=\s*\?/i)
  return m ? m[1].toLowerCase() : null
}

const NodeDb = {
  prepare(sql) {
    let bound = []
    const stmt = {
      bind(...a) { bound = a; return stmt },
      async first() { return exec(sql, bound).rows[0] || null },
      async all() { return { results: exec(sql, bound).rows } },
      async run() { return exec(sql, bound) },
    }
    return stmt
  },
  async batch(stmts) {
    const out = []
    for (const s of stmts) out.push(await s.run())
    return out
  },
}

globalThis.__lxDB = NodeDb

/* ---------------- 加载 bundle ---------------- */

console.log('== 1. 加载 backend.bundle.js ==')
check('文件存在', fs.existsSync(BUNDLE))
const code = fs.readFileSync(BUNDLE, 'utf8')
const logs = []
const origLog = console.log
let loadError = null
console.log = (...a) => { logs.push(a.join(' ')); origLog(...a) }
try {
  vm.runInThisContext(code, { filename: 'backend.bundle.js' })
} catch (e) {
  loadError = e
} finally {
  console.log = origLog
}
if (loadError) {
  console.log(`  ✗ bundle 执行抛异常: ${loadError && loadError.stack || loadError}`)
  process.exit(1)
}

const LB = globalThis.LXBackend
check('挂载 window.LXBackend', !!LB)
check('导出 handleApi', typeof (LB && LB.handleApi) === 'function')
check('导出 currentUser/makeToken/verifyToken', !!(LB && LB.currentUser && LB.makeToken && LB.verifyToken))
check('模块图非空', !!(LB && LB.__modules && LB.__modules.length >= 12), `${LB && LB.__modules && LB.__modules.length} 个模块`)

/* ---------------- 宿主能力标志的默认值 ---------------- */

console.log('\n== 1b. 宿主能力标志 ==')
// LX_ALLOW_HTTP_AUDIO 必须由壳（native.js）显式置位才生效。
// 这里断言"没置位时是关的"：网页里 https 页面加载 http 音频会被浏览器当混合内容
// 静音，一旦这个默认值被改错，网页版会静默变成"有地址但没声音"。
check('未置位时禁止 http 音频（网页默认）', globalThis.LX_ALLOW_HTTP_AUDIO !== true)
globalThis.LX_ALLOW_HTTP_AUDIO = true
check('置位后允许 http 音频（壳内）', globalThis.LX_ALLOW_HTTP_AUDIO === true)
globalThis.LX_ALLOW_HTTP_AUDIO = undefined

/* ---------------- 插件数据（纯数据，求值交给 Worker） ---------------- */

console.log('\n== 2. 内置插件数据 ==')
const PDATA = path.join(ROOT, 'public', 'js', 'plugins.data.js')
check('plugins.data.js 存在', fs.existsSync(PDATA))
let pluginData = []
if (fs.existsSync(PDATA)) {
  const pcode = fs.readFileSync(PDATA, 'utf8')
  vm.runInThisContext(pcode, { filename: 'plugins.data.js' })
  pluginData = globalThis.LX_PLUGIN_DATA || []
}
check('插件数据非空', pluginData.length > 0, `${pluginData.length} 个`)
check('每项都有 script', pluginData.every(p => typeof p.script === 'string' && p.script.length > 50))
check('已排除崩溃插件 pdone-sixyin', !pluginData.some(p => p.id === 'pdone-sixyin'))
const names = pluginData.map(p => p.name).filter(Boolean)
check('插件名可解析', names.length === pluginData.length, `${names.length} 个带名字`)

/* ---------------- /api/* 端到端 ---------------- */

console.log('\n== 3. /api/* 端到端 ==')

/**
 * 空插件池：App 里插件能力由 public/js/lxplugin.js（Worker 隔离）提供，
 * 后端只保留接口形状，避免 api.js 里的 pluginPool 调用抛错。
 * 这里的替身与 native.js 里的 LxpPluginPool 保持同一套方法签名 ——
 * 少一个 setUserPrefs 就曾让整个 App 后端的 /api/* 全 500，所以签名要跟齐。 */
const EMPTY_POOL = {
  summary: () => [],
  qualityMap: () => ({}),
  musicUrlPlugins: () => [],
  invokePlugin: async () => ({ ok: false, value: null, plugin: null }),
  supports: () => false,
  setUserPrefs: () => ({ mode: 'auto', disabled: 0, manualSources: 0 }),
}

// PLUGIN_POOL 传 null 会让 api.js 的 /sources 直接抛错，所以给空池；
// 端到端断言只关心「不依赖 CF 能不能跑通」，不关心插件数量。
const env = { DB: NodeDb, PLUGIN_POOL: EMPTY_POOL, SESSION_SECRET: 'app-test-secret' }
const BASE = 'http://app.local'

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const req = new Request(BASE + '/api' + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const res = await LB.handleApi(req, env, new URL(req.url))
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

const st = await api('/setup-status')
check('GET /setup-status', st.status === 200 && st.json && st.json.needsSetup === true, JSON.stringify(st.json))

const su = await api('/setup', { method: 'POST', body: { username: 'admin', password: 'test1234' } })
check('POST /setup 建管理员', su.status === 200 && !!(su.json && su.json.token))
const token = su.json && su.json.token

const me = await api('/me', { token })
check('GET /me 带 token 鉴权', me.status === 200 && me.json.user && me.json.user.username === 'admin', JSON.stringify(me.json).slice(0, 120))

const noAuth = await api('/me')
check('GET /me 无 token 被拒', noAuth.status === 401, `status=${noAuth.status}`)

const pl = await api('/playlist', { method: 'POST', token, body: { name: '测试歌单', songs: [] } })
check('POST /playlist 建歌单', pl.status === 200 && !!(pl.json && pl.json.playlist), JSON.stringify(pl.json).slice(0, 140))

const pls = await api('/playlists', { token })
check('GET /playlists 列表非空', pls.status === 200 && pls.json.list && pls.json.list.length === 1, `count=${pls.json.list && pls.json.list.length}`)

const src = await api('/sources', { token })
// /sources 返回的是 platforms（各平台 + 插件支持情况），不是 list
const platformKeys = (src.json && src.json.platforms || []).map(s => s.key)
check('GET /sources 原生平台齐全', src.status === 200 && ['kg', 'wy', 'kw', 'tx'].every(s => platformKeys.includes(s)),
  platformKeys.join(','))

// 「装调度偏好」是插件池的**可选**能力，缺了它不能把整个 /api/* 拖挂。
// 真实案例：安卓壳的插件池是个精简适配器，早先没有 setUserPrefs，而这一行
// 卡在 handleApi 的登录之后 —— 结果是 App 后端所有接口一起 500。
{
  const saved = env.PLUGIN_POOL
  env.PLUGIN_POOL = { summary: () => [], qualityMap: () => ({}), musicUrlPlugins: () => [], supports: () => false }
  const bare = await api('/sources', { token })
  check('插件池没有 setUserPrefs 时接口照常可用', bare.status === 200, 'status=' + bare.status)
  env.PLUGIN_POOL = saved
}

/* ---------------- 联外网的真实接口（失败只记警告，不算失败） ---------------- */

console.log('\n== 4. 联外网接口（依赖构建机出口，仅记录不判定） ==')
try {
  const search = await api('/search?q=' + encodeURIComponent('周杰伦') + '&limit=5', { token })
  const n = (search.json && search.json.list && search.json.list.length) || 0
  console.log(`  · /search 「周杰伦」 → status=${search.status}, ${n} 首`)
  if (n) console.log(`      示例: ${search.json.list[0].name} — ${search.json.list[0].singer}`)
} catch (e) {
  console.log(`  · /search 异常: ${e.message}`)
}

try {
  const charts = await api('/charts', { token })
  const n = (charts.json && charts.json.list && charts.json.list.length) || 0
  console.log(`  · /charts → status=${charts.status}, ${n} 个榜单`)
} catch (e) {
  console.log(`  · /charts 异常: ${e.message}`)
}

/* ---------------- 5. SQLite 替身与 schema 对账 ---------------- */

console.log('\n== 5. schema 与 SQLite 替身 ==')

/**
 * 两条断言都是为了让这套替身「坏了能被发现」。
 *
 * ensureSchema 失败只 warn 不抛（老库缺张表只该让用那张表的功能不可用，不该让每个
 * 请求都 500）—— 这个设计是对的，代价是**替身漏了表也照样全绿**，一行常驻警告混在
 * 输出里没人看。所以这里把「有没有 warn」和「表登记齐不齐」各补一条硬断言。
 */
const schemaWarns = warns.filter(m => /建表有失败项/.test(m))
check('建表过程无失败项', schemaWarns.length === 0,
  schemaWarns.length ? schemaWarns[0].slice(0, 220) : '干净')

const declared = [...fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')
  .matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(m => m[1].toLowerCase())
const registered = Object.keys(tables)
const unregistered = declared.filter(t => !registered.includes(t))
check('schema.sql 里的表都在替身里登记过', declared.length > 0 && unregistered.length === 0,
  unregistered.length ? '未登记: ' + unregistered.join(', ') : `${declared.length} 张表`)

/* ---------------- 汇总 ---------------- */

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
