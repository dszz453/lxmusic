/*
 * 跨端业务层 —— 50 启动编排
 *
 * 这一层是「跨端业务层的入口」，对应 RN 那边 index.js 里 AppRegistry 干的事：
 * 装配各模块、决定启动顺序、把原生外壳的状态同步到第一帧上。
 *
 * ══════════════ 启动顺序为什么是这个顺序 ══════════════
 *  1. 先导航同步（install nav）—— 它决定底栏高亮，晚一步就会看到高亮从
 *     「全灭」跳到正确那一项；
 *  2. 再对齐品牌 —— 品牌是首屏就可见的东西，越早越好（宿主已经在 <head>
 *     注入了同步判据，这一步是把它跟真实的服务端对齐）；
 *  3. 最后装页面入口接管 —— 它只影响用户后续的点击，不抢首帧。
 *
 * ══════════════ 为什么所有步骤都各自 try/catch ══════════════
 * 这一层跑在页面启动路径上，任何一步抛异常都可能把后面的步骤一起带走
 * （脚本是顺序执行的）。而这里的每一步都只是**增强**：
 * 失败了用户看到的就是网页版，功能可用、只是少了客户端特化的那点东西。
 * 用「增强失效」换「界面一定出得来」，这个取舍在客户端上是对的。
 */

;(function (global) {
  'use strict'
  var LX = global.LXClientLayer
  if (!LX || !LX.active) return

  var api = LX.api

  /**
   * 某个路由（或任何时候）要做的事，跑一次；并在每次路由变化后再跑。
   *
   * 为什么需要「延迟重试」：设置页是 app.js 异步渲染的（要先等 /api/me），
   * 路由刚变的那一刻 DOM 里还没有 #verLine / #serverBlock。重试几次是
   * 最省事又可靠的等法 —— 比去猜「app.js 什么时候渲染完」稳。
   */
  function onRoute(fn) {
    function run() {
      var tries = [0, 150, 450]
      for (var i = 0; i < tries.length; i++) {
        (function (delay) {
          global.setTimeout(function () {
            try {
              fn()
            } catch (e) {
              LX.log('路由钩子失败：' + ((e && e.message) || e))
            }
          }, delay)
        })(tries[i])
      }
    }
    global.addEventListener('hashchange', run)
    run()
  }

  /** 设置页要补的东西：双版本号 + 一条看得见的服务器入口 */
  function decorateSettingsPage(info) {
    var hash = String(global.location.hash || '')
    // #/settings 与 #/mine 都可能带版本信息（app.js 把设置入口放在「我的」里）
    if (hash.indexOf('#/settings') !== 0 && hash.indexOf('#/mine') !== 0) return
    LX.brand.decorateVersionLine(info)
    LX.brand.injectServerEntry(info)
  }

  function boot() {
    var info = api.info()
    LX.client = info
    if (info) {
      LX.log('客户端层启动：' + info.client + ' ' + info.versionLine
        + ' → ' + (info.builtin ? '内置离线' : (info.brandName + ' ' + info.serverVersion)))
    }

    LX.nav.install()
    LX.brand.align(info)
    LX.pages.install()

    onRoute(function () {
      // 每次路由变化都重新读一次：用户在原生页里可能刚换过服务器
      var cur = api.info() || info
      LX.client = cur
      LX.nav.report()
      LX.brand.align(cur)
      decorateSettingsPage(cur)
    })

    // 品牌被服务端纠正（/api/version 回来）时，顺手把双版本号也刷一遍
    try {
      global.addEventListener('lx-brand', function () {
        var cur = api.info() || info
        decorateSettingsPage(cur)
      })
    } catch (e) { /* 老内核没有 CustomEvent，忽略 */ }
  }

  /**
   * 出场的时机。
   *
   * 本脚本由宿主注入在 </body> 之前，而 app.js 已经执行过了 —— 所以正常情况下
   * readyState 已经是 interactive/complete，直接跑。但为了不被「以后有人把这个
   * 脚本挪到 <head>」这种改动坑到（那种改动是静默失效：底栏永远不高亮），
   * 两种情况都处理。
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})(window)
