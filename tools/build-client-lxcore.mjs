/**
 * 云音乐客户端 · 本地插件运行时打包器
 *
 * 产出两个文件到 `yunmusic-client/assets/web/`：
 *
 *   lxcore.js        插件运行时的加密/编码垫片 + Worker 源码字符串
 *   plugins.data.js  22 个内置插件的源码（纯数据，页面**懒加载**）
 *
 * ── 为什么要有这个脚本，而不是在客户端手抄一份 ────────────────────
 * `src/lib/crypto.js` / `src/lib/util.js` / `public/js/lxworker.js` 是
 * **服务端、网页版、安卓客户端三方共用的同一份源码**。手抄一份就意味着以后
 * 服务端修了 bug（例如 AES 的 PKCS7 去填充边界、base64 的补位），客户端不会
 * 跟着修 —— 而这类 bug 的表现是「插件签名对不上、取流静默失败」，极难排查。
 * 这里用 esbuild 把同一份源码打成客户端能直接 `<script>` 引入的普通脚本。
 *
 * ── 为什么插件数据要单独成文件、还做成懒加载 ──────────────────────
 * 22 个插件源码合计约 760KB。绝大多数用户不会打开「本地插件」开关，
 * 把这段数据写进 index.html 等于让每个人每次冷启动都白解析一遍。
 * 所以它单独成文件，且 index.html **不**用 `<script src>` 静态引入 ——
 * 只有第一次真正需要插件时才动态插进去（见 index.html 的 loadPluginData）。
 *
 * ── 为什么 target 是 es2017 而不是 es5 ────────────────────────────
 * 客户端 index.html 本身已经在用模板字符串（94 处）与 Promise，
 * 真实基线就是 ES2017（Chrome 55+）。降到 es5 反而会构建失败：
 * esbuild 不支持把 async 函数降级到 ES5/ES2015，而 async 是插件 inited
 * 协议的一部分（相当多插件的 sources 是在 Promise 链里异步声明的）。
 *
 * BigInt 用 `supported.bigint` 单独放行 —— 它是 ES2020 的语法，
 * 在 Chrome 67 以下**连解析都过不去**（语法错误，不是运行时错误）。
 * 实测 22 个内置插件里只有 wsl-freemusic 一个用到 rsaEncrypt，而 rsaEncrypt
 * 才需要 BigInt。所以取舍是：让它在支持的设备上可用，在不支持的设备上
 * 整个 lxcore.js 加载失败 —— 页面侧会探测 `window.LXCore` 存不存在，
 * 不存在就把「本地插件」开关置灰并说明原因，其余功能（服务端取流）完全不受影响。
 * 反过来（为了老设备把 BigInt 抠掉）要拆模块，代价远大于收益。
 *
 * ── 产物为什么要提交进仓库 ────────────────────────────────────────
 * 客户端 CI（.github/workflows/yunmusic-android.yml）只 checkout 客户端仓库，
 * 拿不到主仓库的 src/。所以产物必须落盘提交，与 public/js/backend.bundle.js
 * 的做法一致（那份也是 tools/build-app.mjs 生成后提交的）。
 *
 * 用法：
 *   NODE_PATH=<node_modules> node tools/build-client-lxcore.mjs
 *   node tools/build-client-lxcore.mjs --check    # 只校验产物是否为最新，不写盘
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'yunmusic-client', 'assets', 'web')

const CHECK_ONLY = process.argv.includes('--check')

/**
 * esbuild 不在本仓库的 dependencies 里（它只是 wrangler 的传递依赖）。
 * 用 createRequire 从 NODE_PATH 解析，顺带支持直接跑 `node` 时的常见布局。
 */
function loadEsbuild() {
  const require = createRequire(path.join(ROOT, 'noop.cjs'))
  const tried = []
  const candidates = ['esbuild']
  if (process.env.LX_NODE_MODULES) candidates.unshift(path.join(process.env.LX_NODE_MODULES, 'esbuild'))
  for (const c of candidates) {
    try { return require(c) } catch (e) { tried.push(`${c}: ${e.code || e.message}`) }
  }
  throw new Error(
    '找不到 esbuild。它是 wrangler 的传递依赖，不在本仓库 dependencies 里。\n' +
    '请用 `NODE_PATH=<指向含 esbuild 的 node_modules> node tools/build-client-lxcore.mjs` 运行，\n' +
    '或设 LX_NODE_MODULES=<该 node_modules 的绝对路径>。\n已尝试：\n  ' + tried.join('\n  ')
  )
}

const TARGET = 'es2017'
/** BigInt 是 ES2020 语法；只有 lx.utils.crypto.rsaEncrypt 用得到，单独放行 */
const SUPPORTED = { bigint: true }

function digest(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
}

/** 打包 Worker：插件在独立 Worker 里求值，混淆脚本崩掉也只崩一个 Worker */
async function buildWorker(esbuild) {
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, 'public', 'js', 'lxworker.js')],
    bundle: true,
    format: 'iife',
    target: TARGET,
    supported: SUPPORTED,
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  })
  return r.outputFiles[0].text
}

/** 打包运行时：crypto/util 垫片 + 把 Worker 源码作为字符串挂上去 */
async function buildCore(esbuild, workerSrc, stamp) {
  const contents = `
import * as crypto from './src/lib/crypto.js'
import * as util from './src/lib/util.js'

window.LXCore = {
  // Worker 源码以字符串内联：file:// 源下 new Worker('file://...') 会被同源策略拒绝，
  // 只能自己 Blob 一个。顺带也省掉一次文件读取。
  WORKER_SRC: __WORKER_SRC__,
  crypto: crypto,
  util: util,
  // 便于「APK 里的运行时是不是当前源码」一眼可比（同 build-app.mjs 的源摘要思路）
  SOURCE_DIGEST: __DIGEST__,
  TARGET: __TARGET__,
}
`
  const r = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'lxcore-entry.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    target: TARGET,
    supported: SUPPORTED,
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
    define: {
      __WORKER_SRC__: JSON.stringify(workerSrc),
      __DIGEST__: JSON.stringify(stamp),
      __TARGET__: JSON.stringify(TARGET),
    },
  })
  return r.outputFiles[0].text
}

/** 插件数据：把 ESM 的 BUNDLED_PLUGINS 转成挂 window 的普通脚本 */
async function buildPluginData() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'generated', 'plugins.js')).href)
  const list = mod.BUNDLED_PLUGINS
  if (!Array.isArray(list) || !list.length) throw new Error('src/generated/plugins.js 里没有 BUNDLED_PLUGINS')
  // 只留页面真正要用的字段：id / name / url / script。
  // 其余字段（如 bytes）由页面自己算，不重复占体积。
  const slim = list.map(p => ({ id: p.id, name: p.name || '', url: p.url || '', script: p.script }))
  const bytes = slim.reduce((a, p) => a + String(p.script || '').length, 0)
  return {
    code:
      '/* 由 tools/build-client-lxcore.mjs 自动生成，请勿手改。\n' +
      ` * 内置插件 ${slim.length} 个，源码合计 ${(bytes / 1024).toFixed(1)} KB。\n` +
      ' * 页面**懒加载**本文件：只有真正要用本地插件时才动态引入（见 index.html loadPluginData）。\n' +
      ' */\n' +
      'window.LX_BUNDLED_PLUGINS = ' + JSON.stringify(slim) + ';\n',
    count: slim.length,
    bytes,
  }
}

function writeIfChanged(file, code) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (prev === code) return false
  if (CHECK_ONLY) return true
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, code)
  return true
}

async function main() {
  const esbuild = loadEsbuild()
  if (!fs.existsSync(OUT_DIR)) throw new Error(`产物目录不存在：${OUT_DIR}`)

  const workerSrc = await buildWorker(esbuild)
  const stamp = digest(
    fs.readFileSync(path.join(ROOT, 'src', 'lib', 'crypto.js'), 'utf8') +
    fs.readFileSync(path.join(ROOT, 'src', 'lib', 'util.js'), 'utf8') +
    workerSrc
  )
  const coreSrc = await buildCore(esbuild, workerSrc, stamp)
  const data = await buildPluginData()

  const coreFile = path.join(OUT_DIR, 'lxcore.js')
  const dataFile = path.join(OUT_DIR, 'plugins.data.js')
  const coreChanged = writeIfChanged(coreFile, coreSrc)
  const dataChanged = writeIfChanged(dataFile, data.code)

  const kb = n => (n / 1024).toFixed(1) + ' KB'
  console.log(`[lxcore] Worker 源码      ${kb(workerSrc.length)}`)
  console.log(`[lxcore] lxcore.js        ${kb(coreSrc.length)}  ${coreChanged ? (CHECK_ONLY ? '需要更新' : '已写入') : '无变化'}`)
  console.log(`[lxcore] plugins.data.js  ${kb(data.code.length)}  ${dataChanged ? (CHECK_ONLY ? '需要更新' : '已写入') : '无变化'}  （${data.count} 个插件 / 源码 ${kb(data.bytes)}）`)
  console.log(`[lxcore] 源摘要 ${stamp} · target ${TARGET} · BigInt 放行`)

  if (CHECK_ONLY && (coreChanged || dataChanged)) {
    console.error('[lxcore] 产物与源码不一致 —— 请跑 `node tools/build-client-lxcore.mjs` 重新生成并提交。')
    process.exit(1)
  }
}

main().catch(e => { console.error('[lxcore] 失败：' + (e && e.stack || e)); process.exit(1) })
