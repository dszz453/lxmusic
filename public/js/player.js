/**
 * 播放器内核
 *  - HTMLAudioElement 封装：队列 / 播放模式 / 音质 / 进度 / 歌词
 *  - 取流策略：服务端 /api/stream（同源代理，规避跨域与防盗链）
 *              失败后退回浏览器端落雪插件直链
 *  - 通过 Player.on(evt, fn) 向 UI 层广播状态
 */
(function (global) {
  'use strict'

  const $ = U.$
  const TOKEN = () => API.getToken()

  const MODES = [
    { key: 'order', name: '顺序播放' },
    { key: 'loop', name: '列表循环' },
    { key: 'single', name: '单曲循环' },
    { key: 'random', name: '随机播放' },
  ]

  const QUALITIES = [
    { key: '128k', name: '标准 128k' },
    { key: '320k', name: '高清 320k' },
    { key: 'flac', name: '无损 FLAC' },
    { key: 'flac24bit', name: 'Hi-Res' },
  ]

  const MODE_ICON = {
    order: '<path d="M4 6h13M4 12h13M4 18h9"/>',
    loop: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 11.5V10a3.5 3.5 0 0 1 3.5-3.5h13.2"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H3.8"/>',
    single: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 11.5V10a3.5 3.5 0 0 1 3.5-3.5h13.2"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12.5V14a3.5 3.5 0 0 1-3.5 3.5H3.8"/><path d="M11.2 10.6l1.6-.9v4.6"/>',
    random: '<path d="M16 3.2h5v5"/><path d="M21 3.2L3.6 20.6"/><path d="M21 15.8v5h-5"/><path d="M15.2 15.2l5.8 5.6"/><path d="M3.6 3.4l5.6 5.4"/>',
  }

  const audio = $('#audio')
  const dom = {
    view: $('#view'),
    mini: $('#miniplayer'),
    miniProgress: $('#miniProgress i'),
    miniCover: $('#miniCover'),
    miniTitle: $('#miniTitle'),
    miniArtist: $('#miniArtist'),
    miniPlay: $('#miniPlay'),
    miniPlayIcon: $('#miniPlayIcon'),
    player: $('#player'),
    playerBg: $('#playerBg'),
    playerCover: $('#playerCover'),
    playerTitle: $('#playerTitle'),
    playerArtist: $('#playerArtist'),
    navTitle: $('#playerNavTitle'),
    navArtist: $('#playerNavArtist'),
    progressRange: $('#progressRange'),
    progressFill: $('#progressFill'),
    progressThumb: $('#progressThumb'),
    curTime: $('#curTime'),
    totalTime: $('#totalTime'),
    playIcon: $('#playIcon'),
    qualityLabel: $('#qualityLabel'),
    favIcon: $('#favIcon'),
    btnMode: $('#btnMode'),
    footer: $('#playerResolvedBy'),
    lyricScroll: $('#lyricScroll'),
    stage: $('#playerStage'),
    lyricCalVal: $('#lyricCalVal'),
    lyricCalMinus: $('#lyricCalMinus'),
    lyricCalPlus: $('#lyricCalPlus'),
  }

  /**
   * 歌词偏移（秒）。正值 = 歌词**延后**点亮。
   *
   * 为什么需要它：歌词该在「声音到耳朵」的那一刻点亮，但可测量的只有
   * `audio.currentTime`，它描述的是**解码位置**，不是出声位置。
   * 中间隔着音频输出缓冲；蓝牙耳机还要再叠一层编解码延迟（实测 200~400ms）。
   * 网页里没有任何 API 能读到这段延迟，只能让用户按自己耳朵校准一次。
   *
   * 默认 0 = 严格按 LRC 时间戳点亮（不做任何提前/延后）。
   * 早期实现写死「提前 150ms」，叠上设备延迟后歌词会明显比声音早 ——
   * 表现就是「还没唱到就亮了」。
   */
  const LYRIC_DELAY_MAX = 3        // 上限 ±3s，足够覆盖蓝牙耳机与到题外接音箱
  const LYRIC_DELAY_STEP = 0.2
  let lyricDelay = Number(U.store.get('lx.lyricDelay', 0)) || 0
  if (!(lyricDelay >= -LYRIC_DELAY_MAX && lyricDelay <= LYRIC_DELAY_MAX)) lyricDelay = 0

  const state = {
    queue: U.store.get('lx.queue', []) || [],
    index: -1,
    playing: false,
    loading: false,
    mode: U.store.get('lx.mode', 'order'),
    quality: U.store.get('lx.quality', '320k'),
    source: 'server',       // server | plugin
    lyric: null,            // { lyric, tlyric }
    lines: [],              // [{ t, text, sub }]
    lineIndex: -1,
    seeking: false,
    favorites: new Set(),
  }
  if (!MODES.some(m => m.key === state.mode)) state.mode = 'order'
  if (!QUALITIES.some(q => q.key === state.quality)) state.quality = '320k'

  /* ---------------- 事件 ---------------- */

  const listeners = {}
  function on(evt, fn) {
    (listeners[evt] || (listeners[evt] = [])).push(fn)
    return () => {
      const arr = listeners[evt]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }
  function emit(evt, payload) {
    for (const fn of (listeners[evt] || []).slice()) {
      try { fn(payload) } catch (e) { console.error('[player] listener error', e) }
    }
  }

  /* ---------------- 队列 ---------------- */

  const current = () => state.queue[state.index] || null

  function persist() {
    U.store.set('lx.queue', state.queue.slice(0, 300))
    U.store.set('lx.index', state.index)
  }

  /** 用一整个列表替换队列并播放第 startIndex 首 */
  function playList(list, startIndex = 0) {
    const songs = (list || []).filter(s => s && s.id)
    if (!songs.length) { U.toast('没有可播放的歌曲'); return }
    state.queue = songs
    state.index = Math.max(0, Math.min(startIndex, songs.length - 1))
    persist()
    emit('queue', state.queue)
    load(true)
  }

  /** 播放单曲：若已在本队列中则跳转，否则插入到当前之后 */
  function playSong(song) {
    if (!song || !song.id) return
    const at = state.queue.findIndex(s => s.id === song.id)
    if (at >= 0) {
      state.index = at
      persist()
      load(true)
      emit('queue', state.queue)
      return
    }
    if (state.index < 0) {
      state.queue.unshift(song)
      state.index = 0
    } else {
      state.queue.splice(state.index + 1, 0, song)
      state.index += 1
    }
    persist()
    emit('queue', state.queue)
    load(true)
  }

  function enqueue(list) {
    const songs = (list || []).filter(s => s && s.id && !state.queue.some(x => x.id === s.id))
    if (!songs.length) { U.toast('歌曲已在队列中'); return 0 }
    state.queue = state.queue.concat(songs)
    persist()
    emit('queue', state.queue)
    return songs.length
  }

  function clearQueue() {
    pause()
    // 同上：清队列会 removeAttribute('src')，currentTime 归零 ——
    // 若不断开 session，下一次 load() 会把刚存的续播点覆盖成 0
    session = null
    resumeToken++
    state.queue = []
    state.index = -1
    audio.removeAttribute('src')
    persist()
    emit('queue', [])
    emit('song', null)
  }

  function removeAt(i) {
    if (i < 0 || i >= state.queue.length) return
    state.queue.splice(i, 1)
    if (state.queue.length === 0) return clearQueue()
    if (i < state.index) state.index -= 1
    else if (i === state.index) {
      if (state.index >= state.queue.length) state.index = 0
      persist()
      load(state.playing)
      emit('queue', state.queue)
      return
    }
    persist()
    emit('queue', state.queue)
  }

  function randomIndex() {
    if (state.queue.length <= 1) return state.index
    let i = state.index
    for (let n = 0; n < 12 && i === state.index; n++) i = Math.floor(Math.random() * state.queue.length)
    return i
  }

  function step(delta, manual) {
    if (!state.queue.length) return
    if (state.mode === 'single' && !manual) {
      audio.currentTime = 0
      audio.play().catch(() => {})
      return
    }
    let next
    if (state.mode === 'random') next = randomIndex()
    else next = state.index + delta
    if (next >= state.queue.length) next = state.mode === 'order' && delta > 0 ? -1 : 0
    if (next < 0) next = state.mode === 'order' ? -1 : state.queue.length - 1
    if (next === -1) {
      pause()
      // 账已经结完了 —— 清掉 session，免得下一次 load() 拿着「刚被归零的 currentTime」
      // 再补一条，把上一首刚存好的续播点覆盖成 0
      session = null
      audio.currentTime = 0
      emit('ended')
      return
    }
    state.index = next
    persist()
    load(true)
    emit('queue', state.queue)
  }

  const next = (manual) => step(1, manual)
  const prev = (manual) => {
    // 播过 3 秒以上时，「上一首」先回到开头（与主流播放器一致）
    if (!manual && audio.currentTime > 3) { audio.currentTime = 0; return }
    step(-1, manual)
  }

  /* ---------------- 取流 ---------------- */

  /**
   * 服务端代理地址。
   *
   * 远程模式（安卓壳指向自建服务器，见 native.js 第 8 节）必须带上服务器基址：
   * 页面自己那个 origin 是「假域名」（内容由 APK 供给），相对路径会打到本地 assets 上，
   * 拿回来的是一段 HTML 而不是音频。
   */
  function serverStreamUrl(song) {
    const qs = new URLSearchParams({ id: song.id, q: state.quality, token: TOKEN() })
    return (global.LX_REMOTE_BASE || '') + '/api/stream?' + qs.toString()
  }

  /**
   * 取流链路：三级 × 每级多候选，逐条降级。核心诉求是「能直连就直连」——
   * 音频字节不经过 Worker，省流量、少一跳、拖动进度也更跟手。
   *
   *   0 direct —— 服务端 /api/url?fast=1 返回的 https 直链列表。
   *                服务端已做过三件事：http→https 协议升级、并发 Range 探测、
   *                按体积降序（完整版优先）。所以这一级通常是一击命中。
   *   1 plugin —— 浏览器端落雪插件现场解析（零服务端参与），同样直连。
   *   2 server —— 同源代理 /api/stream。兜底：源站防盗链、只有 http、
   *                或客户端网络到源站不通时才用得上。
   *
   * 每条候选都失败才会跳到下一级；三级全挂才跳过这首歌。
   */
  const STAGES = ['direct', 'plugin', 'server']
  let loadToken = 0
  let loading = false        // 是否有 load() 正在取流
  let wantPlay = false       // 取流完成后是否自动起播
  let order = STAGES.slice() // 本次尝试的级别顺序（可能因服务端探测结果调整）
  let curStage = 0           // 当前处在 order 的第几级
  let curStageName = 'direct'
  let curList = []           // 当前级的候选列表
  let curPos = 0             // 当前级试到第几条
  let advancing = false      // 降级重入锁：error 事件可能连发

  /**
   * 「实播时长不到声明时长的多少」才算「音源给的是片段」。
   *
   * **只有这一处口径** —— 元数据一到位（提前告诉用户）与整首播完（兜底再说一次）
   * 用的是同一个值，免得出现「提前提示说没事、播完又跳出来说有事」这种自相矛盾。
   * 取 0.6 与下面 warnIfSnippet 的保守判据（声明时长必须 > 60 秒）配合，
   * 正常短歌、纯音乐里的长静音都不会被误报。
   */
  const SNIPPET_PLAYED_RATIO = 0.6
  /** 本次加载已经就「片段」提示过没有 —— 提示过就别在播完时再说一遍 */
  let snippetWarned = false

  /**
   * 客户端侧的 http→https 升级（与服务端 stream.js 的白名单保持一致）。
   * 插件源给的地址常是 http，在 https 页面会被浏览器拦成混合内容。
   */
  const UPGRADE_HOSTS = [/\.music\.126\.net$/i, /\.kuwo\.cn$/i, /\.kugou\.com$/i,
    /\.kglink\.cn$/i, /\.qqmusic\.qq\.com$/i, /\.music\.qq\.com$/i]
  function upgradeHttps(url) {
    const raw = String(url || '')
    if (!/^http:\/\//i.test(raw)) return raw
    try {
      const host = new URL(raw).hostname
      return UPGRADE_HOSTS.some(re => re.test(host)) ? raw.replace(/^http:/i, 'https:') : raw
    } catch { return raw }
  }

  /**
   * 这条地址在本宿主里能不能播。
   *
   * 网页：只有 https 能用 —— http 会被浏览器当混合内容拦掉。
   * 安卓壳：http 也能用 —— WebView 已开 MIXED_CONTENT_ALWAYS_ALLOW（见 MainActivity），
   *         而且 <audio> 加载跨域地址本就豁免 CORS。
   *
   * 这一条判定直接影响成败：源站给的候选里 http 占比很高，壳里若沿用 https-only
   * 就会把「能直连的」当成「不能直连的」丢掉，白等一轮才降级。
   *
   * 每次调用现读标志（而不是在加载时算好）—— 免得日后有人调了 script 顺序就静默失效。
   */
  function isPlayable(u) {
    const allow = global.LX_ALLOW_HTTP_AUDIO === true
    return allow ? /^https?:\/\//i.test(u) : /^https:\/\//i.test(u)
  }

  /**
   * 直连候选缓存。
   * 两个作用：① 避免 load() 预取 + advance() 正式取流时把 /api/url 请求打两遍；
   * ② 服务端的 verified 标记要靠它带出来，好在 advance() 之前就定好级别顺序。
   */
  let directCache = null

  /** 取某一级的候选列表（已按预期顺序排好，客户端从前往后试） */
  async function stageCandidates(song, stage) {
    if (stage === 'direct') {
      if (directCache) return directCache
      try {
        const r = await API.songUrl(song.id, state.quality, true)
        if (!r || !r.ok) { directCache = []; return directCache }
        const raw = (r.urls && r.urls.length) ? r.urls : [{ url: r.url, from: r.from }]
        const list = raw
          .map(x => ({
            url: upgradeHttps(x.url),
            from: x.from || r.from || '直链',
            size: Number(x.size) || 0,
            trial: x.trial === true,
          }))
          // 本宿主播不了的地址不必浪费一次尝试（网页里是 http，壳里没有这种限制）
          .filter(x => x.url && isPlayable(x.url))
          .map(x => ({ url: x.url, from: x.from + ' · 直连', size: x.size, trial: x.trial }))
        /**
         * 「先排除试听片段，再体积大优先」—— 这条排序是为了「别放到一半就没了」。
         *
         * 各源对不同音质给的是**不同来源**：低音质常落到第三方中转的试听片段
         * （三十多秒），完整曲目往往要插件源给。服务端已经按同一口径预排过，
         * 但它是在自己的出口探的，和手机网络不是一回事；这里再排一次不花什么
         * 代价，却能把「服务端探不出来的那条完整版」顶到前面去。
         *
         * ⚠ **`trial` 必须排在体积之前**：30 秒的**无损**片段可能有 5MB，
         * 比 128k 的完整曲目（4MB）还大 —— 只按体积排会把它选出来。
         * 服务端那条 `looksLikeTrial` 就是这个字段的来源（网易的 freeTrialInfo
         * 或「体积 / 声明时长」推出的码率低得离谱），两边档位必须一致。
         *
         * size 为 0 表示探不出体积（未知），排到已知的后面 —— 未知不等于小，
         * 但「已知的完整版」比「未知的」更值得先试。
         */
        list.sort((a, b) => (a.trial ? 1 : 0) - (b.trial ? 1 : 0) || (b.size || 0) - (a.size || 0))
        directCache = list
        // 服务端把「全部候选一个都没探通」如实标成 verified=false。
        // 这种直连地址可信度不高 —— 探测是在 Cloudflare 出口做的，和用户手机
        // 的网络不是一回事（实测 kg 的第三方中转源在 CF 侧全挂、在浏览器侧被 ORB
        // 拦）。所以把插件级提前，让浏览器自己解析，通常更快也更容易成功。
        if (r.verified === false && list.length) order = ['plugin', 'direct', 'server']
        return list
      } catch { directCache = []; return directCache }
    }
    if (stage === 'plugin') {
      /**
       * 远程模式下这一级不存在：插件在服务器上跑，结果已经并进 /api/url 的候选里了，
       * 本机连插件池都没加载。硬走一遍只会白等一个空池子。
       */
      if (global.LX_REMOTE) return []
      if (!global.LXP) return []
      try {
        const res = await LXP.resolveMusicUrl(song, state.quality)
        const url = upgradeHttps(res && res.url)
        if (url && isPlayable(url)) return [{ url, from: (res.from || '浏览器插件') + ' · 直连' }]
      } catch { /* 落到下一级 */ }
      return []
    }
    if (stage === 'server') {
      /**
       * 安卓壳里没有「服务端代理」这一级 —— /api/stream 本来是给浏览器绕混合内容
       * 限制用的（https 页面加载 http 音频），而这个限制在壳里已被 WebView 配置
       * 直接关掉（MIXED_CONTENT_ALWAYS_ALLOW）。壳里再走一遍代理只会让音频多绕一跳，
       * 还依赖一个根本不需要的远端。
       *
       * 所以壳里这一级改为「用桥解析出直链后直连」：解析走本地后端（网络由原生发，
       * 不受同源策略约束），音频字节仍然直连源站。
       *
       * 远程模式下要反过来 —— 那时后端在别人那台服务器上，代理这一级是真实存在的
       * （而且手机网络到源站不通、或源站防盗链时，正是靠它兜底）。
       */
      if (global.LX_NATIVE && !global.LX_REMOTE) {
        try {
          const r = await API.songUrl(song.id, state.quality, true)
          const raw = (r && r.urls && r.urls.length) ? r.urls : (r && r.url ? [{ url: r.url, from: r.from }] : [])
          const list = raw
            .map(x => ({ url: upgradeHttps(x.url), from: (x.from || '直链') + ' · 壳内解析' }))
            .filter(x => x.url && isPlayable(x.url))
          return list
        } catch { return [] }
      }
      return [{ url: serverStreamUrl(song), from: '服务端代理' }]
    }
    return []
  }

  /**
   * 从 (startStage, startPos) 开始找下一条能试的地址：
   * 同一级内往后挪一条；挪到头就进入下一级的第一条。
   * 级别顺序取 order（默认 direct → plugin → server）。
   */
  async function advance(startStage, startPos) {
    for (let s = Math.max(0, startStage); s < order.length; s++) {
      // 先把级名取出来：stageCandidates 内部可能重排 order，不能等它返回后再读
      const stageName = order[s]
      const list = await stageCandidates(current(), stageName)
      if (!list.length) continue
      const pos = (s === startStage) ? startPos : 0
      if (pos < list.length) {
        curStage = s; curStageName = stageName; curList = list; curPos = pos
        return list[pos]
      }
    }
    return null
  }

  /**
   * 直连卡死看门狗。
   * 直连源站有一种失败是**不报 error 的**：连接建不上、或服务端迟迟不吐数据，
   * <audio> 会一直停在 readyState=0，既不触发 error 也不走进度 —— 用户看到的是
   * 「点了播放没反应」。所以直连/插件这两级加一个 8 秒兜底，超时按失败降级。
   *
   * 代理那一级（server）不加：它慢多半只是网络慢，贸然判定失败会误跳歌。
   */
  let stallTimer = null
  function armStall() {
    clearTimeout(stallTimer)
    if (curStageName === 'server') return
    stallTimer = setTimeout(() => {
      if (loading || audio.readyState >= 2) return
      handleError()
    }, 8000)
  }
  function clearStall() { clearTimeout(stallTimer) }

  /** 把一条候选挂到 <audio> 上 */
  function applySrc(hit) {
    audio.dataset.stage = String(STAGES.indexOf(curStageName))
    audio.dataset.cached = '0'
    snippetWarned = false          // 换了一条候选 → 「片段」提示重新计一轮
    audio.src = hit.url
    setFooter('音源：' + hit.from + (curList.length > 1 && curPos > 0 ? '（备选 ' + curPos + '）' : ''))
    armStall()
    lastHit = hit
  }

  /**
   * 这条候选是不是「疑似试听片段」。
   *
   * ⚠ 这一条**只决定提示文案的措辞**，不决定任何取舍 —— 真正的判据是
   * warnIfSnippet 里那个「实播时长 / 声明时长」（时长是地面真相，不会骗人），
   * 以及上面按 `trial` + 体积的排序。这里之所以还要它，是因为体积对比能区分
   * 「当前音源只给了片段」和「音源给的内容本身就不完整」——两者给用户的建议不一样。
   *
   * 不算精确：只有拿得到体积、且比同级里最大的那条小一大截时才算。
   * 不能靠它拦掉候选：体积小的也可能就是正常短歌（小样、间奏、纯音乐）。
   */
  const SNIPPET_RATIO = 0.5
  function looksLikeSnippet(hit) {
    if (!hit || !hit.size) return false
    const max = curList.reduce((m, x) => Math.max(m, x.size || 0), 0)
    return max > 0 && hit.size < max * SNIPPET_RATIO
  }

  /* ---------------- 播放缓存 ---------------- */

  /**
   * 当前这首有没有命中缓存。
   *
   * `cachedPlay` 只对**当前这一轮 load** 有效（load 开头会重置），
   * 靠它把「命中的那条响应」带到 applyCachedSrc —— 缓存取字节是异步的，
   * 不能在同步的 applySrc 里等。
   */
  let lastHit = null
  let cachedPlay = null

  function cacheApi() {
    const c = global.LXAudioCache
    return (c && c.supported) ? c : null
  }

  function cacheLabel(song) {
    return '本地缓存' + (song && song._cacheQuality ? ' · ' + song._cacheQuality : '')
  }

  /** 命中缓存就取出一条可直接喂 <audio> 的响应，否则 null */
  async function cacheHitFor(song) {
    cachedPlay = null
    const c = cacheApi()
    if (!c || !song) return null
    try {
      const res = await c.get(song, state.quality, '')
      if (!res) return null
      cachedPlay = res
      return res
    } catch { return null }
  }

  /**
   * 挂上缓存里的字节。
   *
   * 这里走 Blob URL 而不是直接给缓存 URL —— `<audio>` 会自己发 Range 请求，
   * 而 Service Worker 对 Range 请求是直接放行（见 sw.js），拦不到；
   * 给一个已经切好的完整 200 响应最省事，也不需要再和缓存层对话。
   * 代价是内存里多驻留一份（一首 320k 约 10MB），播放结束会 revoke。
   */
  function applyCachedSrc(song, res) {
    Promise.resolve(res.blob()).then((b) => {
      if (!current() || current().id !== song.id) return
      if (cacheBlobUrl) { try { URL.revokeObjectURL(cacheBlobUrl) } catch { /* ignore */ } }
      cacheBlobUrl = URL.createObjectURL(b)
      audio.dataset.stage = '-1'
      audio.dataset.cached = '1'
      snippetWarned = false        // 本地缓存不受「片段」判据约束（见 warnIfSnippet）
      audio.src = cacheBlobUrl
      setFooter('音源：本地缓存（省去重新取流）')
      lastHit = { url: 'cache://' + song.id, from: '本地缓存' }
      armStall()
      if (wantPlay) { wantPlay = false; audio.play().catch(() => {}) }
    }).catch(() => {
      // 缓存读坏了（极少见，通常是存储被系统清了）→ 当作没命中，走正常链路
      cache3Retry(song)
    })
  }

  let cacheBlobUrl = null

  /** 缓存读失败时的兜底：把命中标记清掉，重新走一遍正常取流 */
  function cache3Retry(song) {
    cachedPlay = null
    if (!current() || current().id !== song.id) return
    setFooter('本地缓存不可用，正在重新取流…')
    load(!audio.paused)
  }

  /** 播放结束后的「听完整首就存」；已经在缓存里的不会重复下 */
  function maybeStoreToCache() {
    const song = current()
    const c = cacheApi()
    if (!c || !song) return
    // 命中缓存起播的这首本来就在缓存里，不必再走一遍
    if (audio.dataset.cached === '1') return
    if (!lastHit || !lastHit.url) return
    if (global.LX_NATIVE === false && !c.autoEnabled()) return
    c.cacheAfterPlay(song, state.quality, lastHit).then((r) => {
      if (r && r.ok && !r.skipped) emit('cached', { song, bytes: r.bytes })
    }).catch(() => { /* 缓存失败不影响播放 */ })
  }

  /**
   * 音效与「能直连」是冲突的。
   *
   * Web Audio 只认带 CORS 头的音源：`createMediaElementSource` 挂在没有 ACAO 的
   * 跨域源上会输出**静音**（详见 public/js/tone.js 顶部说明）。
   * 所以开着音效时，每条候选都要先过一遍跨域预检：
   *   · 过 → 直连，两全；
   *   · 不过 → 网页端退回同源代理 /api/stream（音效一定可用，只是多占服务器流量）；
   *             安卓壳里根本没有代理这一级，只能把音效关掉 —— 静音比没音效更糟。
   */
  async function routeForTone(song, hit) {
    if (!global.Tone || !hit) return hit
    if (!Tone.active()) return hit
    if (await Tone.canUse(hit.url)) return hit
    if (global.LX_NATIVE && !global.LX_REMOTE) {
      Tone.reset()
      U.toast('该音源不支持音效，已自动关闭音效')
      return hit
    }
    U.toast('该音源不支持音效，已改用服务端中转播放')
    return { url: serverStreamUrl(song), from: '服务端代理 · 音效' }
  }

  /** 音效开关变了 → 按新设置重新取一次流（直连 ⇄ 代理） */
  function reloadForTone() {
    if (!current()) return
    keepPosition()
    load(!audio.paused)
  }

  /**
   * 记住当前位置，供紧接着的 load() 用。
   *
   * 换音质 / 换音效都会把 <audio> 的 src 换掉，于是 currentTime 归零 ——
   * 不显式接上的话，用户听到一半切个音质，歌就从头开始放了。
   * （也顺带绕开了「续播点最近一次心跳是 5 秒前」造成的倒退。）
   */
  function keepPosition() {
    const at = audio.currentTime || 0
    resumeOverride = at > 3 ? at : 0
  }

  async function load(autoplay) {
    const song = current()
    if (!song) return
    // 切歌前先给上一首收个尾（同一首歌重载 —— 换音质 / 降级重试 —— 不算切歌，
    // 跳过以免把「听过一次」重复计两遍）。此刻 audio 还挂着旧 src，位置读得到。
    if (!session || session.id !== song.id) flushProgress(audio.currentTime, audio.duration, true)
    beginSession(song)
    if (autoplay) wantPlay = true
    const token = ++loadToken
    loading = true
    state.loading = true
    paint(song)                 // 立即更新迷你条 / 播放器曲目信息（不依赖取流是否成功）
    emit('song', song)
    emit('loading', true)

    audio.pause()
    audio.removeAttribute('src')
    audio.load()

    state.lyric = null
    state.lines = []
    state.lineIndex = -1
    renderLyric()
    fetchLyric(song)

    order = STAGES.slice()
    directCache = null
    curStage = 0; curList = []; curPos = 0; curStageName = order[0]

    /**
     * 缓存优先 —— 听过的歌直接吃本地字节，连解析都不做。
     *
     * 这一条必须在「取直连候选」之前：整条取流链路的开销（问 /api/url →
     * 插件逐级解析 → Range 探测）省掉才是缓存真正的收益。放到后面就只能
     * 省流量、省不了时间，用户感受不到。
     */
    const cached = await cacheHitFor(song)
    if (token !== loadToken) return
    if (cached) {
      curStageName = 'cache'
      curList = [{ url: 'cache://' + song.id, from: cacheLabel(song) }]
      curPos = 0
      applyCachedSrc(song, cached)
      loading = false
      state.loading = false
      emit('loading', false)
      applyResume(song)
      if (wantPlay) {
        wantPlay = false
        try { await audio.play() } catch { /* 自动播放被拦，等用户手势 */ }
      }
      document.dispatchEvent(new CustomEvent('lx:song', { detail: song }))
      return
    }

    // 先取一次直连候选：既拿到地址，也拿到服务端的探测结论，
    // 在正式挑级别之前把 order 定下来（unverified 时会把插件级提前）。
    await stageCandidates(song, 'direct')
    if (token !== loadToken) return
    const hitRaw = await advance(0, 0)
    if (token !== loadToken) return     // 已被更新的 load() 接管，由它收尾
    // 开着音效但这条直链没有 CORS 头时，换成代理地址（见 routeForTone）
    const hit = hitRaw ? await routeForTone(song, hitRaw) : null
    if (token !== loadToken) return
    if (!hit) {
      loading = false
      wantPlay = false
      state.loading = false
      emit('loading', false)
      setFooter('该歌曲暂无可用音源')
      U.toast('「' + song.name + '」暂无可用音源')
      return
    }
    applySrc(hit)

    loading = false
    state.loading = false
    emit('loading', false)

    // 续播：与起播并行去问，拿到位置再 seek（内部等元数据，最多 3 秒）
    applyResume(song)

    if (wantPlay) {
      wantPlay = false
      try { await audio.play() } catch { /* 自动播放被拦，等用户手势 */ }
    }
    document.dispatchEvent(new CustomEvent('lx:song', { detail: song }))
  }

  /** 当前这条放不出来 → 先试同级备选，再降级到下一级；全挂才跳过 */
  async function handleError() {
    const song = current()
    if (!song) return
    // 取流过程中 load() 会主动清空 src，可能间接触发 error；
    // 此时不要去改 src（会和 load() 抢，导致元素反复重置），交给 load() 收尾。
    if (loading) return
    if (advancing) return          // error 可能连发，避免重复降级
    advancing = true
    const token = loadToken
    try {
      const hit = await advance(curStage, curPos + 1)
      if (token !== loadToken) return      // 期间用户切歌了
      if (hit) {
        applySrc(hit)
        try { await audio.play() } catch { /* ignore */ }
        return
      }
      setFooter('该歌曲暂无可用音源，正在切到下一首…')
      U.toast('「' + song.name + '」播放失败，已跳过')
      setTimeout(() => next(false), 600)
    } finally {
      advancing = false
    }
  }

  function setFooter(text) {
    if (dom.footer) dom.footer.textContent = text || ''
  }

  /* ---------------- 歌词 ---------------- */

  function parseLrc(text) {
    if (!text) return []
    const src = String(text)
    // LRC 的全局偏移标签：[offset:+500] / [offset:-200]，单位毫秒。
    // 各平台歌词大量带这个标签，而此前被直接忽略 —— 结果是整篇歌词恒定提前或滞后，
    // 表现出来就是「歌词和声音对不上」。
    //
    // 符号约定取 LRC 格式原始定义（郭祥祥 / Djohan 规范，中文百科一致口径）：
    // **正值表示整体提前** —— 也就是把每句的时间戳往前挪，所以要减。
    // （英文社区有文档写成「positive = shift later」，与原始定义相反；
    //   我们的歌词全部来自国内平台，跟国内口径。若日后遇到反例，改这一处符号即可。）
    let offset = 0
    const om = src.match(/\[offset:\s*([+-]?\d+)\s*\]/i)
    if (om) offset = (Number(om[1]) || 0) / 1000

    const lines = []
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    for (const raw of src.split('\n')) {
      const stamps = []
      let m
      re.lastIndex = 0
      while ((m = re.exec(raw))) {
        const min = Number(m[1])
        const sec = Number(m[2])
        let ms = m[3] ? Number(m[3]) : 0
        if (m[3] && m[3].length === 2) ms *= 10
        if (m[3] && m[3].length === 1) ms *= 100
        stamps.push(Math.max(0, min * 60 + sec + ms / 1000 - offset))
      }
      if (!stamps.length) continue
      const text = raw.replace(re, '').trim()
      if (!text) continue
      for (const t of stamps) lines.push({ t, text, sub: '' })
    }
    lines.sort((a, b) => a.t - b.t)

    // 合并成「主歌词 + 翻译」一对一结构
    const out = []
    for (const line of lines) {
      const prev = out[out.length - 1]
      if (prev && Math.abs(prev.t - line.t) < 0.02) continue
      out.push(line)
    }
    return out
  }

  function mergeTranslation(lines, tlyric) {
    if (!tlyric) return lines
    const map = new Map()
    for (const l of parseLrc(tlyric)) {
      if (!map.has(l.t.toFixed(2))) map.set(l.t.toFixed(2), l.text)
    }
    for (const l of lines) {
      const hit = map.get(l.t.toFixed(2))
      if (hit) l.sub = hit
    }
    return lines
  }

  /**
   * 取歌词。
   *
   * 两个必须守住的点：
   *
   * ① 判空要看**正文**，不能只看对象在不在。插件取不到词时返回的是
   *    `{lyric:'', tlyric:null, rlyric:null, lxlyric:null}` —— 对象是真的、
   *    里面一个字没有。原来的 `if (!data)` 会把它当成「有歌词」收下，
   *    界面显示一行空白。
   *
   * ② 酷我那条上游单次成功率只有约 25%（服务端已重试 8 次，见 providers/kw.js），
   *    所以这里再兜一次：第一次没拿到正文就隔 1.2s 重来。两轮合计失手率约 1%。
   *    只在**还在放这首**时才重试，切歌立即放弃。
   */
  async function fetchLyric(song) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await API.lyric(song.id)
        if (current() && current().id !== song.id) return   // 期间切歌了，整轮作废
        const data = res && res.lyric
        const text = typeof data === 'string' ? data : (data && (data.lyric || data.lrc)) || ''
        if (text) {
          state.lyric = data
          state.lines = mergeTranslation(parseLrc(text), (data && data.tlyric) || null)
          state.lineIndex = -1
          renderLyric()
          emit('lyric', state.lines)
          return
        }
      } catch { /* 落到重试 */ }
      if (attempt === 0) await new Promise(r => setTimeout(r, 1200))
    }
    if (current() && current().id !== song.id) return
    // 两轮都没有正文：留一个空对象而不是 null —— renderLyric 用 null 表示
    // 「还在加载中」，这里要的是「暂无歌词」。
    state.lyric = {}
    renderLyric()
  }

  /**
   * 把歌词列表位移到「某一行正好落在可视区正中」的位置。传 null 表示对齐第一行。
   *
   * ⚠️ 这里踩过一个很大的坑，改动前务必读完：
   *
   * 不能拿 `active.offsetTop` 去算位移。`.lyric-scroll` 自己带着 transform（就是本函数
   * 写的那个），而**带 transform 的元素会成为后代的 offsetParent** —— 于是
   * `active.offsetTop` 变成「相对歌词列表自己」的坐标；偏偏 `.lyric-scroll` 又被
   * `.player__lyric` 的 `align-items:center` 推到了可视区上方（63 行时 offsetTop ≈ −859）。
   * 两套坐标系一混，算出来的位移整整偏掉「列表高度的一半」。实测后果：
   * 高亮行被推到可视区**上方 860px** 处 —— 屏幕上你读到的那句，永远比正在唱的那句
   * 晚好几行。用户的原话就是「歌词和进度对照不住」。
   *
   * 正确做法：不碰 DOM，用两个 **同时受该 transform 影响** 的矩形相减把 transform 抵消掉，
   * 剩下纯布局量；再加上 `scroll.offsetTop`（布局值，不受 transform 影响）换算到
   * 「相对可视区」的同一个坐标系里。
   */
  function alignLyricTo(node) {
    const scroll = dom.lyricScroll
    const box = scroll && scroll.parentElement
    if (!box) return
    const h = box.clientHeight
    // 播放器没打开时可视区高度为 0，量出来必然是错的 —— 宁可不动，
    // 也别把本来正确的位置污染掉（这正是「开播放器后歌词停在错位」的成因）。
    if (!h) return
    const target = node || scroll.firstElementChild
    // 目标行相对「歌词列表顶部」的位移。列表与目标行同时受同一个 transform 影响，
    // 相减后抵消 —— 所以不必先把 transform 清零，量出来直接就是纯布局值。
    // （清零再量也想过，但读 rect 会强制一次样式重算，过渡动画会把那个临时的 0
    //   当成起点，表现为「每换一句整列先跳一下」，所以刻意不碰 DOM。）
    const sr = scroll.getBoundingClientRect()
    const tr = target ? target.getBoundingClientRect() : null
    const inList = tr ? (tr.top - sr.top) : 0
    const targetH = tr ? tr.height : 0
    // scroll.offsetTop 是**布局**值（不受 transform 影响），相对 #playerLyric 的 padding box。
    // 与 clientHeight / 2 是同一套坐标原点，可以直接相减。
    const top = scroll.offsetTop + inList
    scroll.style.transform = 'translateY(' + (h / 2 - top - targetH / 2) + 'px)'
  }

  /** 按当前进度重摆一次位置。播放器开合、歌词刚回来、用户调偏移之后都要来一次 */
  function realignLyric() {
    if (!state.lines.length) return
    syncLyric(audio.currentTime, true)
  }

  function renderLyric() {
    if (!dom.lyricScroll) return
    if (!state.lines.length) {
      dom.lyricScroll.innerHTML = '<div class="lyric-line" style="color:rgba(255,255,255,.5)">'
        + (state.lyric === null ? '歌词加载中…' : '暂无歌词') + '</div>'
      dom.lyricScroll.style.transform = 'translateY(0px)'
      return
    }
    dom.lyricScroll.innerHTML = state.lines.map((l, i) => {
      const sub = l.sub ? '<div style="font-size:12px;opacity:.7;margin-top:2px">' + U.escapeHtml(l.sub) + '</div>' : ''
      return '<div class="lyric-line' + (i === state.lineIndex ? ' is-active' : '') + '" data-i="' + i + '">'
        + U.escapeHtml(l.text) + sub + '</div>'
    }).join('')
    // 首句居中：歌词还没开始唱时，让第一句先停在中间，后面的句子在下方候着
    alignLyricTo(null)
    // 歌词可能是播到一半才回来的，渲染完补一次启动（空闲时是空操作）
    startLyricLoop()
  }

  /**
   * 按时间戳定高亮行并摆好位置。
   * `force` 为真时忽略「行没变就不用重摆」的短路 —— 播放器刚打开、旋屏、
   * 调完偏移这些时候，行号往往没变但**位置必须重算**（可视区尺寸变了）。
   */
  function syncLyric(time, force) {
    if (!state.lines.length) return
    // 判定时刻 = 播放位置 - 偏移。偏移为正表示歌词延后 → 用更早的时刻去比，
    // 于是每一行都会「晚一点」才亮。
    const at = time - lyricDelay
    let i = -1
    for (let n = 0; n < state.lines.length; n++) {
      // 严格按时间戳：lines[n].t <= at 才点亮（默认 0 提前量，见 lyricDelay 注释）
      if (state.lines[n].t <= at) i = n
      else break
    }
    if (!force && i === state.lineIndex) return
    state.lineIndex = i
    const nodes = dom.lyricScroll.children
    for (let n = 0; n < nodes.length; n++) nodes[n].classList.toggle('is-active', n === i)
    // 只用 transform 定位，**不要再调 scrollIntoView**。
    // .player__lyric 是 overflow:hidden 的滚动容器，scrollIntoView 会去改它的
    // scrollTop，和这里的位移叠加后高亮行会系统性偏离中心。
    // i === -1（还没唱到第一句）时对齐第一行，否则列表会停在上次滚到的位置，
    // 看起来像「歌词卡住了」。
    alignLyricTo(i >= 0 ? nodes[i] : null)
    emit('line', i)
  }

  /* ---------------- 歌词校准 ---------------- */

  /** 把偏移值刷到界面上（0 显示「同步」，非 0 显示带符号秒数） */
  function paintLyricCal() {
    if (!dom.lyricCalVal) return
    const v = Math.round(lyricDelay * 10) / 10
    dom.lyricCalVal.textContent = v === 0 ? '同步' : (v > 0 ? '+' : '') + v.toFixed(1) + 's'
    dom.lyricCalVal.dataset.off = v === 0 ? '' : '1'
  }

  /**
   * 调一档偏移。
   * `sign` 为 +1 表示「歌词再晚一点」（声音比字幕慢时按这个），-1 相反。
   *
   * 改完必须**立刻重算一次高亮**：syncLyric 里 `i === state.lineIndex` 会直接
   * 早退，而调偏移往往跨不过行边界（行没变），所以这里强制重算。
   */
  function nudgeLyricDelay(sign) {
    const next = Math.round((lyricDelay + sign * LYRIC_DELAY_STEP) * 10) / 10
    setLyricDelay(next)
    U.toast(`歌词偏移 ${next === 0 ? '同步' : (next > 0 ? '+' : '') + next.toFixed(1) + 's'}`)
  }

  function setLyricDelay(v) {
    let next = Number(v)
    if (!isFinite(next)) next = 0
    next = Math.max(-LYRIC_DELAY_MAX, Math.min(LYRIC_DELAY_MAX, Math.round(next * 10) / 10))
    lyricDelay = next
    U.store.set('lx.lyricDelay', next)
    paintLyricCal()
    syncLyric(audio.currentTime, true)
    return lyricDelay
  }

  /**
   * 歌词高亮用 rAF 驱动，不靠 timeupdate。
   *
   * timeupdate 大约只有 4Hz（250ms 一次），跟着它切高亮会明显慢半拍；
   * 进度条低频更新无所谓，歌词必须跟帧。暂停时停掉，不空转。
   */
  let lyricRaf = 0
  function lyricLoop() {
    lyricRaf = 0
    if (audio.paused || !state.lines.length) return
    syncLyric(audio.currentTime)
    lyricRaf = requestAnimationFrame(lyricLoop)
  }
  function startLyricLoop() {
    if (!lyricRaf && !audio.paused && state.lines.length) lyricRaf = requestAnimationFrame(lyricLoop)
  }
  function stopLyricLoop() {
    if (lyricRaf) { cancelAnimationFrame(lyricRaf); lyricRaf = 0 }
  }

  /* ---------------- 播放进度上报 / 续播 ----------------
   *
   * 进度存在**服务端**（`play_progress` 表，每「用户 × 歌」一行，见 src/db.js），
   * 不是 localStorage —— 所以换设备、换浏览器、网页与 APK 之间都能接着听。
   * 两个环节：
   *   上报 —— 每 5 秒一条心跳，另外暂停 / 切歌 / 播完 / 页面隐藏各补一条。
   *   续播 —— 每首歌起播时问一句「上次听到哪」，拿到就 seek 过去。
   *
   * 「算不算听过一次」由客户端判，而且**一轮只上报一次 true**：
   * 服务端收到 played=true 就 play_count+1，若每次心跳都带 true，
   * 听一首歌能刷出十几次播放量 —— 所以下面用一个一轮一次性的开关卡住。
   */

  const PROGRESS_INTERVAL = 5000   // 心跳节流（毫秒）
  const PLAYED_MIN_SEC = 30        // 有效播放：累计听够 30 秒……
  const PLAYED_RATIO = 0.5         // ……或听完半首（取小），短歌不至于永远算不上

  /** 本轮播放的记账。切歌时整体更替；同一首歌换音质重载时沿用，免得重复计一次播放 */
  let session = null
  let lastTickAt = 0               // 累计「真的在走」的时长用的墙钟基准
  let resumeToken = 0
  let resumeOverride = 0           // 一次性：本次 load 指定续播点（换音质/换音效时保位置）
  const noResume = new Set()       // 已知没有续播点的歌，别每次起播都白问一遍

  function beginSession(song) {
    if (!song) return
    if (session && session.id === song.id) return
    session = { id: song.id, song, listened: 0, played: false, reportedAt: 0 }
  }

  /**
   * 写一次进度。
   *
   * pos / dur 必须由调用方在**切歌之前**读出来 —— load() 一开头就会
   * `audio.pause()` + `removeAttribute('src')`，之后再读 currentTime 就是 0 了。
   * 所以这里不接受「自己从 audio 上读」，而是把值当参数传进来。
   */
  function flushProgress(pos, dur, force) {
    const s = session
    if (!s) return
    const d = Math.max(0, Number(dur) || Number(s.song.interval) || 0)
    const p = Math.max(0, Number(pos) || 0)
    const need = d > 0 ? Math.min(PLAYED_MIN_SEC, d * PLAYED_RATIO) : PLAYED_MIN_SEC
    const atEnd = d > 0 && p >= d - 2
    let played = false
    if (!s.played && (s.listened >= need || atEnd)) { s.played = true; played = true }
    const t = Date.now()
    // 首次达标的那一条必须立刻发出去，不能等心跳 —— 否则「听完就退」会丢掉这次播放量
    if (!played && !force && t - s.reportedAt < PROGRESS_INTERVAL) return
    s.reportedAt = t
    try { API.reportProgress(s.id, p, d, played).catch(() => {}) } catch { /* 未登录等，静默 */ }
  }

  /**
   * 累计「真的在走」的秒数。
   * 用**墙钟差值**而不是 currentTime 差值：拖进度条跳掉的那几分钟不该算「听过」，
   * 而墙钟只在 timeupdate 真的在推进时才累加（暂停时 timeupdate 不触发）。
   */
  function tickListening() {
    const t = Date.now()
    if (audio.paused || !session) { lastTickAt = 0; return }
    if (lastTickAt) session.listened += Math.min(1, (t - lastTickAt) / 1000)
    lastTickAt = t
  }

  /**
   * 续播：拿到上次的位置就 seek 过去。
   *
   * 两处刻意不续：
   *  - 位置 < 5s：等于从头开始，没必要提示「已续播」；
   *  - 已经播到片尾 5s 内：续过去就停在结尾，用户会以为「这首歌坏了」。
   *
   * seek 要等元数据（readyState >= 1）到位，最多等 3 秒；
   * 另外如果进度请求回来得太慢、用户已经听了 5 秒以上，就干脆放弃 ——
   * 这时候硬跳一下比不续播更糟。
   */
  async function applyResume(song) {
    if (!song) return
    // 换音质 / 换音效引起的那次 load 有明确的续播点（keepPosition），
    // 用它、并且不问服务端 —— 服务端记的是最近一次心跳，会倒退几秒。
    const forced = resumeOverride
    resumeOverride = 0
    const token = ++resumeToken
    let pos = forced
    if (!pos) {
      if (noResume.has(song.id)) return
      try {
        const r = await API.playProgress(song.id)
        const p = r && r.progress
        if (!p) { noResume.add(song.id); return }
        const at = Number(p.position) || 0
        const d = Number(p.duration) || Number(song.interval) || 0
        if (at >= 5 && !(d > 0 && at >= d - 5)) pos = at
      } catch { return }
    }
    if (!pos || token !== resumeToken) return
    if (!current() || current().id !== song.id) return
    for (let i = 0; i < 15 && audio.readyState < 1; i++) {
      if (token !== resumeToken) return
      if (!current() || current().id !== song.id) return
      await new Promise(r => setTimeout(r, 200))
    }
    if (token !== resumeToken || !current() || current().id !== song.id) return
    if (audio.readyState < 1) return
    if (!audio.paused && audio.currentTime > 5) return    // 来得太晚，别打断
    try { audio.currentTime = pos } catch { return }
    paintProgress()
    syncLyric(pos)
    if (!forced) U.toast('已从 ' + U.formatTime(pos) + ' 接着播')
  }

  /* ---------------- UI 同步 ---------------- */

  function setPlayIcon(playing) {
    const path = playing
      ? '<path d="M7.5 5h3.4v14H7.5zM13.1 5h3.4v14h-3.4z" fill="currentColor" stroke="none"/>'
      : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>'
    if (dom.playIcon) dom.playIcon.innerHTML = path
    if (dom.miniPlayIcon) dom.miniPlayIcon.innerHTML = path
    dom.playerCover && dom.playerCover.classList.toggle('is-playing', playing)
    dom.miniCover && dom.miniCover.classList.toggle('is-playing', playing)
  }

  function paint(song) {
    if (!song) return
    // 大图给模糊背景与转盘，小图给迷你条 —— 各自取匹配的缩略尺寸，别让迷你条去下 500px 的图
    const coverBig = U.coverUrl(song, 500)
    const coverMini = U.coverUrl(song, 120)
    const bg = coverBig ? 'url(' + coverBig + ')' : ''
    if (dom.playerCover) dom.playerCover.style.backgroundImage = coverBig ? 'url(' + coverBig + ')' : ''
    if (dom.playerBg) {
      dom.playerBg.style.backgroundImage = bg
      dom.playerBg.style.filter = 'blur(0px)'
    }
    if (dom.miniCover) {
      dom.miniCover.style.backgroundImage = coverMini ? 'url(' + coverMini + ')' : ''
      dom.miniCover.classList.add('is-playing')
    }
    const name = song.name || '未知歌曲'
    const artist = song.singer || song.sourceName || ''
    if (dom.playerTitle) dom.playerTitle.textContent = name
    if (dom.playerArtist) dom.playerArtist.textContent = artist + (song.sourceName ? '  ·  ' + song.sourceName : '')
    if (dom.navTitle) dom.navTitle.textContent = name
    if (dom.navArtist) dom.navArtist.textContent = artist
    if (dom.miniTitle) dom.miniTitle.textContent = name
    if (dom.miniArtist) dom.miniArtist.textContent = artist
    if (dom.mini) dom.mini.hidden = false
    if (dom.qualityLabel) dom.qualityLabel.textContent = qualityName()
    updateFavIcon(song)
    document.title = name + ' - ' + artist
  }

  function updateFavIcon(song) {
    if (!dom.favIcon) return
    const on = song && state.favorites.has(song.id)
    dom.favIcon.innerHTML = on
      ? '<path d="M12 20s-7-4.6-7-9.6A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7 2.4c0 5-7 9.6-7 9.6z" fill="#ec4141" stroke="#ec4141" stroke-width="1.4"/>'
      : '<path d="M12 20s-7-4.6-7-9.6A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7 2.4c0 5-7 9.6-7 9.6z"/>'
    dom.favIcon.setAttribute('data-on', on ? '1' : '')
  }

  function renderMode() {
    if (!dom.btnMode) return
    const svg = dom.btnMode.querySelector('svg')
    if (svg) svg.innerHTML = MODE_ICON[state.mode] || MODE_ICON.order
    dom.btnMode.title = modeName()
  }

  const modeName = () => (MODES.find(m => m.key === state.mode) || MODES[0]).name
  const qualityName = () => (QUALITIES.find(q => q.key === state.quality) || QUALITIES[1]).name

  function paintProgress() {
    const dur = audio.duration || 0
    const cur = audio.currentTime || 0
    const ratio = dur > 0 ? Math.min(1, cur / dur) : 0
    const pct = (ratio * 100).toFixed(2) + '%'
    if (dom.progressFill) dom.progressFill.style.width = pct
    if (dom.progressThumb) dom.progressThumb.style.left = pct
    if (dom.miniProgress) dom.miniProgress.style.width = pct
    if (dom.curTime) dom.curTime.textContent = U.formatTime(cur)
    if (dom.totalTime) {
      const total = dur && isFinite(dur) ? dur : (current() && current().interval) || 0
      dom.totalTime.textContent = U.formatTime(total)
    }
  }

  /* ---------------- 控制 ---------------- */

  function play() {
    if (!current()) {
      if (state.queue.length) {
        if (state.index < 0) state.index = 0
        load(true)
        emit('queue', state.queue)
      }
      return
    }
    // 正在取流：只登记「取完就播」，绝不能在这里再触发一次 load() ——
    // 那会把已经设好的 src 清空（removeAttribute + load），表现为
    // paused=false 但 currentTime 永远不走。
    if (loading) { wantPlay = true; return }
    if (!audio.getAttribute('src')) { load(true); return }
    audio.play().catch(() => {})
  }
  function pause() {
    wantPlay = false
    clearStall()
    // 暂停是「用户离开」的最强信号，进度立刻落一次，别等 5 秒心跳
    flushProgress(audio.currentTime, audio.duration, true)
    audio.pause()
  }
  function toggle() { audio.paused ? play() : pause() }

  function seekRatio(ratio) {
    const dur = audio.duration || 0
    if (!dur) return
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * dur
    paintProgress()
    // 跳进度后歌词必须立刻跟上（同 seekRatioPreview，是另一条入口）
    syncLyric(audio.currentTime, true)
  }

  function setQuality(key) {
    if (!QUALITIES.some(q => q.key === key)) return
    state.quality = key
    U.store.set('lx.quality', key)
    if (dom.qualityLabel) dom.qualityLabel.textContent = qualityName()
    if (current()) {
      const wasPlaying = !audio.paused
      if (!wasPlaying) wantPlay = false     // 换音质时不要凭空开始播放
      keepPosition()                        // 听到一半换音质不该从头开始
      load(wasPlaying)
    }
    emit('quality', key)
  }

  function cycleQuality() {
    const i = QUALITIES.findIndex(q => q.key === state.quality)
    setQuality(QUALITIES[(i + 1) % QUALITIES.length].key)
    U.toast('音质：' + qualityName())
  }

  function setMode(key) {
    if (!MODES.some(m => m.key === key)) return
    state.mode = key
    U.store.set('lx.mode', key)
    renderMode()
    emit('mode', key)
  }

  function cycleMode() {
    const i = MODES.findIndex(m => m.key === state.mode)
    setMode(MODES[(i + 1) % MODES.length].key)
    U.toast('播放模式：' + modeName())
  }

  async function toggleFavorite(song) {
    const s = song || current()
    if (!s) return
    const on = state.favorites.has(s.id)
    try {
      if (on) {
        await API.removeFavorite(s.id)
        state.favorites.delete(s.id)
      } else {
        await API.addFavorite(s.id)
        state.favorites.add(s.id)
      }
      updateFavIcon(s)
      emit('favorite', { id: s.id, on: !on })
      U.toast(!on ? '已加入我喜欢的音乐' : '已取消收藏')
    } catch (e) {
      U.toast((e && e.message) || '操作失败')
    }
  }

  function setFavorites(list) {
    state.favorites = new Set((list || []).map(s => s.id || s))
    updateFavIcon(current())
    emit('favorite', null)
  }

  async function loadFavorites() {
    try {
      const res = await API.favorites()
      setFavorites(res.list || [])
    } catch { /* 未登录等 */ }
  }

  /* ---------------- 全屏播放器开合 ---------------- */

  function openPlayer() {
    if (!dom.player) return
    paint(current())            // 打开前对齐当前曲目，避免显示上一次的残留信息
    setPlayIcon(!audio.paused)
    dom.player.hidden = false
    dom.view && dom.view.classList.add('is-player-open')
    /**
     * 立刻按真实高度重摆一次歌词。
     *
     * 播放器关着时 `.player__lyric` 的高度是 0（display:none 的祖先），
     * 而歌词的 rAF 循环**不管你开没开播放器都在跑** —— 于是它一路按「高度 0」
     * 算位移。等用户再打开时，行号多半没变（一句歌词好几秒），
     * syncLyric 的短路会让它一直不重算，歌词就停在错的位置上。
     */
    realignLyric()
    requestAnimationFrame(() => {
      dom.player.classList.add('is-open')
      realignLyric()            // 入场动画期间尺寸可能还在变，再校一次更稳
    })
    emit('open')
  }
  function closePlayer() {
    if (!dom.player) return
    dom.player.classList.remove('is-open')
    dom.view && dom.view.classList.remove('is-player-open')
    setTimeout(() => { dom.player.hidden = true }, 340)
    emit('close')
  }
  function isPlayerOpen() { return !!(dom.player && dom.player.classList.contains('is-open')) }

  /* ---------------- 进度条拖拽 ---------------- */

  /** 拖动开始/结束。拖动时关掉歌词的过渡动画 —— 跟着手指走才跟手 */
  function setSeeking(on) {
    state.seeking = !!on
    if (dom.lyricScroll) dom.lyricScroll.style.transition = on ? 'none' : ''
  }

  function bindRange(node) {
    if (!node) return
    let dragging = false
    const ratioOf = (clientX) => {
      const rect = node.getBoundingClientRect()
      return rect.width ? (clientX - rect.left) / rect.width : 0
    }
    const move = (e) => {
      const pt = e.touches ? e.touches[0] : e
      seekRatioPreview(ratioOf(pt.clientX))
    }
    node.addEventListener('touchstart', (e) => { dragging = true; setSeeking(true); move(e) }, { passive: true })
    node.addEventListener('touchmove', (e) => { if (dragging) move(e) }, { passive: true })
    node.addEventListener('touchend', () => { dragging = false; setSeeking(false) })
    node.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return
      dragging = true; setSeeking(true); move(e)
      const up = () => { dragging = false; setSeeking(false); window.removeEventListener('pointermove', moveEvent); window.removeEventListener('pointerup', up) }
      const moveEvent = (ev) => { if (dragging) move(ev) }
      window.addEventListener('pointermove', moveEvent)
      window.addEventListener('pointerup', up)
    })
  }

  function seekRatioPreview(ratio) {
    const r = Math.max(0, Math.min(1, ratio))
    const dur = audio.duration || 0
    const pct = (r * 100).toFixed(2) + '%'
    if (dom.progressFill) dom.progressFill.style.width = pct
    if (dom.progressThumb) dom.progressThumb.style.left = pct
    if (dom.curTime) dom.curTime.textContent = U.formatTime(dur * r)
    if (dur) audio.currentTime = dur * r
    /**
     * 歌词要跟着进度条一起走。
     *
     * 不补这一句的话，拖动期间歌词是**完全不动**的：timeupdate 里有一道
     * `if (state.seeking) return`（防它和手指抢进度条），而 timeupdate 正是
     * 平时唯一驱动歌词的东西。用户看到的就是「进度条拖过去了，歌词还在原地」
     * —— 这也是「歌词和进度对照不住」的成因之一。
     */
    if (dur) syncLyric(audio.currentTime, true)
  }

  /* ---------------- 音频事件 ---------------- */

  audio.addEventListener('timeupdate', () => {
    // 拖动进度条期间不碰进度条与上报（和手指抢会抖），但**歌词照跟** ——
    // 这一条和 seekRatioPreview 里的那次是同一件事的两个入口，都不能少。
    if (!state.seeking) {
      paintProgress()
      // 进度上报搭 timeupdate 的车（约 4Hz），内部自己做 5 秒节流
      tickListening()
      flushProgress(audio.currentTime, audio.duration, false)
    }
    syncLyric(audio.currentTime)
  })
  audio.addEventListener('durationchange', paintProgress)
  audio.addEventListener('loadedmetadata', () => {
    clearStall()
    // 元数据一到手就知道总时长了 —— 是片段就**现在**说，别让用户白听 30 秒
    // 再被告知（判据与播完那次是同一份，重复调用由 snippetWarned 挡住）。
    warnIfSnippet()
    paintProgress()
  })
  audio.addEventListener('loadeddata', clearStall)
  audio.addEventListener('canplay', clearStall)
  audio.addEventListener('play', () => {
    // 单曲循环重播、或从队列外起播时，session 可能已被清掉，这里补开一轮
    beginSession(current())
    lastTickAt = Date.now()
    state.playing = true; setPlayIcon(true); emit('state', true); updateMediaSession(); startLyricLoop()
  })
  audio.addEventListener('pause', () => { state.playing = false; setPlayIcon(false); emit('state', false); updateMediaSession(); stopLyricLoop() })
  audio.addEventListener('ended', () => {
    stopLyricLoop()
    // 播完 = 最确定的一次「听过了」，先把这一条发出去再换歌
    flushProgress(audio.currentTime, audio.duration, true)
    warnIfSnippet()
    maybeStoreToCache()       // 整首听完才落缓存（见 audiocache.js 顶部「为什么不边听边存」）
    session = null            // 本轮到此为止；单曲循环由 play 事件重新开一轮
    resumeToken++             // 作废可能还在路上的续播请求
    next(false)
  })

  /**
   * 这首歌实播出来比它声明的短太多 —— 说清楚原因。
   *
   * 这是「同一首歌选不同音质长度不一样」这个问题的可见部分。真因在源侧：
   * 平台对没有播放权限的曲子只给**试听片段**（网易会明说：eapi 的
   * freeTrialInfo={start:0,end:30}，实测就是 470KB ≈ 30 秒），
   * 而完整曲目往往要由插件源给出。服务端现在会因此**多等一会儿**、
   * 优先挑完整版（见 src/lib/stream.js 的 looksLikeTrial / armSettle），
   * 但候选里要是真没有完整版，就只能放到这里 —— 此时**必须让用户知道
   * 是音源的问题、以及可以怎么绕**，否则他只会以为播放器坏了或者歌就是这样。
   *
   * **调用时机有两处，判据只有这一份**：
   *   · `loadedmetadata` —— 元数据一到位就知道时长，**提前**告知（2026-10-10 加）；
   *     以前只在播完时才提示，用户得先白听 30 秒才发现不对。
   *   · `ended` —— 兜底（`snippetWarned` 保证不会重复弹）。
   *
   * 判定要足够保守：只有「歌曲声明时长 > 60 秒」且「实播不到声明的六成」才提示，
   * 免得把正常短歌、纯音乐里的长静音误报成片段。
   */
  function warnIfSnippet() {
    if (snippetWarned) return                            // 同一个候选只提示一次
    const song = current()
    if (!song) return
    const declared = Number(song.interval) || 0          // 秒
    const played = Number(audio.duration) || 0
    if (declared < 60 || !played) return
    if (audio.dataset.cached === '1') return             // 本地缓存不算音源的锅
    if (played >= declared * SNIPPET_PLAYED_RATIO) return
    snippetWarned = true
    const why = looksLikeSnippet(lastHit)
      ? '当前音源只提供了试听片段'
      : '当前音源提供的内容不完整'
    U.toast('「' + song.name + '」' + why
      + '（' + Math.round(played) + 's / ' + declared + 's）——'
      + '可换个音质或换条音源再试', 6000)
    setFooter('音源：' + ((lastHit && lastHit.from) || '未知') + ' · 疑似试听片段')
  }
  audio.addEventListener('error', () => { if (audio.src) { stopLyricLoop(); handleError() } })
  audio.addEventListener('waiting', () => emit('buffering', true))
  audio.addEventListener('playing', () => { clearStall(); emit('buffering', false); emit('state', true) })

  /* ---------------- 系统媒体控制（PWA 锁屏 / 耳机按键） ---------------- */

  function updateMediaSession() {
    /**
     * 安卓壳里这一整套交给原生了（native.js 第 10 节）：
     * WebView 根本没实现 navigator.mediaSession，而原生侧有一套真的 MediaSession
     * 在喂通知栏 / 锁屏 / 控制中心。这道闸门是为了防止将来 WebView 补上这套 API 之后，
     * 系统里同时冒出两个媒体会话 —— 一个有封面一个没有，用户按哪个都别扭。
     */
    if (global.LX_NATIVE) return
    if (!('mediaSession' in navigator)) return
    const song = current()
    if (!song) return
    try {
      const cover = U.coverUrl(song, 500)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name || '',
        artist: song.singer || '',
        album: song.albumName || '',
        artwork: cover ? [{ src: cover, sizes: '500x500', type: 'image/jpeg' }] : [],
      })
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
    } catch { /* ignore */ }
  }

  if ('mediaSession' in navigator) {
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn) } catch { /* ignore */ } }
    set('play', () => play())
    set('pause', () => pause())
    set('previoustrack', () => prev(true))
    set('nexttrack', () => next(true))
    set('seekto', (d) => { if (d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime })
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    renderMode()
    if (dom.qualityLabel) dom.qualityLabel.textContent = qualityName()
    setPlayIcon(false)
    paintLyricCal()
    bindRange(dom.progressRange)

    // 歌词校准：− 提前 / + 延后，点数值复位到「同步」
    if (dom.lyricCalMinus) dom.lyricCalMinus.addEventListener('click', (e) => { e.stopPropagation(); nudgeLyricDelay(-1) })
    if (dom.lyricCalPlus) dom.lyricCalPlus.addEventListener('click', (e) => { e.stopPropagation(); nudgeLyricDelay(1) })
    if (dom.lyricCalVal) dom.lyricCalVal.addEventListener('click', (e) => {
      e.stopPropagation()
      setLyricDelay(0)
      U.toast('歌词偏移已复位')
    })

    if (dom.miniPlay) dom.miniPlay.addEventListener('click', (e) => { e.stopPropagation(); toggle() })
    if (dom.mini) dom.mini.addEventListener('click', openPlayer)
    const cover = dom.miniCover
    if (cover) cover.addEventListener('click', (e) => { e.stopPropagation(); openPlayer() })

    // 心跳最长有 5 秒空窗，切后台 / 关页面各补一条，否则「听完就切走」会丢进度。
    // 不用 sendBeacon：那个带不上 Authorization 头，会 401。
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushProgress(audio.currentTime, audio.duration, true)
    })
    window.addEventListener('pagehide', () => {
      flushProgress(audio.currentTime, audio.duration, true)
    })

    // 旋屏 / 窗口尺寸变化 → 可视区高度变了，歌词要重摆（行号通常没变，必须强制）
    window.addEventListener('resize', () => realignLyric())
    window.addEventListener('orientationchange', () => setTimeout(realignLyric, 120))

    const prevIdx = U.store.get('lx.index', -1)
    if (state.queue.length) {
      state.index = Math.max(0, Math.min(Number(prevIdx) || 0, state.queue.length - 1))
      paint(current())
      setFooter(current() ? '点击播放《' + current().name + '》' : '')
      emit('queue', state.queue)
    }
  }

  global.Player = {
    MODES, QUALITIES, MODE_ICON,
    state,
    on, emit,
    init,
    playList, playSong, enqueue, clearQueue, removeAt,
    play, pause, toggle, next, prev, seekRatio,
    setQuality, cycleQuality, setMode, cycleMode,
    toggleFavorite, setFavorites, loadFavorites,
    openPlayer, closePlayer, isPlayerOpen,
    current,
    syncLyric, setLyricDelay, nudgeLyricDelay, realignLyric,
    get lyricDelay() { return lyricDelay },
    LYRIC_DELAY_MAX, LYRIC_DELAY_STEP,
    get queue() { return state.queue },
    get index() { return state.index },
    get playing() { return state.playing && !audio.paused },
    get audio() { return audio },
    modeName, qualityName,
    // 播放进度（测试与调试用）
    flushProgress, beginSession,
    get progressSession() { return session },
    PROGRESS_INTERVAL, PLAYED_MIN_SEC, PLAYED_RATIO,
    // 音效：换音效后要按新设置重取一次流（直连 ⇄ 代理），换音质则保留位置
    reloadForTone, keepPosition,
    // 播放缓存 / 下载（见 public/js/audiocache.js）——
    // 这两件事都需要「按正常链路解析出一条可用地址」，而那条链路只在这里，
    // 所以由播放器暴露出去，而不是让缓存层自己重造一遍
    resolveForDownload,
  }

  /**
   * 按正常取流链路解析出一条**当前可下载**的地址。
   *
   * 缓存层不该知道「直连 / 插件 / 服务端代理」这三级的差别 —— 那是播放器的知识。
   * 这里复用同一套候选（顺带享受直连候选缓存），只把结果交给调用方。
   * @returns {Promise<{url:string, from:string}|null>}
   */
  async function resolveForDownload(song, quality) {
    if (!song) return null
    const keepQ = state.quality
    const keepOrder = order
    const keepCache = directCache
    try {
      if (quality && quality !== state.quality) state.quality = quality
      order = STAGES.slice()
      directCache = null
      await stageCandidates(song, 'direct')
      const hit = await advance(0, 0)
      return hit || null
    } catch {
      return null
    } finally {
      // 解析是「借」播放器的状态跑一遍，跑完必须还原 ——
      // 否则会串改用户当前正在听的音质或降级顺序
      state.quality = keepQ
      order = keepOrder
      directCache = keepCache
    }
  }
})(window)
