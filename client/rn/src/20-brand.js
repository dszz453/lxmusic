/*
 * 跨端业务层 —— 20 品牌与版本
 *
 * ══════════════ 在这里要解决的两个「用户看得见」的问题 ══════════════
 *
 * 1) **名字闪错**
 *    brand.js 的同步判据在客户端里靠 window.LX_CLIENT_HOST_HINT（由宿主在
 *    <head> 注入），所以首屏就是对的，不会先闪一下另一个名字。
 *    但注入的 hint 是**按档案类型推的**（选了 Docker 档 → docker），
 *    而真实的品牌以服务端的 host 字段为准。两者不一致时（用户把 CF 地址
 *    填进了 Docker 档）要立刻纠正 —— 这里拿原生桥里的结果再做一次对齐，
 *    不等 /api/version 那一趟网络。
 *
 * 2) **版本显示不全**
 *    共用前端只知道自己那一版（window.LX_VERSION，在客户端里就是客户端版本）。
 *    原生桥里有更准的客户端构建号（包里 client-build.txt 那个 commit 前 12 位），
 *    而 index.html 组合出来的是 `客户端 1.0 (dev)` —— dev 在真机上报不了任何信息。
 *    所以这里在设置页的版本行上补出**客户端自己的**版本 + 真实构建号。
 *
 *    ⚠ 不要在这里补服务端版本（老板 2026-10-08：「服务端版本的显示，仅保留设置项里面，
 *    其他页面去掉」）。这一页下面那个 #verHost 已经在显示服务端版本了，
 *    再往版本行尾巴上挂一个「· 服务端 V1.4」就是同一页里同一件事写两遍。
 */

;(function (global) {
  'use strict'
  var LX = global.LXClientLayer
  if (!LX || !LX.active) return

  var api = LX.api

  /**
   * 把品牌对齐到原生桥给出的结果。
   *
   * 用 LXBrand.applyHost（而不是自己去改 DOM）：品牌名在页面里有多个落点
   * （<title>、apple 短名、manifest、登录页大标题、document.title），
   * 逐个改必然漏。applyHost 是那个唯一的纠正入口，它内部会派发 lx-brand 事件
   * 让已经渲染出来的界面跟着改名。
   *
   * @param {object} info 原生桥的 info()
   * @returns {boolean} 是否发生了纠正
   */
  function alignBrand(info) {
    if (!info || !global.LXBrand || typeof global.LXBrand.applyHost !== 'function') return false
    var key = String(info.brandKey || '')
    if (key !== 'cf' && key !== 'docker') return false
    if (global.LXBrand.host === key) return false
    try {
      global.LXBrand.applyHost(key)
      LX.log('品牌按原生桥纠正为 ' + key + '（' + info.brandName + '）')
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * 在设置页的版本行上补出**客户端自己的**版本 + 真实构建号。
   *
   * 时机问题：那一行是 app.js 异步渲染的（要等 /api/version 回来），
   * 而且可能被重新渲染（用户切来切去）。所以不抢在某一刻写，
   * 而是：写一个带标记的补充节点，并用 MutationObserver 保证它不被覆盖掉。
   * 只观察那一个元素，开销可忽略。
   */
  function decorateVersionLine(info) {
    var host = document.getElementById('verLine')
    if (!host) return
    var suffix = '客户端 ' + (info.version || '?')
      + (info.build && info.build !== 'dev' ? ' (' + info.build + ')' : '')
    var mark = host.querySelector('.lx-client-ver')
    if (mark) {
      if (mark.textContent !== suffix) mark.textContent = suffix
      return
    }
    try {
      var em = document.createElement('span')
      em.className = 'lx-client-ver'
      em.textContent = suffix
      em.style.cssText = 'display:block;color:#a3a3a6;font-size:12px;margin-top:2px'
      host.appendChild(em)
    } catch (e) { /* DOM 结构变了就放弃，这只是一个锦上添花的信息 */ }
  }

  /**
   * 设置页 / 关于页里的「服务端」信息卡。
   * 网页版原本在设置页有个 #serverBlock（填地址的），客户端里由宿主 CSS 隐掉了
   * （改由原生「服务器连接」页管理）。这里再提供一条**看得见**的替代入口，
   * 免得用户在设置页里完全找不到服务器相关的信息。
   */
  function injectServerEntry(info) {
    var block = document.getElementById('serverBlock')
    if (!block || !info) return
    // 宿主已经用 CSS 隐藏了它；这里退一步：如果 CSS 那条路没生效（老 WebView
    // 内联样式注入失败等），至少要保证它不可交互，而不是留一个改了没用的输入框。
    block.style.display = 'none'

    if (document.getElementById('lxClientServerEntry')) return
    try {
      var box = document.createElement('div')
      box.id = 'lxClientServerEntry'
      box.className = 'block'
      box.innerHTML = ''
      var label = document.createElement('div')
      label.className = 'field__label'
      label.textContent = '服务端'
      var note = document.createElement('div')
      note.className = 'note'
      note.style.marginBottom = '10px'
      note.textContent = '当前：' + info.profileName + '（' + info.brandName + '）'
        + (info.builtin ? '　数据都在这台手机上。' : ('　' + info.base))
      var btn = document.createElement('button')
      btn.className = 'btn btn--sm'
      btn.textContent = '服务器连接设置'
      btn.addEventListener('click', function () {
        api.openPage('server')
      })
      box.appendChild(label)
      box.appendChild(note)
      box.appendChild(btn)
      block.parentNode.insertBefore(box, block)
    } catch (e) { /* 结构变了就放弃 */ }
  }

  LX.brand = {
    align: alignBrand,
    decorateVersionLine: decorateVersionLine,
    injectServerEntry: injectServerEntry,
  }
})(window)
