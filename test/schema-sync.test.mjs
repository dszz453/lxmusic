/**
 * 结构与接口的一致性检查（纯静态分析，不需要网络、不需要数据库）
 *
 *   node test/schema-sync.test.mjs
 *
 * 三组断言，都是「两边各写一份、漂了不会报错但会出事」的地方：
 *
 *  A. schema.sql  ↔  src/db.js 的 SCHEMA 常量
 *     建表语句在代码里也存了一份（为了让 D1 / Docker 的 node:sqlite / 壳内设备 SQLite
 *     三个宿主都不需要各自的迁移步骤）。两份不一致的表现是「本地跑得好好的、
 *     上线少张表」，而且报错发生在很远的地方。
 *
 *  B. 代码里的 SQL 不许用 SQLite 3.24+ 才有的语法
 *     APK 要兼容 Android 5.0，系统自带 SQLite 是 3.8.x。`ON CONFLICT ... DO UPDATE`
 *     在新机器上没问题、在老机器上直接是语法错误 —— 这种坑只有真机才碰得到。
 *
 *  C. public/js/api.js 里的接口路径  ↔  src/server/api.js 里实现的路由
 *     前端写错一个字母（/search-albums 写成 /searchAlbum）不会报错，
 *     只会在运行时得到一个 404，且往往被当成「后端没实现」。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}
const norm = (s) => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase()

/* ---------- A. schema.sql ↔ SCHEMA 常量 ---------- */

const { schemaStatements } = await import('../src/db.js')
const codeSql = schemaStatements()
const fileSql = read('schema.sql')
  .split(';')
  .map(s => s.replace(/--[^\n]*/g, '').trim())
  .filter(s => /create\s+(table|index|unique\s+index)/i.test(s))

const nameOf = (sql) => {
  const m = /create\s+(table|index|unique\s+index)\s+if\s+not\s+exists\s+([\w.]+)/i.exec(sql)
  return m ? (m[1].toLowerCase().indexOf('index') >= 0 ? 'index:' : 'table:') + m[2].toLowerCase() : null
}

const codeNames = new Set(codeSql.map(nameOf).filter(Boolean))
const fileNames = new Set(fileSql.map(nameOf).filter(Boolean))

const onlyInCode = [...codeNames].filter(n => !fileNames.has(n))
const onlyInFile = [...fileNames].filter(n => !codeNames.has(n))
ok('schema.sql 与代码内 SCHEMA 的表/索引集合一致',
  onlyInCode.length === 0 && onlyInFile.length === 0,
  (onlyInCode.length ? '只在代码里：' + onlyInCode.join(', ') + '  ' : '')
  + (onlyInFile.length ? '只在 schema.sql 里：' + onlyInFile.join(', ') : '')
  || `${codeNames.size} 个对象`)

// 逐条比对定义正文：只有集合一致还不够，「表名对但少一列」同样会炸
const bodyOf = (sql) => {
  const i = sql.indexOf('(')
  const j = sql.lastIndexOf(')')
  if (i < 0 || j < 0) return norm(sql)
  return norm(sql.slice(i, j + 1)).replace(/\s+/g, '')
}
const codeBody = new Map()
for (const sql of codeSql) { const n = nameOf(sql); if (n) codeBody.set(n, bodyOf(sql)) }
const fileBody = new Map()
for (const sql of fileSql) { const n = nameOf(sql); if (n) fileBody.set(n, bodyOf(sql)) }

const bodyDiff = []
for (const [n, b] of codeBody) if (fileBody.has(n) && fileBody.get(n) !== b) bodyDiff.push(n)
ok('两边同名的表/索引，定义正文也逐字一致（防止「少一列」）',
  bodyDiff.length === 0,
  bodyDiff.length ? '不一致：' + bodyDiff.join(', ') : `${codeBody.size} 条已比对`)

ok('play_progress 表在两边都存在（续播与播放历史共用的一张表）',
  codeNames.has('table:play_progress') && fileNames.has('table:play_progress'))
ok('play_progress 有 (user_id, last_played_at) 索引（历史列表按它倒序）',
  codeNames.has('index:idx_progress_user') && fileNames.has('index:idx_progress_user'))

/* ---------- B. 不用老 SQLite 不认识的语法 ---------- */

/**
 * 先剥掉注释再查。
 * 这里查的是「代码里有没有用某个语法」，而 db.js 的注释里正好在**讨论**为什么
 * 不用 `upsert` —— 不剥注释的话，会被自己那句说明判成违规。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
const dbSrc = stripComments(read('src/db.js'))
const banned = [
  { re: /on\s+conflict\s*\([^)]*\)\s*do\s+update/i, why: 'ON CONFLICT ... DO UPDATE（需 SQLite 3.24+，Android 5 自带 3.8）' },
  { re: /\breturning\b/i, why: 'RETURNING（需 SQLite 3.35+）' },
  { re: /over\s*\(\s*partition\s+by/i, why: '窗口函数（需 SQLite 3.25+）' },
  { re: /insert\s+into[^;]*?\bon\s+conflict\b/i, why: 'INSERT ... ON CONFLICT（需 SQLite 3.24+）' },
]
for (const b of banned) {
  const hit = b.re.test(dbSrc)
  ok('src/db.js 不含 ' + b.why.split('（')[0], !hit, hit ? '命中了：' + b.why : '')
}
ok('写进度走的是「INSERT OR IGNORE + UPDATE」两步（老 SQLite 也能跑）',
  /INSERT OR IGNORE INTO play_progress/.test(dbSrc) && /UPDATE play_progress SET/.test(dbSrc))

/* ---------- C. 前端接口路径 ↔ 后端路由 ---------- */

const apiSrc = read('public/js/api.js')
const serverSrc = read('src/server/api.js')

// 后端：把所有 path === '/x' 收成集合；再加上静态资源那边不归 api.js 管的路径
const serverPaths = new Set(
  [...serverSrc.matchAll(/path\s*===\s*'([^']+)'/g)].map(m => m[1])
)
// startsWith 形式的分支（例如前缀守卫、/playlist 之类）也纳入
for (const m of serverSrc.matchAll(/path\.startsWith\('([^']+)'\)/g)) serverPaths.add(m[1])

// 前端：只取看起来像接口路径的字符串字面量（以 / 开头、无空格），去掉查询串。
// '/api' 本身是 fetch 时拼的前缀（req() 里用 '/api' + path），不是接口名。
const staticAssets = new Set(['/', '/api'])
const fePaths = new Set()
for (const m of apiSrc.matchAll(/['"](\/[A-Za-z0-9\-_/]*)['"]/g)) {
  const p = m[1].replace(/\/$/, '') || '/'
  if (staticAssets.has(m[1])) continue
  if (serverPaths.has(p)) { fePaths.add(p); continue }
  // 前缀匹配也算通过（后端用 startsWith 兜的那种）
  if ([...serverPaths].some(sp => sp.endsWith('/') && p.startsWith(sp))) { fePaths.add(p); continue }
  fePaths.add('\u0000' + p)   // 未命中，先记下来
}

const unmatched = [...fePaths].filter(p => p.startsWith('\u0000')).map(p => p.slice(1))
ok('public/js/api.js 里每个接口路径后端都有实现',
  unmatched.length === 0,
  unmatched.length ? '后端未实现：' + unmatched.join(', ') : fePaths.size + ' 条路径全部对上')

// 反向：管理端路径必须带 /admin/ 前缀（否则服务端那道统一守卫会漏掉它）
const adminish = ['stats', 'users', 'play-history', 'search-sources', 'plugin-scores',
  'plugin-prefs', 'ai-config', 'ai-test', 'health', 'diag', 'plugins']
const leaked = adminish.filter(n =>
  serverPaths.has('/' + n) && !serverPaths.has('/admin/' + n))
ok('管理端接口没有留在裸路径上（/x 而未搬去 /admin/x）',
  leaked.length === 0,
  leaked.length ? '仍可从用户端直接调：' + leaked.map(x => '/' + x).join(', ') : adminish.length + ' 个已收口')

// /admin 前缀的统一守卫必须存在 —— 这是所有管理接口唯一的权限闸门
ok('服务端有 /admin/ 前缀统一鉴权',
  /path\.startsWith\('\/admin\/'\)\s*&&\s*!user\.is_admin/.test(serverSrc),
  '缺了它，管理接口就得每个分支自己判权限（漏一个就洞开）')

/* ================= D. 管理后台不许被缓存 ================= */
//
// 这一组是「已经踩过一次」的坑，而且踩完很难定位：全新 profile 打开管理后台一切正常，
// 只有装着 PWA 的老浏览器长期停在旧页面 —— 因为 admin.html 自己不注册 SW，但 SW 的
// scope 是整站，它的 admin.js 会掉进「静态资源 stale-while-revalidate」分支。
// 症状是「改了也部署了，用户那边还是旧的」，来回排查成本极高，所以立成守卫。

const swSrc = read('public/sw.js')
const headersSrc = read('public/_headers')

// 1) SW 的 fetch 里必须存在「管理路径直接放行」的分支
ok('sw.js 明确放行了管理后台路径（不进 SWR 缓存）',
  /ADMIN_PATHS/.test(swSrc) && /isAdminPath\([^)]*\)\s*\)?\s*return/.test(swSrc),
  '缺了这段，/admin 与 admin.js 会掉进下面的 SWR 分支，长期停留在旧版本')

// 2) 放行的清单必须覆盖管理页本身和它的 JS —— 只放行 /admin 而漏了 /js/admin.js，
//    等于只换了一半，症状依旧
const adminList = (swSrc.match(/const ADMIN_PATHS = \[([\s\S]*?)\]/) || [, ''])[1]
for (const must of ['/admin', '/admin.html', '/js/admin.js']) {
  ok('sw.js 放行清单包含 ' + must, adminList.includes("'" + must + "'"), adminList.trim())
}

// 3) HTTP 层也要配 no-cache，否则浏览器自己的缓存照样能把旧页面留下来
const noCacheBlocks = headersSrc.split(/\n(?=\/)/)
const hasNoCache = (routePath) => noCacheBlocks.some(b =>
  b.split('\n')[0].trim() === routePath && /Cache-Control:\s*no-cache/.test(b))
for (const p of ['/admin', '/admin.html', '/js/admin.js']) {
  ok('_headers 给 ' + p + ' 配了 Cache-Control: no-cache', hasNoCache(p))
}

// 4) 失败的取数不能静默 —— 评分块必须显示「为什么没有」，否则 403 和 500
//    在用户眼里都只是「评分没了」，无从问起
const adminSrc = read('public/js/admin.js')
ok('admin.js 保留了 pluginScores 的错误对象（不再 .catch(() => null) 吞掉）',
  /pluginScores\(\)\.catch\(e\s*=>/.test(adminSrc) && /scoreState\.err\s*=/.test(adminSrc))
ok('admin.js 区分「不是管理员」与「服务端报错」两种失败',
  /scoreErrText/.test(adminSrc) && /st === 403 \|\| st === 401/.test(adminSrc) && /st >= 500/.test(adminSrc))

/* ---------- 汇总 ---------- */
console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
process.exit(fail ? 1 : 0)
