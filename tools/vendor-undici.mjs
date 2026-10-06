/**
 * 把 undici 从本地 node_modules 拷进 `vendor/undici/`，供 Docker 镜像直接 COPY。
 *
 * ── 为什么要有这一步 ─────────────────────────────────────────────
 * server/outbound-pool.mjs 靠 `import('undici')` 拿 Agent 来做出站连接复用。
 * 开发机上能 import 成功，是因为 wrangler 把 undici 作为间接依赖装进了 node_modules
 * —— 那是**假象**：node:22-slim 镜像里没有 node_modules，三条路全部失败
 * （`undici` / `node:undici` / `node:internal/deps/undici/undici` 实测都不行）。
 *
 * 而「在 Dockerfile 里 npm install undici」这条路在本项目也走不通：
 * package.json 带着 win32 专用的 devDependency（@cloudflare/workerd-windows-64），
 * 在 linux 上 npm 解析整棵树时会直接 `EBADPLATFORM` 报错退出。
 *
 * 于是：用这个脚本把 undici **拷进仓库**（2.1MB、纯 JS、零 dependencies、无原生模块），
 * Dockerfile 里 `COPY vendor/undici ./node_modules/undici` 就完事。
 * 好处是构建**完全离线**、不依赖 npm registry 或任何镜像站可达性、逐字节可复现。
 *
 * ── 什么时候要重跑 ───────────────────────────────────────────────
 * 升级 undici 时（`npm i -D undici@latest` 后重跑本脚本）。
 * 平时不用管：产物已进仓库，CI 与本地构建都不需要它。
 *
 * 用法：
 *   node tools/vendor-undici.mjs           拷贝并校验
 *   node tools/vendor-undici.mjs --check   只校验，不写（CI 可用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'node_modules', 'undici')
const DST = path.join(ROOT, 'vendor', 'undici')
const CHECK_ONLY = process.argv.includes('--check')

/** 递归拷贝，跳过无用的大件（docs / 类型声明 / 测试），只留运行时需要的。 */
const SKIP_DIRS = new Set(['docs', 'test', 'types', 'scripts', '.github', 'node_modules'])
const SKIP_FILES = new Set(['README.md', 'LICENSE'])

function copyDir(from, to, stats) {
  fs.mkdirSync(to, { recursive: true })
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name)
    const d = path.join(to, ent.name)
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      copyDir(s, d, stats)
    } else {
      // 只留 .js / .json / .mjs —— .d.ts 与 README 对运行时没用，白占体积
      const ext = path.extname(ent.name)
      if (!['.js', '.mjs', '.json'].includes(ext)) continue
      if (SKIP_FILES.has(ent.name)) continue
      fs.copyFileSync(s, d)
      stats.files++
      stats.bytes += fs.statSync(d).size
    }
  }
}

function walk(dir) {
  let n = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += walk(path.join(dir, ent.name))
    else n++
  }
  return n
}

if (!fs.existsSync(SRC)) {
  console.error('✗ 找不到 node_modules/undici —— 先跑 `npm install`（wrangler 会把它带进来）')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies || {})
if (deps.length) {
  console.error('✗ undici 竟然有运行时依赖：' + deps.join(', ') + ' —— 不能直接拷，得改方案')
  process.exit(1)
}

if (CHECK_ONLY) {
  if (!fs.existsSync(DST)) {
    console.error('✗ vendor/undici 不存在 —— 跑 node tools/vendor-undici.mjs 生成')
    process.exit(1)
  }
  const have = JSON.parse(fs.readFileSync(path.join(DST, 'package.json'), 'utf8'))
  console.log('✓ vendor/undici 就位：' + have.version + '，' + walk(DST) + ' 个文件')
  if (have.version !== pkg.version) {
    console.error('✗ 版本不一致：vendor=' + have.version + ' node_modules=' + pkg.version
      + ' —— 重跑 node tools/vendor-undici.mjs')
    process.exit(1)
  }
  process.exit(0)
}

fs.rmSync(DST, { recursive: true, force: true })
const stats = { files: 0, bytes: 0 }
copyDir(SRC, DST, stats)

// 体积哨兵：突然变大说明拷多了（比如把 docs 带进来了），提醒一下而不是硬失败
const mb = stats.bytes / 1024 / 1024
console.log(`✓ 已拷贝 undici ${pkg.version} → vendor/undici/`)
console.log(`  ${stats.files} 个文件，${mb.toFixed(2)} MB`)
if (mb > 4) console.warn('  ⚠ 比预期（~2.1MB）大不少，检查 SKIP_DIRS 是不是漏了什么')
if (fs.existsSync(path.join(DST, 'index.js'))) {
  console.log('  ✓ index.js 在（Dockerfile 的 COPY 目标正确）')
} else {
  console.error('  ✗ 缺 index.js —— 拷贝结构不对，Dockerfile 里 import(\'undici\') 会找不到')
  process.exit(1)
}
