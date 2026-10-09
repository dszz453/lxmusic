/* 后端 API 客户端 */
(function (global) {
  'use strict'

  const TOKEN_KEY = 'lx.token'

  function getToken() { return U.store.get(TOKEN_KEY, '') || '' }
  function setToken(t) { U.store.set(TOKEN_KEY, t || '') }

  /**
   * 请求超时。
   *
   * 为什么必须有：`fetch` 遇到「连上了但对端不回」的中间设备会一直挂着，
   * 既不 resolve 也不 reject 也不报错。搜索页把 `searchState.loading` 当成
   * 「正在拉」的闸门，一个挂死的请求会把它永久按在 true 上 ——
   * 表现就是搜索结果区一直转圈、「上拉加载更多」永远加载不完，刷新才好。
   * 给每次请求套一个 AbortController，到点就抛错，闸门一定能放下来。
   *
   * 超时给 40s：综合搜索要并发 5 个平台，单平台服务端硬超时 7s，
   * 最坏情况（多平台轮流超时）也就 20 秒上下，40s 只会拦住真正挂死的请求。
   */
  const DEFAULT_TIMEOUT = 40000

  async function req(path, options) {
    const opts = options || {}
    const headers = Object.assign({}, opts.headers || {})
    const token = getToken()
    if (token) headers.Authorization = 'Bearer ' + token
    let body = opts.body
    if (body && typeof body !== 'string' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(body)
    }
    const ms = opts.timeout || DEFAULT_TIMEOUT
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    let res
    try {
      res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body, signal: ctrl.signal })
    } catch (e) {
      // AbortError 会因为浏览器版本不同而以不同面目出现，统一成一句人话
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
        const err = new Error('请求超时（' + Math.round(ms / 1000) + 's），请重试')
        err.timeout = true
        throw err
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('请求失败 ' + res.status))
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  /**
   * 同刻同请求合并（in-flight 单飞）。
   *
   * 为什么需要（2026-10-09 老板报「Docker 版客户端重新登录之后，我的歌单是空白、
   * 加载要半天，这时候点『我的』还显示未登录」）：
   *
   * 一次登录会**把首页渲染好几遍** —— `pageLogin` 里的 `location.hash = '#/'` 派一次
   * hashchange、`boot()` 里还有「首帧抢跑」的 `route()` 与结尾的 `await route()`。
   * 用真浏览器取证（`tools/login-flow-probe.mjs`）看到的一次登录：
   *
   *     3× /api/home        2× /api/setup-status        2× /api/version
   *
   * 而 `/api/home` 在冷缓存上要「抓榜单 + 跨 6 个音源搜 24 首」—— 三份并发就是把
   * 同一件事算三遍（那一份兜底内容还是**全站同一份**，见 src/server/api.js），
   * 自建实例上 CPU 与出网全被占住，别的请求（`/api/playlists`、`/api/me`）跟着一起卡。
   * 用户看到的就是「歌单空白转半天」「歌单页在转、我的页还没登录」。
   *
   * 为什么合并在这一层、而不是去改那几处渲染：
   * 重复的调用点分散在 pageHome / 品牌对齐 / 设置页好几处，逐个去重迟早漏一个；
   * 而「同一时刻、同一路径的同一个 GET」本来就该是同一次读。放在出口处一次说清。
   *
   * ⚠ 只合 GET，且要求**本项目的 GET 都没有副作用** —— 这是这份前端的一条约定
   * （写操作一律 POST/PATCH/DELETE：`/daily/refresh`、`/favorite`、`/progress` …）。
   * 以后若要加一个「GET 但会改数据」的接口，要么改成 POST，要么绕开 `once`。
   *
   * ⚠ 合并键是「**令牌 + 完整路径**」，不是光一个路径。
   * 只按路径合并的话，「A 退出、B 登录」那一瞬间 A 在途的请求会被 B 复用 ——
   * 这正是本项目最忌讳的串号（首页缓存专门按「服务器+账号」隔离同一个道理）。
   * 令牌换了就当成另一次读，绝不共用。
   *
   * 失败**不留存**：结束就把这条删掉，所以用户点「重试」拿到的一定是新的一次
   * 请求，不会被上一发失败钉住（这点很关键 —— 否则一次抖动会变成永久加载失败）。
   */
  const inflight = new Map()
  function once(path) {
    const token = getToken()
    const hit = inflight.get(path)
    if (hit && hit.token === token) return hit.promise
    const promise = req(path)
    const rec = { token, promise }
    inflight.set(path, rec)
    // 成败都要清：成功后再来一次是「用户主动刷新」，本就该真打一次
    const drop = () => { if (inflight.get(path) === rec) inflight.delete(path) }
    promise.then(drop, drop)
    return promise
  }

  const get = (p) => once(p)
  const post = (p, body) => req(p, { method: 'POST', body })
  const patch = (p, body) => req(p, { method: 'PATCH', body })
  const del = (p) => req(p, { method: 'DELETE' })

  global.API = {
    getToken, setToken,

    setupStatus: () => get('/setup-status'),
    // 版本号（公开接口，不需要登录）。前端设置页 / 关于页用它显示服务端版本，
    // 与本地 LX_VERSION 对比能立刻发现「App 是新版、连的是旧服务器」。
    version: () => get('/version'),
    setup: (username, password) => post('/setup', { username, password }),
    login: (username, password) => post('/login', { username, password }),
    me: () => get('/me'),
    changePassword: (oldPassword, newPassword) => post('/password', { oldPassword, newPassword }),

    search: (q, opts) => {
      const o = opts || {}
      const qs = new URLSearchParams({ q: q || '', source: o.source || '', page: String(o.page || 1), limit: String(o.limit || 30) })
      return get('/search?' + qs)
    },
    suggest: (q) => get('/suggest?q=' + encodeURIComponent(q)),
    history: () => get('/history'),
    // keyword 有值：删单条；无值：清空全部
    deleteHistory: (keyword) => del('/history' + (keyword ? '?keyword=' + encodeURIComponent(keyword) : '')),

    // 搜专辑（六平台聚合）
    searchAlbums: (q, opts) => {
      const o = opts || {}
      const qs = new URLSearchParams({
        q: q || '', source: o.source || '', page: String(o.page || 1), limit: String(o.limit || 20),
      })
      return get('/search-albums?' + qs)
    },
    // 打开专辑 = 列出曲目。kw / mg 暂不支持，接口会返回明确错误文案。
    albumTracks: (source, id, limit) => get('/album?source=' + encodeURIComponent(source || '')
      + '&id=' + encodeURIComponent(id || '') + '&limit=' + String(limit || 200)),

    home: () => get('/home'),
    dailyRefresh: () => post('/daily/refresh', {}),
    charts: () => get('/charts'),
    chart: (id, source, limit) => get('/chart?id=' + encodeURIComponent(id) + '&source=' + encodeURIComponent(source || 'wy') + '&limit=' + String(limit || 100)),
    // 榜单卡片头图（榜首单曲的专辑封面）：一次最多 8 个，客户端自己分批
    chartCovers: (refs) => get('/chart-covers?ids=' + encodeURIComponent(refs.join(','))),

    // fast=true：服务端只解析直链、不做字节探测，秒回；用于浏览器直连播放
    songUrl: (id, q, fast) => get('/url?id=' + encodeURIComponent(id) + '&q=' + encodeURIComponent(q || '320k') + (fast ? '&fast=1' : '')),
    lyric: (id) => get('/lyric?id=' + encodeURIComponent(id)),

    playlists: () => get('/playlists'),
    playlist: (id) => get('/playlist?id=' + encodeURIComponent(id)),
    createPlaylist: (name, songs) => post('/playlist', { name, songs: songs || [] }),
    importPlaylist: (url, source, name) => post('/playlist/import', { url, source, name }),
    addToPlaylist: (playlistId, songIds) => post('/playlist/add', { playlistId, songIds }),
    deletePlaylist: (id) => del('/playlist?id=' + encodeURIComponent(id)),
    removePlaylistSong: (playlistId, index) => post('/playlist/remove-song', { playlistId, index }),
    renamePlaylist: (playlistId, name) => post('/playlist/rename', { playlistId, name }),
    // 把第 from 首挪到第 to 首（0 基）。服务端按下标重排，重复歌曲也不会串位。
    movePlaylistSong: (playlistId, from, to) => post('/playlist/move', { playlistId, from, to }),

    // 第一步只返回 AI 列表 { title, songs:[{name,singer}] }；匹配与落库由 app.js 逐首完成
    // 注意：生成歌单是**用户端**能力，配置 AI 接口才是管理端的事，两者路径已经分开
    generatePlaylist: (prompt, count) => post('/ai-playlist', { prompt, count }),

    /* ---- 播放进度 / 播放历史（用户端） ---- */

    // 上报进度。played 为真表示「这一轮真的听过」（客户端判：累计够阈值或播到结尾）
    reportProgress: (id, position, duration, played) =>
      post('/progress', { id, position, duration, played: !!played }),
    // 起播前问「上次听到哪了」，返回 { progress: {position,duration,play_count,last_played_at}|null }
    playProgress: (id) => get('/progress?id=' + encodeURIComponent(id)),
    playHistory: (limit) => get('/play-history' + (limit ? '?limit=' + limit : '')),
    clearPlayHistory: (id) => del('/play-history' + (id ? '?id=' + encodeURIComponent(id) : '')),

    favorites: () => get('/favorites'),
    addFavorite: (id) => post('/favorite', { id }),
    removeFavorite: (id) => del('/favorite?id=' + encodeURIComponent(id)),

    sources: () => get('/sources'),

    /* ---- 管理端（全部走 /admin/*，服务端按前缀统一鉴权） ---- */

    adminStats: () => get('/admin/stats'),
    adminUsers: () => get('/admin/users'),
    adminCreateUser: (username, password, isAdmin) => post('/admin/users', { username, password, isAdmin }),
    adminSetPassword: (id, password) => patch('/admin/users', { id, password }),
    adminDeleteUser: (id) => del('/admin/users?id=' + encodeURIComponent(id)),
    adminPlayHistory: (limit) => get('/admin/play-history' + (limit ? '?limit=' + limit : '')),
    adminClearPlayHistory: (userId) => del('/admin/play-history?user=' + encodeURIComponent(userId)),
    // 默认搜索源读写。sources=参与搜索的平台（顺序即优先级）；order=后台列表的完整排布（含未勾选的）
    searchSources: () => get('/admin/search-sources'),
    saveSearchSources: (sources, order) => post('/admin/search-sources', order != null ? { sources, order } : { sources }),
    plugins: () => get('/admin/plugins'),
    /**
     * 导入一个音源插件到**服务端**（服务器模式下插件跑在服务端）。
     * 二选一：给 url（由服务端去下载，GitHub 地址会自动走镜像），或直接给 script 正文。
     * 失败原因（URL 不通 / 内容不像插件 / 脚本加载失败）服务端回 400 带原文，可直接展示。
     */
    importPlugin: (payload) => post('/admin/plugins/import', payload),
    /** 删除一个「用户导入」的插件。内置插件不可删，服务端会回明确的 400。 */
    deletePlugin: (id) => del('/admin/plugins/import?id=' + encodeURIComponent(id)),
    health: () => get('/admin/health'),
    // 插件评分明细 + 当前调度偏好（自动 / 人工）
    pluginScores: () => get('/admin/plugin-scores'),
    savePluginPrefs: (prefs) => post('/admin/plugin-prefs', prefs),
    /**
     * 运行时评分：查状态 / 手动触发一轮。
     *
     * **触发不是长请求**：服务端收到就回 202（已开跑），界面上按间隔轮询状态，
     * 跑完自动刷新排序表。所以这里用默认超时即可 —— 真要挂几分钟等结果的话，
     * 用户一刷新就断、反代 60s 还会掐成 504，而服务端那轮其实还在跑（见 api 侧注释）。
     *
     * 只在自托管（Docker）下可用；线上会返回 501，前端按「不支持」提示。
     */
    pluginRescoreStatus: () => get('/admin/plugin-rescore'),
    pluginRescoreNow: () => post('/admin/plugin-rescore', {}),
    aiConfig: () => get('/admin/ai-config'),
    saveAiConfig: (cfg) => post('/admin/ai-config', cfg),
    aiTest: () => post('/admin/ai-test', {}),
  }
})(window)
