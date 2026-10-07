/**
 * 插件求值探针 —— **子进程入口**。
 *
 * 为什么这件事必须在子进程里做（不是「更稳妥」，是「必须」）：
 *   有一批落雪插件是重度混淆的（自研字节码解释器），求值时会**直接把 JS 引擎搞死**
 *   —— 不抛异常、try/catch 无效、连 process.on('exit') 都不触发。实测 pdone-lx 就是。
 *   三个宿主的后果完全不同：Cloudflare 换隔离区继续跑（所以线上一直没暴露）；
 *   Android WebView 整页白屏；**Node 是进程直接退出**。
 *
 *   而「手动导入插件」是运行时行为 —— 用户粘一个地址进来，如果直接在主进程里求值，
 *   一个坏脚本就能把整台服务器的容器打死。所以主进程先把这个脚本丢进子进程摸一遍，
 *   子进程死了只死子进程。
 *
 * 结果走**临时文件**而不是 stdout：插件初始化时会自己 console.log 一大堆，
 * 和标记文案抢 stdout 会让解析失败（plugin-score 因此误判过两个能加载的插件）。
 *
 * 入参（环境变量）：LXP_ID 插件 id；LXP_SCRIPT 脚本文件路径；LXP_OUT 结果文件路径
 * 出参（写入 LXP_OUT）：{state:'ok'|'error', error}
 */
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const write = (o) => {
  try { fs.writeFileSync(process.env.LXP_OUT, JSON.stringify(o), 'utf8') } catch { /* 出口就是它，写不了也没别的办法 */ }
}

/**
 * 必须在 import 之前置位：src/plugins.js 顶层据此决定要不要自动求值内置插件。
 * 探针只关心目标那一份，把 25 个内置插件也求一遍纯属浪费（而且它们里有会崩的）。
 */
globalThis.__LX_DEFER_PLUGIN_EVAL = true

try {
  const script = fs.readFileSync(process.env.LXP_SCRIPT, 'utf8')
  const mod = await import(pathToFileURL(fileURLToPath(new URL('../src/plugins.js', import.meta.url))).href)
  const r = mod.evaluateOne({ id: process.env.LXP_ID, script, url: '', name: '' }, 'user')
  write({ state: r.ok ? 'ok' : 'error', error: r.error || null })
} catch (e) {
  write({ state: 'error', error: String((e && e.message) || e) })
}

// 显式退出：插件可能挂了一堆定时器/未决 Promise，不退出的话子进程会吊在那里等超时
process.exit(0)
