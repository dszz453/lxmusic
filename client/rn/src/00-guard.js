/*
 * 跨端业务层 —— 00 入口守卫
 *
 * ══════════════ 这一层是什么 ══════════════
 * 对应网易云客户端里的 React Native 那一层：承载「频繁迭代的业务 UI 与页面流转」，
 * 与原生宿主分工。它**只在通用客户端里生效**，判据是原生注入的 window.LXNative：
 *
 *   · 普通浏览器（CF 线上 / Docker 网页端）—— 没有 LXNative，本层整个不介入，
 *     前端行为与以前一模一样；
 *   · 老壳 music-edge（android/）—— 也没有 LXNative（那边只注入了 AndroidHost），
 *     同样不介入；
 *   · 通用客户端（client/）—— 有 LXNative，本层接管原生外壳与跨端页面之间的
 *     那几件必须协同的事：底栏与路由同步、品牌与双版本展示、原生页入口。
 *
 * 这就是「同一份前端资源三宿主共用」的关键：新能力全部挂在一个**只有客户端才有**
 * 的判据上，而不是去改共用代码里的分支。
 *
 * ══════════════ 为什么要分成几个文件再打包 ══════════════
 * 这一层的代码会跑在**每一台设备**上，而它做的又都是「和原生外壳咬合」的活，
 * 任何一处抛异常都可能让整个页面白屏。所以：
 *   · 按职责切成 5 个模块（守卫 / 桥 / 品牌 / 导航 / 页面接管 + 启动编排），
 *     出问题时能一眼定位在哪个环节；
 *   · 由 tools/build-client-rn.mjs 拼成一个 client-layer.js（顺序在构建脚本里写死，
 *     模块缺失直接构建失败 —— 少一个模块就是少一段功能，且症状是「某个功能没了」，
 *     这种静默失败必须在构建期拦住）。
 */

;(function (global) {
  'use strict'

  var NATIVE = global.LXNative

  /**
   * 判据写全：对象在、而且有我们要用的方法。
   * 只看「对象在不在」不够 —— 老版本客户端可能注入了一个功能不全的门面，
   * 那种情况下宁可整个不介入（行为退化成网页版），也不要半接管后报一堆错。
   */
  if (!NATIVE || typeof NATIVE.info !== 'function' || typeof NATIVE.setRoute !== 'function') {
    global.LXClientLayer = {
      active: false,
      reason: NATIVE ? 'bridge-incomplete' : 'no-bridge',
    }
    return
  }

  /**
   * 桥调用一律包一层 try/catch。
   *
   * 为什么必须包：@JavascriptInterface 的方法一旦抛异常，异常会以
   * 「Java exception was raised during method invocation」的形式回灌到 JS，
   * 而它在某些 WebView 版本上会**打断当前脚本**。本层的调用点分布在页面启动路径上，
   * 一处抛出就是白屏。这里的取舍很明确：宁可某个增强功能静默失效，
   * 也不能因为它把整个 App 的界面打没。
   */
  function call(name, args) {
    try {
      var fn = NATIVE[name]
      if (typeof fn !== 'function') return null
      return fn.apply(NATIVE, args || [])
    } catch (e) {
      log('调用 ' + name + ' 失败：' + ((e && e.message) || e))
      return null
    }
  }

  function parse(json, fallback) {
    if (json == null) return fallback
    try {
      return JSON.parse(String(json))
    } catch (e) {
      return fallback
    }
  }

  /** 日志统一走原生 Logcat（页面的 console 在真机上不好捞），失败就算了 */
  function log(msg) {
    try {
      if (global.AndroidHost && typeof global.AndroidHost.log === 'function') {
        global.AndroidHost.log('ClientLayer', String(msg))
      }
    } catch (e) { /* 日志失败不影响主流程 */ }
  }

  global.LXClientLayer = {
    active: true,
    /** 原生桥（原样暴露，模块内部用 LX.call 包一层保护） */
    native: NATIVE,
    call: call,
    parse: parse,
    log: log,
    /** 客户端信息快照，由 50-shell.js 在启动时填 */
    client: null,
  }
})(window)
