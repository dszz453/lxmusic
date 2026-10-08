/*
 * 跨端业务层 —— 10 桥接封装
 *
 * 把原生门面（window.LXNative）包成一组「页面友好」的方法：拿回来的是对象、
 * 不是 JSON 字符串；失败统一返回 null / false，调用方不用自己 try/catch。
 *
 * 与 AndroidHost 的分工：
 *   AndroidHost —— 数据与网络（http / db / 媒体会话），**三宿主共用**的老协议；
 *   LXNative    —— 外壳协同（档案 / 原生页 / 路由 / 剪贴板 / 退出），只有客户端有。
 * 本层只碰后者；前者由 public/js/native.js 负责（那一份一行都不用改）。
 */

;(function (global) {
  'use strict'
  var LX = global.LXClientLayer
  if (!LX || !LX.active) return

  var api = {
    /** 客户端 + 连接态快照。失败返回 null（调用方必须容忍） */
    info: function () {
      return LX.parse(LX.call('info'), null)
    },

    /** 服务器档案列表 */
    profiles: function () {
      var arr = LX.parse(LX.call('profiles'), null)
      return Array.isArray(arr) ? arr : []
    },

    /**
     * 打开一个原生页面：server / settings / local / about。
     * 名字在原生侧有一张表（BridgeHub 的 PAGE_*），这里不重复校验 ——
     * 写错了原生日志里会有「未知的原生页」，比在 JS 侧静默吞掉好查。
     */
    openPage: function (name) {
      LX.call('openPage', [String(name || '')])
    },

    /** 切换服务器档案。true = 真的换了（原生会随后整页重载） */
    selectProfile: function (id) {
      return LX.call('selectProfile', [String(id || '')]) === true
    },

    /** 报告当前路由，原生底栏据此高亮 */
    setRoute: function (hash) {
      LX.call('setRoute', [String(hash || '')])
    },

    /**
     * 显示 / 收起原生外壳（底栏）。
     * 登录页、初始化页这类整屏状态要收起它 —— 那四个入口点了都会被登录页挡回来。
     */
    setChrome: function (visible) {
      LX.call('setChrome', [visible !== false])
    },

    toast: function (msg) {
      LX.call('toast', [String(msg == null ? '' : msg)])
    },

    /** 复制到剪贴板。返回 false 时调用方应回退到自己的方案 */
    copy: function (text) {
      return LX.call('copy', [String(text == null ? '' : text)]) === true
    },

    reload: function () {
      LX.call('reload')
    },

    /** 客户端侧诊断（JSON 对象） */
    diag: function () {
      return LX.parse(LX.call('diag'), null)
    },
  }

  LX.api = api
})(window)
