/**
 * 音色（均衡器）
 *
 * 用 Web Audio 串一条 5 段 EQ：低架 → 3 个峰值 → 高架。
 * 之所以不上「更多段/更细的参数」，是因为手机小屏上没人会去调 ±12dB 的 10 段图；
 * 预设 + 一条能看懂的说明，比一个专业调音台有用。
 *
 * ⚠️ 一条必须记住的硬前提：**音源必须带 CORS 头**。
 *
 * `createMediaElementSource()` 对「跨域且响应里没有 Access-Control-Allow-Origin」
 * 的媒体，输出的是**静音** —— 不是报错、不是警告，就是没声音。
 * 用户看到的现象是「一开音效歌就不响了」，而且关掉音效也不会恢复
 * （那个 MediaElementSourceNode 一旦接上就永久接管这个 <audio> 的输出）。
 *
 * 实测（2026-10）：
 *   网易 m701.music.126.net         ACAO=*     可用
 *   酷狗 fsandroid.tx.kugou.com     ACAO=*     可用
 *   酷我 car-er.kuwo.cn             无 ACAO    ✗ 接上就是静音
 *
 * 所以：**启用前必须先做一次真实的跨域预检**（canUse），不能靠猜、也不能靠
 * 「先接上试试看」。预检做的是同源/跨域判断 + 一次不带自定义头的 GET
 * （不带自定义头才不会触发 OPTIONS 预检，否则会给没有 OPTIONS 处理的源造成误判），
 * 响应头一到就掐掉正文，不浪费流量。
 */
(function (global) {
  'use strict'

  /** 频段：两端用架式，中间用峰值。数值取常见的手机 EQ 中心频率 */
  const BANDS = [
    { f: 62, type: 'lowshelf', label: '低音' },
    { f: 250, type: 'peaking', label: '中低' },
    { f: 1000, type: 'peaking', label: '中音' },
    { f: 4000, type: 'peaking', label: '中高' },
    { f: 12000, type: 'highshelf', label: '高音' },
  ]

  /**
   * 预设。
   * gains 单位 dB，与 BANDS 一一对应。全部为 0 = 原声（不改动信号）。
   */
  const PRESETS = [
    { key: 'flat', name: '原声', desc: '不加工，关掉音效', gains: [0, 0, 0, 0, 0] },
    { key: 'pop', name: '流行', desc: '人声靠前，齿音不刺', gains: [1.5, 0.5, -0.5, 1, 2] },
    { key: 'rock', name: '摇滚', desc: '两端抬起来，鼓更实', gains: [3.5, 1.5, -1, 1.5, 3] },
    { key: 'vocal', name: '人声', desc: '突出嗓音，压掉伴奏厚度', gains: [-1.5, -0.5, 3, 2, 0.5] },
    { key: 'jazz', name: '爵士', desc: '温暖，低频松一点', gains: [2, 1.5, 0, 1, 2.5] },
    { key: 'classical', name: '古典', desc: '高低略抬，保留动态', gains: [2, 1, -1, 1.5, 2.5] },
    { key: 'bass', name: '重低音', desc: '低频大幅加强，适合电子/嘻哈', gains: [5.5, 3, 0, -1, -0.5] },
    { key: 'soft', name: '轻柔', desc: '削掉刺耳的一段，夜里听不累', gains: [-1, -0.5, 0.5, 0.5, 1.5] },
  ]

  const PRESET_BY_KEY = {}
  for (const p of PRESETS) PRESET_BY_KEY[p.key] = p

  const KEY = 'lx.tone'
  let presetKey = 'flat'
  try {
    const saved = global.U && U.store ? U.store.get(KEY, 'flat') : 'flat'
    if (PRESET_BY_KEY[saved]) presetKey = saved
  } catch { /* ignore */ }

  let audioEl = null
  let ctx = null
  let sourceNode = null
  let filters = []
  let attached = false
  let failed = false

  /** 可用性：有些老 WebView 没有 AudioContext，或者被策略禁掉 */
  function supported() {
    return !failed && !!(global.AudioContext || global.webkitAudioContext)
  }

  const preset = () => PRESET_BY_KEY[presetKey] || PRESETS[0]
  const gains = () => (PRESET_BY_KEY[presetKey] || PRESETS[0]).gains.slice()
  /** 「音效开着」= 有任意一段不是 0dB */
  const active = () => gains().some(g => Math.abs(g) > 0.01)
  const isAttached = () => attached

  /* ---------------- 跨域预检 ---------------- */

  const corsCache = new Map()

  /**
   * 这条地址能不能挂 Web Audio（跨域预检）。同源直接算通过。
   *
   * 注意这里用的是**真的 fetch**：安卓壳把 window.fetch 劫持去跑包内后端了，
   * 但只劫持 '/api/*' 开头，其它地址仍然走 WebView 自己的 fetch ——
   * 所以这个预检在壳里反映的就是 WebView 真实的跨域能力，不会误判成「可以用」。
   */
  async function canUse(url) {
    const raw = String(url || '')
    if (!raw) return false
    let origin = ''
    try { origin = new URL(raw, global.location && global.location.href).origin } catch { return false }
    if (global.location && origin === global.location.origin) return true
    if (corsCache.has(origin)) return corsCache.get(origin)

    let ok = false
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null
    try {
      // 不加自定义请求头：加了 Range 之类会触发 OPTIONS 预检，
      // 而很多音源不处理 OPTIONS，于是「明明有 ACAO」也被判成不可用。
      const r = await fetch(raw, ctrl ? { signal: ctrl.signal } : undefined)
      ok = !!(r && (r.ok || r.status === 206))
      // 只要响应头到手就够判定了，正文立刻掐掉，别把整首歌拉下来
      try { if (r && r.body && r.body.cancel) await r.body.cancel() } catch { /* ignore */ }
    } catch {
      ok = false
    } finally {
      if (timer) clearTimeout(timer)
    }
    corsCache.set(origin, ok)
    return ok
  }

  /* ---------------- 图 ---------------- */

  /**
   * 接上 <audio>。
   * 只能接一次 —— `createMediaElementSource` 对同一个元素重复调用会抛
   * InvalidStateError，而且接上之后就永久接管输出，没法「摘下来」。
   * 所以「关掉音效」的实现是把各段增益归零，而不是断开连接。
   */
  function attach(audio) {
    if (attached) return true
    if (!supported() || !audio) return false
    const AC = global.AudioContext || global.webkitAudioContext
    let node = null
    try {
      ctx = new AC()
      sourceNode = ctx.createMediaElementSource(audio)
      audioEl = audio
      node = sourceNode
      filters = BANDS.map(b => {
        const f = ctx.createBiquadFilter()
        f.type = b.type
        f.frequency.value = b.f
        f.Q.value = 1
        f.gain.value = 0
        node.connect(f)
        node = f
        return f
      })
      node.connect(ctx.destination)
      attached = true
      applyGains(PRESET_BY_KEY[presetKey].gains)
      return true
    } catch (e) {
      // 失败就彻底放弃：宁可不提供音效，也不能留下一个半接好的图把声音弄没
      try { if (node) node.disconnect() } catch { /* ignore */ }
      try { if (sourceNode) sourceNode.disconnect() } catch { /* ignore */ }
      ctx = null; sourceNode = null; filters = []; attached = false; failed = true
      console.warn('[tone] 音效不可用:', e && e.message)
      return false
    }
  }

  /**
   * 找当前那个 <audio>。
   *
   * 为什么需要这一步：调用方（app.js 的 pickTone）只知道「用户选了个音色」，
   * 并不知道引擎手里有没有音频元素。早先的实现把希望寄托在 `attach(audio)` 上，
   * 可全项目没有一处提前 attach 过 —— 于是首次选音色必然拿到 null，
   * 直接落在「音效不可用」的提示上。宁可这里多问一句 Player 要元素。
   */
  function resolveAudio() {
    if (audioEl) return audioEl
    try { if (global.Player && global.Player.audio) return global.Player.audio } catch { /* ignore */ }
    try { if (global.document) return global.document.getElementById('audio') } catch { /* ignore */ }
    return null
  }

  function applyGains(arr) {
    if (!attached) return
    for (let i = 0; i < filters.length; i++) {
      const g = Number(arr && arr[i]) || 0
      try {
        // 平滑过渡，避免切换预设时「咔」一下
        filters[i].gain.setTargetAtTime(g, ctx.currentTime, 0.02)
      } catch { filters[i].gain.value = g }
    }
  }

  /**
   * 换预设。返回 false 表示这个环境接不上 Web Audio（调用方据此提示用户）。
   * 首次调用会自动 attach。
   */
  function setPreset(key) {
    if (!PRESET_BY_KEY[key]) return false
    presetKey = key
    try { if (global.U && U.store) U.store.set(KEY, key) } catch { /* ignore */ }
    if (key !== 'flat' || attached) {
      if (!attached && !attach(resolveAudio())) {
        // 接不上就别把「选中态」留在用户眼前：回落原声，免得下次开页还显示重低音
        presetKey = 'flat'
        try { if (global.U && U.store) U.store.set(KEY, 'flat') } catch { /* ignore */ }
        return false
      }
      applyGains(PRESET_BY_KEY[key].gains)
    }
    resume()
    return true
  }

  /** 关掉音效（回到 0dB）。图保留着 —— 已经摘不下来了，归零即等效原声 */
  function reset() {
    presetKey = 'flat'
    try { if (global.U && U.store) U.store.set(KEY, 'flat') } catch { /* ignore */ }
    applyGains([0, 0, 0, 0, 0])
  }

  function resume() {
    if (!ctx) return Promise.resolve(false)
    if (ctx.state === 'running') return Promise.resolve(true)
    return ctx.resume().then(() => ctx.state === 'running').catch(() => false)
  }

  global.Tone = {
    BANDS, PRESETS,
    supported, canUse,
    attach, setPreset, reset, resume, applyGains,
    get preset() { return presetKey },
    get presetInfo() { return preset() },
    get gains() { return gains() },
    active, isAttached,
    get context() { return ctx },
  }
})(window)
