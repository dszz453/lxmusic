/**
 * 跨端业务层打包器 —— 把 client/rn/src/*.js 拼成一个 client-layer.js。
 *
 * ── 为什么不用 esbuild / rollup / vite ────────────────────────
 * 这一层的全部代码就是 5 个模块、加起来二十几 KB，没有依赖、没有 npm 包、
 * 没有 TS 语法糖。引一个打包器意味着引入 node_modules（几百 MB）、
 * 版本升级、配置漂移，以及「构建机没装依赖就构建不了」。
 * 而它换来的是 zero：这里根本不需要 tree-shaking、代码分割、HMR。
 *
 * 所以这里是一个**故意写得很土**的拼接器 —— 但它比土办法多做了三件事，
 * 这三件事正是「静默失效」的防线：
 *
 *   1. **模块清单显式写死**（MODULES 数组）。少了哪个模块，构建直接失败。
 *      不这样做的话，症状是「某个功能莫名没了」，而且要发到用户手机上才发现。
 *   2. **构建期语法检查**：把拼好的源码交给 new Function 编译一次（不执行）。
 *      空指针、括号不配对、模板串写错这些在构建期就能拦住 ——
 *      否则到了设备上是**整页白屏**（一个脚本语法错误会让后面所有脚本都不执行）。
 *   3. **产物指纹**：把源码的 sha256 前 8 位写进文件头，日志里能直接对上
 *      「设备跑的是哪一版跨端层」。
 *
 * 用法：node tools/build-client-rn.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const SRC = path.join(ROOT, 'client/rn/src')
const OUT_DIR = path.join(ROOT, 'client/rn/build')
const OUT = path.join(OUT_DIR, 'client-layer.js')

/**
 * 模块清单与顺序。
 *
 * ⚠ 顺序有意义，而且只有两种合法写法：
 *   00 守卫（决定要不要介入）必须在最前；
 *   50 编排（所有人装配好之后才启动）必须在最后；
 *   中间三个之间没有依赖，改顺序不影响行为。
 * 每个模块都是独立的 IIFE，通过 window.LXClientLayer 互相拿句柄 ——
 * 所以「顺序」只影响「谁先把自己挂上去」，不影响谁引用谁。
 */
const MODULES = [
  '00-guard.js',   // 环境判据 + 公共工具（call / parse / log）
  '10-bridge.js',  // 原生门面封装
  '20-brand.js',   // 品牌与服务端版本
  '30-nav.js',     // 底栏与路由同步
  '40-pages.js',   // 原生页入口接管
  '50-shell.js',   // 启动编排
]

async function main() {
  const { CLIENT_VERSION, CLIENT_BUILD_ID } = await import(
    'file://' + path.join(ROOT, 'client/version.mjs').replace(/\\/g, '/')
  )

  const parts = []
  const sizes = []
  for (const name of MODULES) {
    const p = path.join(SRC, name)
    if (!fs.existsSync(p)) {
      // 明确失败而不是跳过：跳过的后果是「某个功能在真机上没有」，最难查
      throw new Error(`❌ 跨端层模块缺失：${name}（检查 client/rn/src/ 与 MODULES 清单）`)
    }
    const code = fs.readFileSync(p, 'utf8')
    if (/<\/script/i.test(code)) {
      throw new Error(`❌ ${name} 里出现了 </script —— 注入到 HTML 时会提前终止脚本块`)
    }
    sizes.push({ name, bytes: Buffer.byteLength(code, 'utf8') })
    parts.push(code)
  }

  const body = parts.join('\n')

  // 构建期语法检查：只编译、不执行。抓的是「到了设备上才白屏」那类错误
  try {
    // eslint-disable-next-line no-new-func
    new Function(body)
  } catch (e) {
    throw new Error('❌ 跨端层语法检查未通过（产物会让页面白屏，已中断构建）：' + e.message)
  }

  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8)

  const banner = `/*!
 * client-layer.js —— LX-MUSIC 客户端跨端业务层（自动生成，请勿直接改）
 *
 * 源码：client/rn/src/*.js（${MODULES.length} 个模块）
 * 打包：node tools/build-client-rn.mjs
 * 版本：客户端 ${CLIENT_VERSION}　构建 ${CLIENT_BUILD_ID}　指纹 ${hash}
 *
 * 这一层只在通用客户端（client/）里生效：判据是宿主注入的 window.LXNative。
 * 网页端与老壳 music-edge 里没有它，本层整个不介入 ——
 * 「同一份前端资源三宿主共用」就是靠这个判据做到的。
 */
`

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT, banner + body, 'utf8')

  const total = Buffer.byteLength(banner + body, 'utf8')
  console.log('跨端业务层已打包：' + path.relative(ROOT, OUT).replace(/\\/g, '/'))
  for (const s of sizes) {
    console.log('   ' + s.name.padEnd(16) + String(s.bytes).padStart(7) + ' B')
  }
  console.log('   ' + '合计'.padEnd(15) + String(total).padStart(7) + ' B　指纹 ' + hash)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
