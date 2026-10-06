/**
 * 启动开关 —— **必须作为 server/index.mjs 的第一个 import**。
 *
 * 为什么单独占一个文件：ESM 会先把整棵依赖树求值完，才轮到模块自己的语句。
 * 而 src/server/api.js 一路静态 import 到 src/plugins.js，那个模块顶层会
 * 求值全部内置插件 —— 其中个别脚本求值时会**直接杀死 JS 引擎**。
 * 所以「别在顶层求值」这个开关必须在依赖树被求值之前就位，
 * 只能靠「先 import 一个小模块」来抢这个顺序（同源顺序里它排在前面）。
 *
 * 效果：插件改成启动时显式求值（server/index.mjs 里那次），
 * 并且可以先把会崩的插件摘出去再求值。
 */
globalThis.__LX_DEFER_PLUGIN_EVAL = true
