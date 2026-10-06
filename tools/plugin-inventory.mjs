/**
 * 插件能力盘点：求值 plugins/*.js，输出每个插件声明支持的音源与动作。
 *
 * 为什么要子进程隔离：pdone-lx 这类重度混淆脚本在求值时会直接把 JS 引擎搞死
 * （不抛异常、try/catch 无效）。放在同一进程里会让整次盘点无输出。
 *
 * 用法：
 *   node tools/plugin-inventory.mjs            # 盘点本地 plugins/ 缓存
 *   node tools/plugin-inventory.mjs --json     # 只输出 JSON
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PLUGIN_DIR = path.join(ROOT, 'plugins')
const NODE = process.execPath

const CHILD = `
import fs from 'node:fs'
import { evaluatePluginAtStartup } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'lib', 'lxruntime.js')).href)}
const file = process.argv[1]
const script = fs.readFileSync(file, 'utf8')
let r
try {
  r = evaluatePluginAtStartup('probe', script, {})
} catch (e) {
  r = { ok: false, error: String((e && e.message) || e) }
}
process.stdout.write('__JSON__' + JSON.stringify({
  ok: !!r.ok,
  error: r.error || null,
  meta: r.meta || null,
  sources: r.sources || null,
}))
`

const files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).sort()
const inventory = []

for (const f of files) {
  const full = path.join(PLUGIN_DIR, f)
  const res = spawnSync(NODE, ['--input-type=module', '-e', CHILD, full], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  })
  let parsed = null
  const out = (res.stdout || '')
  const idx = out.indexOf('__JSON__')
  if (idx >= 0) {
    try { parsed = JSON.parse(out.slice(idx + 8)) } catch { /* ignore */ }
  }
  const crashed = !parsed
  inventory.push({
    file: f,
    ok: parsed ? parsed.ok : false,
    crashed,
    status: res.status,
    signal: res.signal,
    error: parsed ? parsed.error : ((res.stderr || '').trim().split('\n').slice(-2).join(' ') || '进程未返回结果（可能崩溃）'),
    name: parsed && parsed.meta ? parsed.meta.name : '',
    version: parsed && parsed.meta ? parsed.meta.version : '',
    sources: (parsed && parsed.sources) || null,
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(inventory, null, 2))
} else {
  // 汇总所有插件声明支持的源
  const sourceMap = new Map()
  for (const it of inventory) {
    for (const key of Object.keys(it.sources || {})) {
      const actions = (it.sources[key] && it.sources[key].actions) || []
      if (!sourceMap.has(key)) sourceMap.set(key, [])
      sourceMap.get(key).push(`${it.file}${actions.length ? '[' + actions.join(',') + ']' : ''}`)
    }
  }

  console.log('===== 插件逐个结果 =====')
  for (const it of inventory) {
    const mark = it.ok ? 'OK  ' : (it.crashed ? '崩溃' : '失败')
    const srcs = it.sources ? Object.keys(it.sources).join(',') : '-'
    console.log(`${mark} ${it.file.padEnd(24)} ${(it.name || '').padEnd(14)} v${it.version || '?'}  源: ${srcs}`)
    if (!it.ok) console.log(`       └ ${String(it.error).slice(0, 140)}`)
  }

  console.log('\n===== 音源覆盖汇总 =====')
  const keys = [...sourceMap.keys()].sort()
  for (const k of keys) {
    console.log(`${k.padEnd(6)} (${sourceMap.get(k).length} 个插件): ${sourceMap.get(k).join(' | ')}`)
  }
}
