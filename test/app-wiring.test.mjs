/**
 * 原生媒体会话 —— 静态接线审计
 *
 * 为什么需要这么一份测试：
 *
 * 1.8 那版的原生媒体层，Java 编译通过、桌面替身 26 项链路验收全绿，
 * 但装到真机上「任务中心 / 锁屏一整套完全不生效」。根因是
 * **MediaBridge.ensureService() 写好了却全仓没有任何调用点** ——
 * 播放服务从来没被启动过，listener 恒为 null，notifyState() 每次直接空转。
 *
 * 这类 bug 的运行特征是「不是报错，是压根没跑」，所以：
 *   · 单元测试抓不到（被测函数本身是对的）；
 *   · 桌面替身抓不到（替身顶掉的是 Java 那一层，验的是 JS→替身）；
 *   · 编译期更抓不到（未调用的 public 方法完全合法）。
 *
 * 只能从「接线」层面查：方法有没有人调、门面有没有对应实现、两端的命令字是否对齐、
 * 清单声明的权限与类型是否齐、版本号两处是否一致。
 * 本文件就是干这个的 —— 纯静态，不需要安卓运行时，跑得飞快。
 *
 * 跑法：node test/app-wiring.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const JAVA_DIR = path.join(ROOT, 'android', 'src', 'com', 'zyplnn', 'musicedge')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const readJava = (f) => fs.readFileSync(path.join(JAVA_DIR, f), 'utf8')

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

const manifest = read('android/AndroidManifest.xml')
const buildSh = read('android/build-apk.sh')
/**
 * 版本号的**单一事实来源**。
 *
 * 1.10 起 build-apk.sh 不再写死 VERSION_CODE / VERSION_NAME ——
 * 它是 `VERSION_CODE="$(node -e "import('./src/version.js')…")"` 这样读出来的。
 * 于是早先那版「拿正则去 build.sh 里抠数字」的断言必然抠不到（实测报 `脚本 null`），
 * 但**产品其实是对的**：两处都对，只是比对的中介物选错了。
 *
 * 正确口径是「清单(兜底值) ↔ src/version.js(事实来源)」，
 * 顺带保证 build-apk.sh 确实是从那边取的（否则改了 version.js 而包里没变）。
 */
const versionJs = read('src/version.js')
const srcCode = /APP_VERSION_CODE\s*=\s*(\d+)/.exec(versionJs)
const srcName = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(versionJs)
const mediaBridge = readJava('MediaBridge.java')
const playback = readJava('PlaybackService.java')
const mainActivity = readJava('MainActivity.java')
const nativeJs = read('public/js/native.js')
const appJs = read('public/js/app.js')

/* ---------------------------------------------------------------- 1. 服务启动链路 */
console.log('\n== 1. 播放服务必须真的被启动 ==')

/** 去掉定义行后还剩几个调用点 */
function callSites(src, name) {
  const lines = src.split('\n')
  let defs = 0
  let calls = 0
  for (const line of lines) {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
    const re = new RegExp('\\b' + name + '\\s*\\(', 'g')
    const hits = (line.match(re) || []).length
    if (!hits) continue
    // 定义行形如：public static void ensureService(   /   private void goForeground(
    if (/\b(void|int|boolean|String|Bitmap|State|Notification)\s+$/.test(line.split(name)[0]) &&
        /^\s*(public|private|protected|static|final|\s)+/.test(line)) {
      defs += hits
    } else {
      calls += hits
    }
  }
  return { defs, calls }
}

const ensure = callSites(mediaBridge, 'ensureService')
ok('MediaBridge 里 ensureService 有定义', ensure.defs === 1, JSON.stringify(ensure))
// 关键的那条：定义了必须有人调。1.8 就是在这里翻车的。
ok('ensureService 至少有两个调用点（上报时拉起 + 通知兜底）', ensure.calls >= 2,
  '实际调用点 ' + ensure.calls + ' 个 —— 为 0 就是「服务永远不会启动」')

ok('report() 在上报有曲目时拉起服务', /if \(next\.hasTrack\) ensureService\(\);/.test(mediaBridge))
ok('notifyState() 里有兜底拉起（listener 为空但 state.hasTrack）',
  /if \(l == null\) \{[\s\S]{0,200}?ensureService\(\);/.test(mediaBridge))
ok('ensureService 失败会留痕（不再吞掉异常）', /recordError\("启动播放服务失败"/.test(mediaBridge))

const setListener = callSites(playback, 'setListener')
ok('PlaybackService 把监听器注册到 MediaBridge（不注册则通知永远渲染不出来）',
  setListener.calls >= 1, JSON.stringify(setListener))

const setServiceAlive = callSites(playback, 'setServiceAlive')
ok('服务的存活标志被维护（true/false 各一次）', setServiceAlive.calls >= 2, JSON.stringify(setServiceAlive))

/* ------------------------------------------------ 2. startForeground 的 5 秒硬期限 */
console.log('\n== 2. 前台服务的启动时序 ==')
ok('onStartCommand 里先无条件进前台（占位通知守住 5 秒期限）',
  /onStartCommand[\s\S]{0,1200}?if \(!foreground\) goForeground\(buildPlaceholder\(\)\);/.test(playback))
ok('占位通知存在且带 MediaStyle', /private Notification buildPlaceholder\(\)/.test(playback))
ok('没曲目时会自动收摊（不留点不动的通知）', /emptyStop/.test(playback) &&
  /postDelayed\(emptyStop/.test(playback))
ok('startForeground 失败会退回普通通知兜底 + 留痕',
  /catch \(Throwable t\) \{[\s\S]{0,900}?nm\.notify\(NOTIFICATION_ID, n\)/.test(playback) &&
  /recordError\("startForeground 失败"/.test(playback))
ok('清单里声明了 mediaPlayback 类型与对应权限',
  /android:foregroundServiceType="mediaPlayback"/.test(manifest) &&
  /FOREGROUND_SERVICE_MEDIA_PLAYBACK/.test(manifest))
ok('服务不随任务划掉而销毁（stopWithTask=false）', /stopWithTask="false"/.test(manifest))

/* ------------------------------------------------------ 3. MediaSession 关键三件套 */
console.log('\n== 3. MediaSession 的关键声明 ==')
ok('会话被激活（setActive(true)，不激活收不到按键）', /session\.setActive\(true\);/.test(playback))
ok('声明成本机播放（setPlaybackToLocal，缺失时部分 ROM 直接忽略这条会话）',
  /session\.setPlaybackToLocal\(/.test(playback))
ok('会话可被点击回到 App（setSessionActivity）', /setSessionActivity\(/.test(playback))
ok('通知是 MediaStyle 且挂了 session token',
  /Notification\.MediaStyle\(\)/.test(playback) && /setMediaSession\(session\.getSessionToken\(\)\)/.test(playback))
ok('PlaybackState 报告了可用按键与位置', /ACTION_SKIP_TO_NEXT/.test(playback) &&
  /setState\(s\.playing \? PlaybackState\.STATE_PLAYING/.test(playback))
ok('metadata 带时长与封面', /METADATA_KEY_DURATION/.test(playback) && /METADATA_KEY_ALBUM_ART/.test(playback))

/* ------------------------------------------- 4. 两端命令字必须一一对齐（跨语言契约） */
console.log('\n== 4. 命令字契约（原生发出 → 页面必须认识）==')
const javaCmds = new Set()
for (const m of playback.matchAll(/MediaBridge\.command\("([a-z]+)"/g)) javaCmds.add(m[1])
ok('原生侧确实发命令', javaCmds.size > 0, [...javaCmds].join(','))
const jsHandled = new Set()
const onCommandBlock = nativeJs.slice(nativeJs.indexOf('onCommand(cmd, arg)'))
for (const m of onCommandBlock.slice(0, 900).matchAll(/case '([a-z]+)':/g)) jsHandled.add(m[1])
const missing = [...javaCmds].filter(c => !jsHandled.has(c))
ok('原生会发的每个命令页面都处理了', missing.length === 0,
  '页面没处理的：' + (missing.join(',') || '无'))
// 反向：页面处理但原生从不发，只是冗余，不算问题；但 handleKey 里的键值映射要在
const keyCodes = new Set()
for (const m of playback.matchAll(/case KeyEvent\.(KEYCODE_[A-Z_]+):/g)) keyCodes.add(m[1])
ok('实体媒体键有显式映射（耳机 / 蓝牙 / 车机）', keyCodes.size >= 5, [...keyCodes].join(','))
ok('onMediaButtonEvent 有实现（不靠框架猜该播还是该停）', /public boolean onMediaButtonEvent\(/.test(playback))
ok('ACTION_MEDIA_BUTTON 广播兜底也在', /case Intent\.ACTION_MEDIA_BUTTON:/.test(playback))

/* ------------------------------------------------- 5. Host 门面：JS 用到的都有实现 */
console.log('\n== 5. AndroidHost 门面方法必须齐全 ==')
const wanted = new Set()
for (const src of [nativeJs, appJs]) {
  for (const m of src.matchAll(/(?:HOST|window\.AndroidHost|AndroidHost)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    wanted.add(m[1])
  }
}
const hostBlock = mainActivity.slice(mainActivity.indexOf('public class Host'))
const implemented = new Set()
for (const m of hostBlock.matchAll(/@JavascriptInterface\s+public\s+\w+\s+(\w+)\s*\(/g)) implemented.add(m[1])
const notImpl = [...wanted].filter(n => !implemented.has(n))
ok('JS 调用的每个门面方法在 Host 里都有 @JavascriptInterface 实现',
  notImpl.length === 0, '缺：' + (notImpl.join(',') || '无'))
ok('门面里至少包含 httpRequest / dbQuery / dbExec / mediaReport',
  ['httpRequest', 'dbQuery', 'dbExec', 'mediaReport'].every(n => implemented.has(n)),
  [...implemented].join(','))
ok('门面对象名注册为 AndroidHost',
  /addJavascriptInterface\(new Host\(\), "AndroidHost"\)/.test(mainActivity))

/* --------------------------------------------------------- 6. 诊断链路（可远程定位） */
console.log('\n== 6. 诊断链路 ==')
ok('Host.mediaStatus() 存在（页面能拿到原生实况）', /mediaStatus\(\)/.test(hostBlock))
ok('native.js 暴露 __lxMediaDiag', /global\.__lxMediaDiag\s*=\s*mediaDiag/.test(nativeJs))
ok('native.js 暴露 __lxMediaWake（测试上报）', /global\.__lxMediaWake\s*=\s*mediaWake/.test(nativeJs))
ok('MediaBridge.diagJson() 汇总了关键字段',
  ['serviceAlive', 'sessionActive', 'foreground', 'notifiedAt', 'reportCount']
    .every(f => new RegExp('o\\.put\\("[a-zA-Z]+", ' + f + '\\)').test(mediaBridge)) ||
  /o\.put\("service", serviceAlive\)/.test(mediaBridge))
ok('设置页有「系统播放控制」卡片与四个动作',
  /function mediaBlockHtml\(\)/.test(appJs) &&
  ["'media-refresh'", "'media-ask-notif'", "'media-open-settings'", "'media-test-push'", "'media-diag'"]
    .every(a => appJs.includes('case ' + a + ':')))
ok('通知权限状态、通知总开关、通道状态都能查',
  /notifGranted\(\)/.test(mainActivity) && /notifEnabled\(\)/.test(mainActivity) &&
  /channelState\(\)/.test(mainActivity))

/* -------------------------------------------------------------- 7. 版本号两处一致 */
console.log('\n== 7. 版本号一致性与发布约束 ==')
const mc = /android:versionCode="(\d+)"/.exec(manifest)
const mn = /android:versionName="([\d.]+)"/.exec(manifest)

// 事实来源必须有值，否则后面全是「null === null」的假通过
ok('src/version.js 声明了 APP_VERSION 与 APP_VERSION_CODE',
  !!(srcCode && srcCode[1]) && !!(srcName && srcName[1]),
  `APP_VERSION=${srcName && srcName[1]} / CODE=${srcCode && srcCode[1]}`)

const wantName = (srcName && srcName[1] || '').replace(/^v/i, '')
const wantCode = srcCode && srcCode[1]
ok('清单里的 versionCode 与 src/version.js 一致',
  !!mc && !!wantCode && mc[1] === wantCode, `清单 ${mc && mc[1]} / version.js ${wantCode}`)
ok('清单里的 versionName 与 src/version.js 一致',
  !!mn && !!wantName && mn[1] === wantName, `清单 ${mn && mn[1]} / version.js ${wantName}`)

// 构建脚本必须是**从 version.js 取**，不能自己写死一套 —— 否则改了 version.js 包里没变
ok('build-apk.sh 从 src/version.js 读版本（不是自己写死一套）',
  /VERSION_CODE="\$\(node[^)]*src\/version\.js/.test(buildSh) &&
  /VERSION_NAME="\$\(node[^)]*src\/version\.js/.test(buildSh),
  '没看到从 src/version.js 取值的写法')
ok('aapt2 link 用的就是这两个变量（取到了却没传进去 = 白取）',
  /--version-code\s+\$VERSION_CODE/.test(buildSh) && /--version-name\s+"\$VERSION_NAME"/.test(buildSh))

// 本版说明段：约定形如 `# 1.0：……`
ok('构建脚本里有本版说明（每次改包都该写清楚改了什么）',
  buildSh.includes('# ' + wantName + '：'), '没找到 `# ' + wantName + '：` 的说明段')

/* 发版规矩（老板 2026-10-06 定）：每发一版 APP_VERSION 升 0.1、APP_VERSION_CODE +1。
 * 这条规矩没法靠测试「强制」—— 测试不知道什么时候算发了一版。
 * 能强制的是**同一次发版里几处别漏改**：版本改了、code 没改，手机上装不上新版；
 * package.json 跟不上，npm 侧看到的又是另一个数字。所以这里把「一致性」钉住。 */
console.log('\n== 7b. 发版规矩：几处版本号必须同步 ==')
const pkg = JSON.parse(read('package.json'))
// V1.1 ↔ 1.1.0 （产品版本两位 → semver 补一个 .0）
const wantPkg = wantName + '.0'
ok('package.json 的 version 与 src/version.js 对得上',
  pkg.version === wantPkg, `package.json ${pkg.version} / 期望 ${wantPkg}`)
ok('versionCode 是个只增不减的整数（Android 靠它判断能否覆盖安装）',
  /^\d+$/.test(String(wantCode)), 'code=' + wantCode)
ok('README 头部的「当前版本」跟得上 src/version.js',
  read('README.md').includes('当前版本：V' + wantName),
  'README 里没找到 `当前版本：V' + wantName + '`')
ok('sw.js 的 VERSION 没被当成产品版本用（两条线要分开）',
  !new RegExp("APP_VERSION\\s*=\\s*'v").test(versionJs))

const swVer = /const VERSION = 'v(\d+)'/.exec(read('public/sw.js'))
ok('sw.js 的 VERSION 存在（改静态资源必须抬它，否则手机吃旧缓存）', !!swVer,
  swVer ? 'v' + swVer[1] : '没有 VERSION')

/**
 * ⚠ sw.js 必须**语法可解析** —— 2026-10-10 发现的事故，必须钉死。
 *
 * V2.6 发版时，顶部那段版本说明在 v43 处**提前写了一个块注释结束标记**，于是 v43 的
 * 说明段落到了注释外面、成了裸代码 —— 整个 sw.js 是语法错误，浏览器注册 Service
 * Worker 直接失败（自 2.6 起，直到 10-10 才发现）。
 *
 * 为什么一整轮发版验收都没抓到：`verify-cf.mjs` 做的是**逐文件 sha256 对账**，
 * 它只能证明「线上和我本地这一份一致」，证明不了「这份代码是好的」——
 * 12 道对账全绿、SW 却根本跑不起来。所以这里改用「能不能被解析」来把门：
 * 用 vm.Script 只做**语法**检查，不执行（sw.js 用 self/caches，执行会抛）。
 *
 * 顺带一提：这个文件里写注释要特别小心 —— 描述这条规则本身就可能再触发它，
 * 所以上面一律用「块注释结束标记」来指代，不写那个两字符字面量。
 */
let swParseErr = ''
try {
  new vm.Script(read('public/sw.js'), { filename: 'public/sw.js' })
} catch (e) {
  swParseErr = String((e && e.message) || e).split('\n')[0]
}
ok('⚠ sw.js 能被解析（注释块别提前闭合 —— 否则整个 SW 注册不上，对账还全绿）',
  swParseErr === '', swParseErr)

/* --------------------------------------------------------------- 8. 桌面替身要跟得上 */
console.log('\n== 8. 测试替身与真机形态同步 ==')
const stubMedia = read('test/app-media.mjs')
const stubNative = read('test/app-native.mjs')
ok('app-media 替身提供了 mediaStatus（否则设置页会抛）', /mediaStatus/.test(stubMedia))
ok('app-native 替身提供了 mediaStatus', /mediaStatus/.test(stubNative))

/* ------------------------------------------------------------------------- 汇总 */
console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log(`共 ${pass + fails.length} 项，通过 ${pass}，失败 ${fails.length}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
} else {
  console.log(`全部 ${pass} 项通过`)
}
