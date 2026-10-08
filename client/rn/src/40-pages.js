/*
 * 跨端业务层 —— 40 原生页入口接管
 *
 * ══════════════ 为什么需要「接管」而不是「删除」 ══════════════
 * 共用前端里本来就有几个通往「系统能力」的入口，它们都是为**浏览器**写的：
 *
 *   · 登录页底部的「服务器设置」（data-act="open-server"）——
 *     给用户一条服务器地址填错时的退路（老壳里也是靠它救命的）；
 *   · 设置页的「服务端」卡片（#serverBlock）——填地址、测连接。
 *
 * 在客户端里这两件事都有了更好的归宿（原生「服务器连接」页：能存多条档案、
 * 能看服务端自报的品牌与版本）。但**不能直接删**：
 *   · 共用前端三宿主共用，删了网页端就少一个入口；
 *   · 也不能让两套并存 —— 同一件事两个入口、各存一份地址，
 *     必然出现「原生显示 A、页面连的是 B」这种最难查的不一致。
 *
 * 所以做法是**接管**：拦住那个入口的点击，改成打开原生页。
 * 这样网页端一个字节不改，客户端里也不会冒出第二套配置。
 */

;(function (global) {
  'use strict'
  var LX = global.LXClientLayer
  if (!LX || !LX.active) return

  var api = LX.api

  /**
   * 在**捕获阶段**监听点击。
   *
   * 为什么不用「等 DOM 渲染完再给那个元素挂 onclick」：
   * 那两处入口是 app.js 在渲染时用字符串拼出来的，页面会整块重渲染
   * （登录页 → 初始化页 → 主界面），挂上去的监听随 DOM 一起消失，
   * 得再挂一次 —— 迟早会漏。捕获阶段的委托监听挂在 document 上，
   * 不管中间重渲染多少次都一直在，这是唯一稳的做法。
   */
  function onClickCapture(e) {
    var el = e.target
    // 从点击目标往上找带 data-act 的祖先
    for (var depth = 0; el && depth < 6; depth++) {
      if (el.getAttribute && el.getAttribute('data-act')) break
      el = el.parentNode
    }
    if (!el || !el.getAttribute) return
    var act = el.getAttribute('data-act')
    if (act !== 'open-server') return
    e.preventDefault()
    e.stopPropagation()
    LX.log('拦截网页端的服务器设置入口，改为打开原生页')
    api.openPage('server')
  }

  /**
   * 兜底隐藏网页设置页里的「服务端」卡片。
   *
   * 为什么宿主已经注入了 CSS 还要再做一次：宿主注入的是 `#serverBlock{display:none}`，
   * 而那个块是 app.js 渲染设置页时**动态创建**的 —— 如果哪次 WebView 的内联样式
   * 注入没生效（老内核、或者注入点被页面改写），用户就会看到一个改了不生效的输入框，
   * 那比没有更糟。这里用 DOM 层再兜一道，代价是一次 getElementById。
   *
   * 用 MutationObserver 而不是定时器：设置页是按需渲染的（进 #/settings 才建），
   * 定时器要么跑一辈子、要么正好错过那一刻。
   */
  function guardServerBlock() {
    function hide() {
      var b = document.getElementById('serverBlock')
      if (b && b.style.display !== 'none') b.style.display = 'none'
    }
    hide()
    try {
      var ob = new MutationObserver(hide)
      ob.observe(document.body, { childList: true, subtree: true })
    } catch (e) { /* 没有 MutationObserver 就算了，CSS 那道还在 */ }
  }

  function install() {
    document.addEventListener('click', onClickCapture, true)
    guardServerBlock()
  }

  LX.pages = { install: install, guardServerBlock: guardServerBlock }
})(window)
