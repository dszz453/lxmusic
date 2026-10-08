/**
 * 客户端接线审计 —— 静态检查，不需要安卓运行时，秒级跑完。
 *
 * ── 这份测试防的是什么 ──────────────────────────────────────────
 * 客户端（client/）比隔壁那个壳（android/）复杂得多：它有**四条链路**要同时对上，
 * 而每一条的断裂方式都是「不报错、只是某个功能没了」：
 *
 *   1. 版本线：客户端 V1.0 与服务端 V1.3 是**两条独立的版本线**，
 *      但客户端必须知道「自己该跟哪一版服务端说话」。两边漂移的症状是
 *      握手永远提示版本不一致（用户学会忽略它 = 这条告警等于没有）。
 *
 *   2. 桥：Java 的 @JavascriptInterface 方法名 ↔ JS 里的调用名。
 *      改一个名字，桥照样「在」，只是那个方法变 undefined ——
 *      共用前端在读写它时才会踩空（本项目吃过：MediaBridge.ensureService
 *      写好了却没有任何调用点，整条媒体会话链路一声不响地没跑）。
 *
 *   3. 跨端层模块清单：tools/build-client-rn.mjs 的 MODULES 与 client/rn/src/ 下的
 *      文件必须完全一致。**多一个没进清单 = 那份代码永远不会执行**（静默）；
 *      清单里少一个 = 构建直接失败（这个反而是好事）。
 *
 *   4. 注入契约：宿主在 <head> 里注入的那几个全局变量（LX_CLIENT_HOST_HINT /
 *      LX_CLIENT_SERVICE）与共用前端的读取点必须对得上；宿主注入的 CSS 选择器
 *      必须在网页里真实存在（选择器写错 = 网页顶栏底栏与原生的同时出现，
 *      看起来像「UI 重叠 bug」）。
 *
 * 跑法：node test/client-wiring.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

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

/* ---------------- 读入各方材料 ---------------- */

const V = await import('file://' + path.join(ROOT, 'client/version.mjs').replace(/\\/g, '/'))
const SRCVER = await import('file://' + path.join(ROOT, 'src/version.js').replace(/\\/g, '/'))

const C_MANIFEST = read('client/AndroidManifest.xml')
const A_MANIFEST = read('android/AndroidManifest.xml')
const BUILD = read('client/build-client.sh')
const BUILD_SHELL = read('android/build-apk.sh')
const RN_BUILD = read('tools/build-client-rn.mjs')
const CLIENT_ACT = read('client/src/com/zyplnn/lxclient/ClientActivity.java')
const BRIDGE = read('client/src/com/zyplnn/lxclient/BridgeHub.java')
const BRAND_JAVA = read('client/src/com/zyplnn/lxclient/ClientBrand.java')
const UI_JAVA = read('client/src/com/zyplnn/lxclient/Ui.java')
const STORE_JAVA = read('client/src/com/zyplnn/lxclient/ServerStore.java')
const AUDIO_JAVA = read('client/src/com/zyplnn/lxclient/core/AudioEngine.java')
const COLORS = read('client/res/values/colors.xml')
const STRINGS = read('client/res/values/strings.xml')
const INDEX = read('public/index.html')
const APPJS = read('public/js/app.js')
const BRANDJS = read('public/js/brand.js')
const NATIVEJS = read('public/js/native.js')
const CSS = read('public/css/app.css')

const RN_SRC = path.join(ROOT, 'client/rn/src')
const rnFiles = fs.existsSync(RN_SRC)
  ? fs.readdirSync(RN_SRC).filter((f) => f.endsWith('.js')).sort()
  : []

/** 抠 Java 里的 @JavascriptInterface 方法名 */
function jsMethods(src) {
  return [...new Set([...src.matchAll(/@JavascriptInterface\s+public\s+[\w[\]]+\s+(\w+)\s*\(/g)].map((m) => m[1]))]
}

/** 抠 Java 里某个字符串常量的值 */
function strConst(src, name) {
  const m = src.match(new RegExp(`String\\s+${name}\\s*=\\s*"([^"]*)"`))
  return m ? m[1] : null
}

/* ══════════════ 1. 版本线 ══════════════ */

console.log('\n== 1. 两条版本线各就各位，且客户端知道该跟哪一版服务端说话 ==')
{
  ok('客户端版本清单存在（client/version.mjs）', exists('client/version.mjs'))
  ok('CLIENT_VERSION 以 V 开头（形如 V1.0）', /^V\d/.test(V.CLIENT_VERSION), V.CLIENT_VERSION)
  ok('CLIENT_VERSION_CODE 是 ≥100 的整数（Android 靠它判断能否覆盖安装）',
    Number.isInteger(V.CLIENT_VERSION_CODE) && V.CLIENT_VERSION_CODE >= 100,
    String(V.CLIENT_VERSION_CODE))

  // ★ 最关键的一条：客户端「期望的服务端版本」必须跟着服务端走。
  //   这条断言断在这里而不是「客户端版本 == 服务端版本」—— 两者本来就该能不同号，
  //   强行要求相等会把「服务端发版 → 全量用户重装 App」这种荒唐规则钉进测试里。
  ok('client/version.mjs 的 SERVICE_VERSION === 服务端 APP_VERSION',
    V.SERVICE_VERSION === SRCVER.APP_VERSION,
    `${V.SERVICE_VERSION} vs ${SRCVER.APP_VERSION}`)
  ok('ClientBrand.SERVICE_EXPECT 与同一个值一致（Java 侧握手的比对基准）',
    strConst(BRAND_JAVA, 'SERVICE_EXPECT') === SRCVER.APP_VERSION,
    `${strConst(BRAND_JAVA, 'SERVICE_EXPECT')} vs ${SRCVER.APP_VERSION}`)
  ok('两条版本线确实是分开的（客户端版本 ≠ 服务端版本，或至少各自独立成常量）',
    V.CLIENT_VERSION !== SRCVER.APP_VERSION || V.SERVICE_VERSION === SRCVER.APP_VERSION)
  ok('客户端与服务端的 versionCode 不共用一个数字（避免以后有人把它们强行对齐）',
    V.CLIENT_VERSION_CODE !== SRCVER.APP_VERSION_CODE,
    String(V.CLIENT_VERSION_CODE))

  ok('清单里的兜底 versionName 与客户端版本线一致',
    C_MANIFEST.includes(`android:versionName="${V.CLIENT_VERSION.replace(/^v/i, '')}"`))
  ok('清单里的兜底 versionCode 与客户端版本线一致',
    C_MANIFEST.includes(`android:versionCode="${V.CLIENT_VERSION_CODE}"`))
  ok('清单里的包名与 CLIENT_PACKAGE 一致',
    C_MANIFEST.includes(`package="${V.CLIENT_PACKAGE}"`))
  ok('strings.xml 的 app_name 与 CLIENT_APP_NAME 一致',
    STRINGS.includes(`<string name="app_name">${V.CLIENT_APP_NAME}</string>`))
  ok('Java 侧的客户端名与 CLIENT_APP_NAME 一致',
    strConst(BRAND_JAVA, 'CLIENT_NAME') === V.CLIENT_APP_NAME)
}

/* ══════════════ 2. 与老壳并存 ══════════════ */

console.log('\n== 2. 与 music-edge 壳并存，互不覆盖 ==')
{
  const pkg = (src) => (src.match(/package="([\w.]+)"/) || [])[1]
  ok('客户端包名与老壳包名不同（否则后装的会把先装的顶掉，用户数据全丢）',
    pkg(C_MANIFEST) !== pkg(A_MANIFEST), `${pkg(C_MANIFEST)} vs ${pkg(A_MANIFEST)}`)
  ok('客户端包名与 client/version.mjs 声明的一致', pkg(C_MANIFEST) === V.CLIENT_PACKAGE)

  // 密钥：两个包共用同一把（包名不同不会冲突），且绝不能放 build/ ——
  // build/ 每轮被清，密钥一丢就只能让用户卸载重装。
  const ksClient = (BUILD.match(/^KS="\$ROOT\/(.+)"$/m) || [])[1]
  const ksShell = (BUILD_SHELL.match(/^KS="\$HERE\/(.+)"$/m) || [])[1]
  ok('客户端签名密钥指向 android/keystore/（不在 build/ 里）',
    ksClient && ksClient.startsWith('android/keystore/'), String(ksClient))
  ok('两个客户端共用同一把密钥（部署者只需要备份一份）',
    ksClient && ksShell && ksClient.replace(/^android\//, '') === ksShell,
    `${ksClient} vs ${ksShell}`)
}

/* ══════════════ 3. 构建脚本接线 ══════════════ */

console.log('\n== 3. 构建脚本：版本从哪来、白名单够不够 ==')
{
  ok('build-client.sh 从 client/version.mjs 读版本（不是写死）',
    /client\/version\.mjs/.test(BUILD) && !/VERSION_CODE="\d/.test(BUILD))
  ok('版本真的传给了 aapt2 link（--version-code / --version-name）',
    /--version-code \$VERSION_CODE/.test(BUILD) && /--version-name "\$VERSION_NAME"/.test(BUILD))
  ok('构建前会打包跨端业务层', /tools\/build-client-rn\.mjs/.test(BUILD))
  ok('assets 白名单里有 js/client-layer.js',
    /js\/client-layer\.js/.test(BUILD.slice(BUILD.indexOf('for f in index.html'))))
  ok('assets 白名单里有 client-build.txt（构建标识，关于页与诊断要读）',
    /client-build\.txt/.test(BUILD.slice(BUILD.indexOf('for f in index.html'))))
  ok('同步残留的清理排除了客户端专属文件（否则每轮都被删一次）',
    /CLIENT_ONLY=/.test(BUILD) && /continue 2/.test(BUILD))
  ok('产物名是 lx-music-client-<版本>（与老壳的 music-edge-* 区分开）',
    /APP_NAME="lx-music-client"/.test(BUILD))
  ok('清单声明了四个原生页面 + 主界面 + 播放服务',
    ['.ClientActivity', '.ServerActivity', '.SettingsActivity', '.LocalMusicActivity',
      '.AboutActivity', '.PlaybackService'].every((c) => C_MANIFEST.includes(`android:name="${c}"`)))
}

/* ══════════════ 4. 跨端业务层 ══════════════ */

console.log('\n== 4. 跨端业务层：模块清单、守卫、桥调用 ==')
{
  const listed = [...RN_BUILD.matchAll(/^\s*'([\w-]+\.js)',/gm)].map((m) => m[1])
  ok('打包器的模块清单非空', listed.length >= 4, String(listed.length))
  const missing = listed.filter((f) => !rnFiles.includes(f))
  const extra = rnFiles.filter((f) => !listed.includes(f))
  ok('清单里的每个模块文件都存在', missing.length === 0, missing.join(','))
  // ★ 多一个文件没进清单 = 那份代码永远不执行，且构建不会报错 —— 最典型的静默失效
  ok('src 下没有「存在但没进清单」的模块（漏一个就等于这段代码永不执行）',
    extra.length === 0, extra.join(','))
  ok('守卫模块排在第一个', listed[0] === '00-guard.js', listed[0])
  ok('编排模块排在最后一个', listed[listed.length - 1] === '50-shell.js', listed[listed.length - 1])

  const bundlePath = 'client/rn/build/client-layer.js'
  ok('跨端层产物已生成（构建脚本会现打包，这里查的是仓库里那份）', exists(bundlePath))
  if (exists(bundlePath)) {
    const bundle = read(bundlePath)
    ok('产物头部带源码指纹（日志里能对上设备跑的是哪一版）', /指纹 [0-9a-f]{8}/.test(bundle))
    ok('产物里没有 </script（注入到 HTML 时会提前终止脚本块）', !/<\/script/i.test(bundle))
  }

  // 每个模块都必须先过「在不在客户端里」的守卫，否则网页端也会执行它
  for (const f of rnFiles) {
    const src = fs.readFileSync(path.join(RN_SRC, f), 'utf8')
    if (f === '00-guard.js') continue
    ok(`${f} 有 LXClientLayer 判据（网页端不介入）`, /if \(!LX \|\| !LX\.active\) return/.test(src))
  }

  // 桥调用名必须在 BridgeHub 里真的有对应方法
  const bridgeMethods = jsMethods(BRIDGE)
  const calls = [...new Set([...read('client/rn/src/10-bridge.js').matchAll(/call\('(\w+)'/g)].map((m) => m[1]))]
  const unknown = calls.filter((c) => !bridgeMethods.includes(c))
  ok('跨端层调用的每个桥方法在 BridgeHub 里都存在', unknown.length === 0, unknown.join(','))
  ok('BridgeHub 暴露了 info / setRoute / setChrome（跨端层启动就要用）',
    ['info', 'setRoute', 'setChrome'].every((m) => bridgeMethods.includes(m)))
}

/* ══════════════ 5. 路由与底栏映射 ══════════════ */

console.log('\n== 5. 路由映射：原生底栏 ↔ 网页 tabbar ══════════════')
{
  // 网页 tabbar 的 data-tab / href
  const tabBlock = INDEX.slice(INDEX.indexOf('class="tabbar"'), INDEX.indexOf('</nav>'))
  const webHrefs = [...tabBlock.matchAll(/href="(#\/[^"]*)"/g)].map((m) => m[1])
  const javaHashes = [...CLIENT_ACT.matchAll(/TAB_HASH = \{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
  const layerMain = [...read('client/rn/src/30-nav.js').matchAll(/var MAIN = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))

  ok('网页 tabbar 有四个入口', webHrefs.length === 4, webHrefs.join(' '))
  ok('原生 TAB_HASH 与网页 tabbar 的 href 一一对应',
    javaHashes.join('|') === webHrefs.join('|'), `${javaHashes.join(' ')} vs ${webHrefs.join(' ')}`)
  ok('跨端层的 MAIN 与原生 TAB_HASH 一致（写死两份，必须同步）',
    layerMain.join('|') === javaHashes.join('|'), `${layerMain.join(' ')} vs ${javaHashes.join(' ')}`)

  const dataTabs = [...tabBlock.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1])
  ok('网页 data-tab 仍是 home/library/favorite/mine（原生图标按这个顺序排）',
    dataTabs.join(',') === 'home,library,favorite,mine', dataTabs.join(','))

  // 二级页归属表里的每个 hash 都要真实存在于 app.js 的路由里
  const navSrc = read('client/rn/src/30-nav.js')
  const belongKeys = [...navSrc.matchAll(/\['(#\/[\w-]+)',/g)].map((m) => m[1])
  const fullscreen = [...navSrc.matchAll(/var FULLSCREEN = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
  const badBelong = belongKeys.filter((h) => !APPJS.includes(`'${h}`) && !APPJS.includes(`"${h}`))
  ok('归属表里的每个二级页 hash 都真实存在于 app.js 的路由里', badBelong.length === 0, badBelong.join(','))
  ok('归属表覆盖了搜索 / 歌单 / 专辑这类主要二级页', belongKeys.length >= 6, String(belongKeys.length))
  const badFull = fullscreen.filter((h) => !APPJS.includes(`'${h}`))
  ok('整屏状态（登录/初始化）的 hash 也真实存在', badFull.length === 0, badFull.join(','))

  // 原生导航图标齐不齐
  const icons = ['ic_tab_home', 'ic_tab_library', 'ic_tab_favorite', 'ic_tab_mine']
  ok('四个原生导航图标都在', icons.every((i) => exists(`client/res/drawable/${i}.xml`)),
    icons.filter((i) => !exists(`client/res/drawable/${i}.xml`)).join(','))
  ok('底栏标签文案取自 strings.xml（不写死在 Java 里）',
    ['tab_home', 'tab_library', 'tab_favorite', 'tab_mine']
      .every((s) => STRINGS.includes(`name="${s}"`))
    && /TAB_LABELS = \{[\s\S]{0,200}R\.string\.tab_home/.test(CLIENT_ACT)
    && /getString\(TAB_LABELS\[/.test(CLIENT_ACT)
    // 负向对照：Java 里不该出现写死的中文标签（改文案时只改 strings.xml 一处）
    && !/"(发现|我的歌单|收藏|我的)"/.test(CLIENT_ACT))
}

/* ══════════════ 6. 注入契约（宿主 → 共用前端） ══════════════ */

console.log('\n== 6. 注入契约：宿主给的变量，前端真的在读 ══════════════')
{
  ok('宿主注入了 LX_CLIENT_HOST_HINT（品牌同步判据）',
    /LX_CLIENT_HOST_HINT/.test(CLIENT_ACT))
  ok('brand.js 确实读 LX_CLIENT_HOST_HINT（否则注入了也没人用）',
    /LX_CLIENT_HOST_HINT/.test(BRANDJS))
  ok('brand.js 的 guessHost 优先采信它（排在 LX_NATIVE 之前）',
    /function guessHost\(\)\s*\{[\s\S]{0,160}LX_CLIENT_HOST_HINT[\s\S]{0,160}LX_NATIVE/.test(BRANDJS))
  ok('brand.js 的立即生效段放行了它（否则 Docker 线会装成 music-edge 的 PWA 身份）',
    /if \(global\.LX_NATIVE \|\| global\.LX_CLIENT_HOST_HINT\)/.test(BRANDJS))

  ok('宿主注入了 LX_CLIENT_SERVICE（客户端期望的服务端版本）',
    /LX_CLIENT_SERVICE/.test(CLIENT_ACT))
  ok('app.js 的版本比对确实用 LX_CLIENT_SERVICE（否则客户端 1.0 vs 服务端 V1.3 会一直误报不一致）',
    /LX_CLIENT_SERVICE/.test(APPJS) && /const expect = String\(window\.LX_CLIENT_SERVICE/.test(APPJS))
  ok('app.js 在拿不到 expect 时退回老的字符串比对（老壳行为不变）',
    /expect \? v\.version === expect : v\.version === clientVer/.test(APPJS))

  ok('宿主注入了 client-layer.js 的 script 标签', /\/js\/client-layer\.js/.test(CLIENT_ACT))
  ok('宿主把 active 档案写进 localStorage（native.js 靠它选本机/远程后端）',
    /lx\.serverBase/.test(CLIENT_ACT) && /lx\.serverBase/.test(NATIVEJS))

  // 注入的 CSS 选择器必须在网页里真实存在 —— 写错的表现是「网页顶栏底栏和原生的一起出现」
  const injected = ['.topbar', '.tabbar', '.view', '#serverBlock']
  const missingSel = injected.filter((s) => {
    const bare = s.replace(/^[.#]/, '')
    return !INDEX.includes(bare) && !APPJS.includes(bare)
  })
  ok('隐藏顶栏/底栏的选择器在网页里都存在', missingSel.length === 0, missingSel.join(','))
  ok('样式是在 <head> 里注入的（晚于文档脚本注入会先闪一下网页底栏）',
    /indexOf\("<head>"\)/.test(CLIENT_ACT) && /<style id=\\"lxClientChrome\\">/.test(CLIENT_ACT))
}

/* ══════════════ 7. 桥（AndroidHost）向后兼容 ══════════════ */

console.log('\n== 7. AndroidHost 与共用前端的老协议完全兼容 ══════════════')
{
  const shellHost = jsMethods(read('android/src/com/zyplnn/musicedge/MainActivity.java'))
  const cliHost = jsMethods(CLIENT_ACT)
  const lost = shellHost.filter((m) => !cliHost.includes(m))
  ok('客户端 AndroidHost 覆盖了老壳 Host 的全部方法（漏一个 = 某个功能静默失效）',
    lost.length === 0, lost.join(','))
  ok('老壳 Host 的方法被成功抠出来了（否则上一条是空断言）', shellHost.length >= 10, String(shellHost.length))

  // 共用前端真实调用到的桥方法
  const used = [...new Set([...NATIVEJS.matchAll(/HOST\.(\w+)/g)].map((m) => m[1]))]
  const missingUsed = used.filter((m) => !cliHost.includes(m))
  ok('native.js 用到的每个桥方法客户端都提供', missingUsed.length === 0, missingUsed.join(','))
  ok('桥的对象名与前端读取的名字一致（AndroidHost + LXNative 两个）',
    /"AndroidHost"\)/.test(CLIENT_ACT) && /"LXNative"\)/.test(CLIENT_ACT)
    && /global\.AndroidHost/.test(NATIVEJS) && /global\.LXNative/.test(read('client/rn/src/00-guard.js')))
  ok('两个门面职责分开：AndroidHost 里不塞客户端专属方法（网页端没有它们）',
    !cliHost.includes('profiles') && !cliHost.includes('selectProfile'))
  ok('LXNative 里不塞共用协议的方法（那是 AndroidHost 的活）',
    !jsMethods(BRIDGE).some((m) => ['httpRequest', 'dbQuery', 'dbExec', 'mediaReport'].includes(m)))
}

/* ══════════════ 8. 底层能力层与主题 ══════════════ */

console.log('\n== 8. 底层能力层、权限与主题 ══════════════')
{
  ok('AudioEngine 有 native 可用性判据（不假装 native 存在）',
    /public static boolean nativeAvailable\(\)/.test(AUDIO_JAVA) && /System\.loadLibrary/.test(AUDIO_JAVA))
  ok('AudioEngine 的权限判据随系统版本切换（13+ 用 READ_MEDIA_AUDIO）',
    /READ_MEDIA_AUDIO/.test(AUDIO_JAVA) && /READ_EXTERNAL_STORAGE/.test(AUDIO_JAVA))
  ok('清单里声明了 AudioEngine 会申请的两个权限',
    C_MANIFEST.includes('android.permission.READ_MEDIA_AUDIO')
    && /android\.permission\.READ_EXTERNAL_STORAGE"[\s\S]{0,80}maxSdkVersion="32"/.test(C_MANIFEST))
  ok('AudioEngine 的权限字符串与清单声明一致（申请了没声明的权限会静默失败）',
    C_MANIFEST.includes('android.permission.READ_MEDIA_AUDIO')
    && C_MANIFEST.includes('android.permission.READ_EXTERNAL_STORAGE'))

  ok('ServerStore 有三档预设槽位（内置 / CF / Docker）',
    /ID_BUILTIN\s*=\s*"builtin"/.test(STORE_JAVA)
    && /ID_CF\s*=\s*"cf"/.test(STORE_JAVA)
    && /ID_DOCKER\s*=\s*"docker"/.test(STORE_JAVA))
  ok('ServerStore 的预设槽位不许删（品牌判定要靠它）',
    /ID_BUILTIN\.equals\(id\) \|\| ID_CF\.equals\(id\) \|\| ID_DOCKER\.equals\(id\)/.test(STORE_JAVA))
  ok('Handshake 不会只看状态码就判定成功（必须看正文像不像本项目的接口）',
    /trimmed\.startsWith\("<"\)/.test(read('client/src/com/zyplnn/lxclient/Handshake.java'))
    && /没有 version 字段/.test(read('client/src/com/zyplnn/lxclient/Handshake.java')))
  ok('Handshake 的地址归一化与网页端同一套口径（内网 http / 域名 https）',
    /localish/.test(read('client/src/com/zyplnn/lxclient/Handshake.java'))
    && /hostPart\.indexOf\('\.'\) < 0/.test(read('client/src/com/zyplnn/lxclient/Handshake.java')))

  // 免 Gradle 链路：不能出现 androidx / support 依赖
  const javaFiles = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = dir + '/' + e.name
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.java')) javaFiles.push(p)
    }
  }
  walk('client/src')
  const withAndroidX = javaFiles.filter((f) => /import\s+androidx\.|import\s+android\.support\./.test(read(f)))
  ok('客户端源码没有 androidx / support 依赖（免 Gradle 链路的前提）',
    withAndroidX.length === 0, withAndroidX.join(','))

  // 主题色与网页同一份口径
  const cssVar = (n) => (CSS.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1]
  const colorVal = (n) => {
    const m = COLORS.match(new RegExp(`<color name="${n}">#FF([0-9A-Fa-f]{6})</color>`))
    return m ? '#' + m[1].toLowerCase() : null
  }
  ok('品牌色与网页 --brand 一致', colorVal('brand') === (cssVar('brand') || '').toLowerCase(),
    `${colorVal('brand')} vs ${cssVar('brand')}`)
  ok('页面底色与网页 --bg 一致', colorVal('bg') === (cssVar('bg') || '').toLowerCase())
  ok('主文字色与网页 --text 一致', colorVal('text') === (cssVar('text') || '').toLowerCase())

  ok('原生页面统一走 Ui 工具箱（不各自造轮子）',
    /static LinearLayout page\(/.test(UI_JAVA) && /static View titleBar\(/.test(UI_JAVA))
}

/* ══════════════ 收尾 ══════════════ */

console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
} else {
  console.log('全部 ' + pass + ' 项通过')
}
