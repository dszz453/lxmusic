/**
 * 内置插件的「求值即崩溃」黑名单 —— 由 tools/plugin-prescreen.mjs 生成，别手改。
 *
 * 名单里的插件在**主进程里求值会直接杀死 JS 引擎**（不抛异常，try/catch 拦不住），
 * 所以 Node 宿主（Docker）必须在求值前把它们摘出去，否则容器起不来。
 *
 * 注意这里只收「进程被打死」这一种，不收「加载失败」——
 * 后者多半是构建机出口到不了插件初始化要拉的远端配置，
 * 在用户的服务器上可能是好的，凭构建机的网络删插件是错的。
 *
 * 重新生成：node tools/plugin-prescreen.mjs
 * 生成时间：2026-10-06T23:23:07.158Z
 * 生成环境：Node v22.22.2 / win32-x64
 */
export const PLUGIN_SKIP = [
  "pdone-lx"
]

/** 免得出名单是空的时候有人以为文件坏了 */
export const PLUGIN_SKIP_META = {
  generatedAt: "2026-10-06T23:23:07.162Z",
  node: "v22.22.2",
  platform: "win32-x64",
  loadErrors: ["pdone-sixyin","pdone-flower","pdone-grass","pdone-juhe","pdone-changqing","liuyun-yc"],
}
