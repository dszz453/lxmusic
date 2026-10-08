/**
 * 客户端品牌名 —— 静态接线审计
 *
 * ── 这份测试防的是什么 ──────────────────────────────────────────
 * 老板要求：**Docker 版客户端叫 LX-MUSIC，CF 版（含 CF 网页端与 APK 壳）
 * 叫 music-edge，两个客户端相互独立**。而两个客户端**共用同一份 public/ 前端资源**，
 * 所以「我是谁」只能靠运行时判定。这带来三类很容易踩、且都不报错的坑：
 *
 *   1. **判据失效** —— 服务端没在 /api/version 回 host 字段，前端就永远只能用
 *      兜底猜测。而兜底猜测在「浏览器直接开 Docker 网页端」和「浏览器直接开 CF 线上」
 *      这两种最常见的情况下**答案一样**（都是 docker）→ CF 线上会显示成 LX-MUSIC。
 *      运行特征是「不报错，就是名字不对」，单元测试抓不到。
 *
 *   2. **接线断了** —— brand.js 写好了但 index.html 没引它、引的时机不对
 *      （早于 native.js 就读不到 LX_NATIVE，壳里会判成 docker）；
 *      或者 applyHost 没有任何调用点 → 名字永远停在兜底值。
 *      这是本项目吃过一次的亏（MediaBridge.ensureService 写好了却没调用点）。
 *
 *   3. **名字漂移** —— 名字本该只有一个事实来源，却又在某处写死一份。
 *      以前正是「名字散在四处、改一处漏一处」，所以这里逐个钉住。
 *
 * 纯静态，不需要浏览器 / 安卓运行时，跑得飞快。
 *
 * 跑法：node test/brand.test.mjs
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

/**
 * 从源码抽一个对象字面量并求值。
 *
 * ⚠️ 必须先去掉行注释：抽出来的片段形如
 *      docker: 'LX-MUSIC',   // 自托管（Docker / 本机 node …）
 *    拼成 `return { … }` 交给 new Function 时，那个 `//` 会把收尾的 `}` 一起注释掉，
 *    报 `SyntaxError: Unexpected token ')'` —— 本轮真踩过。
 */
function extractObject(src, name) {
  const m = src.match(new RegExp(`var ${name} = \\{([\\s\\S]*?)\\n  \\}`))
  if (!m) throw new Error(`没能在源码里找到 ${name} —— 是不是改名了？`)
  const body = m[1].replace(/\/\/[^\n]*/g, '')
  return new Function('return {' + body + '}')()
}

const BRAND = read('public/js/brand.js')
const INDEX = read('public/index.html')
const APP = read('public/js/app.js')
const SW = read('public/sw.js')
const MANIFEST = read('public/manifest.json')
const ADMIN = read('public/admin.html')
const API = read('src/server/api.js')
const CF_ENTRY = read('src/index.js')
const NODE_ENTRY = read('server/index.mjs')
const BUILD_APK = read('android/build-apk.sh')

console.log('== 1. 名字的唯一事实来源 ==')
{
  // 从 brand.js 里把 NAMES 字面量抽出来求值 —— 不另造一份平行实现，
  // 源码改了测试立刻跟着变（本项目在 test/stream-pick.mjs 上确立的做法）
  const NAMES = extractObject(BRAND, 'NAMES')
  ok('brand.js 里有 NAMES 常量', Object.keys(NAMES).length > 0)
  ok('docker 客户端叫 LX-MUSIC', NAMES.docker === 'LX-MUSIC', '实际: ' + NAMES.docker)
  ok('cf 客户端叫 music-edge', NAMES.cf === 'music-edge', '实际: ' + NAMES.cf)

  const SHORT = extractObject(BRAND, 'SHORT_NAMES')
  ok('brand.js 里有 SHORT_NAMES 常量（桌面图标下的短名）', Object.keys(SHORT).length > 0)
  ok('LX-MUSIC 的短名不超过 12 字符（否则桌面图标下被截断）', String(SHORT.docker || '').length <= 12)
  ok('music-edge 的短名不超过 12 字符', String(SHORT.cf || '').length <= 12)

  // 两个名字必须真的不同，否则「相互独立」这件事等于没做
  ok('两个客户端的名字不一样（否则没必要分）', NAMES.docker !== NAMES.cf)
}

console.log('\n== 2. host 字段：服务端必须自报家门 ==')
{
  ok('/api/version 回了 host 字段', /\/version'[\s\S]{0,400}?host:\s*env\.LX_HOST_KIND/.test(API))

  // 两个宿主各挂各的标志。缺任何一个，那边就会退化成「不知道」→ 走兜底猜
  ok('CF 入口声明自己是 cf', /env\.LX_HOST_KIND\s*=\s*'cf'/.test(CF_ENTRY))
  ok('Node 入口声明自己是 docker', /env\.LX_HOST_KIND\s*=\s*'docker'/.test(NODE_ENTRY))

  // 值必须落在前端认识的集合里（brand.js 的 HOST_MAP）
  const MAP = extractObject(BRAND, 'HOST_MAP')
  ok('前端认识 "cf"', MAP.cf === 'cf')
  ok('前端认识 "docker"', MAP.docker === 'docker')
}

console.log('\n== 3. brand.js 的加载时机与接线 ==')
{
  ok('index.html 引了 brand.js', INDEX.includes('/js/brand.js'))
  ok('sw.js 预缓存了 brand.js（离线时名字也要对）', SW.includes("'/js/brand.js'"))

  // ⚠️ 必须只匹配 <script src="…"> 那一行，不能拿整份 HTML 找子串：
  // index.html 的注释里详细写了各脚本的加载顺序与理由，直接 indexOf('/js/native.js')
  // 会命中**注释里那次**（位置远早于真正的 script 标签），断言就会假红。
  // 这类「断言匹配到说明文字」的坑本项目踩过（#platHealth 的 note 就写着「接口受限」）。
  const scriptOrder = []
  INDEX.split('\n').forEach((line, i) => {
    const m = line.match(/<script\s+src="([^"]+)"/)
    if (m) scriptOrder.push({ line: i + 1, src: m[1] })
  })
  const at = (f) => scriptOrder.findIndex((s) => s.src.endsWith(f))
  const iNative = at('/native.js')
  const iBrand = at('/brand.js')
  const iApp = at('/app.js')
  // 壳里靠 LX_NATIVE 认自己是 cf。brand.js 若排在 native.js 之前，
  // 那一刻 LX_NATIVE 还没被置位 → 壳会被判成 docker，名字就错了
  ok('brand.js 排在 native.js 之后（否则壳里读不到 LX_NATIVE）', iNative >= 0 && iBrand > iNative,
    'native@' + (iNative + 1) + ' brand@' + (iBrand + 1))
  // 要抢在首屏渲染与浏览器取 manifest 之前把名字刷对，否则闪一下旧名
  ok('brand.js 排在 app.js 之前（否则首屏会闪旧名）', iBrand >= 0 && iApp >= 0 && iBrand < iApp,
    'brand@' + (iBrand + 1) + ' app@' + (iApp + 1))

  // applyHost 是「服务端纠正兜底猜测」的唯一入口，没人调它就等于没接上
  ok('app.js 调用了 LXBrand.applyHost', /LXBrand\.applyHost\s*\(/.test(APP))
  // 必须把接口回的 host 传进去，而不是别的字段
  ok('applyHost 传的是 /api/version 的 host 字段', /applyHost\(\s*v\s*&&\s*v\.host\s*\)/.test(APP))

  /**
   * 品牌确认必须与登录状态无关。
   *
   * 本轮实测踩到的真 bug：bindBrand() 原本放在 boot() 里「已登录」之后的
   * `App.ready = true` 那段，而未登录走的是两个**提前 return** 的分支
   * （needsSetup / 无 token）→ 那两个分支根本到不了 bindBrand。
   * 表现是登录页（正中一个大标题，最需要正确名字的地方）永远显示兜底猜的名，
   * 而兜底猜在 Docker 与 CF 上答案一样（都是 docker）→ **CF 线上会显示成 LX-MUSIC**。
   *
   * 边界取「boot 里第一个 if」而不是「第一个 return」—— 后者会命中
   * **注释里的**「提前 return」这个词，断言假红（本轮又踩了一次：
   * 「断言别匹配会出现在说明文字里的词」这条规矩要反复提醒自己）。
   */
  const bootStart = APP.indexOf('async function boot()')
  const firstIf = APP.indexOf('if (', bootStart)
  const bootHead = bootStart >= 0 && firstIf > bootStart ? APP.slice(bootStart, firstIf) : ''
  ok('bindBrand() 在 boot() 的最前面（未登录也要认得出自己是哪个客户端）',
    /bindBrand\(\)/.test(bootHead),
    bootHead ? 'boot 头部未见 bindBrand()' : '没找到 boot()')
  // 而且不该在别处再调一次（重复调用多发一次请求，也没必要）
  ok('bindBrand() 只被调用一次', (APP.match(/bindBrand\(\)/g) || []).length === 2,
    '出现 ' + (APP.match(/bindBrand\(\)/g) || []).length + ' 次（含定义处那一次）')
}

console.log('\n== 4. 界面文案不再写死旧品牌名 ==')
{
  // 老板要求「全部替换掉，界面上不再出现云音乐」。
  // 注意排除：注释里的说明、以及「网易云音乐」这个平台名（那不能动）
  const uiFiles = ['public/index.html', 'public/js/app.js', 'public/admin.html', 'public/manifest.json']
  const offenders = []
  for (const f of uiFiles) {
    const src = read(f)
    src.split('\n').forEach((line, i) => {
      if (!line.includes('云音乐')) return
      const trimmed = line.trim()
      // 注释行放过（说明文字里提到旧名是正常的，甚至是必要的）
      if (/^(\*|\/\/|\/\*|<!--)/.test(trimmed)) return
      // 「网易云音乐」是平台名，不是本应用的名字
      if (line.includes('网易云音乐')) return
      offenders.push(f + ':' + (i + 1) + '  ' + trimmed.slice(0, 70))
    })
  }
  ok('界面文案里没有残留「云音乐」', offenders.length === 0, offenders.join(' | '))

  ok('登录页大标题走 brandName()（不是写死的）', /pageLogin[\s\S]{0,400}?esc\(brandName\(\)\)/.test(APP))
  ok('document.title 走 brandName()', /document\.title\s*=\s*\(song\.name\s*\|\|\s*brandName\(\)\)/.test(APP))
  ok('app.js 定义了 brandName()', /function brandName\(\)/.test(APP))
  // 退路必须是中性名 —— 退回某个具体品牌名就等于又写死了一份，会漂
  ok('brandName 的退路是中性的，不是某个具体品牌名',
    /function brandName\(\)\s*\{[\s\S]{0,200}?\|\|\s*'音乐'/.test(APP))
}

console.log('\n== 5. manifest 按宿主合成 ==')
{
  ok('brand.js 有 installManifest', /function installManifest\(\)/.test(BRAND))
  ok('合成时会改 name 与 short_name', /raw\.name\s*=/.test(BRAND) && /raw\.short_name\s*=/.test(BRAND))
  // id 必须跟着变：两个客户端装同一台设备时 id 相同会互相顶掉
  ok('合成时会改 id（否则两个客户端装同一台设备会互相顶掉）', /raw\.id\s*=/.test(BRAND))
  ok('静态 manifest.json 的兜底名已是 music-edge（CF 线上直接吃这份）',
    /"short_name":\s*"music-edge"/.test(MANIFEST))

  /**
   * 浏览器模式首屏**不得**同步应用 title/manifest。
   *
   * 原因（实测踩到）：浏览器上同步判据猜不出 Docker 与 CF（两者 LX_REMOTE 都是假），
   * 猜的结果在 CF 上是 docker → 同步应用等于把静态的 music-edge 覆盖成 LX-MUSIC，
   * 接口回来再纠正 —— 线上出现「music-edge → LX-MUSIC → music-edge」两次切换，
   * 中间还是个**错名字**。所以立即生效段只能被「判据可靠」的两类宿主放行：
   *   · 老的 music-edge 壳（LX_NATIVE）
   *   · 通用客户端（LX_CLIENT_HOST_HINT —— 客户端握手时就知道自己连的哪条线）
   * 两者在浏览器里都不存在，所以浏览器模式的守卫效果不变。
   */
  const tail = BRAND.slice(BRAND.indexOf('立即生效'))
  ok('立即生效段被 LX_NATIVE 守卫（浏览器模式不动静态落点，防闪错名）',
    /if \(global\.LX_NATIVE/.test(tail))
  ok('立即生效段额外放行通用客户端的同步判据（否则 Docker 线会装成 music-edge 身份）',
    /if \(global\.LX_NATIVE \|\| global\.LX_CLIENT_HOST_HINT\)/.test(tail))
  ok('guessHost 优先采信客户端的同步判据 LX_CLIENT_HOST_HINT',
    /function guessHost\(\)\s*\{[\s\S]{0,220}LX_CLIENT_HOST_HINT/.test(BRAND))
  ok('浏览器模式（无 hint）仍不会走到立即生效段',
    /if \(global\.LX_NATIVE \|\| global\.LX_CLIENT_HOST_HINT\)/.test(tail)
    && !/LX_CLIENT_HOST_HINT\s*\|\|\s*true/.test(tail))
  ok('浏览器模式的 manifest 合成延后到服务端确认（applyHost 里做）',
    /manifestDone\s*=\s*true[\s\S]{0,120}installManifest/.test(BRAND.slice(BRAND.indexOf('applyHost ='))))

  // 登录页大标题的竞态：首屏渲染时品牌可能还是猜的，确认后要纠正
  ok('登录页 h1 带 id（确认后可被纠正）', /<h1 id="loginBrand">/.test(APP))
  ok('app.js 监听 lx-brand 事件纠正登录页标题', /watchBrandForLogin/.test(APP) && /addEventListener\('lx-brand'/.test(APP))
  ok('init() 里注册了品牌监听', /init\(\)\s*\{[\s\S]{0,200}watchBrandForLogin\(\)/.test(APP))
}

console.log('\n== 6. APK 构建清单跟得上 ==')
{
  // build-apk.sh 有一份「必须存在」的白名单，缺文件即中断构建。
  // brand.js 不加进去，就会出现「构建通过但包里没有 brand.js」——
  // 壳里名字错，而且没人知道为什么
  ok('build-apk.sh 的资源白名单里有 brand.js', /js\/brand\.js/.test(BUILD_APK))
}

console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
} else {
  console.log('全部 ' + pass + ' 项通过')
}
