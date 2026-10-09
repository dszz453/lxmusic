/**
 * 首屏启动速度 —— 静态接线审计
 *
 * ── 为什么这条要单独钉一份测试 ────────────────────────────────
 *
 * 「同一个前端，网页打开秒开、App 打开要等两三秒」这个现象，根因**不在任何
 * 一个函数写错了**（所以单元测试永远抓不到），而是两处「接线方式」的代价叠加：
 *
 * 1) **客户端的 /api 请求逐个冷启动。**
 *    HttpBridge / Handshake 读完响应就把 TCP 连接 disconnect() 掉，于是下一个
 *    请求走不到连接池，DNS + TCP + TLS 整套重做。同一台自建服务器实测：
 *        冷连接 418ms   /   复用连接 20ms
 *    浏览器那边 HTTP/2 多路复用 + 连接复用，这笔钱几乎不用花 —— 这就是差异的来源。
 *
 * 2) **首屏在渲染之前串行等了好几个来回。**
 *    boot() 里 setupStatus → me → sources 一前一后，home 页要等它们全部回来
 *    才开始画。并行能省掉一整个来回，sources 更是首帧根本没用到。
 *
 * ── 为什么断言必须先剔注释 ────────────────────────────────────
 *
 * 这两处的修复方式都是「**把某段代码删掉**」，而删掉的理由必须写在注释里
 * （不写的话，下一个人看一眼觉得「少了 disconnect 会泄漏」就给加回来了）。
 * 于是注释里必然出现 `disconnect()` 这个字面量 —— 直接对整文件做
 * /disconnect/ 断言会**永远失败**，对 /不包含 disconnect/ 断言则会**永远通过**
 * （测了个寂寞）。所以下面一律先 stripComments 再匹配。
 *
 * 跑法：node test/boot-speed.test.mjs
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
  if (cond) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fails.push(name + (detail ? '  → ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''))
  }
}

/** 去掉块注释与行注释，只留可执行的代码（保留 http:// 这种非注释的 `//`） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 切出一段函数体：从 startMarker 到 endMarker 之前 */
function sliceBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  if (a < 0) return ''
  const b = src.indexOf(endMarker, a + startMarker.length)
  return b > a ? src.slice(a, b) : src.slice(a)
}

/* ============================================================
   1. 客户端网络层：连接必须能复用
   ============================================================ */

console.log('\n== 1. 客户端网络层：连接能复用（否则每个 /api 都重做一次握手）==')

const HB_RAW = read('client/src/com/zyplnn/lxclient/HttpBridge.java')
const HS_RAW = read('client/src/com/zyplnn/lxclient/Handshake.java')
const HB = stripComments(HB_RAW)
const HS = stripComments(HS_RAW)

const readResp = sliceBetween(HB, 'private String readResponse(', 'private static boolean isBinary(')

/* 只看 finally 块：readResponse 里「无响应体」那条提前返回的分支**应该**断开
 * （没有 body 可读，连接已放弃），拿整个方法体断言会把它误判成违规。 */
const finallyBlock = (() => {
  const i = readResp.lastIndexOf('finally')
  return i >= 0 ? readResp.slice(i) : ''
})()

ok('HttpBridge.readResponse 切出来了（否则下面几条是空断言）', readResp.length > 200)
ok('finally 块切出来了（否则下一条是空断言）', finallyBlock.length > 20)
ok('读完响应后不再对连接调 disconnect（这是「每次重握手」的直接原因）',
  !/closeQuietly\(\s*conn\s*\)/.test(finallyBlock)
  && !/\bconn\s*\.\s*disconnect\s*\(/.test(finallyBlock))
ok('无响应体那条提前返回的分支仍然断开连接（那里没有 body 可读，不该留在池里）',
  /if\s*\(\s*is\s*==\s*null\s*\)[\s\S]{0,400}?closeQuietly\(\s*conn\s*\)/.test(readResp))
ok('响应流仍然被关掉（不 disconnect 的前提是流必须关，否则才是真泄漏）',
  /closeQuietly\(\s*is\s*\)/.test(readResp))
ok('closeQuietly 本身还在（重定向换地址那处仍然需要它）',
  /private static void closeQuietly\(/.test(HB))
ok('重定向分支仍然断开旧连接（那里响应体没读，本来就不能复用）',
  sliceBetween(HB, 'private String execute(', 'private HttpURLConnection open(').includes('closeQuietly(conn)'))

ok('Handshake 已不再 disconnect（握手/探测的连接要留给后续 /api 复用）',
  !/\.\s*disconnect\s*\(/.test(HS))
ok('Handshake.readStream 仍然关流', /rd\s*\.\s*close\s*\(\)/.test(HS))
ok('Handshake 的两处请求都还在（probe + needsSetup，别误删）',
  /\/api\/version/.test(HS) && /\/api\/setup-status/.test(HS))

/* ============================================================
   2. 首屏：并行而不是串行
   ============================================================ */

console.log('\n== 2. 首屏请求：并行发出，且不拿首帧用不到的东西挡路 ==')

const APPJS = read('public/js/app.js')
const bootRaw = sliceBetween(APPJS, 'async function boot()', 'function init()')
const boot = stripComments(bootRaw)

ok('boot() 切出来了（否则下面几条是空断言）', boot.length > 400)

const allArgs = (() => {
  const i = boot.indexOf('Promise.all(')
  if (i < 0) return ''
  const j = boot.indexOf('])', i)
  return j > i ? boot.slice(i, j) : ''
})()

ok('setupStatus 与 me 走同一个 Promise.all（并行，不再一前一后各等一个来回）',
  allArgs.includes('API.setupStatus()') && allArgs.includes('API.me()'))
ok('不再有独立的 await API.setupStatus()（串行的旧写法）',
  !/await\s+API\s*\.\s*setupStatus\s*\(/.test(boot))
ok('不再有独立的 await API.me()（串行的旧写法）',
  !/await\s+API\s*\.\s*me\s*\(/.test(boot))
ok('平台清单不再 await（首帧没有任何视图读它，白等一个来回）',
  !/await\s+API\s*\.\s*sources\s*\(/.test(boot))
ok('平台清单改成后台填充（.then 写入 App.sources）',
  /API\s*\.\s*sources\s*\(\s*\)\s*\.\s*then\s*\(/.test(boot))
ok('唯一阻塞首屏的 await route() 还在（渲染不能被吞掉）', /await\s+route\s*\(\)/.test(boot))
ok('me 的 catch 里**不**清令牌（服务器要初始化时 me 必然失败，那不是令牌坏了）',
  /API\s*\.\s*me\s*\(\s*\)\s*\.\s*then[\s\S]{0,120}?\.\s*catch\s*\(\s*\(?\s*e\s*\)?\s*=>\s*\(\s*\{\s*error/.test(allArgs))

/* ============================================================
   3. 快不能以改坏语义为代价
   ============================================================ */

console.log('\n== 3. 改快了，但语义一字未改 ==')

ok('needsSetup 分支仍在，且优先于登录判断',
  /status\.needsSetup/.test(boot)
  && (boot.indexOf('status.needsSetup') < boot.indexOf('if (!token)')))
ok('无令牌时仍然跳登录页', /if\s*\(\s*!token\s*\)/.test(boot))
ok('只有「明确被拒绝」那条分支才清令牌并跳登录页',
  (() => {
    const i = boot.indexOf('if (tokenRejected)')
    if (i < 0) return false
    const seg = boot.slice(i, i + 400)
    return /setToken\s*\(\s*''\s*\)/.test(seg) && /#\/login/.test(seg)
  })())
ok('setup 分支仍跳 #/setup', /#\/setup/.test(boot))
ok('me 的结果仍然落到身份上（不再取自被吞掉的局部变量）',
  /trustIdentity\s*\(\s*meRes\.user\s*\)/.test(boot))
ok('身份确认后仍记下 username（下一次冷启动的首帧靠它读磁盘缓存）',
  /trustIdentity\s*\(\s*meRes\.user\s*\)[\s\S]{0,220}rememberUser\s*\(\s*App\.user/.test(boot))
/**
 * 2026-10-09 补的一条：`me` 失败（超时/断网/服务器重启）**不等于**未登录，
 * 手里那份「服务端刚确认过的身份」不许被降级 —— 老板在这个点上报过
 * 「重新登录之后我的歌单空白、我的页显示未登录、大概 10 秒才好」。
 */
ok('me 失败时先看身份是否已确认（确认过就不降级、不标离线）',
  /if \(meRes\.error\)[\s\S]{0,320}if \(identityTrusted\)/.test(boot))
ok('App.ready 在身份确定之后才置位',
  boot.indexOf('App.ready = true') > boot.indexOf('trustIdentity(meRes.user)'))

/* ============================================================
   4. 客户端首屏：别再解析 1.9 MB 用不到的本机后端
   ============================================================ */

console.log('\n== 4. 客户端远程档案：不加载本机后端那两个大文件（合计 1.9 MB）==')

const CA = stripComments(read('client/src/com/zyplnn/lxclient/ClientActivity.java'))
const shell = sliceBetween(CA, 'private String injectClientShell(', 'private WebResourceResponse serveAsset(')

ok('injectClientShell 切出来了（否则下面几条是空断言）', shell.length > 500)
ok('远程档案下摘掉 plugins.data.js 的 script 标签',
  /replace\([^)]*plugins\.data\.js/.test(shell))
ok('远程档案下摘掉 backend.bundle.js 的 script 标签',
  /replace\([^)]*backend\.bundle\.js/.test(shell))
ok('摘除被 !builtin 守着（老壳走内置模式，这两个文件是命根子）',
  /if\s*\(\s*!\s*builtin\s*\)/.test(shell))

const NJ = stripComments(read('public/js/native.js'))
const njBoot = sliceBetween(NJ, 'function boot() {', 'function waitForLxp(')

ok('native.js 的 boot() 切出来了（否则下一条是空断言）', njBoot.length > 100)
ok('远程模式下 boot() 直接放行、不碰本机后端与插件预置（这才是「摘掉」成立的前提）',
  /if\s*\(\s*serverBase\s*\)\s*\{[\s\S]{0,500}?releaseBootstrap\s*\(\s*\)[\s\S]{0,200}?return/.test(njBoot))
ok('LXBackend 的消费者仍只有本机侧（远程模式下没人再读它）',
  !/LXBackend/.test(stripComments(read('public/js/util.js')))
  && !/LXBackend/.test(stripComments(read('public/js/player.js')))
  && !/LXBackend/.test(stripComments(read('public/js/app.js'))))
ok('LX_PLUGIN_DATA 的消费者仍只有 seedPlugins 那条路（远程模式读不到它）',
  (stripComments(read('public/js/native.js')).match(/LX_PLUGIN_DATA/g) || []).length === 1)

/* ============================================================
   5. 首屏空白：boot 异常要兜底，插件预置不许抢首屏
   ============================================================ */

console.log('\n== 5. 首屏不许留白：boot 异常兜底 + 插件预置让路 ==')

const initFn = sliceBetween(stripComments(APPJS), 'function init()', 'global.App = App')

ok('init() 切出来了（否则下面两条是空断言）', initFn.length > 100)
ok('boot() 挂了也兜底再渲染一次当前路由（否则 #view 永远空着，只能靠点底栏救）',
  /boot\s*\(\s*\)\s*\.\s*catch/.test(initFn) && /route\s*\(\s*\)\s*\.\s*catch/.test(initFn))
ok('不再是无 catch 的裸 boot()（异常会把整屏静默吞掉）',
  !/^\s*boot\s*\(\s*\)\s*$/m.test(initFn))

ok('seedPlugins 不再直接挂在 bootstrap 链上（会跟首屏渲染抢主线程）',
  !/\.then\s*\(\s*\(\s*\)\s*=>\s*seedPlugins\s*\(\s*\)\s*\)/.test(njBoot))
ok('seedPlugins 改到空闲时才跑（requestIdleCallback，老 WebView 回退到定时器）',
  /requestIdleCallback/.test(njBoot) && /setTimeout\s*\(\s*run\s*,/.test(njBoot))
ok('种子插件导入本身还在（别连同「延后」一起删掉）', /seedPlugins\s*\(\s*\)/.test(NJ))

/**
 * 这一组是 2026-10-08「打开客户端一片空白，点一下发现才出来」的根因护栏。
 *
 * 根因：首帧被串在「确认身份」那趟网络后面（客户端里还要过原生桥 + 冷 TLS，
 * 上游一慢就是好几秒），而点底栏走的是 hashchange，直接绕开整个启动流程 ——
 * 所以这个现象一直看着像玄学。修法是**首帧不等网络**：有令牌就先把当前路由
 * 画出来（用上一次登录的用户名读磁盘缓存），身份确认完再按真身份路由一次。
 */
ok('boot() 首帧不等网络：有令牌就先渲染一次当前路由',
  /if\s*\(\s*token\s*\)\s*route\s*\(\s*\)\s*\.\s*catch/.test(boot))
{
  const iRoute = boot.indexOf('if (token) route()')
  const iAll = boot.indexOf('Promise.all')
  ok('抢跑那一次在 await Promise.all **之前**（排在它后面就等于没修）',
    iRoute > 0 && iAll > iRoute, 'route@' + iRoute + ' Promise.all@' + iAll)
}
ok('没有令牌时不抢跑（那时该出的是登录页，先画首页会闪一下）',
  !/^\s*route\s*\(\s*\)\s*\.\s*catch/m.test(boot))
ok('身份确认完之后仍按真身份再路由一次（抢跑那次只是临时的）',
  /rememberUser\([\s\S]{0,300}await\s+route\s*\(\s*\)/.test(boot))
ok('init() 里 boot 之前的装配步骤包在 try/catch 里（那几步抛了 boot 就永不执行）',
  /try\s*\{[\s\S]{0,700}watchBrandForLogin\s*\(\s*\)[\s\S]{0,500}\}\s*catch/.test(initFn))
ok('装配 try/catch 在 init() 内部（不是在 init 调用处糊一层 —— 那样 boot 照样不执行）',
  initFn.indexOf('watchBrandForLogin') > 0 && initFn.indexOf('try') < initFn.indexOf('watchBrandForLogin'))

/* ============================================================
   6. 一次登录不许把最贵的接口打三遍
   ============================================================ */

console.log('\n== 6. 一次登录的请求风暴：同刻同请求合并 ==')

const APIJS = stripComments(read('public/js/api.js'))

/**
 * 2026-10-09 老板报「Docker 版客户端**重新登录**之后，我的歌单是空白、加载要半天」。
 * 真浏览器取证（tools/login-flow-probe.mjs，本地自建宿主 + 干净档案）看到的一次登录：
 *
 *     3× /api/home        2× /api/setup-status        2× /api/version
 *
 * 来源是「一次登录把首页渲染了好几遍」：`location.hash = '#/'` 派一次 hashchange、
 * `boot()` 里还有「首帧抢跑」的 route() 与结尾的 `await route()`。
 * 而 `/api/home` 在冷缓存上要「抓榜单 + 跨 6 个音源搜 24 首」，三份并发就是白算三遍 ——
 * 自建实例上别的请求（`/api/playlists`、`/api/me`）跟着一起卡，用户看到的就是
 * 「歌单空白转半天」「我的页还没登录」。
 *
 * 修法是在出口处合并（改那几处渲染点迟早会漏一个），下面钉住这条接线。
 */
ok('api.js 有同刻同请求合并（inflight 表）', /const inflight = new Map\(\)/.test(APIJS))
ok('GET 全走合并后的 once()（写操作是 POST/PATCH/DELETE，不受影响）',
  /const get = \(p\) => once\(p\)/.test(APIJS))
ok('合并键是**完整路径**（含 query —— 少了它会把不同查询合成一次）',
  /inflight\.get\(path\)/.test(APIJS) && /req\(path\)/.test(APIJS))
/**
 * 只按路径合并的话，「A 退出、B 登录」那一瞬间 A 在途的请求会被 B 复用 ——
 * 那是本项目最忌讳的串号（首页缓存专门按「服务器 + 账号」隔离同一个道理）。
 */
ok('合并键还带上令牌（换人登录时绝不共用同一个在途请求）',
  /const token = getToken\(\)[\s\S]{0,200}hit\.token === token/.test(APIJS))
ok('失败/成功都要把条目清掉（否则用户点「重试」会粘在上一发上）',
  /const drop = \(\) => \{[\s\S]{0,140}inflight\.delete\(path\)/.test(APIJS)
  && /promise\.then\(drop, drop\)/.test(APIJS))
ok('合并只发生在 GET 这一层，POST/PATCH/DELETE 仍走裸 req()',
  /const post = \(p, body\) => req\(p, \{ method: 'POST', body \}\)/.test(APIJS)
  && /const patch = \(p, body\) => req\(p, \{ method: 'PATCH', body \}\)/.test(APIJS)
  && /const del = \(p\) => req\(p, \{ method: 'DELETE' \}\)/.test(APIJS))

console.log('\n' + '='.repeat(62))
if (fails.length === 0) {
  console.log(`✅ 首屏启动速度护栏：${pass} 项全部通过`)
  process.exit(0)
} else {
  console.log(`❌ 首屏启动速度护栏：${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
