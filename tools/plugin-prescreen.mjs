#!/usr/bin/env node
/**
 * 插件预筛：找出「求值就会杀死 JS 引擎」的内置插件，产出 src/generated/plugin-skip.js。
 *
 * ── 为什么必须做 ─────────────────────────────────────────────
 * 有些落雪插件是重度混淆的（自研字节码解释器），求值时会**直接把 JS 引擎搞死**：
 * 不抛异常、try/catch 无效、连 process.on('exit') 都不触发。实测 pdone-lx 就是这样。
 *
 * 三个宿主对此的容忍度完全不同：
 *   · Cloudflare Worker —— 顶层求值，隔离区被搞死就换一个继续跑，服务整体不受影响，
 *     表现只是「这个插件永远不就绪」。所以线上一直没事，问题被平台盖住了。
 *   · Android WebView —— 整个 App 白屏。
 *   · **Node（Docker）—— 进程直接退出**，容器起不来。
 *
 * 所以 Docker 版必须在**主进程之外**先摸清哪些能安全求值，再在主进程里求值剩下的。
 * 这里就是那次「摸底」：一个插件一个子进程，崩了只崩子进程。
 *
 * ── 一条重要的判定纪律 ───────────────────────────────────────
 * **只把「进程被信号打死 / 无输出」算崩溃，其它一律不算。**
 * 「脚本未发送 inited 事件」这类是环境类失败 —— 插件初始化时要拉远端配置，
 * 构建机的出口到不了，在用户的服务器上可能是好的。把它们也拉黑，
 * 等于凭构建机的网络替用户删插件，那是错的（这条在 tools/plugin-score.mjs 里也踩过）。
 *
 * 用法：
 *   node tools/plugin-prescreen.mjs           摸底并写入 src/generated/plugin-skip.js
 *   node tools/plugin-prescreen.mjs --check   只摸底，不改文件（退出码非 0 表示有崩溃项）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(ROOT, 'src', 'generated', 'plugin-skip.js')
const TMP_DIR = path.join(__dirname, '.prescreen-tmp')
const CHECK_ONLY = process.argv.includes('--check')

/**
 * 子进程脚本。
 *
 * 结果走**临时文件**而不是 stdout：插件初始化时会自己 console.log 一大堆东西，
 * 和标记文案抢 stdout 会让解析失败（plugin-score 就因此误判过两个能加载的插件）。
 */
const CHILD_SRC = `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const write = (o) => { try { fs.writeFileSync(process.env.LXP_OUT, JSON.stringify(o), 'utf8') } catch {} }
globalThis.__LX_DEFER_PLUGIN_EVAL = true
const mod = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'src', 'plugins.js'))}).href)
const item = mod.PLUGIN_MANIFEST.find(p => p.id === process.env.LXP_ID)
if (!item) { write({ state: 'missing' }); process.exit(0) }
// 静音插件的开机横幅，只看结论
const noop = () => {}
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = noop
let r
try { r = mod.evaluateOne(item) }
catch (e) { write({ state: 'error', error: String((e && e.message) || e) }); process.exit(0) }
write({ state: r.ok ? 'ok' : 'error', error: r.error || null })
`

/**
 * 探一个插件。
 *
 * ⚠️ 用**异步 spawn** 而不是 spawnSync —— 在 Windows 上从正在运行的 node 里
 * spawnSync 同一个 node.exe 会直接 `EBUSY`（文件被占用），25 个插件会在 1 秒内
 * 全部「假崩溃」。异步 spawn 没这个问题。
 */
function probe(item) {
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const out = path.join(TMP_DIR, `${item.id}.json`)
  try { fs.unlinkSync(out) } catch { /* 无所谓 */ }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SRC], {
      env: { ...process.env, LXP_ID: item.id, LXP_OUT: out },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.on('data', () => { /* 插件的开机横幅，丢弃 */ })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 90000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ state: 'crash', error: '子进程启动失败: ' + e.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (fs.existsSync(out)) {
        try {
          const j = JSON.parse(fs.readFileSync(out, 'utf8'))
          if (j.state === 'ok' || j.state === 'error') return resolve(j)
          return resolve({ state: 'crash', error: '子进程没有得出有效结论' })
        } catch { /* 落到下面 */ }
      }
      // 没写出结果 = 没走完 = 引擎被打死
      const last = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || ''
      resolve({
        state: 'crash',
        error: signal
          ? `求值时进程被信号 ${signal} 终止`
          : (code ? `进程异常退出 status=${code}${last ? ' — ' + last.slice(0, 120) : ''}` : '求值无输出'),
      })
    })
  })
}

async function main() {
  globalThis.__LX_DEFER_PLUGIN_EVAL = true
  const { PLUGIN_MANIFEST } = await import(pathToFileURL(path.join(ROOT, 'src', 'plugins.js')).href)

  console.log(`[prescreen] 逐个求值 ${PLUGIN_MANIFEST.length} 个内置插件（每个一个子进程）\n`)
  const results = []
  for (const item of PLUGIN_MANIFEST) {
    const r = await probe(item)
    results.push({ id: item.id, name: item.name || item.id, ...r })
    const mark = r.state === 'ok' ? '✓ 可用' : (r.state === 'crash' ? '✗ 崩溃' : '· 加载失败')
    console.log(`  ${mark}  ${item.id}${r.error ? '  — ' + String(r.error).slice(0, 70) : ''}`)
  }

  const crashes = results.filter(r => r.state === 'crash')
  const loadErrors = results.filter(r => r.state === 'error')
  console.log(`\n[prescreen] 可用 ${results.filter(r => r.state === 'ok').length}`
    + `，崩溃 ${crashes.length}，加载失败（环境类，保留）${loadErrors.length}`)

  if (CHECK_ONLY) {
    process.exit(crashes.length ? 1 : 0)
  }

  const body = `/**
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
 * 生成时间：${new Date().toISOString()}
 * 生成环境：Node ${process.version} / ${process.platform}-${process.arch}
 */
export const PLUGIN_SKIP = ${JSON.stringify(crashes.map(r => r.id), null, 2)}

/** 免得出名单是空的时候有人以为文件坏了 */
export const PLUGIN_SKIP_META = {
  generatedAt: ${JSON.stringify(new Date().toISOString())},
  node: ${JSON.stringify(process.version)},
  platform: ${JSON.stringify(process.platform + '-' + process.arch)},
  loadErrors: ${JSON.stringify(loadErrors.map(r => r.id))},
}
`
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, body, 'utf8')
  console.log(`[prescreen] 已写入 ${path.relative(ROOT, OUT_FILE)}：跳过 ${JSON.stringify(crashes.map(r => r.id))}`)
}

main().catch((e) => {
  console.error('[prescreen] 失败:', (e && e.stack) || e)
  process.exit(1)
})
