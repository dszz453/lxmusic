/**
 * 服务端「手动导入插件」。
 *
 * ── 为什么必须有这一块 ────────────────────────────────────────────
 * 用户端的插件管理分成两种模式（见 public/js/app.js）：
 *   · 本机模式 —— 插件跑在浏览器/App 自己身上，导入落在本机 IndexedDB；
 *   · 服务器模式 —— 插件由服务端统一加载调度，用户端只显示一句
 *     「需要增删插件请到管理端」。
 * 但**管理端此前根本没有导入功能**（只有列表 / 评分 / 启停），服务端也没有导入接口 ——
 * 等于那句话把人指到了一个不存在的地方。用户的原话就是「插件没有办法手动导入新的插件」。
 *
 * ── 为什么用 settings 表存，不开新表 ──────────────────────────────
 * 三个宿主（Cloudflare D1 / 容器 SQLite / 壳内 SQLite）共用同一段建表 SQL，
 * 加一张表就要同时改 schema + 两侧适配层 + app-bundle 的替身登记表。而插件清单
 * 本来就是一份「全局唯一、整体读整体写」的数据，用 KV 存语义上完全吻合，改动面最小。
 *
 * ── 为什么只在自托管（Node）下真的能用 ───────────────────────────
 * 求值插件要 `new Function`。Cloudflare Worker 只在**启动阶段**允许它，
 * 请求处理阶段一律禁止（见 src/plugins.js 顶部）。所以那边如实回 501，
 * 而不是假装支持然后 500。
 */
import { parseScriptMeta } from '../lib/lxruntime.js'
import { getSetting, setSetting } from '../db.js'
import { outboundFetch } from '../lib/http.js'
/*
 * ⚠️ 这里**不能**静态 import 下面这些东西：
 *
 *   node:fs / node:child_process / node:url   —— 裸模块说明符，打包器直接拒绝
 *   import.meta                              —— 展平后的非模块脚本里是**语法错误**
 *   ../plugins.js                            —— 最隐蔽的一个：它顶层会求值全部内置插件，
 *                                               其中 pdone-lx 求值时**直接把 JS 引擎杀死**。
 *                                               它一进 bundle，产物加载即崩
 *                                               （本轮实测：模块数 22 → 26，
 *                                                新增的正是 plugins.js / lxruntime.js /
 *                                                plugin-rank.js，进程无异常直接退出）。
 *
 * 这些全是**宿主相关**的能力，统一改成注入（见下面 setPluginHost）。
 * src/ 这边只认函数签名，谁提供都行 —— 于是 WebView 打包不再被绊住。
 */

/** settings 表里的键。整体是一份 JSON 数组 */
export const USER_PLUGINS_KEY = 'user_plugins'

/** 单个插件脚本的体量上限。落落雪插件实测最大约 340KB，给到 2MB 足够宽松 */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024

/** 抓脚本的超时。镜像站偶发慢，给足 20s */
const FETCH_TIMEOUT = 20000

/**
 * GitHub 镜像降级链（与服务端无关，是为了「服务器本身也连不上 raw.githubusercontent」）。
 * 顺序与 public/js/lxplugin.js 保持一致：ghfast.top 优先（老板指定），原地址兜底。
 */
export function mirrorCandidates(url) {
  const rawRe = /^https:\/\/raw\.githubusercontent\.com\//
  const blobRe = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  const out = []
  let raw = ''
  if (rawRe.test(url)) raw = url
  else if (blobRe.test(url)) {
    const m = blobRe.exec(url)
    raw = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`
  }
  if (raw) {
    out.push('https://ghfast.top/' + raw)
    out.push('https://gh-proxy.com/' + raw)
    out.push('https://ghproxy.net/' + raw)
    out.push(raw)
  } else {
    out.push(url)
  }
  // 原地址永远兜底（非 GitHub 地址时它本来就是唯一一项）
  if (out[out.length - 1] !== url) out.push(url)
  return Array.from(new Set(out))
}

/** 内容像不像一份落雪插件脚本。镜像挂了常回 200 的 HTML 错误页，不能只看状态码 */
function looksLikePlugin(text) {
  const s = String(text || '')
  if (s.length < 50) return false
  if (/^\s*<(!doctype|html)/i.test(s)) return false
  return true
}

/** 同步短哈希（免 crypto 的异步），用来给脚本生成稳定的 id */
function shortHash(s) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = ((h1 ^ c) * 16777619) >>> 0
    h2 = ((h2 + c) * 31) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10)
}

/* ---------------- 子进程预筛（宿主注入） ---------------- */
/*
 * 预筛要 spawn 子进程，是**纯 Node 能力**，所以实现在 server/plugin-import-node.mjs，
 * 由 server/index.mjs 启动时注入进来（见那里的 setProbeRunner）。
 *
 * 为什么不直接在 src/ 里 import 那个文件：src/ 会被 tools/build-app.mjs
 * 展平成给 WebView 用单文件 IIFE。那边一旦引入 node:child_process 或 import.meta，
 * 轻则报「不支持裸模块说明符」打断打包，重则产物一加载就炸
 * （import.meta 在非模块脚本里是**语法错误**，不是运行时才出错）。
 * 用注入就把这层依赖反转掉了：src/ 侧只认一个函数签名，谁提供都行。
 */

/** 当前的预筛实现。null = 当前宿主没有这项能力（Cloudflare / 壳内） */
let probeRunner = null

/**
 * 注入预筛实现。server/index.mjs 启动时调用一次。
 * 传 null 可显式关掉（测试里想跳过子进程时用）。
 */
export function setProbeRunner(fn) {
  probeRunner = typeof fn === 'function' ? fn : null
}

/* ---------------- 插件池与求值器（宿主注入） ---------------- */

/**
 * 插件池 + 求值函数，由宿主注入 —— **不能**从 ../plugins.js 静态 import。
 *
 * ../plugins.js 顶层有一句 `if (!globalThis.__LX_DEFER_PLUGIN_EVAL) evaluateBundledPlugins()`，
 * 而内置插件里 pdone-lx 求值时会**直接把 JS 引擎杀死**（不抛异常、try/catch 拦不住）。
 * 在 Node 宿主里那句被 boot-flags 挡掉了（改成启动时显式求值），所以自托管没问题；
 * 但**打包产物**（给 WebView 的单文件 IIFE）里没有那个旗标，一旦 plugins.js 被带进去，
 * 产物一加载就整个进程消失 —— 表现是测试「只输出两三行就退出，连报错都没有」。
 *
 * 本轮实测：给 plugin-import.mjs 加了 `import { pluginPool } from '../plugins.js'`，
 * bundle 模块数从 22 涨到 26（新增 plugins.js / lxruntime.js / plugin-rank.js），
 * test/app-bundle.mjs 立刻从 22 通过变成「加载即死」。
 * 所以池子和求值器都走注入：api.js 那边本来就用 env.PLUGIN_POOL（见它全文），
 * 这里保持同一个口径。
 */
let pluginHost = null

/**
 * 注入插件池与求值器。
 * @param {{pool:object, evaluate:(entry:object, origin:string)=>object}} host
 */
export function setPluginHost(host) {
  pluginHost = host && host.pool ? host : null
}

/** 拿池子。没注入就当空池处理（WebView / Worker 走不到这些分支） */
function hostPool() {
  return (pluginHost && pluginHost.pool) || null
}

/** 求值一个插件。没注入求值器时抛「宿主不支持」而不是静默失败 */
function hostEvaluate(entry, origin) {
  if (!pluginHost || typeof pluginHost.evaluate !== 'function') {
    throw Object.assign(new Error('当前宿主不支持运行时求值插件'), { userError: true })
  }
  return pluginHost.evaluate(entry, origin)
}

/**
 * 在**子进程**里求值这个脚本，判断它会不会把 JS 引擎搞死。
 *
 * 判定纪律（与 tools/plugin-prescreen.mjs 一致，很重要）：
 *   只有「进程被打死 / 超时无输出」才算危险；
 *   「脚本未发送 inited 事件」「取不到远端配置」这类是**环境类**失败 ——
 *   服务器出口到不了那个站点而已，换个网络可能就是好的。这类**不算危险**，
 *   照常让主进程去求值并如实把错误显示出来。
 *
 * 没有注入实现时（Cloudflare / 安卓壳）如实返回 error 而不是 crash ——
 * 上层据此「不拦」，让主进程自己去求值。把「没能力筛」当成「脚本危险」
 * 会把正常插件也拒掉。
 *
 * @returns {Promise<{state:'ok'|'error'|'crash'|'timeout', error?:string|null}>}
 */
export async function probePluginInChild(id, script) {
  if (!probeRunner) {
    return { state: 'error', error: '当前宿主不支持子进程预筛，已跳过这一步（由主进程直接求值）' }
  }
  return probeRunner(id, script)
}

/** 读回全部用户导入的插件 */
export async function readUserPlugins(db) {
  const raw = await getSetting(db, USER_PLUGINS_KEY, '')
  if (!raw) return []
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.filter(x => x && x.id && x.script) : []
  } catch { return [] }
}

async function writeUserPlugins(db, list) {
  await setSetting(db, USER_PLUGINS_KEY, JSON.stringify(list))
}

/** 抓一份插件脚本，逐个镜像降级。返回 { script, from } */
export async function fetchPluginScript(url) {
  const errors = []
  for (const u of mirrorCandidates(url)) {
    let host = u
    try { host = new URL(u).host } catch { /* 保持原样 */ }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      const res = await outboundFetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (lxmusic plugin importer)' },
        redirect: 'follow',
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) { errors.push(host + ': HTTP ' + res.status); continue }
      if (!looksLikePlugin(text)) { errors.push(host + ': 内容不像插件脚本'); continue }
      return { script: text, from: host }
    } catch (e) {
      errors.push(host + ': ' + String((e && e.message) || e).slice(0, 60))
    } finally {
      clearTimeout(timer)
    }
  }
  throw Object.assign(new Error('下载失败（已试 ' + mirrorCandidates(url).length + ' 个地址）— ' + errors.join('；')), { userError: true })
}

/**
 * 导入一个插件：接受 URL 或脚本正文。
 *
 * 落库策略是「**先在子进程摸底 → 再在主进程求值 → 成功才落库**」。
 * 这三个顺序都有理由：
 *   · 不先摸底 —— 一个会搞死引擎的脚本（实测 pdone/lx 就是）能把整台服务器打死；
 *   · 不先求值就落库 —— 会留下一条让容器**下次启动**起不来的记录；
 *   · 落库放在最后 —— 上面两步任何一步失败，都不会在库里留下半个残骸。
 * 宁可导入失败报错，也不留一个「重启就挂」的定时炸弹。
 *
 * @returns {Promise<{ok:true, plugin:object, replaced:boolean, from?:string}>}
 */
export async function importPlugin(db, { url, script, name } = {}) {
  let text = String(script || '')
  let from = null
  if (!text) {
    const raw = String(url || '').trim()
    if (!raw) throw Object.assign(new Error('请填写插件 URL 或粘贴脚本'), { userError: true })
    if (!/^https?:\/\//i.test(raw)) throw Object.assign(new Error('URL 必须以 http(s):// 开头'), { userError: true })
    const got = await fetchPluginScript(raw)
    text = got.script
    from = got.from
  }
  if (text.length > MAX_SCRIPT_BYTES) {
    throw Object.assign(new Error('脚本过大（' + Math.round(text.length / 1024) + 'KB，上限 ' + (MAX_SCRIPT_BYTES / 1024 / 1024) + 'MB）'), { userError: true })
  }
  if (!looksLikePlugin(text)) throw Object.assign(new Error('内容不像插件脚本'), { userError: true })

  const meta = parseScriptMeta(text)
  const id = 'user_' + shortHash(text)
  const record = {
    id,
    name: String(name || meta.name || '未命名插件').slice(0, 60),
    version: meta.version || '',
    author: meta.author || '',
    url: String(url || '').trim(),
    from: from || null,
    script: text,
    bytes: text.length,
    createdAt: Date.now(),
  }

  // ① 先在子进程里摸一遍 —— 确认这个脚本不会把 JS 引擎搞死。
  //    主进程直接求值一个坏脚本 = 整台服务器的容器被打死，这一步省不得。
  const probe = await probePluginInChild(id, text)
  if (probe.state === 'crash' || probe.state === 'timeout') {
    throw Object.assign(new Error(
      '这个插件脚本不能加载：' + (probe.error || '求值异常')
      + '。为了不让它把整个服务弄挂，已经拒绝导入。'
    ), { userError: true })
  }

  // ② 摸底通过 → 在主进程里正式装载。求值失败不留半个残骸在池子里。
  //    注意「先求值成功、再落库」的顺序：反过来会留下一条让容器下次起不来的记录。
  const r = hostEvaluate({ id, script: text, url: record.url, name: record.name }, 'user')
  if (!r.ok) {
    const p = hostPool()
    if (p) p.remove(id)
    throw Object.assign(new Error('插件未能就绪：' + (r.error || '未知原因')
      + '（脚本本身加载了，但初始化没成功 —— 常见原因是它要拉一份远端配置而服务器出口取不到）'), { userError: true })
  }

  const list = await readUserPlugins(db)
  const at = list.findIndex(x => x.id === id)
  const replaced = at >= 0
  if (replaced) list[at] = record
  else list.push(record)
  await writeUserPlugins(db, list)

  return { ok: true, plugin: { id, name: record.name, version: record.version, bytes: record.bytes, from }, replaced, from }
}

/**
 * 删除一个「用户导入」的插件。
 * 内置插件不给删 —— 它们是构建产物，删了下次构建又回来，只会造成「删了又出现」的困惑；
 * 想让它别上岗应该用「停用」（走 plugin-prefs）。
 */
export async function removeImportedPlugin(db, id) {
  const key = String(id || '')
  if (!key) throw Object.assign(new Error('缺少 id'), { userError: true })
  if (!key.startsWith('user_')) {
    throw Object.assign(new Error('内置插件不能删除，请改用「停用」'), { userError: true })
  }
  const list = await readUserPlugins(db)
  const next = list.filter(x => x.id !== key)
  if (next.length === list.length) throw Object.assign(new Error('没有这个插件'), { userError: true, status: 404 })
  await writeUserPlugins(db, next)
  const p0 = hostPool()
  if (p0) p0.remove(key)
  return { ok: true, removed: key, left: next.length }
}

/**
 * 启动时把用户导入的插件装回池子。
 *
 * `skip` 里的是「上一次启动求值它时把进程搞死了」的 id（见 server/index.mjs 的
 * pending 标记自愈）—— 这类插件不装进池子，但要在池子里留一条说明，
 * 否则管理端的列表里它凭空消失，用户只会以为「导入的记录丢了」。
 */
export async function loadUserPlugins(db, skip = new Set()) {
  let list = []
  try { list = await readUserPlugins(db) } catch { return { total: 0, loaded: 0 } }
  if (!list.length) return { total: 0, loaded: 0 }

  const say = (s) => process.stdout.write(s + '\n')
  const pool = hostPool()
  if (!pool) return { total: 0, loaded: 0 }
  let loaded = 0
  for (const rec of list) {
    if (skip.has(rec.id)) {
      pool.add({
        ok: false, id: rec.id, url: rec.url || '', origin: 'user',
        error: '已跳过：该脚本求值会杀死 JS 引擎（删掉它或改用别的插件）',
        meta: { name: rec.name, version: rec.version, author: rec.author },
      })
      continue
    }
    let r
    try { r = hostEvaluate({ id: rec.id, script: rec.script, url: rec.url, name: rec.name }, 'user') } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) }
      pool.add({
        ok: false, id: rec.id, url: rec.url || '', origin: 'user',
        error: r.error, meta: { name: rec.name, version: rec.version, author: rec.author },
      })
    }
    if (r.ok) loaded++
  }
  say(`[server] 用户导入插件 ${loaded}/${list.length} 可用`)
  return { total: list.length, loaded }
}
