/**
 * 安卓壳桥接层 —— 让整个后端在 App 内跑起来，不依赖 Cloudflare。
 *
 * 设计要点：
 *
 * 1) **只在安卓壳里生效**。检测不到 AndroidHost 时直接返回，浏览器 / Worker
 *    侧的既有行为一点不变（同一份前端代码两端共用）。
 *
 * 2) **网络走原生**。网页发出的跨域请求会被同源策略拦（各音乐源站基本不回
 *    ACAO），所以把 globalThis.__lxFetch 换成「交给 Java 发、再回投结果」的实现。
 *    后端源码里所有出站调用都收敛在 src/lib/http.js 的 outboundFetch 一个点上，
 *    所以这一处替换就能覆盖搜索 / 取流解析 / 歌词 / 封面全部链路。
 *
 * 3) **数据走 SQLite**。globalThis.__lxDB 实现 D1 的同名接口（prepare/bind/
 *    first/all/run/batch），底下是 Java 侧的 android.database.sqlite。
 *    src/db.js 一行不用改。
 *
 * 4) **所有 API 请求都不出设备**。劫持 window.fetch，把 /api/ 开头的请求直接交给
 *    backend.bundle.js 里的 handleApi。前端 app.js / player.js / api.js
 *    全部零改动 —— 它们仍然以为自己在跟一个远端 API 说话。
 *
 *    唯一的例外见第 8 节「远程模式」：用户在设置里填了服务器地址时，/api/* 改走
 *    原生桥发往那台服务器，本机后端整体退场（数据与插件也就都回到服务器上）。
 *
 * 5) **插件交给 Worker**。内置插件不在这里求值，而是灌给 lxplugin.js，
 *    由它逐个放进独立 Web Worker —— 个别混淆脚本崩掉也只崩一个 Worker。
 *
 * 加载顺序（见 index.html，不能调换）：
 *   util.js → plugins.data.js → backend.bundle.js → native.js → api.js
 *   → lxplugin.js → player.js → app.js
 *
 * backend.bundle.js 必须在前：本文件末尾的 boot() 是同步启动的，第一件事就是
 *   自动开户（打 /api/*），那时必须已经有 window.LXBackend 供劫持层调用。
 * native.js 又必须在 api.js / player.js / app.js 之前：fetch 劫持与两个桥
 *   要在前端发起第一个请求之前装好。
 */
(function (global) {
  'use strict'

  const HOST = global.AndroidHost

  /**
   * 壳能不能播 http 音频 —— 默认 false：网页里 https 页面加载 http 音频
   * 会被浏览器当混合内容拦掉。置位后 src/lib/http.js 的 allowHttpAudio() 与
   * player.js 的 isPlayable() 都会放行 http 候选。
   * 两者都是运行时读取，所以本文件晚于 backend.bundle.js 加载也不影响。
   */
  global.LX_ALLOW_HTTP_AUDIO = false

  /** 桥不可用 → 普通浏览器环境，本文件不介入 */
  if (!HOST || typeof HOST.httpRequest !== 'function' || typeof HOST.dbQuery !== 'function') {
    global.LX_NATIVE = false
    return
  }

  global.LX_NATIVE = true
  // MainActivity 给 WebView 设了 MIXED_CONTENT_ALWAYS_ALLOW，
  // 且 <audio> 加载跨域地址本就豁免 CORS —— 所以壳里 http 直链能播、也不用代理。
  // 置位后，取流链路与 fast 解析都不再丢弃 http 候选。
  global.LX_ALLOW_HTTP_AUDIO = true

  const TOKEN_KEY = 'lx.token'      // 与 public/js/api.js 保持一致
  const CRED_KEY = 'lx.app.cred'    // 本机自动登录用的凭据
  const SEED_KEY = 'lx.app.seeded'  // 内置插件预置版本
  const SEED_VER = '1'
  /**
   * 每条请求在**原生侧**的读超时（随请求发给 Java，用作 connect / read timeout）。
   * 它同时是原生侧「整条请求含全部重定向跳」的总预算。
   */
  const HTTP_TIMEOUT = 30000

  /**
   * 页面侧的等待上限 —— 必须**比原生侧晚到**，两者别再合成一个常量。
   *
   * 早先两者都是 30000，而这里的计时是「请求发出」那一刻就开始跑的
   * （下面 entry.timer 在塞进 pendingHttp 之前就装好了），**排队时间照样算进去**。
   * 于是几乎总是页面先到点，抛出一句
   *
   *     桥请求超时: /api/playlists
   *
   * 把原生侧真正的原因（连接超时 / 读超时 / 连不上 / 重定向过多 / 桥太忙）全盖住了。
   * 老板 2026-10-09 截图报的就是这句 —— 而那个接口在服务端只是一条 SQLite 查询，
   * 慢的根本不是接口。
   *
   * 现在页面侧留 5 秒余量：正常情况原生侧会带着明确文案先回投；
   * 只有原生侧整个没动静（进程被杀、线程池真卡死）才由这里兜底。
   */
  const HTTP_GUARD = HTTP_TIMEOUT + 5000
  const SERVER_KEY = 'lx.serverBase'  // 非空 = 远程模式（见第 8 节）
  // 远程模式判定要在 fetch 劫持之前就定下来（劫持层每次请求现读它），
  // 所以放在常量区；readServerBase 是函数声明，会提升，这里能直接调。
  const serverBase = readServerBase()
  global.LX_REMOTE = !!serverBase
  global.LX_REMOTE_BASE = serverBase

  function log(msg) {
    try { HOST.log('LXB', String(msg)) } catch { /* 日志失败不影响主流程 */ }
  }

  /* ================= 1. HTTP 桥 ================= */

  const pendingHttp = new Map()
  let httpSeq = 0

  /**
   * Java 侧回投入口。Java 用 evaluateJavascript 调 window.__LXB_HTTP(id, json)。
   * payload: {status, headers, body, enc, url, error}
   */
  global.__LXB_HTTP = function (id, payloadJson) {
    const p = pendingHttp.get(id)
    if (!p) return
    pendingHttp.delete(id)
    if (p.timer) clearTimeout(p.timer)
    let pl
    try { pl = JSON.parse(payloadJson) } catch (e) {
      p.reject(new Error('桥回投数据解析失败'))
      return
    }
    if (pl.error) {
      p.reject(new Error(pl.error))
      return
    }
    const headers = pl.headers || {}
    try {
      if (pl.enc === 'base64') {
        const bin = atob(pl.body || '')
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        p.resolve(new Response(bytes, { status: pl.status || 200, headers }))
      } else {
        p.resolve(new Response(pl.body == null ? '' : pl.body, { status: pl.status || 200, headers }))
      }
    } catch (e) {
      p.reject(e)
    }
  }

  function headersToObject(h) {
    const out = {}
    if (!h) return out
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach((v, k) => { out[k] = v })
      return out
    }
    for (const k of Object.keys(h)) out[k] = String(h[k])
    return out
  }

  function bodyToString(body) {
    if (body == null) return null
    if (typeof body === 'string') return body
    // lxruntime 里可能传 FormData，退化成 urlencoded（本项目插件基本只用 form）
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const sp = new URLSearchParams()
      body.forEach((v, k) => sp.append(k, v))
      return sp.toString()
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString()
    try { return JSON.stringify(body) } catch { return String(body) }
  }

  /**
   * fetch 兼容的出站实现：交给 Java 发请求，天然不受同源策略约束
   */
  function bridgeFetch(input, opts) {
    const o = opts || {}
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    const method = String(o.method || (input && input.method) || 'GET').toUpperCase()
    const headers = headersToObject(o.headers)
    const signal = o.signal || (input && input.signal) || null

    if (signal && signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

    return new Promise((resolve, reject) => {
      const id = 'h' + (++httpSeq)
      const entry = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        if (!pendingHttp.has(id)) return
        pendingHttp.delete(id)
        // 走到这里说明原生侧整个没回话（进程被杀 / 线程池真卡死）——
        // 正常的超时、连不上、重定向过多、桥忙，都由 Java 带着明确文案先回投，
        // 见 HTTP_GUARD 上方那段说明。
        reject(new Error('桥请求超时: ' + url))
      }, HTTP_GUARD)
      pendingHttp.set(id, entry)

      // 接住 AbortSignal：api.js 给每个请求套了 40s 超时（AbortController），
      // 不接的话「服务端连上了但不回」这种情况会一直挂着，那层超时形同虚设。
      // 注意桥本身没有「取消在途请求」的能力，这里只是把 Promise 就地失败掉。
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => {
          const e = pendingHttp.get(id)
          if (!e) return
          pendingHttp.delete(id)
          if (e.timer) clearTimeout(e.timer)
          e.reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      }

      const payload = JSON.stringify({
        url,
        method,
        headers,
        body: bodyToString(o.body),
        timeout: HTTP_TIMEOUT,
      })

      try {
        HOST.httpRequest(id, payload)
      } catch (e) {
        pendingHttp.delete(id)
        clearTimeout(entry.timer)
        reject(e)
      }
    })
  }

  // 后端源码唯一出口（src/lib/http.js 的 outboundFetch 读这个）
  global.__lxFetch = bridgeFetch

  /** 给前端直接用的桥（封面等图片走这条路，或在 App 里干脆直连） */
  global.LXBridge = { fetch: bridgeFetch }

  /* ================= 2. SQLite 桥（D1 兼容层） ================= */

  function rowsOf(sql, args) {
    const raw = HOST.dbQuery(sql, JSON.stringify(args || []))
    return JSON.parse(raw || '[]')
  }

  function makeStmt(sql, args) {
    return {
      bind() {
        return makeStmt(sql, Array.prototype.slice.call(arguments))
      },
      async first() {
        const rows = rowsOf(sql, args)
        return rows.length ? rows[0] : null
      },
      async all() {
        return { results: rowsOf(sql, args) }
      },
      async run() {
        const changes = HOST.dbExec(sql, JSON.stringify(args || []))
        return { success: true, changes: typeof changes === 'number' ? changes : 0 }
      },
      // 调试用：batch 需要能拿到原始 SQL
      __sql: sql,
      __args: args,
    }
  }

  globalThis.__lxDB = {
    prepare(sql) { return makeStmt(sql, []) },
    async batch(stmts) {
      const out = []
      for (const s of stmts) {
        if (s && typeof s.run === 'function') out.push(await s.run())
      }
      return out
    },
  }

  /* ================= 3. 插件池适配器（转发到 LXP） ================= */

  /**
   * 同一首歌的取址结果缓存 —— 合并并发、并供后续调用复用。
   *
   * 为什么必须有这一层：
   *   后端 `musicUrlCandidateList()` 会为「每个插件 × 每个音源」各建一个候选，
   *   而 `LXP.resolveMusicUrl(song, quality)` 内部是**遍历整个插件池**去解析的 ——
   *   它不接受「只用某个插件」这个约束。于是 10 个候选会并发发起 10 次完全相同的
   *   全池解析，全部挤在同一条原生桥上互相拖慢。冷启动实测就是这个形态：
   *   单个候选看似只要 0.9s，10 个并发却 3.5s 还没出结果。
   *
   * 所以这里按「歌曲 + 音质」合并：同一首歌只解析一次，其余候选共享同一个 promise。
   * TTL 给 5 分钟 —— 源站直链一般几十分钟有效，而取流本身还有三级兜底，
   * 过期后重新解析即可，不会把用户卡在一条死链上。
   */
  const resolveCache = new Map()
  const RESOLVE_TTL = 5 * 60 * 1000
  const RESOLVE_CACHE_MAX = 60

  function resolveMusicUrlShared(musicInfo, quality) {
    // 用整个 musicInfo 序列化当键，而不是挑 songmid/hash 之类字段 ——
    // 各音源的主键字段名不同（songmid / hash / rid / copyrightId），挑错就是缓存串号。
    let key
    try { key = quality + '|' + JSON.stringify(musicInfo) } catch { return global.LXP.resolveMusicUrl(musicInfo, quality) }

    const now = Date.now()
    const hit = resolveCache.get(key)
    if (hit) {
      if (hit.pending) return hit.pending
      if (now - hit.at < RESOLVE_TTL) return Promise.resolve(hit.value)
      resolveCache.delete(key)
    }

    const pending = global.LXP.resolveMusicUrl(musicInfo, quality).then(
      (v) => {
        if (resolveCache.size > RESOLVE_CACHE_MAX) {
          for (const k of Array.from(resolveCache.keys()).slice(0, RESOLVE_CACHE_MAX / 2)) resolveCache.delete(k)
        }
        resolveCache.set(key, { at: Date.now(), value: v })
        return v
      },
      (e) => { resolveCache.delete(key); throw e },
    )
    resolveCache.set(key, { at: now, pending })
    return pending
  }

  /**
   * 用户调度偏好（自动 / 人工），管理员在「音源与插件」页设的，存设备内 SQLite。
   *
   * 壳里没有构建机那套实测评分表（插件在**设备上**跑，出口和构建机完全不同，
   * 拿构建机的分数来排壳里的顺序是本末倒置），所以这里只实现「用户说了算」：
   *   · 自动模式 —— 保持 LXP 的原始顺序
   *   · 人工模式 —— 用户排过的按用户顺序，没排到的按原顺序垫后
   *   · disabled —— 两种模式都生效
   * 这是用户明确要的「单机版也要能选源」。
   */
  let userPrefs = { mode: 'auto', order: {}, disabled: [] }

  /**
   * src/providers/index.js 期望的 pluginPool 形状。
   * 这里全部转发到 lxplugin.js 的 LXP —— 插件在 Worker 里跑，崩了也不影响页面。
   */
  const lxpPool = {
    summary() {
      const list = (global.LXP && typeof global.LXP.summary === 'function') ? global.LXP.summary() : []
      return list.map(p => ({
        id: p.id,
        name: p.name,
        ok: !!p.ready,
        error: p.error || null,
        sources: p.sources || [],
      }))
    },
    qualityMap() { return [] },
    /**
     * 候选插件顺序。注意调用方（providers/index.js）会把返回的每一项原样回传给
     * invokePlugin，而壳里真正解析地址走的是「合并后的共享结果」（见下），
     * 所以这里返回的 id 只用于**顺序与归因**，不用于限定执行。
     */
    musicUrlPlugins(source, action) {
      if (!this.supports(source, action)) return []
      let list = this.summary()
        .filter(p => p.ok && p.sources.indexOf(source) >= 0)
        .map(p => ({ id: p.id, name: p.name }))

      const disabled = new Set(userPrefs.disabled || [])
      if (disabled.size) list = list.filter(p => !disabled.has(p.id))

      const manual = userPrefs.mode === 'manual' ? (userPrefs.order || {})[source] : null
      if (manual && manual.length) {
        const rank = new Map(manual.map((id, i) => [id, i]))
        const pos = new Map(list.map((p, i) => [p.id, i]))
        const MAX = Number.MAX_SAFE_INTEGER
        list = list.slice().sort((a, b) => {
          const ra = rank.has(a.id) ? rank.get(a.id) : MAX
          const rb = rank.has(b.id) ? rank.get(b.id) : MAX
          return (ra - rb) || (pos.get(a.id) - pos.get(b.id))
        })
      }
      return list
    },
    /** 后端 /api/plugin-prefs 保存后调这里，让设置即时生效 */
    setUserPrefs(prefs) {
      const p = (prefs && typeof prefs === 'object') ? prefs : {}
      userPrefs = {
        mode: p.mode === 'manual' ? 'manual' : 'auto',
        order: (p.order && typeof p.order === 'object') ? p.order : {},
        disabled: Array.isArray(p.disabled) ? p.disabled : [],
      }
      return {
        mode: userPrefs.mode,
        disabled: userPrefs.disabled.length,
        manualSources: Object.keys(userPrefs.order).length,
      }
    },
    async invokePlugin(plugin, source, action, payload) {
      // 本项目里插件只被用于取流；歌词走 /api/lyric 的原生实现
      if (action !== 'musicUrl') return { ok: false, value: null, plugin: plugin && plugin.id }
      try {
        // 注意：resolveMusicUrl 不接受「只用某个插件」，它自己遍历池子。
        // 所以调用方给的 plugin 只用于归因展示，实际解析走合并后的共享结果。
        const r = await resolveMusicUrlShared(payload.musicInfo, payload.type)
        return { ok: !!r.url, value: r.url || null, plugin: (plugin && plugin.name) || '客户端插件' }
      } catch (e) {
        return { ok: false, value: null, plugin: (plugin && plugin.id) || null, error: String((e && e.message) || e) }
      }
    },
    supports(source, action) {
      try {
        return !!(global.LXP && typeof global.LXP.supports === 'function' && global.LXP.supports(source, action))
      } catch { return false }
    },
  }

  /* ================= 4. /api/* 本地路由 ================= */

  const env = {
    DB: globalThis.__lxDB,
    PLUGIN_POOL: lxpPool,
    SESSION_SECRET: 'lxmusic-app-local-secret',
    APP_MODE: true,
  }

  async function localCall(pathWithQuery, init) {
    if (!global.LXBackend || typeof global.LXBackend.handleApi !== 'function') {
      throw new Error('backend.bundle.js 未加载')
    }
    const url = 'http://app.local' + pathWithQuery
    const req = new Request(url, init || {})
    return global.LXBackend.handleApi(req, env, new URL(url))
  }

  /** 内部调用：不经过 bootstrap 门闸，避免自己等自己 */
  async function apiJson(path, init) {
    const res = await localCall(path, init)
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('请求失败 ' + res.status))
      err.status = res.status
      throw err
    }
    return data
  }

  let releaseBootstrap = null
  const bootstrapPromise = new Promise(resolve => { releaseBootstrap = resolve })

  const origFetch = global.fetch ? global.fetch.bind(global) : null

  global.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || ''
    if (u.indexOf('/api/') === 0 || u === '/api') {
      if (serverBase) {
        // 远程模式：转给用户配置的那台服务器，走原生桥（见第 8 节：页面 origin 是
        // 那个「假域名」，跨域 fetch 会被同源策略拦掉，而对方多半没配 ACAO）。
        // 注意 init 里带 signal 时 bridgeFetch 会接住 abort，api.js 的 40s 超时依然有效。
        return bootstrapPromise.then(() => bridgeFetch(serverBase + u, init))
      }
      // 先等本机账号就绪，否则首屏会被判定成「未初始化」而跳去设置页
      return bootstrapPromise.then(() => localCall(u, init))
    }
    if (origFetch) return origFetch(input, init)
    return Promise.reject(new Error('fetch 不可用: ' + u))
  }

  /* ================= 5. 本机账号：自动初始化 + 自动登录 ================= */

  function randomPassword() {
    const bytes = new Uint8Array(16)
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2)
    return 'lx' + s
  }

  function readCred() {
    try { return JSON.parse(global.localStorage.getItem(CRED_KEY) || 'null') } catch { return null }
  }
  function writeCred(c) {
    try { global.localStorage.setItem(CRED_KEY, JSON.stringify(c)) } catch { /* ignore */ }
  }
  /**
   * 注意：token 必须按 U.store 的约定存取 —— public/js/util.js 里的 store.set 会
   * JSON.stringify、store.get 会 JSON.parse。这里图省事直接塞裸字符串的话，
   * api.js 的 getToken() 会在 JSON.parse 时抛错并回落成空串，表现为「明明登录了
   * 却一直跳登录页」。所以这里显式做同样的编解码。
   */
  function saveToken(t) {
    try { global.localStorage.setItem(TOKEN_KEY, JSON.stringify(t || '')) } catch { /* ignore */ }
  }
  function loadToken() {
    try {
      const raw = global.localStorage.getItem(TOKEN_KEY)
      if (raw == null) return ''
      const v = JSON.parse(raw)
      return typeof v === 'string' ? v : ''
    } catch { return '' }
  }

  /**
   * 单机 App 里的用户系统没有存在意义（没有第二个人用、也没有服务端可同步），
   * 但后端接口是按多用户写的。所以这里做一次「静默开户」：
   * 首次启动建一个本机账号并把凭据留在设备上，之后自动登录。
   * 用户看不到登录页，也不用记密码。
   */
  async function ensureAccount() {
    // 已有可用 token 就直接用
    if (loadToken()) {
      try {
        await apiJson('/api/me')
        return
      } catch { saveToken('') }
    }

    const status = await apiJson('/api/setup-status')
    let cred = readCred()

    if (status.needsSetup) {
      cred = { username: 'local', password: randomPassword() }
      const r = await apiJson('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: cred.username, password: cred.password }),
      })
      writeCred(cred)
      saveToken(r.token)
      log('本机账号已创建')
      return
    }

    // 库里已有账号：用存下来的凭据登录；凭据丢了就留给用户手动登录
    if (cred && cred.username && cred.password) {
      try {
        const r = await apiJson('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: cred.username, password: cred.password }),
        })
        saveToken(r.token)
        return
      } catch (e) {
        log('自动登录失败：' + ((e && e.message) || e))
      }
    }
    log('需要手动登录（凭据已失效）')
  }

  /* ================= 6. 内置插件预置（交给 Worker） ================= */

  async function seedPlugins() {
    if (!global.LXP || typeof global.LXP.importFromText !== 'function') return
    const data = global.LX_PLUGIN_DATA
    if (!Array.isArray(data) || !data.length) return
    if (global.localStorage.getItem(SEED_KEY) === SEED_VER) return

    log(`开始预置内置插件 ${data.length} 个`)
    const BATCH = 4   // 一批 4 个 Worker：太少慢，太多在同一台手机上会抢资源
    let ok = 0
    for (let i = 0; i < data.length; i += BATCH) {
      const slice = data.slice(i, i + BATCH)
      const rs = await Promise.all(slice.map(it =>
        global.LXP.importFromText(it.script, it.url || ('builtin:' + it.id))
          .then(r => { ok++; return r })
          .catch(e => { log(`插件导入失败 ${it.id}: ${(e && e.message) || e}`); return null })
      ))
      // 让出主线程，避免导入过程把首屏交互卡住
      await new Promise(r => setTimeout(r, 0))
      if (!rs.some(Boolean) && i === 0 && slice.length === data.length) break
    }
    log(`内置插件预置完成：${ok}/${data.length}`)
    try { global.localStorage.setItem(SEED_KEY, SEED_VER) } catch { /* ignore */ }
  }

  /* ================= 8. 远程模式（手机端服务器地址可配置） ================= */

  /**
   * 壳里默认「自包含」：后端跑在设备内（包内 backend.bundle.js + SQLite），一个字节
   * 都不出设备。但这带来两个绕不开的代价：
   *   · 数据只在这台手机上，换机 / 重装即清空；
   *   · 插件在手机上跑，冷启动要建 Worker 链（首次点歌实测 ~3s）。
   * 于是给一个开关：把后端换成自己那台服务器（CF Worker / Docker / 反代出来的地址），
   * 壳退化成一个纯客户端 —— 数据在服务器上、插件在服务器上跑，手机只管取流和播放。
   *
   * 两处关键取舍：
   *
   * 1) **远程请求走原生桥，不走 WebView 的 fetch。**
   *    页面 origin 是那个「假域名」（https://music.zyplnn.dpdns.org，内容由 APK 供给），
   *    而用户填的服务器是另一个域 —— 跨域 fetch 会被同源策略拦掉，除非服务器配合回
   *    ACAO。走桥就是原生发请求，既不用改服务器，也不用管对方有没有配 CORS。
   *
   * 2) **切换地址 = 存下配置 + 整页重载。**
   *    不做「热切换」：两套后端意味着 token、插件池、缓存、播放队列全都要换一套，
   *    热切换的状态残留比重新加载一次贵得多。重载顺手也把残留清干净了。
   */
  function readServerBase() {
    try {
      const raw = global.localStorage.getItem(SERVER_KEY)
      if (raw == null) return ''
      const v = JSON.parse(raw)
      return typeof v === 'string' ? v.trim() : ''
    } catch { return '' }
  }

  function writeServerBase(v) {
    try { global.localStorage.setItem(SERVER_KEY, JSON.stringify(v || '')) } catch { /* ignore */ }
  }

  /**
   * 登录用户名（可选），与服务器地址配成一对连接参数。
   *
   * 只是个**预填值**，不参与鉴权 —— 存它的目的只有一个：登录页把用户名自动带上，
   * 免得每次指向自建服务器都得手输一遍。空串 = 没配，登录页保持空白。
   * 编解码口径与 token 一致（U.store 的 JSON 约定），裸字符串读出来会带引号。
   */
  const SERVER_USER_KEY = 'lx.serverUser'

  function readServerUser() {
    try {
      const raw = global.localStorage.getItem(SERVER_USER_KEY)
      if (raw == null) return ''
      const v = JSON.parse(raw)
      return typeof v === 'string' ? v.trim() : ''
    } catch { return '' }
  }

  function writeServerUser(v) {
    try { global.localStorage.setItem(SERVER_USER_KEY, JSON.stringify(String(v || '').trim())) } catch { /* ignore */ }
  }

  /**
   * 把用户随手写的东西归一成基址：
   *   `192.168.1.9:8080` → `http://192.168.1.9:8080`
   *   `music.abc.com`    → `https://music.abc.com`
   *   `https://a.com/api/` → `https://a.com`
   * 没写协议时的判据：IP / localhost / 单段名 → http（内网基本不会配证书）；
   * 其余（含点的域名）→ https。带端口不参与判断，否则 `a.com:8443` 会被误判成 http。
   */
  function normalizeServer(input) {
    let s = String(input == null ? '' : input).trim().replace(/\s+/g, '')
    if (!s) return ''
    if (!/^https?:\/\//i.test(s)) {
      const host = s.split('/')[0].split(':')[0]
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      const isLocal = /^localhost$/i.test(host) || host.indexOf('.') < 0
      s = (isIp || isLocal ? 'http://' : 'https://') + s
    }
    s = s.replace(/\/+$/, '')
    s = s.replace(/\/api$/i, '')       // 顺手吃掉多写的 /api
    return s
  }

  /**
   * 连通性自检：问一次 /api/setup-status。
   * 走原生桥，所以只要手机能连上就一定能过 —— 不会出现「因为跨域被拦」
   * 这种跟网络无关的假失败。返回值里带耗时，方便判断是慢还是不通。
   */
  async function testServer(input) {
    const base = normalizeServer(input)
    if (!base) return { ok: false, error: '地址为空' }
    const t0 = Date.now()
    try {
      const res = await bridgeFetch(base + '/api/setup-status')
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch { /* 不是 JSON，下面按失败处理 */ }
      if (!res.ok) return { ok: false, base, error: '服务器返回 HTTP ' + res.status }
      if (!data || typeof data.needsSetup === 'undefined') {
        return { ok: false, base, error: '这个地址不是本应用的服务端' }
      }
      return {
        ok: true, base, ms: Date.now() - t0,
        needsSetup: !!data.needsSetup,
        // 版本对不上时后端可能少接口，先如实告诉用户，别让人猜
        version: data.version || '',
      }
    } catch (e) {
      return { ok: false, base, error: (e && e.message) || String(e) }
    }
  }

  /**
   * 存下连接参数（地址 + 可选用户名）。地址为空串 = 回本机模式，此时用户名一并清掉
   * —— 本机模式没有「登录别的账号」这回事，留着只会误导。
   */
  function setServer(input, user) {
    const base = normalizeServer(input)
    writeServerBase(base)
    writeServerUser(base ? user : '')
    // 换服务器 = 换了一整套账号体系，旧 token 留着只会让首屏白跳一次登录。
    // 改用户名同理：那是「换个人用」，沿用旧 token 反而让人以为切换没生效。
    saveToken('')
    return base
  }

  if (serverBase) log('远程模式 → ' + serverBase)

  /* ================= 9. 启动 ================= */

  function boot() {
    if (serverBase) {
      /**
       * 远程模式：账号、数据、插件都在服务器那一侧，本机什么都不用预置。
       * 尤其**不能**再跑 ensureAccount() —— 那会拿本机的 setup-status 建一个
       * `local` 账号，把「服务器上还没有账号，请先创建管理员」这件事悄悄盖掉。
       * 这里直接放行 /api/*，让前端走它正常的初始化 / 登录页。
       */
      releaseBootstrap()
      return
    }
    ensureAccount()
      .catch(e => log('账号初始化失败：' + ((e && e.message) || e)))
      .then(() => {
        releaseBootstrap()          // 放行所有 /api/* 请求
        return waitForLxp()
      })
      .then(() => {
        /**
         * 预置内置插件是「后台工程」，不该和首屏抢主线程。
         *
         * 24 个插件要逐个起 Web Worker、求值 542 KB 混淆脚本，还要写 localStorage ——
         * 在这一步直接跑，正好和首页的渲染撞在一起，表现就是「首页转好几秒才出来」
         * 「点开我的歌单要等十秒」。插件晚几秒可用不影响听歌（用户从打开到点播放
         * 至少也要这么久），所以延到主线程空闲时再做。
         * 没有 requestIdleCallback 的老 WebView 退回定时器 —— 一样是「等首屏先画」。
         */
        const run = () => seedPlugins()
          .catch(e => log('插件预置异常：' + ((e && e.message) || e)))
        if (typeof global.requestIdleCallback === 'function') {
          global.requestIdleCallback(run, { timeout: 5000 })
        } else {
          global.setTimeout(run, 2500)
        }
      })
  }

  function waitForLxp(timeout = 8000) {
    const start = Date.now()
    return new Promise(resolve => {
      const tick = () => {
        if (global.LXP && typeof global.LXP.importFromText === 'function') return resolve()
        if (Date.now() - start > timeout) return resolve()
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  // 暴露给前端做「App 模式」分支判断与手动重试
  global.LXApp = {
    isNative: true,
    isRemote: !!serverBase,
    get serverBase() { return serverBase },
    pool: lxpPool,
    env,
    log,
    ready: bootstrapPromise,
    reseedPlugins() {
      try { global.localStorage.removeItem(SEED_KEY) } catch { /* ignore */ }
      return seedPlugins()
    },
    /* —— 服务器地址（第 8 节）：`/api/*` 换成自己那台服务器 —— */
    normalizeServer,
    testServer,
    get serverUser() { return readServerUser() },
    /** 存连接参数并整页重载（地址空串 = 回本机模式；user 是可选的登录用户名预填值） */
    applyServer(input, user) {
      const base = setServer(input, user)
      // 稍等一下再重载：让调用方把 toast 画出来，用户看得见「正在切换」
      setTimeout(() => {
        /**
         * 重载前先把 hash 抹掉。
         *
         * 换服务器等于换了一整套账号体系，而 hash 是**跟着 URL 活过重载的** ——
         * 不清掉的话，上一套后端的视图状态会被原样带到新后端上。最典型的一种：
         * 在远程模式下停在 `#/setup`（那台服务器还没建管理员），切回本机模式后
         * 仍然渲染「初始化」页，说「数据库还是空的，先创建一个管理员账号吧」，
         * 可本机账号明明早就有了，真去点「创建并进入」还会被服务端拒掉。
         *
         * 用 replaceState 而不是 `location.hash = ''`：后者只改片段、浏览器视作
         * 同页跳转，反而不会触发我们要的那次重载，还会先惊动一遍路由。
         */
        try {
          global.history.replaceState(null, '', global.location.pathname + global.location.search)
        } catch { /* 沙箱里可能禁 history，那也不影响下面的 reload */ }
        try { global.location.reload() } catch { /* ignore */ }
      }, 400)
      return base
    },
  }

  /* ================= 10. 原生媒体会话（通知栏 / 锁屏 / 控制中心 / 耳机按键） ================= */

  /**
   * 让系统知道「这个 App 正在放什么」。
   *
   * 网页版这件事是靠 navigator.mediaSession 做的（见 player.js 里的 updateMediaSession），
   * 但 **Android WebView 没有实现这套 W3C API** —— `'mediaSession' in navigator` 恒为
   * false。所以在装上原生媒体层之前，壳里一直只是「一条写着『正在播放』的静态通知」：
   * 没有封面、没有进度、没有上一首/下一首，锁屏、控制中心和蓝牙耳机按键全都控制不了。
   *
   * 这里把同一件事改走原生：状态推给 AndroidHost.mediaReport，按键由 Java 侧
   * MediaSession 的回调再调回 window.__nativeMedia.onCommand。页面只负责「如实汇报」，
   * 通知长什么样、系统媒体卡片怎么画，全由原生决定 —— 一份状态一个来源，不两边各写一套。
   *
   * 只在真的播过第一首之后才开始上报：不然一进 App 就冒出一张「暂停中」的媒体卡片，
   * 用户没点过播放却先看到通知，会以为程序在自己乱跑。
   */
  const MEDIA_MIN_INTERVAL = 900      // 位置类上报的最小间隔（毫秒）
  const MEDIA_HEARTBEAT = 3000        // 兜底心跳：有些机型后台会把 timeupdate 拉得很稀

  let mediaArmed = false
  let mediaLastAt = 0
  let mediaLastSig = ''
  let mediaLastPos = -1
  let mediaInstalled = false
  let mediaPushTotal = 0
  let mediaLastPushAt = 0
  let mediaSkipReason = ''

  function mediaCover(song) {
    if (!song) return ''
    try {
      // 壳里 U.coverUrl 不走 /api/cover 代理，直接给源地址（原因见 util.js 的 coverProxy）
      if (global.U && typeof U.coverUrl === 'function') return U.coverUrl(song, 500) || ''
    } catch { /* 下面是兜底 */ }
    return song.img || ''
  }

  function mediaSnapshot() {
    const P = global.Player
    const song = (P && typeof P.current === 'function') ? P.current() : null
    const a = P && P.audio
    const queue = (P && P.state && P.state.queue) || []

    // 时长优先用解码出来的真实值；还没 loadedmetadata 时先退回曲目自带的 interval，
    // 否则通知栏一上来是一条「没有长度」的进度，看着像卡住了
    let dur = 0
    if (a && isFinite(a.duration) && a.duration > 0) dur = a.duration
    else if (song && song.interval) dur = Number(song.interval) || 0

    return {
      track: !!song,
      title: (song && song.name) || '',
      artist: (song && song.singer) || '',
      album: (song && song.albumName) || '',
      cover: mediaCover(song),
      duration: Math.round(dur * 1000),          // 原生侧一律毫秒
      position: a ? Math.round((a.currentTime || 0) * 1000) : 0,
      playing: !!(P && P.playing),
      index: (P && typeof P.index === 'number') ? P.index : -1,
      total: queue.length,
    }
  }

  function mediaPush(force) {
    if (!global.Player || typeof HOST.mediaReport !== 'function') {
      mediaSkipReason = !global.Player ? 'Player 还没就绪' : '这版 APK 没有 mediaReport 接口'
      return
    }

    const s = mediaSnapshot()
    if (!mediaArmed) {
      if (!s.playing) { mediaSkipReason = '还没播过第一首'; return }
      mediaArmed = true
      force = true                // 第一声必须立刻报，晚了通知里是空的
    }

    const now = Date.now()
    if (!force && now - mediaLastAt < MEDIA_MIN_INTERVAL) { mediaSkipReason = '节流中'; return }

    const sig = [s.track, s.title, s.artist, s.album, s.cover, s.playing, s.index, s.total]
      .join('\u0001')
    // 暂停且什么都没变就不用重复报；但位置变过（拖了进度、续播跳位）得补一条
    if (!force && !s.playing && sig === mediaLastSig && s.position === mediaLastPos) {
      mediaSkipReason = '暂停且无变化'
      return
    }

    mediaLastAt = now
    mediaLastSig = sig
    mediaLastPos = s.position
    mediaSkipReason = ''
    try {
      HOST.mediaReport(JSON.stringify(s))
      mediaPushTotal++
      mediaLastPushAt = now
    } catch (e) {
      mediaSkipReason = '上报抛异常：' + ((e && e.message) || e)
    }
  }

  function installMediaSession() {
    const P = global.Player
    if (!P || mediaInstalled) return
    mediaInstalled = true

    /**
     * 系统按键入口。Java 侧 MediaSession 的 onPlay / onPause / onSkipToNext /
     * onSkipToPrevious / onSeekTo 全收口到这里。
     *
     * 一律调 Player 的公开方法，不直接摆弄 audio 元素 —— 队列推进、随机与单曲模式、
     * 播放记录落库、续播点写入都挂在那些方法上，绕过它们就会出现
     * 「通知栏切的歌不计入播放历史」这类不一致。
     */
    global.__nativeMedia = {
      onCommand(cmd, arg) {
        try {
          switch (cmd) {
            case 'play': P.play(); break
            case 'pause': P.pause(); break
            case 'toggle': P.toggle(); break
            case 'next': P.next(true); break
            case 'prev': P.prev(true); break
            case 'stop': P.pause(); break
            case 'seek': {
              const a = P.audio
              const dur = (a && isFinite(a.duration)) ? a.duration : 0
              // 原生侧给的是毫秒，<audio>.currentTime 要秒
              if (a && dur > 0) a.currentTime = Math.max(0, Math.min(dur, (Number(arg) || 0) / 1000))
              break
            }
            default: break
          }
        } catch (e) {
          log('媒体命令失败 ' + cmd + '：' + ((e && e.message) || e))
        }
        mediaPush(true)
      },
    }

    // 切歌 / 队列变化 / 播放态变化：立刻同步，不等心跳
    P.on('song', () => mediaPush(true))          // 队列清空时这里报 track:false，原生据此收摊
    P.on('queue', () => mediaPush(true))
    P.on('state', () => mediaPush(true))
    P.on('quality', () => mediaPush(true))

    const a = P.audio
    if (a) {
      a.addEventListener('timeupdate', () => mediaPush(false))
      a.addEventListener('loadedmetadata', () => mediaPush(true))
      a.addEventListener('seeked', () => mediaPush(true))
      a.addEventListener('ended', () => mediaPush(true))
    }

    setInterval(() => { if (mediaArmed) mediaPush(false) }, MEDIA_HEARTBEAT)
    log('原生媒体会话已装配')
  }

  /**
   * 诊断：把「页面侧看到的」与「原生侧看到的」并成一份。
   *
   * 「通知栏 / 锁屏控制不了」这句话背后可能是五六个完全不同的原因（页面没装配、
   * 服务没起来、通知权限没给、系统通知总开关关了、startForeground 抛异常……），
   * 而开发机没有安卓运行时、只能看设备上到底卡在哪一层。设置页把这份摊开，
   * 用户截个图就够定位了。
   */
  function mediaDiag() {
    const out = {
      js: {
        installed: mediaInstalled,
        armed: mediaArmed,
        pushes: mediaPushTotal,
        lastPushAgoMs: mediaLastPushAt ? Date.now() - mediaLastPushAt : -1,
        skip: mediaSkipReason,
        covered: !!mediaCover((global.Player && typeof global.Player.current === 'function')
          ? global.Player.current() : null),
      },
    }
    try {
      if (HOST && typeof HOST.mediaStatus === 'function') out.host = JSON.parse(HOST.mediaStatus())
      else out.host = { ok: false, error: '这版 APK 里没有 mediaStatus（装的很可能是旧包）' }
    } catch (e) {
      out.host = { ok: false, error: String((e && e.message) || e) }
    }
    return out
  }

  /** 立刻按当前状态补一次上报（设置页的「测试上报」按钮） */
  function mediaWake() {
    mediaPush(true)
    return mediaPushTotal
  }

  global.__lxMediaDiag = mediaDiag
  global.__lxMediaWake = mediaWake

  function waitForPlayer(timeout = 15000) {    const start = Date.now()
    return new Promise(resolve => {
      const tick = () => {
        if (global.Player && typeof global.Player.on === 'function') return resolve(global.Player)
        if (Date.now() - start > timeout) return resolve(null)
        setTimeout(tick, 120)
      }
      tick()
    })
  }

  boot()

  // player.js 在本文件之后加载，所以媒体会话只能等它出现再接
  waitForPlayer()
    .then(installMediaSession)
    .catch(e => log('媒体会话装配失败：' + ((e && e.message) || e)))
})(window)
