/**
 * 运行时插件评分 —— 「按时间间隔自动评分，或者手动触发」这条需求的落点。
 *
 * ── 它解决什么问题 ───────────────────────────────────────────────
 * `tools/plugin-score.mjs` 一直只能人手工跑，产物是**构建期写死的常量**
 * （src/generated/plugin-rank.js）。于是有两件事做不到：
 *
 *   ① 用户自己 Docker 部署的实例，吃的是**我构建机上**的评分 ——
 *      但插件能不能取到流、快不快，恰恰取决于**用户自己的网络出口**。
 *      同一个插件在我这儿 100% 成功，在用户那儿的运营商网络下可能全超时。
 *   ② 插件上游会变（站点挂了、换域名、加验证），评分应该跟着变，
 *      而不是等我重新发一版镜像才更新。
 *
 * 所以这里让服务**自己**定期实测一遍，结果落库、运行时生效。
 *
 * ── 三条硬约束（都踩过或差点踩到）────────────────────────────────
 *
 *  1. **必须子进程隔离。** 有的插件求值时会直接杀死 JS 引擎（不抛异常、catch 不住，
 *     见 src/generated/plugin-skip.js）。评分要挨个求值 24 个插件，
 *     在服务主进程里跑 = 随机把正在放歌的服务打死。所以走 `spawn` 子进程。
 *
 *  2. **绝不能阻塞请求路径。** 一轮几分钟，还要真打各音乐平台。
 *     全程后台跑，且同一时间只允许一轮（`running` 闸）——
 *     手动点两次「立即重评」不能起两个评分进程互相抢带宽、互相打架。
 *
 *  3. **失败不能影响服务。** 评分失败（网络不通、超时、子进程被杀）就是「这次没测成」，
 *     保留上一次的结果继续用，绝不能因此让服务报错或重启。
 *
 * ── 结果存哪、怎么生效 ────────────────────────────────────────────
 *   存：D1/SQLite settings 一行 JSON（键 `plugin.rank`），列表太长所以另存 `plugin.scores` 摘要。
 *   生效：装进 `pluginPool.setRank()`，与构建期那份完全同一个接口 —— 取流链路无感知。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCORER = path.join(ROOT, 'tools', 'plugin-score.mjs')

/** 结果在库里的键。前缀 plugin. 与既有的 plugin.prefs 一致 */
export const RANK_SETTING = 'plugin.rank'
export const SCORES_SETTING = 'plugin.scores'
/** 上次评分结束时的状态摘要（成功/失败/耗时），管理端要显示 */
export const STATUS_SETTING = 'plugin.rescore.status'

/** 一轮评分的最长时限。超了就杀掉子进程 —— 它可能卡在某个不可达的源站上 */
const RUN_TIMEOUT = 20 * 60 * 1000

/**
 * 解析「多久评一轮」。
 *
 * 支持写法（大小写不敏感，值可以带单位也可以裸写秒数）：
 *   off / 0 / never  → 关闭自动评分（仍可手动触发）
 *   12h / 1d / 6h    → 12 小时 / 1 天 / 6 小时
 *   30m              → 30 分钟
 *   1800             → 裸数字当秒
 *
 * 默认 1d：一天一轮。为什么不是更密 —— 每轮都会真打各音乐平台（十几到几十次请求），
 * 对免费音源站是有成本的，而插件上游的变化频率本来也是「天」级而不是「小时」级。
 * 想更密/更疏都由 LX_SCORE_INTERVAL 一个变量说了算，不用改代码。
 *
 * @returns {number} 间隔毫秒；0 表示关闭
 */
export function parseInterval(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
  if (!s) return 24 * 60 * 60 * 1000          // 默认 1 天
  if (s === 'off' || s === 'never' || s === '0') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(s)
  if (!m) return 24 * 60 * 60 * 1000          // 写错了就当默认，别因此关掉功能
  const n = Number(m[1])
  const unit = m[2] || 's'
  const table = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }
  const ms = n * table[unit]
  // 太短没意义（一轮本身就要几分钟），给个 5 分钟下限免得把源站打挂
  return ms < 5 * 60 * 1000 ? 5 * 60 * 1000 : ms
}

/** 人话描述间隔，给界面用 */
export function describeInterval(ms) {
  if (!ms) return '已关闭（仅手动）'
  const d = Math.round(ms / 86400000 * 100) / 100
  if (d >= 1) return '每 ' + (Number.isInteger(d) ? d : d.toFixed(2)) + ' 天'
  const h = Math.round(ms / 3600000 * 100) / 100
  if (h >= 1) return '每 ' + (Number.isInteger(h) ? h : h.toFixed(2)) + ' 小时'
  return '每 ' + Math.round(ms / 60000) + ' 分钟'
}

/**
 * 跑一轮评分（子进程）。
 *
 * @param {{dataDir?: string, timeout?: number, only?: string[], sources?: string[], onLog?: (s: string) => void}} [opts]
 * @returns {Promise<{ok: boolean, payload?: object, error?: string, elapsedMs: number, stdout?: string}>}
 *          永不 reject —— 调用方只需要看 ok
 */
export function runScoring(opts = {}) {
  const dataDir = opts.dataDir || process.env.LX_DATA_DIR || ROOT
  const timeout = opts.timeout || RUN_TIMEOUT
  const t0 = Date.now()

  // 结果与临时文件一律放数据卷：镜像里的 tools/ 属主是 root，容器以 node 运行写不进去
  const outFile = path.join(dataDir, '.rescore-result.json')
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch { /* 交给子进程报错 */ }
  try { fs.unlinkSync(outFile) } catch { /* 没有更好，避免读到上一轮的 */ }

  const args = [SCORER, '--ephemeral', '--json=' + outFile]
  if (opts.only && opts.only.length) args.push('--only=' + opts.only.join(','))
  if (opts.sources && opts.sources.length) args.push('--sources=' + opts.sources.join(','))

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        // LXP_DATA_DIR 让评分脚本把探针缓存与子进程回报也放进数据卷
        env: { ...process.env, LXP_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ ok: false, error: '无法启动评分进程：' + String((e && e.message) || e), elapsedMs: Date.now() - t0 })
    }

    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch { /* 已经退了 */ }
    }, timeout)

    const feed = (chunk, sink) => {
      const s = String(chunk)
      if (sink === 'out') stdout += s
      else stderr += s
      // 只在最后 4000 字符里留痕：评分跑完会有几十行报表，全留着没意义
      if (sink === 'out' && stdout.length > 8000) stdout = stdout.slice(-4000)
      if (sink === 'err' && stderr.length > 8000) stderr = stderr.slice(-4000)
      if (opts.onLog) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLog(line.trim())
    }
    child.stdout.on('data', (c) => feed(c, 'out'))
    child.stderr.on('data', (c) => feed(c, 'err'))

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: '评分进程出错：' + String((e && e.message) || e), elapsedMs: Date.now() - t0 })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - t0

      /**
       * 先看结果文件在不在，再看退出码 —— 顺序很关键。
       *
       * 子进程正常跑完会自己写 outFile 并以 0 退出；但**被信号打死**（某个插件
       * 把 JS 引擎搞崩，这正是评分走子进程的原因）时 code 是 null、signal 有值，
       * 而这时结果文件通常还没写。
       *
       * 反过来，如果文件**已经写好了**，那就说明评分本身跑完了，
       * 之后进程才因为别的原因非零退出（比如某个插件残留的定时器把 stdio 弄断了）——
       * 这种情况下结果仍然可用，不该白扔一轮十几分钟的实测。
       */
      let payload = null
      let readErr = null
      try {
        payload = JSON.parse(fs.readFileSync(outFile, 'utf8'))
      } catch (e) {
        readErr = e
      }

      if (payload && payload.ok) {
        try { fs.unlinkSync(outFile) } catch { /* 无所谓 */ }
        return resolve({ ok: true, payload, elapsedMs, stdout, stderr })
      }

      if (killed) {
        return resolve({
          ok: false,
          error: '评分超时（超过 ' + Math.round(timeout / 60000) + ' 分钟）已被中止',
          elapsedMs, stdout, stderr,
        })
      }

      return resolve({
        ok: false,
        error: signal
          ? '评分进程被信号 ' + signal + ' 终止（多半是某个插件求值时把 JS 引擎搞崩了）'
          : '评分未产出结果（退出码 ' + code + '）'
            + (readErr ? '，读取失败：' + String((readErr && readErr.message) || readErr).slice(0, 80) : ''),
        elapsedMs, stdout, stderr,
      })
    })
  })
}

/* ============================ 调度器 ============================ */

/**
 * 评分调度器 —— 定时自动跑 + 手动触发，同一时间只跑一轮。
 *
 * 为什么不写成 setInterval 一把梭：这里要处理的事比「到点调一次」多得多 ——
 *  · 上一轮还没跑完就到点了，不能再起一轮（会互相抢带宽、把源站打挂）；
 *  · 服务刚起来时不该立刻跑（启动已经很忙，而且多半刚部署完，评分刚跑过）；
 *  · 容器被 stop 时要能干净地停掉定时器（不然 SIGTERM 之后还挂在后台）；
 *  · 手动触发的优先级高于定时，且要能立刻反馈「已经在跑了」而不是排队。
 *
 * 所以做成一个小状态机，把「现在能不能跑」和「下一轮什么时候」分开表达。
 */
export function createScheduler({ dataDir, intervalMs, apply, store, log = () => {} }) {
  const state = {
    intervalMs,
    running: false,
    lastRunAt: null,       // 上次**结束**时间（毫秒时间戳）
    lastOk: null,
    lastError: null,
    lastElapsedMs: null,
    lastTrigger: null,     // 'manual' | 'auto' | 'startup'
    rounds: 0,
    nextAt: null,
    timer: null,
    stopped: false,
  }

  const now = () => Date.now()

  function planNext(delayMs) {
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    if (state.stopped || !state.intervalMs) { state.nextAt = null; return }
    // unref：定时器不该拖着进程不让它退（容器 stop 时要能立刻结束）
    const wait = Math.max(5000, delayMs == null ? state.intervalMs : delayMs)
    state.nextAt = now() + wait
    state.timer = setTimeout(tick, wait)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  async function tick() {
    await run('auto')
    // 无论成功失败都按固定间隔安排下一轮 ——
    // 失败时若改成「退避重试」会越拖越久，而失败本身常常是「用户网络临时不通」，
    // 下一轮正常间隔再试一次就够了。
    planNext()
  }

  /**
   * 跑一轮。**永远不 reject、永远不抛** —— 评分是附加能力，
   * 它出问题绝不能把正在服务的主进程带下水。
   *
   * @param {'manual'|'auto'|'startup'} trigger
   * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, error?: string, elapsedMs?: number}>}
   */
  async function run(trigger = 'manual') {
    if (state.stopped) return { ok: false, skipped: true, reason: '调度器已停止' }
    if (state.running) {
      // 手动触发撞上正在跑的一轮：如实告诉调用方，而不是排队等（用户会以为卡住了）
      return { ok: false, skipped: true, reason: '已有一轮评分正在进行中' }
    }
    state.running = true
    state.lastTrigger = trigger
    const t0 = now()
    log('[rescore] 开始评分（' + trigger + '），子进程隔离运行…')

    let result
    try {
      result = await runScoring({ dataDir, onLog: (l) => log('[rescore] ' + l) })
    } catch (e) {
      result = { ok: false, error: String((e && e.stack) || e), elapsedMs: now() - t0 }
    }

    state.running = false
    state.lastRunAt = now()
    state.lastElapsedMs = result.elapsedMs
    state.lastOk = !!result.ok
    state.lastError = result.ok ? null : (result.error || '未知错误')
    state.rounds++

    if (result.ok && result.payload) {
      try {
        await apply(result.payload)
        log('[rescore] 完成：平台 ' + Object.keys(result.payload.rank || {}).length
          + ' 个，耗时 ' + Math.round(result.elapsedMs / 1000) + 's，已生效')
      } catch (e) {
        // 「评分成功但落库失败」要单独说清楚 —— 否则用户看到分数没变会以为评分没跑
        state.lastOk = false
        state.lastError = '评分成功但写入失败：' + String((e && e.message) || e)
        log('[rescore] ' + state.lastError)
      }
    } else {
      log('[rescore] 失败：' + state.lastError + '（保留上一次的结果）')
    }

    try { if (store) await store.writeStatus(snapshot()) } catch { /* 状态写不进去不影响评分结果 */ }

    return { ok: !!result.ok, error: result.ok ? undefined : state.lastError, elapsedMs: result.elapsedMs }
  }

  /** 给接口/界面看的一份快照 */
  function snapshot() {
    return {
      intervalMs: state.intervalMs,
      intervalText: describeInterval(state.intervalMs),
      running: state.running,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      lastOk: state.lastOk,
      lastError: state.lastError,
      lastElapsedMs: state.lastElapsedMs,
      lastTrigger: state.lastTrigger,
      rounds: state.rounds,
      nextAt: state.nextAt ? new Date(state.nextAt).toISOString() : null,
      stopped: state.stopped,
    }
  }

  /**
   * 启动调度。
   *
   * @param {{firstDelayMs?: number}} [opts] firstDelayMs 给 0 就立刻跑一轮
   *   （手动模式/测试用）；默认不立刻跑 —— 服务刚起、还在加载插件，
   *   而且用户多半刚部署完（评分刚跑过），没必要马上再压一轮。
   */
  function start(opts = {}) {
    state.stopped = false
    if (!state.intervalMs) {
      log('[rescore] 自动评分已关闭（LX_SCORE_INTERVAL=off），仍可在管理端手动触发')
      return snapshot()
    }
    const first = opts.firstDelayMs == null ? state.intervalMs : opts.firstDelayMs
    planNext(first)
    log('[rescore] 自动评分已启用：' + describeInterval(state.intervalMs)
      + '，首轮 ' + Math.round(first / 1000) + 's 后')
    return snapshot()
  }

  /** 容器 stop 时调用：清掉定时器，让进程能立刻退出 */
  function stop() {
    state.stopped = true
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    state.nextAt = null
  }

  return { run, start, stop, snapshot, get running() { return state.running } }
}
