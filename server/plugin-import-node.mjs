/**
 * 子进程预筛 —— **Node 专属**，放在 server/ 下是有意的。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 求值用户导入的插件脚本可能**直接把 JS 引擎搞死**（自研字节码解释器，
 * 不抛异常、try/catch 拦不住、连 process.on('exit') 都不触发）。实测
 * `plugins/pdone-lx.js` 就是这种：主进程一求值它就没了。
 * 所以必须先在一个**子进程**里试一遍，看它会不会被打死。
 *
 * 这一招只在自托管（Node）下成立：
 *   · Cloudflare Worker —— 请求阶段禁止 new Function，本来就不支持运行时导入；
 *   · 安卓壳 —— 走的是本机 IndexedDB 那条路，插件跑在 Web Worker 里，
 *     且壳里没有 child_process。
 * 所以这段代码归 server/（和 index.mjs / plugin-eval-probe.mjs / plugin-rescore.mjs 同级），
 * **不能**放进 src/ —— src/ 会被 tools/build-app.mjs 展平成给 WebView 用的单文件 IIFE，
 * 里面出现 node: 内置模块或 import.meta 都会让整个 APK 构建/加载失败。
 *
 * 判据：src/server/plugin-import.mjs 里不能出现 `import.meta` —— 那个表达式在
 * 非模块脚本里是**语法错误**，会让打包产物一加载就炸（不是等到那行执行才炸）。
 * 本轮就栽过这一次：预筛逻辑留在用 `import.meta.url` 算 PROBE 路径，
 * bundle 一跑就报 "Cannot use 'import.meta' outside a module"。
 *
 * 用法（由 server/index.mjs 在启动时注入，见那里的 setProbeRunner）：
 *   import { probePluginInChild } from './plugin-import-node.mjs'
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-eval-probe.mjs')

/** 子进程摸底的超时。正常插件求值在百毫秒级，给到 60s 只拦「死循环/卡住」 */
const PROBE_TIMEOUT = 60000

/**
 * 在**子进程**里求值这个脚本，判断它会不会把 JS 引擎搞死。
 *
 * 判定纪律（与 tools/plugin-prescreen.mjs 一致，很重要）：
 *   只有「进程被打死 / 超时无输出」才算危险；
 *   「脚本未发送 inited 事件」「取不到远端配置」这类是**环境类**失败 ——
 *   服务器出口到不了那个站点而已，换个网络可能就是好的。这类**不算危险**，
 *   照常让主进程去求值并如实把错误显示出来。
 *
 * @returns {Promise<{state:'ok'|'error'|'crash'|'timeout', error?:string|null}>}
 */
export function probePluginInChild(id, script) {
  return new Promise((resolve) => {
    let dir = ''
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxplugin-'))
    } catch (e) {
      return resolve({ state: 'error', error: '无法创建临时目录：' + ((e && e.message) || e) })
    }
    const scriptFile = path.join(dir, 'script.js')
    const outFile = path.join(dir, 'out.json')
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，清不掉也不影响 */ } }
    try {
      fs.writeFileSync(scriptFile, script, 'utf8')
    } catch (e) {
      cleanup()
      return resolve({ state: 'error', error: '无法写入临时脚本：' + ((e && e.message) || e) })
    }

    let killed = false
    const child = spawn(process.execPath, [PROBE], {
      env: { ...process.env, LXP_ID: id, LXP_SCRIPT: scriptFile, LXP_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, PROBE_TIMEOUT)

    const done = (r) => { clearTimeout(timer); cleanup(); resolve(r) }

    child.stdout.on('data', () => { /* 插件的开机横幅，丢弃 */ })
    child.stderr.on('data', () => { /* 同上，结论走临时文件 */ })
    child.on('error', (e) => done({ state: 'crash', error: '子进程启动失败：' + ((e && e.message) || e) }))
    child.on('close', (code, signal) => {
      if (killed) return done({ state: 'timeout', error: '求值超过 ' + Math.round(PROBE_TIMEOUT / 1000) + ' 秒未结束（脚本可能有死循环）' })
      if (fs.existsSync(outFile)) {
        try { return done(JSON.parse(fs.readFileSync(outFile, 'utf8'))) } catch (e) {
          return done({ state: 'crash', error: '子进程输出无法解析：' + ((e && e.message) || e) })
        }
      }
      done({
        state: 'crash',
        error: '求值该脚本会直接把 JS 引擎搞死（子进程被杀死，exit=' + code + ' signal=' + signal + '）',
      })
    })
  })
}
