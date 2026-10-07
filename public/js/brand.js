/*!
 * 客户端品牌名 —— 同一份代码，两个宿主各自显示自己的名字。
 *
 * ── 为什么要单独一个文件 ────────────────────────────────────────
 * 这个项目两个宿主（Docker 自托管 / Cloudflare Worker + 安卓壳）共用同一份
 * public/ 前端资源，以前显示名写死在四处（manifest.json、index.html 的 <title>
 * 与 apple-mobile-web-app-title、app.js 的登录页大标题与 document.title），
 * 全是「云音乐」。老板要求：**Docker 版叫 LX-MUSIC，CF 版叫 music-edge**，
 * 两个客户端相互独立、各自认得自己。
 *
 * 名字散在四处必然漂移（改一处漏一处），所以收拢到这里做唯一事实来源，
 * 其余地方一律 `window.LXBrand.name` 取。
 *
 * ── 怎么判断自己是哪个宿主 ──────────────────────────────────────
 * 关键约束：**不能靠配置文件**。老板要求 Docker 与 CF 不许改 docker-compose.yml /
 * wrangler.toml，所以判定必须**零配置、运行时自动得出**。三级判据：
 *
 *   1. 安卓壳（window.LX_NATIVE === true）→ music-edge
 *      壳里是 WebView 跑了 Java 桥，它就是基于 CF 那条线的客户端。
 *
 *   2. 普通浏览器：向服务端问一句「你是谁」→ 看 /api/version 的 host 字段。
 *      这是最可靠的判据 —— 由服务端自己声明。不靠响应头 / CDN 特征那些
 *      可能被反向代理抹掉的东西（Server: cloudflare 在自建反代后面就没了）。
 *
 *   3. 兜底：host 取不到（接口挂了、离线、服务端是尚未升级的旧版）时，
 *      按「本机模式 vs 远程模式」粗判：
 *        · LX_REMOTE 为真 → 壳配了服务器地址，与壳同源 → music-edge
 *        · 否则            → 直接打开的网页（Docker 自托管最常见）→ LX-MUSIC
 *      这个兜底**可能判错**（比如 CF 网页端离线冷启动会落到 LX-MUSIC），
 *      所以它只是兜底：一旦 /api/version 回来就会纠正，并派发 lx-brand 事件
 *      让已经渲染出来的界面跟着改名。
 *
 * ── manifest 为什么在前端生成 ────────────────────────────────────
 * manifest.json 是**浏览器直接读的文件**（不是 DOM，改不了）。而两个宿主的
 * 静态资源是一样的那份，所以要么服务端按宿主返回不同 manifest、要么前端自己合成。
 * 选了后者，理由：
 *   · CF 的资源层在 Worker 之前（见 public/_headers 顶部说明），
 *     `/manifest.json` 命中静态文件后**压根不会走到 Worker** ——
 *     想在服务端按宿主改写它，得先绕开资源层、改前端 link、改 SW 预缓存，
 *     动的是四条链路。前端合成只动这一个文件。
 *   · 零配置、零构建耦合：不需要新增构建步骤，也不需要 docker/wrangler 配合。
 * 做法是把原 manifest 抓下来、改掉三个字段、用 Blob 造一个新 URL 挂到
 * `<link rel="manifest">` 上。index.html 里那个原 link 会被替换掉。
 *
 * ⚠️ 时机：必须在**页面早期**就换好 link。浏览器读 manifest 是在导航开始后不久，
 * 晚了（比如等 app.js 初始化完）它已经按旧 link 去取了，装出来的名字就是旧的。
 * 所以本文件在 index.html 里紧跟 util.js 之后、app.js 之前加载并立即执行。
 */
(function (global) {
  'use strict'

  /** 两个客户端各自的展示名。改名字只改这里 */
  var NAMES = {
    docker: 'LX-MUSIC',   // 自托管（Docker / 本机 node server/index.mjs）
    cf: 'music-edge',     // Cloudflare Worker 线上 + 基于它的安卓壳
  }

  /** 桌面图标下的短名。太长会被系统截断成一串省略号 */
  var SHORT_NAMES = {
    docker: 'LX-MUSIC',
    cf: 'music-edge',
  }

  /**
   * 服务端在 /api/version 里回的 host 字段 → 品牌键。
   * 服务端没回、或回了没见过的值，一律当作「不知道」，交给兜底判据。
   */
  var HOST_MAP = {
    docker: 'docker',
    node: 'docker',      // 本机 node 直跑，与 Docker 是同一个 server/index.mjs
    cf: 'cf',
    worker: 'cf',
    cloudflare: 'cf',
  }

  /**
   * 当前品牌键。先按同步判据定一个，接口回来再纠正。
   * 同步判据里**壳一定是 cf**（桥在 native.js 里就会置 LX_NATIVE）；
   * 网页端先用 LX_REMOTE 粗判（壳配了服务器地址时它才为真，而壳就是 cf 线）。
   */
  function guessHost() {
    if (global.LX_NATIVE) return 'cf'
    return global.LX_REMOTE ? 'cf' : 'docker'
  }

  var host = guessHost()
  var resolved = false

  var brand = {
    /** 品牌键：'docker' | 'cf' */
    get host() { return host },
    /** 展示名，界面上用这个 */
    get name() { return NAMES[host] || NAMES.docker },
    /** 是否已由服务端确认过（而不是靠兜底猜的） */
    get resolved() { return resolved },
    /** 两个名字都暴露出去，便于调试与「关于」页列全 */
    all: NAMES,
  }

  /* ---------------- 静态落点：<title> 与 apple 的短名 ---------------- */

  /**
   * 把标题类的落点刷成当前品牌。
   *
   * @param {string} subtitle 有副标题时组成「副标题 - 品牌名」，否则用默认那句
   */
  brand.applyDocumentTitle = function (subtitle) {
    var t = brand.name
    try {
      document.title = subtitle ? (subtitle + ' - ' + t) : (t + ' · 在线音乐聚合')
      var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]')
      if (meta) meta.setAttribute('content', t)
    } catch (e) { /* 非浏览器环境，忽略 */ }
  }

  /* ---------------- manifest：按宿主合成一份 ---------------- */

  /**
   * 抓原 manifest、改名、挂回去。
   *
   * 只改 name / short_name / id 三个字段：
   *   · name / short_name —— 就是这次的需求。
   *   · id —— 必须跟着变。两个客户端若装到同一台设备上，id 相同会被浏览器
   *     当成同一个应用而**互相顶掉**（后装的覆盖先装的图标与入口）。
   *     用品牌键做前缀，两个客户端就能并存。
   * 其余字段（icons / start_url / shortcuts / theme_color…）一律透传，
   * 以后改 public/manifest.json 那一处，两个客户端同时生效，不会漏。
   */
  function installManifest() {
    var link = document.querySelector('link[rel="manifest"]')
    if (!link || typeof fetch !== 'function' || typeof Blob === 'undefined') return
    var href = link.getAttribute('href') || '/manifest.json'
    fetch(href, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (raw) {
        if (!raw) return
        raw.name = brand.name + ' · 在线音乐聚合'
        raw.short_name = SHORT_NAMES[host] || brand.name
        raw.id = '/' + host + '/'
        var url = URL.createObjectURL(new Blob([JSON.stringify(raw)], { type: 'application/manifest+json' }))
        link.setAttribute('href', url)
      })
      .catch(function () { /* 抓不到就保持原样，PWA 仍可安装，只是名字是默认那个 */ })
  }
  brand.installManifest = installManifest

  /* ---------------- 服务端确认与纠正 ---------------- */

  /** manifest 是否已经合成过（避免确认路径与立即路径重复造 blob） */
  var manifestDone = false

  /**
   * 标题是否已经被我们写过。
   *
   * 为什么需要它（Docker 上实测踩到）：浏览器模式的首屏**不动** title（防闪错名），
   * 于是页面标题是 index.html 的静态名（music-edge）。确认回来时若只看
   * 「品牌键变没变」—— Docker 上兜底猜的恰好也是 docker，键没变 → 不应用 →
   * **Docker 的标题永远停在静态的 music-edge**。
   * 所以第一次确认必须无条件应用一次：比较的对象是「静态名 vs 确认名」，
   * 不是「猜的键 vs 确认的键」。
   */
  var titleApplied = false

  /**
   * 用服务端回的 host 纠正品牌。由 app.js 在 /api/version 返回后调用。
   *
   * 「派事件」只在键真的变了的时候 —— 每次首屏都发一遍会让监听者白干活，
   * 而「名字没变」是最常见的情况，没必要惊动重渲染。
   *
   * @param {string} rawHost 服务端 /api/version 的 host 字段
   * @returns {boolean} 品牌是否发生了变化
   */
  brand.applyHost = function (rawHost) {
    var key = HOST_MAP[String(rawHost || '').toLowerCase()] || ''
    if (!key) return false
    var changed = key !== host
    host = key
    resolved = true
    // manifest 现在合成：浏览器模式下立即执行段不再碰它（见文件尾），
    // 确认之后才合成，装出来的 PWA 名字就一定是对的
    if (!manifestDone) {
      manifestDone = true
      try { installManifest() } catch (e) { /* 忽略 */ }
    }
    // 标题：键变了、或还一次都没写过（浏览器模式首屏没动过它）都要写。
    // 只看 changed 的话，Docker 上「猜的=确认的」会让静态名永远不被纠正。
    if (changed || !titleApplied) {
      titleApplied = true
      brand.applyDocumentTitle('')
    }
    if (changed) {
      try {
        global.dispatchEvent(new CustomEvent('lx-brand', { detail: { host: host, name: brand.name } }))
      } catch (e) { /* 老浏览器没有 CustomEvent，忽略 */ }
    }
    return changed
  }

  global.LXBrand = brand

  /* ---------------- 立即生效 ---------------- */

  /**
   * 立即应用的范围**分宿主**，这是防「闪错误名字」的关键：
   *
   *   · 壳（LX_NATIVE）—— 判据**可靠**（Java 桥就在那儿，不依赖网络），
   *     立即应用 title 与 manifest，零闪烁。
   *
   *   · 浏览器 —— 同步判据**猜不出** Docker 与 CF 的区别（两者 LX_REMOTE 都是假），
   *     此刻应用只会把 index.html 的静态名（music-edge）覆盖成**猜的**。
   *     在 CF 线上那是一次「music-edge → LX-MUSIC → music-edge」的两次切换，
   *     中间还是个错名字。所以浏览器模式**什么都不动**：静态标题保持原样，
   *     manifest 等服务端确认后再合成（applyHost 里做）。
   *     代价是 Docker 网页首屏短暂显示静态的 music-edge、确认后切到 LX-MUSIC ——
   *     一次切换、且切换前显示的不是「错误的 Docker 名」，比 CF 闪错名好得多。
   */
  try {
    if (global.LX_NATIVE) {
      titleApplied = true
      brand.applyDocumentTitle('')
      manifestDone = true
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installManifest, { once: true })
      } else {
        installManifest()
      }
    }
  } catch (e) { /* 非浏览器环境，忽略 */ }
})(window)
