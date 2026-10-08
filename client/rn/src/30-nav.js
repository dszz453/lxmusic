/*
 * 跨端业务层 —— 30 底栏与路由同步
 *
 * ══════════════ 要解决的问题 ══════════════
 * 原生底栏（Java 画的）与跨端页面（WebView 里的 hash 路由）是两套独立的东西，
 * 必须双向对齐，否则会出现这几个很扎眼的毛病：
 *
 *   · 用户点原生底栏「收藏」→ 页面切过去了，但高亮还停在「发现」；
 *   · 用户在页面里点了搜索结果跳到歌单页 → 底栏还高亮着上一个 tab，
 *     而且用户以为自己在那个 tab 里；
 *   · 点二级页的返回键回到首页 → 底栏全灭。
 *
 * 方向与实现：
 *   原生 → 跨端：原生直接改 location.hash（ClientActivity.openRoute）。
 *   跨端 → 原生：本模块监听 hashchange / popstate，把当前 hash 报给原生
 *                （LXNative.setRoute），由原生决定高亮哪一项。
 *
 * ⚠ 一个必须处理的细节：**主 tab 之外的页面**。
 * 跨端层里除了四个主 tab，还有搜索、歌单详情、专辑、缓存管理等二级页。
 * 这些页面上原生底栏**不应该**保持主 tab 的高亮（用户已经离开那个 tab 了），
 * 但也不该全灭 —— 在搜索页里，它其实还属于「发现」那一支。
 * 所以这里维护一张「二级页 → 归属哪个主 tab」的映射，映射不到就报空
 * （原生那边把空 hash 视作「全不选中」）。
 */

;(function (global) {
  'use strict'
  var LX = global.LXClientLayer
  if (!LX || !LX.active) return

  /** 四个主 tab 的 hash（与 Java 侧 TAB_HASH 必须一致，改一处要一起改） */
  var MAIN = ['#/', '#/library', '#/favorite', '#/mine']

  /**
   * 二级页归属表。键是二级页的 hash 前缀。
   *
   * 为什么要这张表而不是「非主 tab 一律不上报」：底栏高亮是用户定位自己的唯一线索。
   * 在搜索页里底栏全灭，用户会觉得「我是不是点到什么地方去了」。
   * 归属到「发现」是最符合直觉的 —— 搜索正是从发现页进去的。
   *
   * ⚠ 前缀匹配是**按下标顺序**来的，所以更具体的路径要写在更前面
   * （例如 '#/playlist' 会吃掉 '#/playlist-add'，两者归属相同所以无害，
   * 但以后若要分开归属就必须把长的写在前面）。
   * 表里的每个 hash 都必须真实存在于 app.js 的路由里 ——
   * test/client-wiring.test.mjs 会逐个去 app.js 里核对，写错了会报红。
   */
  var BELONG = [
    ['#/search', '#/'],
    ['#/album', '#/'],
    ['#/charts', '#/'],
    ['#/playlist', '#/library'],
    ['#/cache', '#/mine'],
    ['#/history', '#/mine'],
    ['#/import', '#/mine'],
    ['#/ai', '#/mine'],
    ['#/settings', '#/mine'],
    ['#/about', '#/mine'],
  ]

  /**
   * 这些路由是**整屏状态**而不是「某个 tab 里的一页」：登录、建管理员、初始化。
   * 它们出现时既不该高亮任何 tab，也不该显示底栏 —— 底栏上四个入口点了都会
   * 被登录页挡回来，看着像坏了。所以不但不上报 tab，还让原生把底栏整个收起来。
   */
  var FULLSCREEN = ['#/login', '#/setup']

  function isFullscreen(path) {
    for (var i = 0; i < FULLSCREEN.length; i++) {
      if (path === FULLSCREEN[i] || path.indexOf(FULLSCREEN[i]) === 0) return true
    }
    return false
  }

  /** 把当前 hash 归一到「该高亮哪个主 tab」；不属于任何主 tab 时返回空串 */
  function resolve(hash) {
    var h = String(hash || '')
    if (h === '#' || h === '') return '#/'
    // 带查询串的（#/search?q=xxx）只取路径部分
    var q = h.indexOf('?')
    var path = q >= 0 ? h.slice(0, q) : h
    var i
    for (i = 0; i < MAIN.length; i++) {
      if (path === MAIN[i]) return path
    }
    // 精确不中时按前缀退（#/playlist/abc 也属于我的歌单）
    for (i = 0; i < BELONG.length; i++) {
      if (path.indexOf(BELONG[i][0]) === 0) return BELONG[i][1]
    }
    // 主 tab 的深链接（#/mine/settings 这种）也按前缀算
    for (i = 0; i < MAIN.length; i++) {
      if (MAIN[i] !== '#/' && path.indexOf(MAIN[i]) === 0) return MAIN[i]
    }
    return ''
  }

  var last = null
  var lastChrome = null

  /** 上报当前路由（变化时才上报，避免每次滚动都惊动原生） */
  function report() {
    var raw = String(global.location.hash || '')
    var q = raw.indexOf('?')
    var path = q >= 0 ? raw.slice(0, q) : raw
    if (!path) path = '#/'

    var h = resolve(raw)
    if (h !== last) {
      last = h
      LX.api.setRoute(h)
    }

    // 整屏状态（登录 / 初始化）收起原生底栏，其余情况显示
    var chrome = !isFullscreen(path)
    if (chrome !== lastChrome) {
      lastChrome = chrome
      LX.api.setChrome(chrome)
    }
  }

  function install() {
    global.addEventListener('hashchange', report)
    // popstate 也监听：少数 WebView 在返回时只发 popstate 不发 hashchange
    global.addEventListener('popstate', report)
    report()
    LX.log('路由同步已安装，当前归属 ' + resolve(global.location.hash))
  }

  LX.nav = {
    install: install,
    report: report,
    resolve: resolve,
    isFullscreen: isFullscreen,
    MAIN: MAIN,
    BELONG: BELONG,
    FULLSCREEN: FULLSCREEN,
  }
})(window)
