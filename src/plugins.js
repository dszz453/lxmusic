/**
 * 内置插件池
 *
 * 两种求值时机，取决于运行环境：
 *
 *  · Cloudflare Worker —— **必须**在模块顶层求值。这是平台的硬约束：
 *    只有「启动阶段」允许 new Function/eval，请求处理阶段一律禁止。
 *
 *  · 安卓壳（WebView）—— 顶层求值变成风险点。落雪插件里有相当一部分是重度
 *    混淆的（自研字节码解释器），实测 pdone-lx 这一份会在求值时把 JS 引擎直接
 *    搞死：不抛异常、try/catch 无效、连进程退出钩子都不触发。放在顶层就意味着
 *    「一个第三方插件把整个 App 变成白屏」。
 *
 *    所以壳里改为「延迟求值」——由 public/js/native.js 显式调用 evaluateBundledPlugins()，
 *    并且可以先在隔离环境里预筛。这样插件的可用性由运行环境决定，而不是让
 *    一份坏脚本决定 App 能不能启动。
 *
 * 开关：globalThis.__LX_DEFER_PLUGIN_EVAL = true 时不自动求值。
 * 不设时（Worker）保持原有行为，线上逻辑完全不变。
 */
import { PluginPool, evaluatePluginAtStartup, parseScriptMeta } from './lib/lxruntime.js'
import { BUNDLED_PLUGINS } from './generated/plugins.js'
import { PLUGIN_RANK, PLUGIN_RANK_META } from './generated/plugin-rank.js'

export const pluginPool = new PluginPool()

export const PLUGIN_MANIFEST = BUNDLED_PLUGINS

/**
 * 装载「实测得分排序表」。
 * 取流只试候选列表的前 N 个，所以「谁排前面」直接决定能不能出声音 ——
 * 这份表由 tools/plugin-score.mjs 实测生成，缺失或为空时退回注册顺序。
 */
const rankedSources = pluginPool.setRank(PLUGIN_RANK)
console.log(`[plugins] 已装载实测排序表：${rankedSources} 个平台` +
  (PLUGIN_RANK_META.generatedAt ? `（评分时间 ${PLUGIN_RANK_META.generatedAt}）` : '（未评分，按注册顺序）'))

/** 单个插件的元信息（不求值），供诊断 / 预筛 / 界面展示使用 */
export function pluginBrief(item) {
  const meta = parseScriptMeta(item.script)
  return {
    id: item.id,
    name: meta.name || item.name,
    version: meta.version || '',
    author: meta.author || '',
    bytes: item.script.length,
  }
}

/**
 * 求值一个插件并登记进池。调用方负责隔离 ——
 * 这个函数不保证返回：混淆脚本可能直接终止 JS 引擎。
 * @returns {{ok:boolean, error?:string}}
 */
export function evaluateOne(item) {
  const meta = parseScriptMeta(item.script)
  const result = evaluatePluginAtStartup(item.id, item.script, {
    name: meta.name,
    description: meta.description,
    version: meta.version,
    author: meta.author,
    homepage: meta.homepage,
    rawScript: null, // 不保留原文，避免内存翻倍
  })
  pluginPool.add({ ...result, id: item.id, url: item.url || '', meta: { ...meta, ...(result.meta || {}) } })
  return { ok: !!result.ok, error: result.error || null }
}

/**
 * 求值全部内置插件。
 * @param {string[]} [skipIds] 已知会让引擎崩溃的插件 id（由预筛结果提供）
 * @param {(r:object)=>void} [onEach] 每个插件的进度回调
 */
export function evaluateBundledPlugins({ skipIds = [], onEach = null } = {}) {
  const skip = new Set(skipIds)
  let loaded = 0
  for (const item of BUNDLED_PLUGINS) {
    if (skip.has(item.id)) {
      const brief = pluginBrief(item)
      pluginPool.add({ ok: false, id: item.id, url: item.url || '', error: '已在预筛中跳过（该脚本会使 JS 引擎崩溃）', meta: brief })
      if (onEach) onEach({ ...brief, ok: false, skipped: true })
      continue
    }
    let r
    try {
      r = evaluateOne(item)
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) }
      const brief = pluginBrief(item)
      pluginPool.add({ ok: false, id: item.id, url: item.url || '', error: r.error, meta: brief })
    }
    if (r.ok) loaded++
    if (onEach) onEach({ ...pluginBrief(item), ok: r.ok, error: r.error })
  }
  return { total: BUNDLED_PLUGINS.length, loaded }
}

if (!globalThis.__LX_DEFER_PLUGIN_EVAL) {
  evaluateBundledPlugins()
  // 输出一次加载结果，便于通过 wrangler tail 排查插件初始化失败
  console.log('[plugins] 内置音源加载结果:', JSON.stringify(pluginPool.summary()))
}
