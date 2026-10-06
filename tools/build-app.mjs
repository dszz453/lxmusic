/**
 * App 侧后端打包器：src/ 的 ESM 后端 → 单个 IIFE → public/js/backend.bundle.js
 *
 * 为什么需要它：
 *   安卓壳里没有 Node、也没有 Worker 运行时，后端逻辑只能在 WebView 的 JS 引擎里跑。
 *   而 WebView 加载的是 file:// 资源，ESM 的 <script type="module"> 在 file:// 下会因
 *   同源策略被拒（"Access to script at 'file://' from origin 'null' has been blocked"）。
 *   所以必须把 ESM 展平成一个普通 <script> 能直接执行的 IIFE。
 *
 * 为什么自己写而不上 esbuild/rollup：
 *   本项目的 ESM 用法极其规整 —— 只有四种 import（默认 / 具名 / 命名空间 / 副作用）
 *   和五种 export（default / function / class / const-let-var / 具名列表），没有
 *   export *、没有 import.meta、没有动态 import、依赖图无环。用 200 行覆盖全部形态，
 *   换来「零依赖、离线可构建、出错能一眼定位到源文件第几行」，比拉一个 10MB 的
 *   打包器更划算。转换完会做残留检查（源文件里不该再有裸 import/export），
 *   一旦将来引入新语法，构建会直接失败而不是产出坏包。
 *
 * 与 Worker 的关系：
 *   Worker 侧仍由 wrangler 打包同一份 src/，两边共用源码、行为一致。
 *   本脚本只额外产出 App 用的展平版，不改动任何源文件。
 *
 * 用法：node tools/build-app.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

/**
 * 产物里的「源摘要」。
 *
 * 刻意**不写生成时间** —— 那会让每次构建的哈希都不一样，于是「APK 里的前端是不是当前源码」
 * 就只能靠人肉 diff 确认。改成源码摘要后，同一份源码 → 逐字节相同的产物：
 *   · 哈希不变 = 没动代码（重跑构建、重新出包都应如此）
 *   · 哈希变了 = 真动了代码，去看 diff
 * 校验 APK 是否与源码同步，一个 sha256 就够了。
 */
function digest(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
}
/**
 * 只打包 server/api.js 这一条依赖链（业务逻辑）。
 *
 * 插件**不**走这个 bundle，而是单独生成 public/js/plugins.data.js（纯数据）。
 * 原因见 src/plugins.js 顶部的说明：内置插件里有会让 JS 引擎直接崩溃的混淆脚本，
 * 放在 bundle 顶层求值 = App 白屏。App 侧改为把插件脚本交给 public/js/lxplugin.js，
 * 让每个插件在独立 Web Worker 里求值 —— 崩也只崩一个 Worker，页面活着。
 * 顺带的好处是插件支持异步 inited，可用数量反而比 Worker 侧更高。
 */
const ENTRY_API = path.join(SRC_DIR, 'server', 'api.js')
const OUT_FILE = path.join(ROOT, 'public', 'js', 'backend.bundle.js')
const PLUGIN_DATA_FILE = path.join(ROOT, 'public', 'js', 'plugins.data.js')
const PLUGIN_JS = path.join(ROOT, 'src', 'generated', 'plugins.js')
const BLACKLIST = path.join(ROOT, 'probe', 'plugin-blacklist.json')

/* ---------------- 正则：只覆盖本项目实际用到的 ESM 形态 ---------------- */

// import … from '…'（跨行安全：靠 `from` 收尾，import 子句里不会出现 from）
const RE_IMPORT = /^[ \t]*import\b([\s\S]*?)\bfrom[ \t]*(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm
// 纯副作用 import：import '…'
const RE_IMPORT_BARE = /^[ \t]*import[ \t]+(['"])([^'"]+)\1[ \t]*;?[ \t]*$/gm
// export default …
const RE_EXPORT_DEFAULT = /^[ \t]*export[ \t]+default[ \t]+/gm
// export { a, b as c }
const RE_EXPORT_NAMED = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm
// export [async] function / export class / export const|let|var
const RE_EXPORT_DECL = /^[ \t]*export[ \t]+((?:async[ \t]+)?function\*?|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm

/** 把 import 子句解析成可生成的绑定形式 */
function parseBindings(raw) {
  const t = raw.trim()
  if (!t) return { kind: 'side' }
  if (t.startsWith('*')) {
    const m = t.match(/^\*[ \t]*as[ \t]+([A-Za-z_$][\w$]*)$/)
    if (!m) throw new Error(`无法解析命名空间导入: ${t}`)
    return { kind: 'ns', name: m[1] }
  }
  if (t.startsWith('{')) {
    const inner = t.replace(/^\{/, '').replace(/\}$/, '')
    const pairs = inner.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.match(/^([A-Za-z_$][\w$]*)[ \t]*(?:as[ \t]+([A-Za-z_$][\w$]*))?$/)
      if (!m) throw new Error(`无法解析具名导入项: ${s}`)
      return m[2] ? `${m[1]}: ${m[2]}` : m[1]
    })
    return { kind: 'named', pairs }
  }
  // 默认导入（本项目里不会与具名混用）
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) throw new Error(`无法解析默认导入: ${t}`)
  return { kind: 'default', name: t }
}

/** 解析模块说明符为绝对路径 */
function resolveSpec(spec, fromAbs) {
  if (!spec.startsWith('.')) throw new Error(`App 打包不支持裸模块说明符: ${spec}（来自 ${path.relative(ROOT, fromAbs)}）`)
  let p = path.resolve(path.dirname(fromAbs), spec)
  if (!path.extname(p)) p += '.js'
  if (!fs.existsSync(p)) throw new Error(`模块不存在: ${spec} → ${p}`)
  return p
}

const toId = (abs) => path.relative(ROOT, abs).split(path.sep).join('/')

/* ---------------- 单模块重写 ---------------- */

function rewrite(abs) {
  const src = fs.readFileSync(abs, 'utf8')
  const deps = []
  const exportedNames = []
  const head = []

  let code = src

  // ① 具名/默认/命名空间 import → __require
  code = code.replace(RE_IMPORT, (_full, bindRaw, _q, spec) => {
    const id = toId(resolveSpec(spec, abs))
    deps.push(id)
    const b = parseBindings(bindRaw)
    if (b.kind === 'side') return `__require(${JSON.stringify(id)});`
    if (b.kind === 'ns') return `const ${b.name} = __require(${JSON.stringify(id)});`
    if (b.kind === 'named') return `const { ${b.pairs.join(', ')} } = __require(${JSON.stringify(id)});`
    return `const ${b.name} = __require(${JSON.stringify(id)}).default;`
  })

  // ② 纯副作用 import
  code = code.replace(RE_IMPORT_BARE, (_full, _q, spec) => {
    const id = toId(resolveSpec(spec, abs))
    deps.push(id)
    return `__require(${JSON.stringify(id)});`
  })

  // ③ export default X → __exports.default = X
  code = code.replace(RE_EXPORT_DEFAULT, '__exports.default = ')

  // ④ export { a, b as c } → __exports.b = a;
  code = code.replace(RE_EXPORT_NAMED, (_full, inner) => {
    const parts = inner.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.match(/^([A-Za-z_$][\w$]*)[ \t]*(?:as[ \t]+([A-Za-z_$][\w$]*))?$/)
      if (!m) throw new Error(`${toId(abs)}: 无法解析导出项 ${s}`)
      const local = m[1]
      const out = m[2] || m[1]
      return `__exports.${out} = ${local};`
    })
    return parts.join(' ')
  })

  // ⑤ export <decl> → 去掉 export，末尾统一挂到 exports
  code = code.replace(RE_EXPORT_DECL, (_full, kind, name) => {
    exportedNames.push(name)
    return `${kind} ${name}`
  })

  // 护栏：转换后不该再有模块级 import/export，一旦有新语法立即失败
  const residual = code.match(/^[ \t]*(?:import|export)\b/m)
  if (residual) {
    throw new Error(`${toId(abs)}: 转换后仍残留模块语法 ${JSON.stringify(residual[0].trim())}，请扩展打包器`)
  }

  if (exportedNames.length) {
    head.push(`  /* 导出挂载 */`)
    for (const n of exportedNames) head.push(`  __exports.${n} = ${n};`)
  }

  return {
    id: toId(abs),
    deps,
    code: `__modules[${JSON.stringify(toId(abs))}] = function (__exports, __require) {\n` +
      code + `\n` +
      (head.length ? head.join('\n') + '\n' : '') +
      `};\n`,
  }
}

/* ---------------- 收集 + 打包 ---------------- */

function collect(entries) {
  const mods = new Map()
  const queue = entries.slice()
  while (queue.length) {
    const abs = queue.shift()
    const id = toId(abs)
    if (mods.has(id)) continue
    const m = rewrite(abs)
    mods.set(id, m)
    for (const d of m.deps) {
      const dAbs = path.resolve(ROOT, d)
      if (!mods.has(d)) queue.push(dAbs)
    }
  }
  return mods
}

/**
 * 生成插件数据文件（纯数据，不求值）。
 *
 * 从 build.mjs 产出的 src/generated/plugins.js 里抽出 {id,name,url,script}，
 * 剔除黑名单后写成 window.LX_PLUGIN_DATA。
 * 这些脚本由 App 启动时的 lxplugin.js 逐个灌进独立 Worker 求值。
 */
function emitPluginData() {
  if (!fs.existsSync(PLUGIN_JS)) {
    console.warn(`[build-app] 跳过插件数据：${path.relative(ROOT, PLUGIN_JS)} 不存在（先跑 node build.mjs）`)
    return null
  }
  let skip = []
  if (fs.existsSync(BLACKLIST)) {
    try { skip = JSON.parse(fs.readFileSync(BLACKLIST, 'utf8')).skip || [] } catch { /* 读坏就不过滤 */ }
  }
  const src = fs.readFileSync(PLUGIN_JS, 'utf8')
  // generated/plugins.js 的结构是固定的：每项一个对象字面量，字段顺序 id/name/url/script
  const items = []
  const re = /id:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*name:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*url:\s*("(?:[^"\\]|\\.)*"),\s*\n\s*script:\s*("(?:[^"\\]|\\.)*")/g
  let m
  while ((m = re.exec(src)) !== null) {
    items.push({ id: JSON.parse(m[1]), name: JSON.parse(m[2]), url: JSON.parse(m[3]), script: JSON.parse(m[4]) })
  }
  if (!items.length) {
    console.warn('[build-app] 插件数据解析为空，检查 generated/plugins.js 格式')
    return null
  }
  const kept = items.filter(it => !skip.includes(it.id))
  const dropped = items.filter(it => skip.includes(it.id))

  const totalKB = (kept.reduce((a, it) => a + it.script.length, 0) / 1024).toFixed(0)
  const out = `/* 由 tools/build-app.mjs 自动生成，请勿手动修改。
 * 源摘要: ${digest(kept.map(it => it.id + it.script).join('\n'))}
 * 内置插件 ${kept.length} 个（已排除 ${dropped.length} 个：${dropped.map(d => d.id).join(', ') || '无'}），脚本共 ${totalKB} KB。
 *
 * 这里只有数据，没有求值 —— 求值由 public/js/lxplugin.js 在独立 Web Worker 里完成，
 * 避免个别混淆脚本把整个页面搞崩。
 */\nwindow.LX_PLUGIN_DATA = ${JSON.stringify(kept.map(it => ({ id: it.id, name: it.name, url: it.url, script: it.script })))};
`
  fs.writeFileSync(PLUGIN_DATA_FILE, out, 'utf8')
  console.log(`[build-app] 插件数据 ${kept.length} 个（排除 ${dropped.map(d => d.id).join(', ') || '无'}）→ ${path.relative(ROOT, PLUGIN_DATA_FILE)}（${(out.length / 1024).toFixed(1)} KB）`)
  return { kept: kept.length, dropped: dropped.map(d => d.id) }
}

function main() {
  if (!fs.existsSync(ENTRY_API)) throw new Error(`入口不存在: ${ENTRY_API}`)
  const mods = collect([ENTRY_API])

  const body = Array.from(mods.values()).map(m => m.code).join('\n')

  const banner = `/* 由 tools/build-app.mjs 自动生成，请勿手动修改。
 * 源摘要: ${digest(body)}
 * 模块数: ${mods.size}
 *
 * 这是给安卓壳用的后端展平版：把 src/ 的 ESM 后端打成单个 IIFE，
 * 让 WebView 用普通 <script> 就能加载（file:// 下 ESM 会被同源策略拒绝）。
 * 依赖注入见 public/js/native.js —— 它会把 __lxFetch / __lxDB 换成走原生桥的实现。
 */\n`

  const out = `${banner}(function () {
'use strict'
var __modules = {};
var __cache = {};
function __require(id) {
  var hit = __cache[id];
  if (hit) return hit;
  var factory = __modules[id];
  if (!factory) throw new Error('模块未打包: ' + id);
  var exp = {};
  __cache[id] = exp;
  factory(exp, __require);
  return exp;
}
${body}
var __api = __require(${JSON.stringify(toId(ENTRY_API))});
var LXBackend = {
  handleApi: __api.handleApi,
  currentUser: __api.currentUser,
  makeToken: __api.makeToken,
  verifyToken: __api.verifyToken,
  __modules: Object.keys(__modules)
};
if (typeof window !== 'undefined') window.LXBackend = LXBackend;
if (typeof globalThis !== 'undefined') globalThis.LXBackend = LXBackend;
if (typeof self !== 'undefined') self.LXBackend = LXBackend;
})();
`

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, out, 'utf8')

  console.log(`[build-app] 模块 ${mods.size} 个`)
  console.log(`[build-app] 清单: ${Array.from(mods.keys()).sort().join('  ')}`)
  console.log(`[build-app] 已写入 ${path.relative(ROOT, OUT_FILE)}（${(out.length / 1024).toFixed(1)} KB）`)
  emitPluginData()
}

main()
