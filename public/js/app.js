/**
 * 云音乐 PWA — 路由与页面渲染
 * 首页版式严格对齐网易云音乐 App：
 *   顶部栏 → 金刚区 → 推荐歌单三列栅格 → 猜你喜欢歌曲列表
 */
(function (global) {
  'use strict'

  const { $, $$, el, escapeHtml: esc, coverUrl, coverTag, coverProxy, thumbUrl, upgradeCoverUrl, formatTime, formatCount, toast, store } = U

  const view = $('#view')
  const drawer = $('#drawer')
  const drawerTitle = $('#drawerTitle')
  const drawerBody = $('#drawerBody')
  const queueSheet = $('#queueSheet')
  const queueList = $('#queueList')
  const queueCount = $('#queueCount')

  /* ================= 全局状态 ================= */

  /**
   * 平台清单 —— 单一事实来源。
   * 搜索页的平台 chips、错误提示里的平台名、音源页的开关都从这里派生，
   * 以前这几处各写一份字面量，加了咪咕/喜马拉雅之后必然漏改某一处。
   */
  const PLATFORMS = [
    { key: 'wy', name: '网易云音乐', short: '网易' },
    { key: 'kg', name: '酷狗音乐', short: '酷狗' },
    { key: 'kw', name: '酷我音乐', short: '酷我' },
    { key: 'tx', name: 'QQ音乐', short: 'QQ' },
    { key: 'mg', name: '咪咕音乐', short: '咪咕' },
    { key: 'xm', name: '喜马拉雅', short: '喜马', audio: true },
  ]

  const platformNames = {}
  const platformShort = {}
  for (const p of PLATFORMS) { platformNames[p.key] = p.name; platformShort[p.key] = p.short }

  const App = {
    user: null,
    home: null,
    sources: [],
    platformNames,
    platformShort,
    loadedIcons: {},
  }

  /**
   * 能打开曲目的平台。
   * kw（酷我）与 mg（咪咕）的专辑曲目接口不可用（kw 要 csrf token、mg 路由不支持），
   * 实测结论见 src/providers/index.js 的 fetchAlbumTracks 注释。
   * 这类平台在专辑搜索结果里照常展示，但点进去会明确告知「打不开」，
   * 而不是给一个点了没反应的死卡片。
   */
  const ALBUM_TRACK_SOURCES = { kg: 1, wy: 1, tx: 1, xm: 1 }

  /** 页面内注册的歌曲列表：key -> songs，供事件委托按下标取用 */
  const lists = {}
  let listSeq = 0
  function registerList(key, songs) {
    const k = key || ('l' + (++listSeq))
    lists[k] = songs || []
    return k
  }

  /* ================= 图标 ================= */

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
    playAll: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8.6l6 3.4-6 3.4z" fill="currentColor" stroke="none"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-9.6A4.4 4.4 0 0 1 12 8a4.4 4.4 0 0 1 7 2.4c0 5-7 9.6-7 9.6z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M9.5 14.5l5-5"/><path d="M11 7l1.6-1.6a3.5 3.5 0 0 1 5 5L16 12"/><path d="M13 17l-1.6 1.6a3.5 3.5 0 0 1-5-5L8 12"/></svg>',
    plugin: '<svg viewBox="0 0 24 24"><path d="M9 4v4H5v4h4v4H5v4h4"/><path d="M15 4v16"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
    list: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M6.5 7l1 12h9l1-12"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    fire: '<svg viewBox="0 0 24 24"><path d="M12 3c3 3.6 5.5 6 5.5 9.8A5.5 5.5 0 0 1 12 18.5a5.5 5.5 0 0 1-5.5-5.7C6.5 9 9 6.6 12 3z"/><path d="M12 18.5c1.6 0 2.6-1.1 2.6-2.6 0-1.6-1.3-2.6-2.6-4-1.3 1.4-2.6 2.4-2.6 4 0 1.5 1 2.6 2.6 2.6z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    radio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9"/><path d="M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 19.5a10.6 10.6 0 0 0 0-15"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
    // 播放历史：表盘 + 逆时针回拨箭头，比「一个时钟」更能表达「回溯」
    history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7.4v5l3.2 1.9"/></svg>',
    // 唱片：一个圆 + 中心小圆 + 高光弧，比「一张方图」更像专辑
    album: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3a9 9 0 0 1 6.4 2.6"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 15V9h3l4-3v12l-4-3H4z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.8"/></svg>',
    logout: '<svg viewBox="0 0 24 24"><path d="M14 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7"/><path d="M17 8l4 4-4 4M21 12h-9"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="3.2"/><path d="M11.2 12H20M17 12v3M20 12v3"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.6 9.6A4.2 4.2 0 0 0 7 18z"/></svg>',
    empty: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>',
    // 自建歌单用到的三个：改名 / 调序 / 加进去了
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>',
    arrowDown: '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>',
  }

  /* ================= 路由 ================= */

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '') || '/'
    const [path, query] = raw.split('?')
    return { path: path || '/', q: new URLSearchParams(query || '') }
  }

  const ROUTES = {
    '/': () => pageHome(),
    '/search': (r) => pageSearch(r),
    '/album': (r) => pageAlbum(r),
    '/charts': () => pageCharts(),
    '/chart': (r) => pageChart(r),
    '/library': () => pageLibrary(),
    '/playlist': (r) => pagePlaylist(r),
    '/playlist-add': (r) => pagePlaylistAdd(r),
    '/favorite': () => pageFavorite(),
    '/history': () => pageHistory(),
    '/cache': () => pageCache(),
    '/import': () => pageImport(),
    '/ai': () => pageAi(),
    '/settings': (r) => pageSettings(r),
    '/mine': () => pageMine(),
    '/about': () => pageAbout(),
    '/login': () => pageLogin(),
    '/setup': () => pageSetup(),
  }

  let routeToken = 0

  async function route() {
    const r = parseHash()
    const token = ++routeToken
    const handler = ROUTES[r.path] || (() => pageNotFound())
    if (searchMoreObserver) { searchMoreObserver.disconnect(); searchMoreObserver = null }
    setActiveTab(r.path)
    setChrome(r.path)
    view.scrollTop = 0
    try {
      await handler(r)
    } catch (e) {
      if (token !== routeToken) return
      view.innerHTML = emptyState('出错了', esc((e && e.message) || String(e)))
    }
    if (token === routeToken) emitRoute(r)
  }

  function emitRoute(r) {
    document.dispatchEvent(new CustomEvent('lx:route', { detail: r }))
  }

  function setActiveTab(path) {
    const map = { '/': 'home', '/library': 'library', '/favorite': 'favorite', '/mine': 'mine' }
    const tab = map[path] || ''
    $$('#tabbar .tabbar__item').forEach(a => a.classList.toggle('is-active', a.dataset.tab === tab))
  }

  /** 顶层 tab 页（有底部标签栏的那几个）保留全局顶栏 */
  const TAB_PATHS = ['/', '/library', '/favorite', '/mine']

  /**
   * 二级页隐藏全局顶栏。
   * 二级页（搜索 / 榜单 / 设置 …）自己就有 .searchbar 头部（返回箭头 + 标题 / 输入框），
   * 再叠一个全局顶栏就会出现「上下两个搜索框」，而且上面那个点了只是跳 #/search，
   * 在搜索页等于原地不动 —— 也就是"上面那个不管用"。
   */
  function setChrome(path) {
    const app = document.getElementById('app')
    if (app) app.classList.toggle('is-subpage', TAB_PATHS.indexOf(path) < 0)
  }

  const go = (hash) => { location.hash = hash }
  const back = () => { if (history.length > 1) history.back(); else go('#/') }

  /* ================= 通用片段 ================= */

  function emptyState(title, desc, action) {
    return '<div class="empty">' + ICON.empty
      + '<div class="empty__title">' + esc(title) + '</div>'
      + (desc ? '<div class="empty__desc">' + desc + '</div>' : '')
      + (action || '') + '</div>'
  }

  function skeleton(rows) {
    return '<div class="skeleton">' + new Array(rows || 6).fill('<div class="skeleton__row"></div>').join('') + '</div>'
  }

  function pageHeader(title, right) {
    return '<div class="searchbar">'
      + '<button class="icon-btn searchbar__back" data-act="back" aria-label="返回">' + ICON.back + '</button>'
      + '<div style="flex:1;font-size:17px;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(title) + '</div>'
      + (right || '')
      + '</div>'
  }

  /**
   * 歌曲行
   * @param song   songForWeb 结构
   * @param opts   { list, i, index, showCover, numbered }
   */
  function songRow(song, opts) {
    const o = opts || {}
    const acts = []
    if (o.showFav !== false) acts.push('<button class="song__act" data-act="fav" data-id="' + esc(song.id) + '" aria-label="收藏">' + ICON.heart + '</button>')
    acts.push('<button class="song__act" data-act="song-menu" data-list="' + esc(o.list) + '" data-i="' + o.i + '" aria-label="更多">' + ICON.more + '</button>')

    const idx = o.index || (o.numbered ? o.i + 1 : 0)
    const index = idx
      ? '<div class="song__index' + (idx <= 3 ? ' is-top' : '') + '">' + idx + '</div>'
      : (o.showCover ? '<div class="song__cover">' + coverTag(song.img, song.name, 120) + '</div>' : '')

    const duration = song.interval ? '<span class="dot">·</span>' + formatTime(song.interval) : ''

    return '<div class="song' + (o.showCover ? ' song--rich' : '') + '" data-list="' + esc(o.list) + '" data-i="' + o.i + '">'
      + index
      + '<div class="song__meta">'
      + '<div class="song__name">' + esc(song.name || '未知歌曲') + '</div>'
      + '<div class="song__sub">' + esc(song.singer || '未知歌手') + duration + '</div>'
      + '</div>'
      + '<div class="song__acts">' + acts.join('') + '</div>'
      + '</div>'
  }

  function songList(songs, listKey, opts) {
    const o = opts || {}
    if (!songs || !songs.length) return emptyState(o.emptyTitle || '暂无歌曲', o.emptyDesc || '')
    return '<div class="songlist">' + songs.map((s, i) =>
      songRow(s, Object.assign({ list: listKey, i }, o.row || {}))
    ).join('') + '</div>'
  }

  /**
   * 歌单/榜单卡片（三列栅格，带播放量角标，对齐网易云「推荐歌单」）
   *
   * 传入 item.id + item.source 时，卡片会带上 data-chart，稍后由
   * upgradeChartCovers() 把官方榜单设计图换成「榜首单曲的专辑封面」并补一行歌手名 ——
   * 网易云官方榜单单图是纯色块，铺成三列整屏都是色块，看着跟没图一样。
   */
  function playlistCard(item, href) {
    const ref = item.id && item.source ? item.source + ':' + item.id : ''
    return '<a class="card" href="' + esc(href) + '"' + (ref ? ' data-chart="' + esc(ref) + '"' : '') + '>'
      + '<div class="card__cover">'
      + coverTag(item.cover, item.name, 300)
      + (item.count ? '<span class="card__badge">' + ICON.play.replace('<svg', '<svg style="fill:currentColor;stroke:none"') + formatCount(item.count) + '</span>' : '')
      + '<span class="card__badge card__badge--play">' + ICON.play + '</span>'
      + '</div>'
      + '<div class="card__title">' + esc(item.name) + '</div>'
      + '<div class="card__sub" hidden></div>'
      + '</a>'
  }

  /* ---------- 榜单卡片头图：换成榜首单曲的专辑封面 ---------- */

  const HEAD_KEY = 'lx.chartHead'
  const HEAD_TTL = 12 * 3600 * 1000
  const HEAD_BATCH = 8            // 与服务端 CHART_HEAD_MAX_IDS 对齐

  function applyChartHead(el, head) {
    if (!el || !head || !head.cover) return
    const img = el.querySelector('.card__cover img')
    if (!img) return
    const url = upgradeCoverUrl(head.cover)
    const direct = /^https:/i.test(url)
    // 换新图：src 与回退地址必须成对换掉，只换 src 的话直连失败会退回上一张图
    img.dataset.fallback = coverProxy(url, 300)
    img.removeAttribute('data-fallback-used')
    img.style.opacity = ''
    img.src = direct ? thumbUrl(url, 300) : coverProxy(url, 300)
    const sub = el.querySelector('.card__sub')
    if (sub) {
      const who = [head.artist, head.song].filter(Boolean).join(' · ')
      if (who) { sub.textContent = '#1 ' + who; sub.hidden = false }
    }
    el.dataset.headDone = '1'
  }

  /**
   * 把当前视图里的榜单卡片逐批升级成「歌手专辑封面」。
   * 先命中 localStorage 缓存立刻换；剩下的分批（8 个/次）串行拉，
   * 这样首屏不会被几十个榜单的请求卡住，卡片是「一张一张变好看」。
   */
  async function upgradeChartCovers(root) {
    const els = $$('[data-chart]', root || view).filter(el => !el.dataset.headQueued && !el.dataset.headDone)
    if (!els.length) return
    const cache = U.store.get(HEAD_KEY, {}) || {}
    const now = Date.now()
    const pending = []
    for (const el of els) {
      el.dataset.headQueued = '1'
      const hit = cache[el.dataset.chart]
      if (hit && now - hit.ts < HEAD_TTL) applyChartHead(el, hit)
      else pending.push(el)
    }
    if (!pending.length) return

    let dirty = false
    try {
      for (let i = 0; i < pending.length; i += HEAD_BATCH) {
        const chunk = pending.slice(i, i + HEAD_BATCH)
        if (!document.body.contains(chunk[0])) break   // 页面已切走，别再拉了
        let covers = {}
        try {
          const res = await API.chartCovers(chunk.map(el => el.dataset.chart))
          covers = (res && res.covers) || {}
        } catch { break }                              // 网络抖动就放弃，卡片保留官方图
        for (const el of chunk) {
          const head = covers[el.dataset.chart]
          if (!head) { el.dataset.headDone = '1'; continue }
          applyChartHead(el, head)
          cache[el.dataset.chart] = Object.assign({ ts: Date.now() }, head)
          dirty = true
        }
      }
    } finally {
      if (dirty) { try { U.store.set(HEAD_KEY, cache) } catch { /* 配额满忽略 */ } }
    }
  }

  function sectionHead(title, more) {
    return '<div class="section__head"><div class="section__title">' + esc(title) + '</div>'
      + (more || '') + '</div>'
  }

  /* ================= 首页（对齐网易云首页） ================= */

  const QUICKS = [
    { key: 'daily', label: '每日推荐', cls: 'c-red', icon: 'calendar' },
    { key: 'charts', label: '排行榜', cls: 'c-orange', icon: 'chart' },
    { key: 'album', label: '搜专辑', cls: 'c-green', icon: 'album' },
    { key: 'ai', label: 'AI 歌单', cls: 'c-teal', icon: 'sparkle' },
    { key: 'import', label: '歌单导入', cls: 'c-blue', icon: 'link' },
    { key: 'favorite', label: '我的收藏', cls: 'c-pink', icon: 'heart' },
    // 原来这里是「音源插件」—— 服务端插件已经收进管理端 /admin，
    // 金刚区留给用户自己会反复用的功能：看看听到哪儿了。
    { key: 'history', label: '播放历史', cls: 'c-purple', icon: 'history' },
  ]

  async function pageHome() {
    const cached = App.home
    renderHome(cached)
    if (cached) return
    try {
      const data = await API.home()
      App.home = data
      if (parseHash().path !== '/') return
      // 骨架 → 内容的交叉过渡：先让骨架淡出，再换上真内容。
      // 不这么做的话，数据回来那一下是「骨架瞬间消失 + 内容瞬间出现」，
      // 在慢网（数据要等几秒）时这个硬切特别刺眼。
      if (!view.querySelector('.skeleton')) { renderHome(data); return }
      await new Promise((resolve) => fadeOutSkeleton(view, resolve))
      if (parseHash().path !== '/') return
      renderHome(data)
    } catch (e) {
      if (parseHash().path !== '/') return
      view.innerHTML = emptyState('首页加载失败', esc((e && e.message) || '请检查网络后重试'), '<button class="btn btn--sm" data-act="reload-home" style="margin-top:14px">重新加载</button>')
    }
  }

  /** 每日推荐 banner 的一句描述：AI 生成时把标题亮出来，兜底时亮关键词 */
  function dailyDesc(data) {
    if (!data) return '正在为你挑选今日歌曲…'
    const n = data.hot ? data.hot.length : 0
    const src = data.daily && data.daily.generator === 'ai' ? '按你的歌单与播放记录挑的' : '今日为你精选'
    return '「' + data.keyword + '」· ' + src + ' ' + n + ' 首'
  }

  function renderHome(data) {
    const quickbar = '<div class="quickbar">' + QUICKS.map(q =>
      '<a class="quick" href="javascript:void(0)" data-quick="' + q.key + '">'
      + '<span class="quick__icon ' + q.cls + '">' + ICON[q.icon] + '</span>'
      + '<span class="quick__label">' + q.label + '</span>'
      + '</a>').join('') + '</div>'

    // Banner 用今日第一首推荐歌的封面：一张底图 + 右侧封面缩略图，
    // 比纯红渐变块有内容感（拿不到封面时退回原来的日历图标）
    const bannerSong = (data && data.hot && data.hot[0]) || null
    const bannerBg = bannerSong && bannerSong.img
      ? '<div class="banner__bg" style="--banner-bg:url(' + esc(coverUrl(bannerSong.img, 500)) + ')"></div>'
      : ''
    const bannerArt = bannerSong && bannerSong.img
      ? '<div class="banner__art banner__art--img">' + coverTag(bannerSong.img, '', 200) + '</div>'
      : '<div class="banner__art">' + ICON.calendar + '</div>'

    const banner = '<div class="banner"><div class="banner__inner">'
      + bannerBg
      + '<div class="banner__body"><div class="banner__title">每日推荐</div>'
      + '<div class="banner__desc">' + esc(dailyDesc(data)) + '</div>'
      + '<a class="banner__btn" href="javascript:void(0)" data-quick="daily">' + ICON.play + '立即播放</a>'
      + '<a class="banner__btn banner__btn--refresh" href="javascript:void(0)" data-quick="daily-refresh" id="dailyRefresh">' + ICON.refresh + '换一批</a></div>'
      + bannerArt
      + '</div></div>'

    const charts = (data && data.charts) || []
    const hot = (data && data.hot) || []
    const hotKey = registerList('home-hot', hot)

    const chartsSection = charts.length
      ? '<section class="section">' + sectionHead('推荐歌单',
        '<a class="section__more" href="#/charts">更多' + ICON.chevron + '</a>')
      + '</section><div class="grid3">'
      + charts.map(c => playlistCard(
        { name: c.name, cover: c.cover, count: c.playCount, id: c.id, source: c.source },
        '#/chart?id=' + encodeURIComponent(c.id) + '&source=' + c.source
      )).join('')
      + '</div>'
      : ''

    const hotSection = hot.length
      ? '<section class="section">' + sectionHead('猜你喜欢', '<a class="section__more" href="javascript:void(0)" data-act="play-list" data-list="' + hotKey + '">播放全部</a>')
      + '</section>' + songList(hot.slice(0, 12), hotKey, { row: { numbered: true } })
      + (hot.length > 12 ? '<div style="text-align:center;padding:6px 0 18px"><a class="btn btn--ghost btn--sm" href="#/search?q=' + encodeURIComponent((data && data.keyword) || '') + '">查看全部 ' + hot.length + ' 首</a></div>' : '')
      : (data ? emptyState('暂无推荐', '换个关键词搜索试试') : skeleton(4))

    view.innerHTML = quickbar + banner + chartsSection + hotSection
    playHomeEnter()
    // 不 await：头图是锦上添花，不能拖住首页首屏
    upgradeChartCovers().catch(() => {})
  }

  /**
   * 首页入场动画。
   *
   * 只在「首次把首页画出来」这一下播（见下面 homeEntered 的判断）——
   * 从搜索页/设置页返回首页时重播会变成噪音，同一段动画看第三遍就只剩烦。
   *
   * 实现上注意两点：
   *   · 必须等这一帧的布局稳定后再加类。紧挨着 innerHTML 赋值就加，浏览器会把
   *     「初始态 + 目标态」合并成一次计算，动画根本不跑（表现为内容直接出现）。
   *   · 动画结束后把类摘掉，避免它长期挂在 DOM 上影响后续的样式匹配。
   */
  let homeEntered = false

  function playHomeEnter() {
    if (homeEntered) return
    homeEntered = true
    // 系统开了「减少动态效果」就干脆不加类 —— CSS 那边也有兜底，
    // 但在 JS 层就拦住更彻底（连动画事件都不会产生）
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    } catch { /* 老浏览器没有 matchMedia，继续播 */ }
    requestAnimationFrame(() => {
      if (parseHash().path !== '/') return
      view.classList.add('is-entering')
      const done = () => view.classList.remove('is-entering')
      // 兜底定时器：万一 animationend 因为元素被替换而没触发，
      // 类不能永远挂着（那样后续再进首页会被当成「已播过」而不播）
      setTimeout(done, 700)
      const first = view.firstElementChild
      if (first) first.addEventListener('animationend', done, { once: true })
    })
  }

  /** 骨架屏退场：淡出之后再换内容，避免中间闪一下白 */
  function fadeOutSkeleton(box, done) {
    if (!box) { if (done) done(); return }
    const sk = box.querySelector && box.querySelector('.skeleton')
    if (!sk) { if (done) done(); return }
    sk.classList.add('is-out')
    setTimeout(() => { if (done) done() }, 180)
  }

  function handleQuick(key) {
    const hot = (App.home && App.home.hot) || []
    switch (key) {
      case 'daily':
      case 'radio': {
        if (!hot.length) { toast('推荐歌曲还在加载中'); return }
        const start = key === 'radio' ? Math.floor(Math.random() * hot.length) : 0
        Player.playList(hot, start)
        toast(key === 'radio' ? '私人漫游：随机播放' : '播放今日推荐')
        break
      }
      // 每日推荐「换一批」：强制重生成当天的推荐（AI 按歌单名 + 播放记录）。
      // AI 生成要 30~90s，按钮禁用 + toast 说清楚，别让人以为点了没反应。
      case 'daily-refresh': {
        const btn = document.getElementById('dailyRefresh')
        if (btn && btn.dataset.busy === '1') return
        if (btn) { btn.dataset.busy = '1'; btn.style.opacity = '.5' }
        toast('正在按你的口味换一批，大约需要一分钟…')
        API.dailyRefresh().then(data => {
          App.home = Object.assign({}, App.home || {}, { hot: data.songs || [], keyword: data.title || '每日推荐', daily: { generator: data.generator, generatedAt: data.generatedAt, date: data.date } })
          if (parseHash().path === '/') renderHome(App.home)
          toast('换好了：' + (data.title || '新一批推荐'))
        }).catch(e => {
          toast('换一批失败：' + ((e && e.message) || '稍后再试'))
        }).finally(() => {
          if (btn) { btn.dataset.busy = ''; btn.style.opacity = '' }
        })
        break
      }
      case 'charts': go('#/charts'); break
      // 首页金刚区的「搜专辑」：直接进搜索页并把类型切到专辑，
      // 省掉「先进搜索页、再找那个小 chip」这一步 —— 之前专辑搜索就是藏得太深。
      case 'album': go('#/search?type=album'); break
      case 'ai': go('#/ai'); break
      case 'import': go('#/import'); break
      case 'favorite': go('#/favorite'); break
      case 'history': go('#/history'); break
      default: break
    }
  }

  /* ================= 搜索 ================= */

  const searchState = { q: '', source: '', type: 'song', page: 1, list: [], total: 0, loading: false, done: false, key: '' }

  /** 搜索类型：单曲 / 专辑。专辑走各平台的 searchAlbum，见 src/providers/index.js */
  const SEARCH_TYPES = [
    { key: 'song', name: '单曲' },
    { key: 'album', name: '专辑' },
  ]

  /**
   * 「上拉加载更多」的硬顶。
   *
   * 综合搜索每页都是各平台各取一段再交错合并，只要还有源在返回，
   * 合并后总能凑满 limit —— 光看「本页条数 < limit」永远等不到「已加载全部」，
   * 于是用户越拉越多、没完没了（原来的 bug）。现在的终止条件见 loadSearchPage：
   *   ① 本页去重后一条新的都没有 → 到底了；
   *   ② 各平台原始返回合计不足一页 → 到底了；
   *   ③ 翻到 MAX_SEARCH_PAGE 页 → 强制收尾（防止某个源无限翻页）。
   */
  const MAX_SEARCH_PAGE = 20

  /** 搜索框占位文案跟着「类型 + 平台」走，别让人以为只能搜歌 */
  function searchPlaceholder(type, source) {
    if (type === 'album') return source === 'xm' ? '搜索有声书 / 播客专辑' : '搜索专辑'
    if (source === 'xm') return '搜索单集、有声书、播客'
    return '搜索歌曲、歌手、专辑'
  }

  async function pageSearch(r) {
    const q = r.q.get('q') || ''
    const source = r.q.get('source') || ''
    const type = r.q.get('type') === 'album' ? 'album' : 'song'
    searchState.q = q
    searchState.source = source
    searchState.type = type

    // 平台 chips：7 个（综合 + 六平台）在一行里**等分**排开。
    // 不能用默认的 flex-wrap —— 7 个 2 字 chip 在 390px 屏上刚好放不下，
    // 会换行把最后一个（喜马拉雅）单独甩到第三行，看着像一个走错片场的标签，
    // 用户会以为「搜索里没有喜马拉雅」。等分 + nowrap 保证七个都露在同一行。
    const platformChips = [{ key: '', name: '综合' }].concat(
      PLATFORMS.map(p => ({ key: p.key, name: p.short }))
    )

    const bar = '<div class="searchbar">'
      + '<button class="icon-btn searchbar__back" data-act="back" aria-label="返回">' + ICON.back + '</button>'
      + '<input class="searchbar__input" id="searchInput" type="search" enterkeyhint="search" placeholder="'
      + esc(searchPlaceholder(type, source)) + '" value="' + esc(q) + '">'
      + '<button class="searchbar__btn" data-act="do-search">搜索</button>'
      + '</div>'
      + '<div class="chips chips--tight">' + SEARCH_TYPES.map(t =>
        '<button class="chip' + (t.key === type ? ' is-active' : '') + '" data-act="switch-type" data-type="' + t.key + '">' + t.name + '</button>'
      ).join('') + '</div>'
      + '<div class="chips chips--fit">' + platformChips.map(c =>
        '<button class="chip' + (c.key === source ? ' is-active' : '') + '" data-act="switch-source" data-source="' + c.key + '">' + c.name + '</button>'
      ).join('') + '</div>'

    if (!q) {
      let history = []
      try { history = (await API.history()).list || [] } catch { /* ignore */ }
      view.innerHTML = bar
        + (history.length
          ? '<section class="section">' + sectionHead('搜索历史', '<a class="section__more" href="javascript:void(0)" data-act="clear-history">清空</a>') + '</section>'
            + '<div class="chips">' + history.slice(0, 20).map(h => {
              const kw = h.keyword || h
              const href = '#/search?q=' + encodeURIComponent(kw) + (type === 'album' ? '&type=album' : '')
              return '<span class="chip chip--del">'
                + '<a href="' + href + '">' + esc(kw) + '</a>'
                + '<button class="chip__del" data-act="del-history" data-keyword="' + esc(kw) + '" aria-label="删除">&times;</button>'
                + '</span>'
            }).join('') + '</div>'
          : '<section class="section">' + sectionHead('热门搜索') + '</section>'
            + '<div class="chips">' + ['周杰伦', '邓紫棋', '林俊杰', '薛之谦', '五月天', '陈奕迅', '毛不易', '刘德华', '纯音乐', '粤语经典']
              .map(k => '<a class="chip" href="#/search?q=' + encodeURIComponent(k) + (type === 'album' ? '&type=album' : '') + '">' + k + '</a>').join('') + '</div>')
      focusSearchInput()
      return
    }

    view.innerHTML = bar + '<div id="searchResult">' + skeleton(5) + '</div>'
    focusSearchInput()
    searchState.page = 1
    searchState.list = []
    searchState.total = 0
    searchState.done = false
    // 进页面时无条件把闸门放开。
    // loadSearchPage 的第一行是 `if (loading || done) return` —— 这是防重入用的，
    // 但万一上一页有个请求没正常收尾（网络挂死、切页时被打断），
    // 这个标志会把新页面也一起锁死：搜索结果区永远停在骨架屏上，
    // 用户看到的就是「一直加载不出来」。进页面重置一次，成本为零，保险得多。
    searchState.loading = false
    await loadSearchPage(false)
  }

  function focusSearchInput() {
    const input = $('#searchInput')
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch() })
      if (!input.value) setTimeout(() => input.focus(), 120)
    }
  }

  /**
   * 平台报错提示：压缩成一行可读文案（谁挂了、为什么），
   * 原始诊断收进可展开区 —— 排查时有用，但不再把几百字 HTTP 诊断泼在界面上。
   */
  function errorNote(errors) {
    if (!errors || !errors.length) return ''
    const items = errors.map((raw) => {
      const text = String(raw)
      const m = text.match(/^([A-Za-z]{2,8})[:：]\s*([\s\S]*)$/)
      const key = m ? m[1] : ''
      const detail = m ? m[2] : text
      const name = (App.platformShort && App.platformShort[key]) || key || '部分平台'
      const brief = /(http=(4|5)\d\d|code=null|接口受限|超时|timeout|fail)/i.test(detail)
        ? '接口受限，本次未返回结果'
        : '未返回结果'
      return { name, brief, detail }
    })
    const short = items.map(i => i.name + ' ' + i.brief).join('；')
    const full = items.map(i => i.name + '：' + i.detail).join('\n')
    return '<details class="errdetail"><summary>' + esc(short) + '</summary>'
      + '<pre class="errdetail__raw">' + esc(full) + '</pre></details>'
  }

  /**
   * 专辑卡片（三列栅格）。
   * 能打开曲目的平台点进去是专辑详情；kw / mg 的曲目接口不可用，
   * 卡片照常展示（搜索本身是好的），但带一枚「曲目不可用」角标，点了给明确提示。
   */
  function albumCard(a) {
    const openable = !!ALBUM_TRACK_SOURCES[a.source]
    const sub = [a.singer, a.publishDate].filter(Boolean).join(' · ')
    // 有的平台（实测是喜马拉雅的部分条目）整张专辑就是没有封面图，
    // 不给占位的话那一格是纯色空块，混在一排封面里像破图。给个唱片图标。
    const cover = coverTag(a.img, a.name, 300) || ('<span class="cover-ph">' + ICON.album + '</span>')
    const inner = '<div class="card__cover">'
      + cover
      + (a.trackCount ? '<span class="card__badge">' + a.trackCount + ' 首</span>' : '')
      + (openable ? '' : '<span class="card__badge card__badge--warn">曲目不可用</span>')
      + '</div>'
      + '<div class="card__title">' + esc(a.name) + '</div>'
      + '<div class="card__sub"' + (sub ? '' : ' hidden') + '>'
      + esc(sub) + '<span class="dot">·</span>' + esc(App.platformShort[a.source] || a.source)
      + '</div>'

    return openable
      ? '<a class="card" href="#/album?source=' + encodeURIComponent(a.source)
        + '&id=' + encodeURIComponent(a.id) + '&name=' + encodeURIComponent(a.name) + '">' + inner + '</a>'
      : '<a class="card card--blocked" href="javascript:void(0)" data-act="album-blocked" data-source="' + esc(a.source) + '">' + inner + '</a>'
  }

  function albumGrid(albums, emptyTitle, emptyDesc) {
    if (!albums || !albums.length) return emptyState(emptyTitle || '没有找到专辑', emptyDesc || '')
    return '<div class="grid3" style="padding-top:12px">'
      + albums.map(albumCard).join('')
      + '</div><div style="height:16px"></div>'
  }

  /**
   * 「这一页之后还有没有下一首」—— 抽成纯函数，便于回归测试直接钉住三个分支。
   *
   *   ① fresh == 0          本页去重后一条新的都没有（各平台都翻到头了）
   *   ② raw < limit         各平台原始返回合计都不满一页，再翻也是空的
   *   ③ page >= 硬顶        某个源不认 page、每页都吐同样一坨，必须强制收尾
   *
   * 原来只判「本页条数 < limit」：综合搜索是各平台各取一段再交错合并，
   * 只要还有源在返回就总能凑满 limit，于是永远显示「上拉加载更多…」，没完没了。
   */
  function searchPageDone(fresh, rawCount, limit, page) {
    return fresh <= 0 || rawCount < limit || page >= MAX_SEARCH_PAGE
  }

  async function loadSearchPage(append) {
    if (searchState.loading || searchState.done) return
    searchState.loading = true
    const box = $('#searchResult')
    if (append && box) box.insertAdjacentHTML('beforeend', skeleton(2))
    const album = searchState.type === 'album'
    const limit = album ? 20 : 30
    try {
      const res = album
        ? await API.searchAlbums(searchState.q, { source: searchState.source, page: searchState.page, limit })
        : await API.search(searchState.q, { source: searchState.source, page: searchState.page, limit })
      const got = (res.list || []).filter(s => s && s.id)
      // 按 id 去重合并 —— 综合搜索里同一个平台的结果可能在相邻两页重复出现，
      // 直接 concat 会在列表里叠出一串一模一样的歌。
      const keyOf = (s) => s.source + ':' + s.id
      const seen = {}
      for (const s of searchState.list) seen[keyOf(s)] = 1
      // 同一页内部也可能重复（不同插件返回同一首），这里一并压掉
      const fresh = []
      for (const s of got) {
        const k = keyOf(s)
        if (seen[k]) continue
        seen[k] = 1
        fresh.push(s)
      }
      searchState.list = append ? searchState.list.concat(fresh) : fresh
      searchState.total = res.total || searchState.list.length
      searchState.page = res.page || searchState.page

      // 到底了没？三个判据见 searchPageDone 上方注释
      const rawCount = (res.list || []).length
      if (searchPageDone(fresh.length, rawCount, limit, searchState.page)) {
        searchState.done = true
      }

      const key = registerList('search-' + searchState.q + '-' + searchState.source, searchState.list)
      searchState.key = key
      const errors = errorNote(res.errors)
      if (box) {
        const unit = album ? ' 张' : ' 首'
        const empty = album
          ? emptyState('没有找到专辑「' + searchState.q + '」', '换个关键词，或把平台切到「综合」再试')
          : emptyState('没有找到「' + searchState.q + '」', '试试更换关键词，或切换其它音源平台')
        box.innerHTML = searchState.list.length
          ? (album ? albumGrid(searchState.list) : songList(searchState.list, key, { row: { showCover: true } }))
            + (searchState.done
              ? '<div class="note" style="text-align:center;padding:14px">已加载全部 ' + searchState.list.length + unit + '</div>'
              : '<div class="note" id="searchMore" style="text-align:center;padding:14px">上拉加载更多…</div>')
          : errors + empty
      }
    } catch (e) {
      if (box) box.innerHTML = emptyState('搜索失败', esc((e && e.message) || '请重试'))
    } finally {
      searchState.loading = false
      bindSearchMore()
    }
  }

  /**
   * 「上拉加载更多」的触发。
   *
   * 之前 #searchMore 只是画了一行字，没有任何监听 —— 翻页逻辑写了但从不触发，
   * 搜索结果永远停在第一页。这里用 IntersectionObserver 盯住它：
   * 每次渲染完重新绑定（box.innerHTML 会换掉节点），滚到底部附近就接着拉下一页。
   */
  let searchMoreObserver = null

  function bindSearchMore() {
    if (searchMoreObserver) { searchMoreObserver.disconnect(); searchMoreObserver = null }
    const more = $('#searchMore')
    if (!more || !('IntersectionObserver' in window)) return
    searchMoreObserver = new IntersectionObserver((entries) => {
      if (searchState.done || searchState.loading) return
      if (searchState.page >= MAX_SEARCH_PAGE) { searchState.done = true; return }
      if (entries.some(en => en.isIntersecting)) {
        searchState.page++
        loadSearchPage(true)
      }
    }, { root: view, rootMargin: '240px' })
    searchMoreObserver.observe(more)
  }

  /* ================= 专辑详情 ================= */

  /**
   * 打开一张专辑 = 列出它的全部曲目，可以直接「播放全部」或整个收藏成歌单。
   * 打不开时（kw / mg）给一条明确出路：换平台搜同名专辑，而不是留个空白页。
   */
  async function pageAlbum(r) {
    const source = r.q.get('source') || ''
    const id = r.q.get('id') || ''
    const name = r.q.get('name') || ''
    const title = name || '专辑'

    if (!source || !id) {
      view.innerHTML = pageHeader(title) + emptyState('参数不完整', '缺少 source 或 id')
      return
    }

    view.innerHTML = pageHeader(title) + skeleton(6)
    try {
      const res = await API.albumTracks(source, id, 200)
      const album = res.album || {}
      const songs = album.songs || []
      const key = registerList('album-' + source + '-' + id, songs)
      const who = [album.singer, album.publishDate].filter(Boolean).join(' · ')
      view.innerHTML = pageHeader(album.name || title)
        + '<div class="block" style="display:flex;gap:14px;align-items:center">'
        + '<div class="card__cover" style="width:92px;flex:0 0 92px;border-radius:10px;overflow:hidden;background:#f0f0f2">'
        + coverTag(album.cover, album.name || title, 300) + '</div>'
        + '<div style="min-width:0">'
        + '<div style="font-size:17px;font-weight:700;margin-bottom:4px">' + esc(album.name || title) + '</div>'
        + (who ? '<div class="note">' + esc(who) + '</div>' : '')
        + '<div class="note">共 ' + songs.length + ' 首 · 来源 ' + esc(App.platformNames[source] || source) + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '<button class="btn btn--sm" data-act="play-list" data-list="' + key + '">' + ICON.play + '播放全部</button>'
        + '<button class="btn btn--sm btn--ghost" data-act="import-to" data-list="' + key + '" data-name="' + esc(album.name || title) + '">收藏到歌单</button>'
        + '</div></div></div>'
        + songList(songs, key, { row: { numbered: true } })
    } catch (e) {
      const msg = (e && e.message) || '未知错误'
      view.innerHTML = pageHeader(title)
        + emptyState('打不开这张专辑', msg)
        + '<div style="display:flex;gap:8px;justify-content:center;padding:0 14px 24px">'
        + '<a class="btn btn--sm btn--ghost" href="#/search?q=' + encodeURIComponent(title) + '&type=album">换个平台搜同名专辑</a>'
        + '<a class="btn btn--sm btn--ghost" href="#/search?q=' + encodeURIComponent(title) + '">按单曲搜索</a>'
        + '</div>'
    }
  }

  /** 把搜索态拼成 hash —— source / type 一律跟着状态走，避免切一次平台就丢一次类型 */
  function searchHash(q, source, type) {
    return '#/search?q=' + encodeURIComponent(q)
      + (source ? '&source=' + encodeURIComponent(source) : '')
      + (type === 'album' ? '&type=album' : '')
  }

  function doSearch(keyword) {
    const input = $('#searchInput')
    const q = (keyword !== undefined ? keyword : (input && input.value) || '').trim()
    if (!q) { toast('请输入关键词'); return }
    go(searchHash(q, searchState.source, searchState.type))
  }

  /* ================= 榜单 ================= */

  async function pageCharts() {
    view.innerHTML = pageHeader('排行榜') + skeleton(6)
    try {
      const res = await API.charts()
      const list = res.list || []
      view.innerHTML = pageHeader('排行榜', '<span class="note" style="padding-right:14px">' + list.length + ' 个</span>')
        + (list.length
          ? '<div class="grid3" style="padding-top:12px">' + list.map(c => playlistCard(
            { name: c.name, cover: c.cover, count: c.playCount, id: c.id, source: c.source },
            '#/chart?id=' + encodeURIComponent(c.id) + '&source=' + c.source
          )).join('') + '</div><div style="height:20px"></div>'
          : emptyState('暂无榜单', '榜单接口暂时不可用，请稍后再试'))
      // 官方榜单单图是纯色设计图，一屏色块。逐批换成各榜榜首的专辑封面 + 歌手名。
      upgradeChartCovers().catch(() => {})
    } catch (e) {
      view.innerHTML = pageHeader('排行榜') + emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  async function pageChart(r) {
    const id = r.q.get('id')
    const source = r.q.get('source') || 'wy'
    view.innerHTML = pageHeader('榜单') + skeleton(6)
    try {
      const res = await API.chart(id, source, 200)
      const songs = res.list || []
      const key = registerList('chart-' + id, songs)
      const chart = res.chart || {}
      // 头图用榜首单曲的专辑封面（服务端随 /chart 一并返回，不用再发一次请求）
      const head = chart.head && chart.head.cover ? chart.head : null
      const headCover = head ? head.cover : chart.cover
      const headWho = head
        ? '<div class="note">榜首 ' + esc([head.artist, head.song].filter(Boolean).join(' · ')) + '</div>'
        : ''
      view.innerHTML = pageHeader(chart.name || '榜单')
        + '<div class="block" style="display:flex;gap:14px;align-items:center">'
        + '<div class="card__cover" style="width:92px;flex:0 0 92px;border-radius:10px;overflow:hidden;background:#f0f0f2">' + coverTag(headCover, chart.name, 300) + '</div>'
        + '<div style="min-width:0">'
        + '<div style="font-size:17px;font-weight:700;margin-bottom:4px">' + esc(chart.name || '榜单') + '</div>'
        + headWho
        + '<div class="note">共 ' + songs.length + ' 首 · 来源 ' + esc(App.platformNames[source] || source) + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '<button class="btn btn--sm" data-act="play-list" data-list="' + key + '">' + ICON.play + '播放全部</button>'
        + '<button class="btn btn--sm btn--ghost" data-act="import-to" data-list="' + key + '" data-name="' + esc(chart.name || '榜单') + '">收藏到歌单</button>'
        + '</div></div></div>'
        + songList(songs, key, { row: { numbered: true } })
    } catch (e) {
      view.innerHTML = pageHeader('榜单') + emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  /* ================= 我的歌单 ================= */

  /**
   * 歌单封面。
   * 优先用歌单自己的封面；没有就用第一首歌的专辑封面（服务端也会补，
   * 这里再兜一层是因为详情页拿到的 songs 已经在手上，不用多跑一次请求）；
   * 空歌单（连一首歌都没有）给个图标占位，别留一块空灰格子。
   */
  function playlistCoverTag(cover, songs, name, size) {
    const img = cover || ((songs && songs.length && songs[0] && songs[0].img) || '')
    if (img) return coverTag(img, name, size)
    return '<span class="cover-ph">' + ICON.list + '</span>'
  }

  /**
   * 「我的歌单」标题栏。
   * 「新建」常驻在标题右边 —— 之前它只出现在**空状态**里，建过一个歌单之后
   * 就再也找不到入口了，只能先删光才能新建。
   */
  function libraryHead() {
    return sectionHead('我的歌单',
      '<span style="display:inline-flex;gap:6px">'
      + '<button class="section__more" data-act="new-playlist">' + ICON.plus + '新建</button>'
      + '<a class="section__more" href="#/import">' + ICON.link + '导入</a>'
      + '</span>')
  }

  async function pageLibrary() {
    view.innerHTML = '<section class="section">' + libraryHead() + '</section>' + skeleton(4)
    try {
      const res = await API.playlists()
      const list = res.list || []
      view.innerHTML = '<section class="section">' + libraryHead() + '</section>'
        + (list.length
          ? '<div class="songlist">' + list.map(p =>
            '<a class="song song--rich" href="#/playlist?id=' + encodeURIComponent(p.id) + '">'
            + '<div class="song__cover">' + playlistCoverTag(p.cover, null, p.name, 200) + '</div>'
            + '<div class="song__meta"><div class="song__name">' + esc(p.name) + '</div>'
            + '<div class="song__sub">' + (p.song_count || 0) + ' 首' + (p.source ? ' · ' + esc(App.platformShort[p.source] || p.source) : '') + '</div></div>'
            + '<div class="song__act">' + ICON.chevron + '</div>'
            + '</a>').join('') + '</div>'
          : emptyState('还没有歌单', '新建一个自己往里加歌，也可以导入别人的歌单，或用 AI 生成',
            '<div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">'
            + '<button class="btn btn--sm" data-act="new-playlist">' + ICON.plus + '新建歌单</button>'
            + '<a class="btn btn--sm" href="#/ai">✨ AI 生成</a>'
            + '<a class="btn btn--sm btn--ghost" href="#/import">导入歌单</a></div>'))
    } catch (e) {
      view.innerHTML = emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  /* ================= 歌单详情 ================= */

  /**
   * 当前打开着的歌单详情。
   * 供「从歌单移除 / 上移 / 下移 / 重命名」用 —— 这些动作都要知道
   * 正在编辑哪一张歌单，而歌曲行本身只带 listKey 与下标。
   */
  let plCtx = null

  function reloadPlaylist() {
    if (!plCtx) return
    pagePlaylist({ q: new URLSearchParams('id=' + encodeURIComponent(plCtx.id)) })
  }

  async function pagePlaylist(r) {
    const id = r.q.get('id')
    view.innerHTML = pageHeader('歌单') + skeleton(6)
    try {
      const res = await API.playlist(id)
      const pl = res.playlist
      const songs = pl.songs || []
      const key = registerList('pl-' + id, songs)
      plCtx = { id, listKey: key, name: pl.name }

      const addBtn = '<button class="btn btn--sm btn--ghost" data-act="add-songs" data-id="' + esc(id) + '">'
        + ICON.plus + '添加歌曲</button>'

      view.innerHTML = pageHeader(pl.name,
        '<button class="icon-btn" data-act="rename-playlist" data-id="' + esc(id) + '" aria-label="重命名歌单">' + ICON.edit + '</button>'
        + '<button class="icon-btn" data-act="del-playlist" data-id="' + esc(id) + '" aria-label="删除歌单">' + ICON.trash + '</button>')
        + '<div class="block" style="display:flex;gap:14px;align-items:center">'
        + '<div class="card__cover" style="width:92px;flex:0 0 92px;border-radius:10px;overflow:hidden">' + playlistCoverTag(pl.cover, songs, pl.name, 200) + '</div>'
        + '<div style="min-width:0">'
        + '<div style="font-size:17px;font-weight:700;margin-bottom:4px">' + esc(pl.name) + '</div>'
        + '<div class="note">' + songs.length + ' 首' + (pl.source ? ' · ' + esc(App.platformNames[pl.source] || pl.source) : '') + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'
        + '<button class="btn btn--sm" data-act="play-list" data-list="' + key + '">' + ICON.play + '播放全部</button>'
        + addBtn
        + '<button class="btn btn--sm btn--ghost" data-act="enqueue-list" data-list="' + key + '">加入队列</button>'
        + '</div></div></div>'
        + (songs.length
          ? '<div class="note" style="padding:0 16px 4px">点每首歌右侧的「⋯」可以把它移出歌单、或上移 / 下移调整顺序</div>'
            + songList(songs, key, { row: { showCover: true } })
          : emptyState('歌单还是空的', '搜一首歌加进来，它就算建起来了',
            '<div style="display:flex;gap:10px;justify-content:center;margin-top:16px">' + addBtn + '</div>'))
    } catch (e) {
      plCtx = null
      view.innerHTML = pageHeader('歌单') + emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  /* ================= 收藏 ================= */

  async function pageFavorite() {
    view.innerHTML = '<section class="section">' + sectionHead('我喜欢的音乐') + '</section>' + skeleton(5)
    try {
      const res = await API.favorites()
      const songs = res.list || []
      const key = registerList('favorites', songs)
      Player.setFavorites(songs)
      view.innerHTML = '<div class="block" style="display:flex;gap:14px;align-items:center;background:linear-gradient(120deg,#ff7a7a,#ec4141);color:#fff">'
        + '<div class="card__cover" style="width:88px;flex:0 0 88px;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.2);display:grid;place-items:center">'
        + (songs.length && songs[0].img ? coverTag(songs[0].img, songs[0].name, 200) : '<span style="opacity:.8">' + ICON.heart + '</span>')
        + '</div><div><div style="font-size:18px;font-weight:700">我喜欢的音乐</div>'
        + '<div style="font-size:12px;opacity:.85;margin-top:3px">' + songs.length + ' 首</div>'
        + '<button class="btn btn--sm" style="margin-top:10px;background:#fff;color:var(--brand)" data-act="play-list" data-list="' + key + '">播放全部</button>'
        + '</div></div>'
        + songList(songs, key, { row: { showCover: true }, emptyTitle: '还没有收藏歌曲', emptyDesc: '在播放器或歌曲列表点心形图标即可收藏' })
    } catch (e) {
      view.innerHTML = emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  /* ================= 歌单：搜索并添加歌曲 ================= */

  /**
   * 「添加歌曲」页（#/playlist-add?id=xxx）。
   *
   * 为什么单独做成一页而不是一个抽屉：加歌是个**连续动作** —— 搜一次往往要挑好几首，
   * 抽屉看完一批就得关掉重开。整页能一直停在搜索结果上，加完一首接着加下一首。
   *
   * 进页面先把歌单里已有的歌 id 捞下来：一是搜索到的歌能标成「已在歌单」，
   * 二是避免重复添加（服务端不管这件事，同一个歌单里加两遍是允许的）。
   */
  const plAddState = { playlistId: '', songs: [], have: null }

  async function pagePlaylistAdd(r) {
    const id = r.q.get('id') || ''
    plAddState.playlistId = id
    plAddState.songs = []
    let plName = ''
    try {
      const res = await API.playlist(id)
      const pl = res.playlist || {}
      plName = pl.name || ''
      plAddState.have = new Set((pl.songs || []).map(s => s.id))
    } catch (e) {
      view.innerHTML = pageHeader('添加歌曲') + emptyState('打开歌单失败', esc((e && e.message) || ''))
      return
    }

    view.innerHTML = pageHeader(plName ? '添加到「' + plName + '」' : '添加歌曲')
      + '<div class="searchbar" style="padding-top:0">'
      + '<input class="searchbar__input" id="plAddInput" type="search" enterkeyhint="search" placeholder="搜索歌名 / 歌手" autocomplete="off">'
      + '<button class="searchbar__btn" data-act="pl-add-search">搜索</button>'
      + '</div>'
      + '<div class="note" style="padding:0 16px 6px">点右侧「＋」加入歌单，可以接着搜下一首；已在歌单里的会显示为「已加入」。</div>'
      + '<div id="plAddList">' + emptyState('先搜一首歌', '输入歌名或歌手，回车开始搜索') + '</div>'

    const input = $('#plAddInput')
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doPlAddSearch() })
    setTimeout(() => input.focus(), 120)
  }

  async function doPlAddSearch() {
    const input = $('#plAddInput')
    const q = ((input && input.value) || '').trim()
    if (!q) { toast('先输入歌名或歌手'); return }
    const box = $('#plAddList')
    box.innerHTML = skeleton(5)
    try {
      const res = await API.search(q, { limit: 30 })
      const songs = res.list || []
      plAddState.songs = songs
      if (!songs.length) {
        box.innerHTML = emptyState('没有搜到', '换个关键词试试'
          + ((res.errors && res.errors.length) ? '（部分平台接口受限）' : ''))
        return
      }
      const key = registerList('pladd', songs)
      box.innerHTML = '<div class="songlist">' + songs.map((s, i) => {
        const have = !!(plAddState.have && plAddState.have.has(s.id))
        return '<div class="song song--rich" data-list="' + key + '" data-i="' + i + '">'
          + '<div class="song__cover">' + coverTag(s.img, s.name, 120) + '</div>'
          + '<div class="song__meta"><div class="song__name">' + esc(s.name) + '</div>'
          + '<div class="song__sub">' + esc(s.singer || '') + '<span class="dot">·</span>'
          + esc(App.platformShort[s.source] || s.source) + '</div></div>'
          + '<button class="song__act" data-pl-add="' + i + '" aria-label="加入歌单"'
          + (have ? ' disabled' : '') + '>' + (have ? ICON.check : ICON.plus) + '</button>'
          + '</div>'
      }).join('') + '</div>'
    } catch (e) {
      box.innerHTML = emptyState('搜索失败', esc((e && e.message) || ''))
    }
  }

  async function addSongFromSearch(i) {
    const song = (plAddState.songs || [])[i]
    if (!song || !plAddState.playlistId) return
    if (plAddState.have && plAddState.have.has(song.id)) { toast('这首歌已经在歌单里了'); return }
    try {
      await API.addToPlaylist(plAddState.playlistId, [song.id])
      if (plAddState.have) plAddState.have.add(song.id)
      toast('已加入：' + song.name)
      // 就地改这一个按钮，不重绘整个列表 —— 重绘会把滚动位置弹回顶部，
      // 连着加几首的时候非常难受。
      const btn = view.querySelector('[data-pl-add="' + i + '"]')
      if (btn) { btn.disabled = true; btn.innerHTML = ICON.check }
    } catch (e) { toast((e && e.message) || '加入失败') }
  }

  /* ================= 歌单导入 ================= */

  /**
   * 把「歌名 + 歌手」清单逐首匹配成可播放的曲目。
   *
   * 走 /suggest 而不是 /search：前者不写搜索历史 —— 这种批量匹配会在用户的历史里
   * 一次性刷进几十条噪音；而且每首一个短请求，进度能实时画出来。
   *
   * AI 歌单与汽水歌单导入共用这一段：两边要做的完全是同一件事
   * （拿到一份「歌名 + 歌手」，在现有音源里找出能播的那一首）。
   */
  async function matchSongsBySearch(songs, onProgress) {
    const matched = []
    const misses = []
    for (let i = 0; i < songs.length; i++) {
      const item = songs[i]
      if (onProgress) onProgress(i, songs.length, item)
      const q = item.singer ? item.name + ' ' + item.singer : item.name
      try {
        const s = await API.suggest(q)
        const hit = (s.list || [])[0]
        if (hit) matched.push(hit)
        else misses.push(item.name)
      } catch { misses.push(item.name) }
    }
    return { matched, misses }
  }

  function pageImport() {
    const examples = [
      { name: '网易云', sample: 'https://music.163.com/#/playlist?id=3778678' },
      { name: '网易分享短链', sample: 'https://163cn.tv/xxxxxxxx' },
      { name: '汽水音乐', sample: 'https://qishui.douyin.com/s/xxxxxxxx/' },
      { name: '酷狗', sample: 'https://www.kugou.com/yy/special/single/519669.html' },
      { name: '酷我', sample: 'https://www.kuwo.cn/playlist_detail/2787295395' },
      { name: 'QQ音乐', sample: 'https://y.qq.com/n/ryqq/playlist/7011264340' },
    ]
    view.innerHTML = pageHeader('导入歌单')
      + '<div class="block">'
      + '<div class="field"><div class="field__label">歌单链接或 ID</div>'
      + '<input class="input" id="importUrl" placeholder="粘贴网易云 / 汽水 / 酷狗 / 酷我 / QQ 歌单链接" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label">歌单名称（可选，留空自动识别）</div>'
      + '<input class="input" id="importName" placeholder="自动读取原标题" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label">来源平台</div>'
      + '<select class="select" id="importSource">'
      + '<option value="">自动识别</option>'
      + Object.keys(App.platformNames).map(k => '<option value="' + k + '">' + App.platformNames[k] + '</option>').join('')
      + '</select></div>'
      + '<button class="btn btn--block" id="btnImport">开始导入</button>'
      + '<div class="note" style="margin-top:12px">也可以直接填数字 ID，例如网易云热歌榜 <b>3778678</b>；或在前面加平台前缀，如 <b>kg:519669</b>。</div>'
      + '</div>'
      + '<div id="importResult"></div>'
      + '<div class="block"><div class="field__label" style="margin-bottom:8px">识别规则示例</div>'
      + examples.map(e => '<div class="note" style="margin-bottom:6px"><b>' + e.name + '</b>　' + esc(e.sample) + '</div>').join('')
      + '<div class="note" style="margin-top:8px">网易 / 酷狗 / 酷我的歌单导入后可以直接播。'
      + '<b>汽水音乐</b>给不出可播直链，导入时会自动拿歌名去现有音源里逐首匹配，'
      + '匹配不到的那几首会列出来（不会混进歌单）。分享链接一般几天就过期，失效请重新复制。</div>'
      + '</div>'

    $('#btnImport').addEventListener('click', async () => {
      const raw = $('#importUrl').value.trim()
      const name = $('#importName').value.trim()
      const source = $('#importSource').value
      if (!raw) { toast('请填写歌单链接或 ID'); return }
      const btn = $('#btnImport')
      const result = $('#importResult')
      btn.disabled = true
      btn.textContent = '导入中…'
      try {
        const res = await API.importPlaylist(raw, source, name)

        // 汽水这类「只有曲目、没有可播直链」的歌单：服务端把歌名清单交回来，
        // 这里逐首匹配成能播的曲目再落库。见 api.js 里 /playlist/import 的注释。
        if (res.matchNeeded) {
          const list = res.songs || []
          if (!list.length) throw new Error('歌单为空或解析失败')
          const { matched, misses } = await matchSongsBySearch(list, (i, n, item) => {
            btn.textContent = '匹配中 ' + (i + 1) + '/' + n + '…'
            result.innerHTML = '<div class="block"><div class="note" style="text-align:center">'
              + '歌单「' + esc(res.name || '汽水歌单') + '」已读取，正在匹配音源…<br>'
              + '<b>' + (i + 1) + ' / ' + n + '</b>'
              + '<div class="note" style="margin-top:6px">当前：' + esc(item.name) + (item.singer ? ' - ' + esc(item.singer) : '') + '</div></div></div>'
          })
          if (!matched.length) {
            result.innerHTML = '<div class="block"><div class="note" style="color:var(--brand)">'
              + '读到了 ' + list.length + ' 首，但没有一首能在现有音源里搜到，无法导入。</div></div>'
            btn.disabled = false
            btn.textContent = '开始导入'
            return
          }
          const created = await API.createPlaylist(name || res.name || '导入的歌单', matched)
          const missNote = misses.length
            ? '<div class="note" style="margin-top:10px">有 ' + misses.length + ' 首没匹配到：' + esc(misses.slice(0, 8).join('、')) + (misses.length > 8 ? ' 等' : '') + '</div>'
            : ''
          result.innerHTML = '<div class="block">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
            + '<div><div style="font-weight:700">' + esc(created.playlist.name) + '</div>'
            + '<div class="note">已匹配 ' + matched.length + ' / ' + list.length + ' 首</div></div>'
            + '<a class="btn btn--sm" href="#/playlist?id=' + encodeURIComponent(created.playlist.id) + '">查看歌单</a></div>'
            + missNote + '</div>'
          toast('导入成功：' + matched.length + ' 首')
          App.library = null
          App.home = null
          btn.disabled = false
          btn.textContent = '开始导入'
          return
        }

        toast('导入成功：' + res.total + ' 首')
        App.home = null
        go('#/playlist?id=' + encodeURIComponent(res.playlist.id))
      } catch (e) {
        toast((e && e.message) || '导入失败')
        btn.disabled = false
        btn.textContent = '开始导入'
      }
    })
  }

  /* ================= AI 歌单 ================= */

  function pageAi() {
    const u = App.user || {}
    view.innerHTML = pageHeader('AI 歌单')
      + '<div class="block">'
      + '<div class="field"><div class="field__label">描述你的心情 / 场景 / 关键词</div>'
      + '<textarea class="input" id="aiPrompt" rows="3" placeholder="例如：深夜开车听的粤语老歌；适合跑步的英文快节奏；下雨天听的安静民谣" style="resize:none"></textarea></div>'
      + '<div class="field"><div class="field__label">歌单名称（可选）</div>'
      + '<input class="input" id="aiName" placeholder="留空用 AI 起名" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label">数量</div>'
      + '<div class="chips" style="padding:0">'
      + [10, 20, 30, 50].map(n => '<button class="chip' + (n === 20 ? ' is-active' : '') + '" data-act="ai-count" data-n="' + n + '">' + n + ' 首</button>').join('')
      + '</div></div>'
      + '<button class="btn btn--block" id="btnAi">✨ 生成歌单</button>'
      + '<div class="note" style="margin-top:10px">AI 会理解你的描述并生成歌单，再自动从音源里匹配真实可播的歌曲。</div>'
      + '</div>'
      + '<div id="aiResult"></div>'
      + (u.isAdmin ? '<div class="block"><a class="note" href="#/settings#ai" style="color:var(--brand)">⚙ 配置 AI 接口（千问 / OpenAI，管理员）</a></div>' : '')

    let aiCount = 20
    view.querySelectorAll('[data-act="ai-count"]').forEach(b => {
      b.addEventListener('click', () => {
        aiCount = Number(b.dataset.n)
        view.querySelectorAll('[data-act="ai-count"]').forEach(x => x.classList.toggle('is-active', x === b))
      })
    })

    $('#btnAi').addEventListener('click', async () => {
      const prompt = $('#aiPrompt').value.trim()
      const name = $('#aiName').value.trim()
      if (!prompt) { toast('请先描述你想要什么样的歌单'); return }
      const btn = $('#btnAi')
      const result = $('#aiResult')
      btn.disabled = true
      btn.textContent = '生成中…'
      result.innerHTML = '<div class="block"><div class="note" style="text-align:center">正在让 AI 生成歌单…（最长可能需要一两分钟）</div></div>'
      try {
        // 第一步：AI 出列表（歌名 + 歌手）。服务端只做这一件事，请求短、不容易被掐断。
        const res = await API.generatePlaylist(prompt, aiCount)
        const songs = Array.isArray(res.songs) ? res.songs : []
        if (!songs.length) throw new Error('AI 未能生成有效歌单，请换个描述试试')

        // 第二步：逐首匹配音源。走 /suggest（不写搜索历史），每首一个短请求，进度实时可见。
        // 这段与「汽水歌单导入」共用同一个函数 —— 要做的本来就是同一件事。
        const { matched, misses } = await matchSongsBySearch(songs, (i, n, item) => {
          btn.textContent = '匹配中 ' + (i + 1) + '/' + n + '…'
          result.innerHTML = '<div class="block"><div class="note" style="text-align:center">'
            + '歌单「' + esc(res.title || 'AI 歌单') + '」已生成，正在匹配音源…<br>'
            + '<b>' + (i + 1) + ' / ' + n + '</b>'
            + '<div class="note" style="margin-top:6px">当前：' + esc(item.name) + (item.singer ? ' - ' + esc(item.singer) : '') + '</div></div></div>'
        })

        if (!matched.length) {
          result.innerHTML = '<div class="block"><div class="note" style="color:var(--brand)">歌单生成了，但没有一首能在音源里搜到，请换个描述试试。</div></div>'
        } else {
          // 第三步：落库（复用通用建歌单接口）
          const created = await API.createPlaylist(name || res.title || 'AI 歌单', matched)
          const missNote = misses.length
            ? '<div class="note" style="margin-top:10px">有 ' + misses.length + ' 首未匹配到：' + esc(misses.slice(0, 8).join('、')) + (misses.length > 8 ? ' 等' : '') + '</div>'
            : ''
          result.innerHTML = '<div class="block">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
            + '<div><div style="font-weight:700">' + esc(created.playlist.name) + '</div>'
            + '<div class="note">已匹配 ' + matched.length + ' / ' + songs.length + ' 首</div></div>'
            + '<a class="btn btn--sm" href="#/playlist?id=' + encodeURIComponent(created.playlist.id) + '">查看歌单</a></div>'
            + missNote + '</div>'
          toast('歌单已生成：' + matched.length + ' 首')
          App.library = null
        }
      } catch (e) {
        result.innerHTML = '<div class="block"><div class="note" style="color:var(--brand)">' + esc((e && e.message) || '生成失败') + '</div></div>'
      }
      btn.disabled = false
      btn.textContent = '✨ 生成歌单'
    })
  }

  /* ================= 本地音源插件（用户自己的） =================
   *
   * 这一段和「音源与插件」不是一回事，别混：
   *   服务端插件（PLUGIN_POOL）—— 部署时打包好的，影响所有人，归管理端 /admin。
   *   本地插件（LXP）      —— 存在**用户自己这台设备**的 IndexedDB 里，
   *                           只影响自己，别人看不到也管不着，所以归用户端。
   * 之前两者被塞在同一个「音源与插件」页里，看着像一回事，其实权限来源完全不同。
   */

  /** 「本地音源插件」区块：存在本机 IndexedDB，只影响自己这台设备 */
  function localPluginBlockHtml() {
    const online = LXP.summary()
    const list = online.length
      ? online.map(p =>
        '<div class="card-block"><div class="card-block__head">'
        + '<span class="card-block__name">' + esc(p.name) + '</span>'
        + '<span class="pill ' + (p.ready ? 'pill--ok' : (p.error ? 'pill--bad' : '')) + '">'
        + (p.ready ? '运行中' : (p.error ? '异常' : '加载中')) + '</span>'
        + '</div><div class="card-block__desc">'
        + (p.sources || []).map(x => '<span class="pill">' + esc(App.platformShort[x] || x) + '</span>').join('')
        + (p.version ? '<span class="pill">v' + esc(p.version) + '</span>' : '')
        + '</div>'
        + (p.error ? '<div class="note" style="color:#d73535;margin-top:4px">' + esc(p.error) + '</div>' : '')
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '<button class="btn btn--sm btn--ghost" data-act="toggle-plugin" data-id="' + esc(p.id) + '" data-on="' + (p.enabled ? '1' : '0') + '">' + (p.enabled ? '停用' : '启用') + '</button>'
        + '<button class="btn btn--sm btn--ghost" data-act="del-plugin" data-id="' + esc(p.id) + '">删除</button>'
        + '</div></div>').join('')
      : '<div class="note">本机还没有插件。下面「常用音源一键导入」可以直接拉。</div>'

    const presets = LXP.PRESETS.map((p, i) =>
      '<div class="menu-item" style="padding-left:0;padding-right:0"><div class="menu-item__text">' + esc(p.name)
      + '<div class="menu-item__desc">' + esc(p.url.replace('https://raw.githubusercontent.com/', '')) + '</div></div>'
      + '<button class="btn btn--sm" data-act="import-preset" data-i="' + i + '">导入</button></div>').join('')

    return '<div class="field__label" style="margin-bottom:8px">本地插件（' + online.length + ' 个）· 只在本机生效</div>'
      + list
      + '<button class="btn btn--block" data-act="open-import-plugin" style="margin-top:12px">导入插件（URL / 粘贴脚本）</button>'
      + '<div class="field__label" style="margin:16px 0 8px">常用音源一键导入</div>'
      + presets
      + '<div class="note" style="margin-top:10px">插件脚本经服务端代理下载、在浏览器 Web Worker 沙箱里执行，'
      + '只用于解析播放链接，不会上传任何账号信息。存在本机 IndexedDB，清掉 App 数据就没了。</div>'
  }

  /** 重绘本地插件区块（导入 / 启停 / 删除后调用） */
  async function reloadLocalPlugins() {
    // 远程模式下这一块画的是「插件在服务器上」的说明，不能被本地插件列表顶掉
    if (window.LX_REMOTE) return
    const host = $('#localPluginBlock')
    if (!host) return
    host.innerHTML = localPluginBlockHtml()
  }

  /* ================= 服务端地址（仅安卓壳） ================= */

  /**
   * 壳默认「单机版」：后端跑在设备内，数据只在这台手机上，插件也在手机上跑。
   * 填上服务器地址就切成纯客户端 —— 数据 / 账号 / 插件全在服务器那一侧，
   * 换机重装都不丢，点歌也不用等插件 Worker 冷启动。
   *
   * 两边各有各的好，所以做成开关而不是二选一，并把当前处在哪种模式明确写在页面上。
   */
  /**
   * 远程模式下的「音源插件」区块。
   *
   * ⚠️ 这块以前只写一句「插件由服务器统一管理与调度，需要增删插件请到管理端」，
   * 而**管理端当时根本没有导入功能**（只有列表 / 评分 / 启停），服务端也没有导入接口
   * —— 等于把人指到一个不存在的地方。用户反馈的原话就是
   * 「插件没有办法手动导入新的插件」。
   *
   * 现在服务端补齐了导入 / 删除（见 src/server/plugin-import.mjs），这里也直接给
   * 一个导入入口：手机上调出浏览器去开管理端本来就别扭，能在 App 里点完最好。
   * 非管理员只看到说明 —— 服务端的插件池是全局的，改它会影响所有人。
   */
  function remotePluginNoteHtml() {
    const base = (window.LXApp && window.LXApp.serverBase) || ''
    const adminUrl = base + '/admin'
    const isAdmin = !!(App.user && App.user.isAdmin)
    const head = '<div class="field__label" style="margin-bottom:8px">音源插件</div>'
      + '<div class="note">当前是自建服务器模式，插件在服务器上统一加载与调度，本机不再单独加载。</div>'
    if (!isAdmin) {
      return head
        + '<a class="btn btn--block btn--ghost" style="margin-top:12px" href="' + esc(adminUrl)
        + '" target="_blank" rel="noopener">打开管理端</a>'
        + '<div class="note" style="margin-top:8px">' + esc(adminUrl) + '</div>'
        + '<div class="note" style="margin-top:8px">音源插件由服务器统一管理，只有管理员账号能增删。</div>'
    }
    return head
      + '<div class="field" style="margin-top:12px"><div class="field__label">插件脚本 URL</div>'
      + '<input class="input" id="srvPluginUrl" placeholder="https://.../latest.js" autocomplete="off"></div>'
      + '<button class="btn btn--block" data-act="srv-import-url">从 URL 导入到服务器</button>'
      + '<button class="btn btn--block btn--ghost" style="margin-top:8px" data-act="srv-import-open">粘贴脚本导入</button>'
      + '<div id="srvImportBox" hidden style="margin-top:10px">'
      + '<textarea class="textarea" id="srvPluginText" placeholder="/* @name ... */&#10;(function(){ ... })()"></textarea>'
      + '<button class="btn btn--block" data-act="srv-import-text" style="margin-top:8px">解析并导入</button>'
      + '</div>'
      + '<div class="note" id="srvPluginState" style="margin-top:10px"></div>'
      + '<div class="field__label" style="margin:16px 0 8px">服务器上的插件</div>'
      + '<div id="srvPluginList"><div class="note">加载中…</div></div>'
      + '<a class="btn btn--block btn--ghost" style="margin-top:12px" href="' + esc(adminUrl)
      + '" target="_blank" rel="noopener">打开管理端（完整设置）</a>'
  }

  /** 拉取服务器上的插件清单并画出来（仅远程模式 + 管理员） */
  async function refreshServerPlugins() {
    const host = $('#srvPluginList')
    if (!host) return
    try {
      const r = await API.plugins()
      const list = (r && r.list) || []
      if (!list.length) { host.innerHTML = '<div class="note">服务器上还没有插件。</div>'; return }
      host.innerHTML = list.map(p => {
        const badges = '<span class="pill ' + (p.ok ? 'pill--ok' : 'pill--bad') + '">'
          + (p.ok ? '运行中' : '加载失败') + '</span>'
          + (p.bytes ? '<span class="pill">' + Math.round(p.bytes / 1024) + 'KB</span>' : '')
          + (p.origin === 'user' ? '<span class="pill">手动导入</span>' : '')
        return '<div class="card-block"><div class="card-block__head">'
          + '<span class="card-block__name">' + esc(p.name || p.id) + '</span>' + badges
          + '</div><div class="card-block__desc">'
          + ((p.sources || []).map(x => '<span class="pill">' + esc(App.platformShort[x] || x) + '</span>').join('') || '—')
          + '</div>'
          + (!p.ok && p.error ? '<div class="note" style="color:#d73535;margin-top:4px">' + esc(p.error) + '</div>' : '')
          + (p.origin === 'user'
            ? '<div style="margin-top:10px"><button class="btn btn--sm btn--ghost" data-act="srv-del-plugin" data-id="'
              + esc(p.id) + '">删除</button></div>'
            : '')
          + '</div>'
      }).join('')
    } catch (e) {
      host.innerHTML = '<div class="note" style="color:#d73535">读取失败：' + esc((e && e.message) || '') + '</div>'
    }
  }

  /**
   * 把插件导入到**服务器**。
   *
   * 失败原因（URL 不通 / 内容不像插件脚本 / 脚本自身加载失败）留在页面上而不只是
   * 弹 toast —— 两秒后 toast 就没了，而这三类原因的处置办法完全不同。
   */
  async function importPluginToServer(payload, node) {
    const st = $('#srvPluginState')
    const old = node ? node.textContent : ''
    if (node) { node.disabled = true; node.textContent = '导入中…' }
    if (st) { st.style.color = ''; st.textContent = '正在下载并加载插件…（大脚本可能要十几秒）' }
    try {
      const r = await API.importPlugin(payload)
      const name = (r.plugin && r.plugin.name) || '插件'
      toast((r.replaced ? '已更新：' : '已导入：') + name + (r.from ? '（经 ' + r.from + '）' : ''))
      if (st) st.textContent = '已导入：' + name
      await refreshServerPlugins()
    } catch (e) {
      const msg = (e && e.message) || '导入失败'
      if (st) { st.textContent = msg; st.style.color = '#d73535' }
      toast(msg, 6000)
    } finally {
      if (node) { node.disabled = false; node.textContent = old }
    }
  }

  /**
   * 「系统播放控制」状态卡（仅安卓壳）。
   *
   * 通知栏、锁屏、控制中心、耳机按键这一整套能不能用，取决于三层：
   *   ① 页面把媒体会话装配起来（native.js）→ ② 原生播放服务在跑（MediaSession 宿主）
   *   → ③ 系统真的允许这个 App 发通知（通知权限 + 通知总开关）。
   * 任何一层断了，用户看到的现象都是同一句「控制不了」，所以这里把每一层都摊开。
   * 排查手段也只有这一个 —— 开发机没有安卓运行时，只能让设备把实况回传。
   */
  function mediaBlockHtml() {
    const d = (typeof window.__lxMediaDiag === 'function') ? window.__lxMediaDiag() : null
    if (!d) {
      return '<div class="field__label">系统播放控制</div>'
        + '<div class="note" style="color:var(--brand)">诊断入口没装配（App 内的 native.js 未加载）。</div>'
    }
    const host = d.host || {}
    if (host.ok === false) {
      return '<div class="field__label">系统播放控制</div>'
        + '<div class="note" style="color:var(--brand)">' + esc(host.error || '原生媒体接口不可用') + '</div>'
    }

    const js = d.js || {}
    const nat = host.native || {}
    const ago = (ms) => (ms == null || ms < 0) ? '从未'
      : (ms < 1500 ? '刚刚' : (ms < 60000 ? Math.round(ms / 1000) + ' 秒前' : Math.round(ms / 60000) + ' 分钟前'))
    const notifText = host.notifGranted === 3 ? '已授权'
      : host.notifGranted === 2 ? '未授权' : '系统无需授权'

    const rows = [
      { k: '页面装配', v: js.installed ? '已装配' : '未装配', ok: !!js.installed },
      { k: '播放服务', v: nat.service ? '运行中' : '未运行', ok: !!nat.service },
      { k: '媒体会话', v: nat.session ? '已激活' : '未激活', ok: !!nat.session },
      { k: '前台服务', v: nat.foreground ? '已进前台' : '未进前台', ok: !!nat.foreground },
      { k: '通知', v: nat.notifiedAgoMs >= 0 ? '已发出 · ' + ago(nat.notifiedAgoMs) : '未发出', ok: nat.notifiedAgoMs >= 0 },
      { k: '通知权限', v: notifText, ok: host.notifGranted === 3 || host.notifGranted === 1 },
      { k: '通知总开关', v: host.notifEnabled === false ? '已关闭' : '已开启', ok: host.notifEnabled !== false },
      { k: '上报', v: js.pushes ? js.pushes + ' 次 · ' + ago(js.lastPushAgoMs) : '一次都没有', ok: js.pushes > 0 },
      { k: '系统按键', v: nat.lastCmd ? nat.lastCmd + ' · ' + ago(nat.cmdAgoMs) : '还没收到过', ok: !!nat.lastCmd },
      { k: '封面', v: nat.coverOk ? '已加载' : (nat.coverError ? '取图失败' : '未加载'), ok: !!nat.coverOk },
    ]

    const errs = (nat.errors || []).slice(-3)
    const errText = errs.length
      ? errs.map(e => esc(e.msg) + '（' + ago(e.agoMs) + '）').join('<br>')
      : ''
    const skip = (!js.pushes && js.skip) ? '<div class="note" style="margin-top:8px">未上报的原因：' + esc(js.skip) + '</div>' : ''

    return '<div class="field__label" style="margin-bottom:8px">系统播放控制</div>'
      + '<div class="note" style="margin-bottom:10px">通知栏、锁屏、控制中心、耳机按键要三层都通：'
      + '页面装配媒体会话 → 原生播放服务在跑 → 系统允许发通知。</div>'
      + '<div>' + rows.map(r =>
        '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)">'
        + '<div class="note" style="flex:0 0 80px">' + r.k + '</div>'
        + '<div style="flex:1;font-size:13px;color:' + (r.ok ? 'var(--text)' : 'var(--brand)') + '">' + esc(r.v) + '</div>'
        + '</div>').join('') + '</div>'
      + skip
      + (errText ? '<div class="note" style="margin-top:10px;color:var(--brand)">' + errText + '</div>' : '')
      + '<div class="note" style="margin-top:10px">机型 ' + esc(host.brand || '?') + ' · Android ' + esc(host.android || '?') + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button class="btn btn--sm btn--ghost" data-act="media-refresh">刷新状态</button>'
      + (host.notifGranted === 2 ? '<button class="btn btn--sm" data-act="media-ask-notif">申请通知权限</button>' : '')
      + '<button class="btn btn--sm btn--ghost" data-act="media-open-settings">系统设置</button>'
      + '<button class="btn btn--sm btn--ghost" data-act="media-test-push">测试上报</button>'
      + '<button class="btn btn--sm btn--ghost" data-act="media-diag">完整诊断</button>'
      + '</div>'
  }

  /** 完整诊断：原样铺一份 JSON，用户可直接截图回报 */
  function openMediaDiag() {
    const d = (typeof window.__lxMediaDiag === 'function') ? window.__lxMediaDiag() : { error: '诊断入口未装配' }
    openDrawer('原生播放诊断',
      '<div style="padding:0 16px 18px">'
      + '<pre style="white-space:pre-wrap;word-break:break-all;font-size:11.5px;line-height:1.6;'
      + 'background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px;'
      + 'max-height:52vh;overflow:auto;user-select:text;-webkit-user-select:text">'
      + esc(JSON.stringify(d, null, 2)) + '</pre>'
      + '<div class="note" style="margin-top:10px">把这一屏截图发我即可定位。</div>'
      + '</div>')
  }

  function serverBlockHtml() {
    const remote = !!window.LX_REMOTE
    const cur = (window.LXApp && window.LXApp.serverBase) || ''
    const curUser = (window.LXApp && window.LXApp.serverUser) || ''
    return '<div class="field__label" style="margin-bottom:8px">服务端</div>'
      + '<div class="note" style="margin-bottom:10px">当前：<b>' + (remote ? '自建服务器' : '本机模式')
      + '</b><br>' + (remote
        ? esc(cur) + '　账号、播放记录、音源插件都在这一台上。'
        : '搜索、账号、播放记录都存在这台手机里，换手机或重装就清空了。') + '</div>'
      + '<div class="field"><input class="input" id="serverInput" autocomplete="off" '
      + 'placeholder="https://music.example.com 或 192.168.1.9:8080" value="' + esc(cur) + '"></div>'
      // 用户名只是预填值，不参与鉴权 —— 存它就是为了让登录页自动带上，不用每次手输
      + '<div class="field" style="margin-top:8px"><input class="input" id="serverUserInput" '
      + 'autocomplete="username" placeholder="登录用户名（可选，填了登录页自动带上）" value="' + esc(curUser) + '"></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button class="btn btn--sm" data-act="test-server">测试连接</button>'
      + '<button class="btn btn--sm btn--ghost" data-act="save-server">保存并重启</button>'
      + (remote ? '<button class="btn btn--sm btn--ghost" data-act="use-local">恢复本机模式</button>' : '')
      + '</div>'
      + '<div class="note" style="margin-top:10px">填自建后端的地址即可（Cloudflare Worker / Docker / 反向代理都行）。'
      + '不写协议时：IP 与 localhost 按 http 处理，域名按 https。</div>'
      + '<div class="note" id="serverHint" style="margin-top:8px"></div>'
  }

  /** 同一个表单在登录页也要有 —— 服务器地址填错时进不去设置页，这是唯一的退路 */
  function openServerSheet() {
    openDrawer('服务端地址',
      '<div style="padding:4px 16px 18px">' + serverBlockHtml() + '</div>')
  }

  /**
   * 登录 / 初始化页底部的「服务器设置」入口。
   *
   * 只在安卓壳里出现。这两页是「还没登录」时唯一的界面 —— 如果服务器地址填错了，
   * 用户连设置页都进不去，没这个出口就只能重装 App。所以退路必须放在这里。
   */
  function serverEntryHtml() {
    if (!window.LX_NATIVE) return ''
    const cur = (window.LXApp && window.LXApp.serverBase) || ''
    return '<div class="note" style="margin-top:16px;text-align:center">'
      + '<span style="color:var(--brand);text-decoration:underline;cursor:pointer" data-act="open-server">服务器设置</span>'
      + '　·　当前 ' + (window.LX_REMOTE ? esc(cur) : '本机模式') + '</div>'
  }

  async function testServerFrom(input) {
    if (!window.LXApp || typeof window.LXApp.testServer !== 'function') { toast('仅本机版可用'); return }
    const hint = $('#serverHint')
    const btn = $('[data-act="test-server"]')
    if (btn) { btn.disabled = true; btn.textContent = '测试中…' }
    const r = await window.LXApp.testServer(input)
    if (btn) { btn.disabled = false; btn.textContent = '测试连接' }
    const msg = r.ok
      ? '连接正常（' + r.ms + 'ms）' + (r.needsSetup ? '，该服务器还没有账号，保存后会引导创建' : '')
      : '连不上：' + r.error
    if (hint) {
      hint.innerHTML = (r.ok ? '<span style="color:var(--ok,#1a9c53)">' : '<span style="color:var(--brand)">')
        + esc(msg) + '</span>'
    }
    toast(r.ok ? '连接正常（' + r.ms + 'ms）' : '连不上：' + r.error)
  }

  function applyServerFrom(input, user) {
    if (!window.LXApp || typeof window.LXApp.applyServer !== 'function') { toast('仅本机版可用'); return }
    const base = window.LXApp.normalizeServer(input)
    const cur = window.LXApp.serverBase || ''
    const curUser = window.LXApp.serverUser || ''
    const nextUser = String(user == null ? '' : user).trim()
    if (base === cur && nextUser === curUser) { toast(base ? '已经是这个地址了' : '已经是本机模式'); return }
    const what = base
      ? ('切换到服务器 ' + base + (nextUser && nextUser !== curUser ? '（用户名 ' + nextUser + '）' : ''))
      : '恢复本机模式'
    if (!confirm(what + '？\n\nApp 会重启一次。'
      + (base ? '服务器上的账号和播放记录才是之后看到的。' : '之后看到的是这台手机上的数据。'))) return
    toast('正在切换…', 2000)
    window.LXApp.applyServer(base, nextUser)
  }

  async function importPluginByUrl(url) {
    U.toast('正在下载插件…（GitHub 源会自动走镜像）', 60000)
    try {
      const res = await LXP.importFromUrl(url)
      // 带上来源镜像：国内直连 raw.githubusercontent.com 不通，
      // 让用户看见「从哪个镜像拿到的」，下次遇到慢就知道该换哪个
      const via = res.from ? '（经 ' + res.from + '）' : ''
      U.toast('已导入：' + ((res.meta && res.meta.name) || '插件') + via)
      await reloadLocalPlugins()
    } catch (e) {
      U.toast((e && e.message) || '导入失败', 8000)
    }
  }

  function openPluginImport() {
    openDrawer('导入插件',
      '<div style="padding:4px 16px 16px">'
      + '<div class="field"><div class="field__label">插件脚本 URL</div>'
      + '<input class="input" id="pluginUrl" placeholder="https://.../latest.js" autocomplete="off"></div>'
      + '<button class="btn btn--block" id="btnPluginUrl" style="margin-bottom:16px">从 URL 导入</button>'
      + '<div class="field"><div class="field__label">或直接粘贴脚本内容</div>'
      + '<textarea class="textarea" id="pluginText" placeholder="/* @name ... */&#10;(function(){ ... })()"></textarea></div>'
      + '<button class="btn btn--block btn--ghost" id="btnPluginText">解析并导入</button>'
      + '<div class="note" style="margin-top:12px">导出的插件保存在本机 IndexedDB 中，刷新后依然有效。</div>'
      + '</div>', () => {
      $('#btnPluginUrl').addEventListener('click', async () => {
        const url = $('#pluginUrl').value.trim()
        if (!url) { toast('请填写 URL'); return }
        closeSheet(drawer)
        await importPluginByUrl(url)
      })
      $('#btnPluginText').addEventListener('click', async () => {
        const text = $('#pluginText').value.trim()
        if (text.length < 50) { toast('脚本体太短了'); return }
        try {
          const res = await LXP.importFromText(text, '')
          toast('已导入：' + ((res.meta && res.meta.name) || '插件'))
          closeSheet(drawer)
          await reloadLocalPlugins()
        } catch (e) { toast((e && e.message) || '导入失败') }
      })
    })
  }

  /* ================= 我的 ================= */

  async function pageMine() {
    const u = App.user || {}
    const items = [
      // 播放历史排在第一位：它是「上次听到哪」的入口，比「我的歌单」更常用
      { act: 'nav', href: '#/history', icon: 'history', text: '播放历史' },
      { act: 'nav', href: '#/library', icon: 'list', text: '我的歌单' },
      { act: 'nav', href: '#/ai', icon: 'sparkle', text: 'AI 生成歌单' },
      { act: 'nav', href: '#/favorite', icon: 'heart', text: '我喜欢的音乐' },
      { act: 'nav', href: '#/import', icon: 'link', text: '导入歌单' },
      { act: 'nav', href: '#/settings', icon: 'settings', text: '播放与账号设置' },
      { act: 'nav', href: '#/about', icon: 'info', text: 'Subsonic 客户端接入' },
    ]
    // 管理后台是**另一个页面**（/admin），不是本站的 hash 路由：
    // 它自带登录、不加载播放器，用户端这边只留一个跳板。
    // 用新标签页打开，免得在同一个标签里来回切换把播放中的队列丢掉。
    // 远程模式下管理端在服务器那一侧，必须带上服务器基址 —— 否则点开的是本机页面
    // （页面 origin 是壳里那个「假域名」），什么都不会有。
    if (u.isAdmin) {
      const adminHref = (window.LX_REMOTE && window.LXApp ? window.LXApp.serverBase : '') + '/admin'
      items.push({ act: 'link', href: adminHref, icon: 'key', text: '管理后台（音源 / 用户 / 记录）' })
    }
    items.push({ act: 'logout', icon: 'logout', text: '退出登录' })

    view.innerHTML = '<div class="block" style="display:flex;align-items:center;gap:14px">'
      + '<div style="width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,#ff7a7a,#ec4141);display:grid;place-items:center;color:#fff;font-size:22px;font-weight:700">'
      + esc((u.username || '?').slice(0, 1).toUpperCase()) + '</div>'
      + '<div><div style="font-size:18px;font-weight:700">' + esc(u.username || '未登录') + '</div>'
      + '<div class="note">' + (u.isAdmin ? '管理员账号' : '普通账号') + '</div></div></div>'
      + '<div style="border-top:8px solid var(--bg)"></div>'
      + items.map(it => {
        const inner = '<span class="quick__icon ' + (it.act === 'logout' ? 'c-gray' : 'c-red') + '">' + ICON[it.icon] + '</span>'
          + '<div class="menu-item__text">' + it.text + '</div>'
        if (it.act === 'nav') return '<a class="menu-item" href="' + it.href + '">' + inner + '</a>'
        if (it.act === 'link') {
          return '<a class="menu-item" href="' + it.href + '" target="_blank" rel="noopener">' + inner
            + '<span class="menu-item__ext">' + ICON.link + '</span></a>'
        }
        return '<div class="menu-item" data-act="' + it.act + '">' + inner + '</div>'
      }).join('')
      + '<div style="height:24px"></div>'
  }

  /* ================= 播放历史 ================= */

  /** 相对时间：刚刚 / N 分钟前 / 今天 21:03 / 昨天 21:03 / 10-02 21:03 */
  function fmtWhen(ts) {
    const n = Number(ts)
    if (!n) return ''
    const d = new Date(n)
    const now = new Date()
    const diff = (now.getTime() - n) / 1000
    if (diff >= 0 && diff < 60) return '刚刚'
    if (diff >= 0 && diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
    const p = (x) => String(x).padStart(2, '0')
    const hm = p(d.getHours()) + ':' + p(d.getMinutes())
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm
    if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨天 ' + hm
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm
  }

  /**
   * 播放历史。
   *
   * 数据只有一份 —— `play_progress` 表（每「用户 × 歌」一行，见 src/db.js）：
   *   last_played_at 决定排序，position 决定「下次从哪儿接着放」。
   * 所以这一页和续播是同一份账，不会出现「历史里有、续播找不到」这种对不上的情况。
   *
   * 记录在服务端而不是 localStorage：换设备、换浏览器、网页与 APK 之间都能接着听。
   */
  async function pageHistory() {
    const head = () => pageHeader('播放历史',
      '<button class="icon-btn" data-act="clear-play-history" aria-label="清空播放历史">' + ICON.trash + '</button>')
    view.innerHTML = head() + skeleton(6)
    try {
      const res = await API.playHistory(200)
      const rows = (res.list || []).filter(r => r && r.song)
      if (!rows.length) {
        view.innerHTML = pageHeader('播放历史')
          + emptyState('还没有播放记录', '播放过的歌会自动记在这里，下次点开能接着上次的位置听')
        return
      }
      const songs = rows.map(r => r.song)
      const key = registerList('history', songs)
      view.innerHTML = head()
        + '<div class="block" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
        + '<button class="btn btn--sm" data-act="play-list" data-list="' + key + '">' + ICON.play + '播放全部</button>'
        + '<div class="note">共 ' + rows.length + ' 首 · 记录在服务器，换设备也在</div></div>'
        + '<div class="songlist">' + rows.map((r, i) => {
          const dur = Number(r.duration) || 0
          const pos = Number(r.position) || 0
          const pct = dur > 0 ? Math.max(0, Math.min(100, Math.round(pos / dur * 100))) : 0
          return '<div class="song song--rich" data-list="' + key + '" data-i="' + i + '">'
            + '<div class="song__cover">' + coverTag(r.song.img, r.song.name, 120) + '</div>'
            + '<div class="song__meta">'
            + '<div class="song__name">' + esc(r.song.name || '未知歌曲') + '</div>'
            + '<div class="song__sub">' + esc(r.song.singer || '未知歌手') + '</div>'
            + '<div class="hist__bar"><i style="width:' + pct + '%"></i></div>'
            + '<div class="hist__meta">' + formatTime(pos) + (dur ? ' / ' + formatTime(dur) : '')
            + ' · 播了 ' + (Number(r.playCount) || 0) + ' 次 · ' + fmtWhen(r.lastPlayedAt) + '</div>'
            + '</div>'
            + '<button class="song__act" data-act="del-play-history" data-id="' + esc(r.songId) + '" aria-label="删除这条记录">'
            + ICON.trash + '</button>'
            + '</div>'
        }).join('') + '</div>'
        + '<div style="height:20px"></div>'
    } catch (e) {
      view.innerHTML = pageHeader('播放历史') + emptyState('加载失败', esc((e && e.message) || ''))
    }
  }

  /* ================= 设置 ================= */

  async function pageSettings() {
    const u = App.user || {}
    const qs = Player.QUALITIES.map(q =>
      '<button class="chip' + (q.key === Player.state.quality ? ' is-active' : '') + '" data-act="set-quality" data-key="' + q.key + '">' + q.name + '</button>').join('')
    const ms = Player.MODES.map(m =>
      '<button class="chip' + (m.key === Player.state.mode ? ' is-active' : '') + '" data-act="set-mode" data-key="' + m.key + '">' + m.name + '</button>').join('')

    view.innerHTML = pageHeader('设置')
      + '<div class="block"><div class="field__label">默认音质</div><div class="chips" style="padding:0">' + qs + '</div>'
      + '<div class="note" style="margin-top:8px">无损/Hi-Res 需要对应插件支持，取不到时服务端会自动降到可用音质。</div></div>'
      + '<div class="block"><div class="field__label">播放模式</div><div class="chips" style="padding:0">' + ms + '</div></div>'
      + '<div class="block" id="cacheBlock">' + cacheBlockHtml() + '</div>'
      + '<div class="block"><div class="field__label">播放队列</div>'
      + '<div class="note">当前 ' + Player.queue.length + ' 首</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px">'
      + '<button class="btn btn--sm btn--ghost" data-act="open-queue">查看队列</button>'
      + '<button class="btn btn--sm btn--ghost" data-act="clear-queue">清空队列</button></div></div>'
      + '<div class="block"><div class="field__label" style="margin-bottom:8px">修改密码</div>'
      + '<div class="field"><input class="input" id="oldPwd" type="password" placeholder="原密码" autocomplete="current-password"></div>'
      + '<div class="field"><input class="input" id="newPwd" type="password" placeholder="新密码（至少 4 位）" autocomplete="new-password"></div>'
      + '<button class="btn btn--block btn--ghost" data-act="change-pwd">保存新密码</button></div>'
      + '<div class="block" id="localPluginBlock">' + (window.LX_REMOTE ? remotePluginNoteHtml() : localPluginBlockHtml()) + '</div>'
      + (window.LX_NATIVE ? '<div class="block" id="serverBlock">' + serverBlockHtml() + '</div>' : '')
      + (window.LX_NATIVE ? '<div class="block" id="mediaBlock">' + mediaBlockHtml() + '</div>' : '')
      + '<div class="block"><div class="field__label">当前账号</div><div class="note">' + esc(u.username || '-') + (u.isAdmin ? '（管理员）' : '') + '</div>'
      + '<button class="btn btn--block btn--ghost" style="margin-top:10px" data-act="logout">退出登录</button></div>'
      + '<div class="block"><div class="field__label">版本</div><div class="note" id="verLine">' + esc(window.LX_VERSION_LINE || '读取中…') + '</div>'
      + '<div class="note" style="margin-top:6px" id="verHost">读取服务端版本…</div></div>'
      + '<div style="height:20px"></div>'

    // 服务端版本异步补 —— 不在上面的 innerHTML 里等它，否则进设置页会卡一下
    fillVersionBlock()
    // 缓存占用要遍历 Cache Storage 量字节，同步算会卡住整个设置页
    fillCacheBlock()
    // 服务器模式下的插件清单也异步补（同样不占首屏）
    if (window.LX_REMOTE) refreshServerPlugins().catch(() => {})
  }

  /* ---------------- 播放缓存 / 下载 ---------------- */

  const MB = 1024 * 1024

  function fmtBytes(n) {
    const b = Number(n) || 0
    if (b < 1024) return b + ' B'
    if (b < MB) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * MB) return (b / MB).toFixed(1) + ' MB'
    return (b / 1024 / MB).toFixed(2) + ' GB'
  }

  /**
   * 缓存设置卡。
   *
   * 三个东西必须一眼可见，否则用户没法判断「缓存到底有没有在起作用」：
   *   ① 已占用多少 —— 不给数字就会怀疑它偷偷把手机塞满；
   *   ② 上限是多少，且能改 —— 手机存储是稀缺资源，默认值不该是唯一选择；
   *   ③ 自动开不开 —— 流量敏感的用户要有办法关掉。
   */
  function cacheBlockHtml() {
    const c = window.LXAudioCache
    if (!c || !c.supported) {
      return '<div class="field__label">播放缓存</div>'
        + '<div class="note">当前环境不支持离线缓存（浏览器隐私模式下 Cache 接口不可用）。</div>'
    }
    const auto = c.autoEnabled()
    const limit = c.limitMb()
    const opts = [200, 500, 1024, 2048]
    return '<div class="field__label" style="margin-bottom:8px">播放缓存</div>'
      + '<div class="note" id="cacheStat">正在统计…</div>'
      + '<div class="field__label" style="margin:14px 0 6px">缓存上限</div>'
      + '<div class="chips" style="padding:0">' + opts.map(m =>
        '<button class="chip' + (m === limit ? ' is-active' : '') + '" data-act="set-cache-limit" data-key="' + m + '">'
        + (m >= 1024 ? (m / 1024) + 'GB' : m + 'MB') + '</button>').join('') + '</div>'
      + '<div class="field__label" style="margin:14px 0 6px">自动缓存听过的歌</div>'
      + '<div class="chips" style="padding:0">'
      + '<button class="chip' + (auto ? ' is-active' : '') + '" data-act="set-cache-auto" data-key="1">开启</button>'
      + '<button class="chip' + (!auto ? ' is-active' : '') + '" data-act="set-cache-auto" data-key="0">关闭</button>'
      + '</div>'
      + '<div class="note" style="margin-top:8px">整首播完后自动存到本机。再次播放不再重新取流，弱网下也能听。</div>'
      + '<div style="display:flex;gap:8px;margin-top:12px">'
      + '<button class="btn btn--sm btn--ghost" data-act="open-cache-list">查看缓存的歌</button>'
      + '<button class="btn btn--sm btn--ghost" data-act="clear-cache">清空缓存</button></div>'
  }

  async function fillCacheBlock() {
    const el = document.getElementById('cacheStat')
    if (!el) return
    const c = window.LXAudioCache
    if (!c) return
    try {
      const s = await c.stats()
      if (!document.body.contains(el)) return    // 用户已经离开设置页
      const pct = s.limitMb > 0 ? Math.min(100, Math.round(s.usedBytes / (s.limitMb * MB) * 100)) : 0
      el.innerHTML = '已缓存 <b>' + s.count + '</b> 首 · 占用 <b>' + fmtBytes(s.usedBytes) + '</b>'
        + ' / ' + (s.limitMb >= 1024 ? (s.limitMb / 1024) + 'GB' : s.limitMb + 'MB')
        + '（' + pct + '%）'
        + (s.writing ? '<span style="color:var(--brand)"> · 正在缓存 ' + s.writing + ' 首…</span>' : '')
    } catch (e) {
      el.textContent = '统计失败：' + ((e && e.message) || '')
    }
  }

  /**
   * 缓存清单页。
   *
   * 缓存条目里只有 id 与平台（Cache 里存不了歌名），所以这里**刻意复用 `.song`
   * 那一套行样式**而不是另造一套：既和全站的歌曲列表长得一致，也不用新增 CSS。
   * 想具体知道是哪首，点「播放」去还原；列表本身只负责「占了多少、能删掉」。
   */
  async function pageCache() {
    view.innerHTML = pageHeader('播放缓存') + '<div id="cacheList">' + skeleton(4) + '</div>'
    const box = document.getElementById('cacheList')
    const c = window.LXAudioCache
    if (!c || !c.supported) { box.innerHTML = emptyState('不可用', '当前环境不支持缓存'); return }
    let items = []
    try { items = await c.list() } catch { items = [] }
    if (!items.length) {
      box.innerHTML = emptyState('还没有缓存的歌', '整首听完的歌会自动存下来；也可以在歌曲菜单里点「下载到本机」')
      return
    }
    const total = items.reduce((s, x) => s + x.bytes, 0)
    box.innerHTML = '<div class="section"><div class="note" style="padding:0 14px 10px">'
      + items.length + ' 首 · 共 ' + fmtBytes(total) + '</div></section>'
      + '<div class="songlist">' + items.map(it => {
        const p = App.platformShort[it.song.source] || it.song.source || '未知'
        return '<div class="song">'
          + '<div class="song__index">' + ICON.download + '</div>'
          + '<div class="song__meta"><div class="song__name">' + esc(p) + ' · ' + esc(String(it.song.id)) + '</div>'
          + '<div class="song__sub">' + esc(it.quality) + '<span class="dot">·</span>' + fmtBytes(it.bytes)
          + (it.createdAt ? '<span class="dot">·</span>' + fmtTime(it.createdAt) : '') + '</div></div>'
          + '<div class="song__acts">'
          + '<button class="song__act" data-act="cache-play" data-key="' + esc(it.key) + '" aria-label="播放">' + ICON.play + '</button>'
          + '<button class="song__act" data-act="cache-del" data-key="' + esc(it.key) + '" aria-label="删除">' + ICON.trash + '</button>'
          + '</div></div>'
      }).join('') + '</div>'
  }

  function fmtTime(ms) {
    const d = new Date(Number(ms) || 0)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前'
    if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前'
    const p = (x) => String(x).padStart(2, '0')
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /**
   * 下载一首歌。
   *
   * 优先吃缓存（听过就不必再下一次）；没缓存就现抓。进度直接写在按钮上 ——
   * 一首无损有几十 MB，没有进度就等于「点了没反应」。
   */
  async function downloadSong(song, node) {
    const c = window.LXAudioCache
    if (!c || !c.supported) { toast('当前环境不支持下载'); return }
    const label = song.name || '这首歌'
    const old = node ? node.textContent : ''
    let lastPct = -1
    const onProgress = (p) => {
      if (!node || p < 0) return
      const pct = Math.round(p * 100)
      // 每 5% 才改一次 DOM —— 每帧都改会让长列表里的按钮疯狂重排
      if (pct === lastPct || pct % 5 !== 0) return
      lastPct = pct
      node.textContent = '下载 ' + pct + '%'
    }
    if (node) { node.disabled = true; node.textContent = '准备中…' }
    toast('正在获取「' + label + '」…')
    try {
      const r = await c.exportSong(song, Player.state.quality,
        () => Player.resolveForDownload(song, Player.state.quality), onProgress)
      if (r && r.ok) {
        toast('已保存：' + r.filename + '（' + fmtBytes(r.bytes) + '）', 4000)
      } else {
        toast('下载失败：' + ((r && r.error) || '未知原因'), 5000)
      }
    } catch (e) {
      toast('下载失败：' + ((e && e.message) || ''), 5000)
    } finally {
      if (node) { node.disabled = false; node.textContent = old || '下载' }
    }
  }

  /* ================= 客户端品牌名 ================= */

  /**
   * 当前客户端的展示名（Docker → LX-MUSIC，CF/壳 → music-edge）。
   *
   * 收成一个函数是为了**没有任何硬编码的退路**：万一 brand.js 没加载成功
   * （脚本 404、被 CSP 拦），也只会退到一个中性名字，而不是某个写死的旧品牌名 ——
   * 以前的 bug 正是「名字散在四处、改一处漏一处」，这里不再重蹈。
   */
  function brandName() {
    return (global.LXBrand && global.LXBrand.name) || '音乐'
  }

  /**
   * 品牌名确认后，把已经渲染出来的登录页大标题也纠正过来。
   *
   * 浏览器模式下 brand.js 首屏不动任何落点（防闪错名，见它的文件尾），
   * 所以登录页第一次渲染时 h1 可能还是**兜底猜**的名字 —— 在 CF 线上
   * 猜的是 docker → 大标题短暂显示 LX-MUSIC。brand.test 的静态断言管不到
   * 这种「渲染时机 vs 异步确认」的竞态，所以这里用事件把它接上：
   * applyHost 确认真变了 → 派 lx-brand → 这里直接改 h1 文本。
   */
  function watchBrandForLogin() {
    global.addEventListener('lx-brand', () => {
      const h = document.getElementById('loginBrand')
      if (h) h.textContent = brandName()
    })
  }

  /**
   * 让服务端确认「我到底是哪个客户端」，据此把名字刷成 LX-MUSIC 或 music-edge。
   *
   * 为什么必须有这一步：brand.js 加载时只能用**同步**判据猜（壳里？远程模式？），
   * 那条路在「浏览器直接打开 Docker 网页端」和「浏览器直接打开 CF 线上」这两种
   * 最常见的情况下**给出的答案一样** —— 都是 docker。所以要靠服务端
   * /api/version 的 host 字段来定论（那边 src/index.js / server/index.mjs 各写各的）。
   *
   * 为什么不 await：这是个纯显示问题，不该拖慢首屏。品牌猜错顶多是标题先显示
   * 一会儿默认名、随后纠正；而 await 会让整个 boot 卡在网络上。
   */
  function bindBrand() {
    if (!global.LXBrand) return
    API.version().then((v) => {
      // applyHost 只在真的变了的时候返回 true（并自己重刷标题、manifest、派事件）
      global.LXBrand.applyHost(v && v.host)
    }).catch(() => { /* 接口不通就保持兜底判据，不打扰用户 */ })
  }

  /**
   * 把版本号填进设置页。
   *
   * 为什么要在设置页显示：用户报问题（「我这里没声音」「插件不工作」）时，
   * 第一件事永远是确认双方说的是同一个版本，否则半小时都在猜。
   *
   * 两个数字分别来自不同宿主，**故意都显示**：
   *   · 前端版本 —— 写死在 window.LX_VERSION_LINE（由 index.html 的内联脚本注入）
   *   · 服务端版本 —— GET /api/version（Docker / CF / 壳内后端各回各的）
   * 两者不一致时高亮提示：这正是「App 装了新版但连的老服务器」的典型症状，
   * 以前只能靠人肉对比，现在一眼可见。
   */
  async function fillVersionBlock() {
    const host = document.getElementById('verHost')
    if (!host) return   // 用户已经离开设置页
    try {
      const v = await API.version()
      // 浏览器模式的 LX_VERSION 是 'web' 占位（真实版本只存在于壳里），
      // 网页客户端与服务端出自同一次部署、天然同步 —— 拿占位去比必然「不一致」，
      // 之前每个浏览器用户都会看到假的「⚠ 与服务端版本不一致」，这里只在壳里才比。
      const clientVer = String(window.LX_VERSION || '')
      const same = !v.version || clientVer === 'web' || v.version === clientVer
      host.innerHTML = '服务端 ' + esc(v.full || v.version || '?')
        + (same ? '' : '<span style="color:var(--warn,#e6a23c)"> ⚠ 与服务端版本不一致</span>')
      window.LX_VERSION_LINE = (window.LX_VERSION_LINE || '') + ' · 服务端 ' + (v.version || '?')
      const line = document.getElementById('verLine')
      if (line) line.textContent = window.LX_VERSION_LINE
    } catch (e) {
      host.innerHTML = '<span style="color:var(--danger,#f56c6c)">服务端版本读取失败：'
        + esc((e && e.message) || '网络不可达') + '</span>'
    }
  }

  /* ================= Subsonic 接入信息 ================= */

  function pageAbout() {
    const origin = location.origin
    const u = App.user || {}
    const rows = [
      { k: '服务器地址', v: origin },
      { k: '端口', v: location.protocol === 'https:' ? '443（HTTPS）' : '80' },
      { k: '用户名', v: u.username || '-' },
      { k: '密码', v: '你自己的登录密码' },
      { k: '认证方式', v: 'Token（客户端里勾选 "使用 Token 认证" 或填 salt）' },
    ]
    view.innerHTML = pageHeader('Subsonic 客户端接入')
      + '<div class="block">'
      + rows.map(r => '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">'
        + '<div class="note" style="flex:0 0 84px">' + r.k + '</div>'
        + '<div style="flex:1;word-break:break-all;font-size:13.5px">' + esc(r.v) + '</div></div>').join('')
      + '<div class="note" style="margin-top:14px">在 <b>音流 / Feishin / DSub / substreamer</b> 等客户端里，服务器地址填 <b>' + esc(origin) + '</b>，'
      + '用户名密码填本应用的登录账号即可。若客户端要求填路径，加 <b>/rest</b>。</div>'
      + '</div>'
      + '<div class="block"><div class="field__label" style="margin-bottom:8px">支持的接口</div>'
      + '<div class="note">ping · getLicense · search3 · stream · download · getCoverArt · getLyricsBySongId · '
      + 'getPlaylists · getPlaylist · createPlaylist · updatePlaylist · deletePlaylist · star / unstar · '
      + 'getStarred2 · getAlbumList2 · getArtists · getArtist · getAlbum · scrobble · getScanStatus 等 Subsonic 1.16.1 接口。</div></div>'
      + '<div class="block"><div class="field__label" style="margin-bottom:8px">关于</div>'
      + '<div class="note" id="aboutVer">' + esc(window.LX_VERSION_LINE || '') + '</div>'
      + '<div class="note" style="margin-top:6px">本应用兼容落雪（LX Music）自定义音源插件，'
      + '搜索聚合酷狗 / 网易云 / 酷我 / QQ音乐等平台，播放地址由插件解析后输出。'
      + '可跑在 Cloudflare Workers、安卓壳内或你自己的 Docker 服务器上。</div></div>'
      + '<div style="height:20px"></div>'
  }

  function pageNotFound() {
    view.innerHTML = emptyState('页面不存在', '返回首页继续听歌',
      '<div style="margin-top:16px"><a class="btn btn--sm" href="#/">回到首页</a></div>')
  }

  /* ================= 登录 / 初始化 ================= */

  async function pageLogin() {
    // 用户名预填：设置页里配过「登录用户名」的话直接带上，不用每次手输
    const presetUser = (window.LXApp && window.LXApp.serverUser) || ''
    view.innerHTML = '<div class="login-wrap">'
      + '<h1 id="loginBrand">' + esc(brandName()) + '</h1><p>登录后即可搜索播放、导入歌单，并用 Subsonic 客户端连接。</p>'
      + '<div class="field"><div class="field__label">用户名</div><input class="input" id="loginUser" autocomplete="username" value="' + esc(presetUser) + '"></div>'
      + '<div class="field"><div class="field__label">密码</div><input class="input" id="loginPwd" type="password" autocomplete="current-password"></div>'
      + '<button class="btn btn--block" id="btnLogin" style="margin-top:8px">登录</button>'
      + '<div class="note" style="margin-top:14px;text-align:center">首次使用？如果数据库里还没有账号，会引导你创建一个。</div>'
      + serverEntryHtml()
      + '</div>'
    const submit = async () => {
      const username = $('#loginUser').value.trim()
      const password = $('#loginPwd').value
      if (!username || !password) { toast('请填写用户名和密码'); return }
      const btn = $('#btnLogin')
      btn.disabled = true; btn.textContent = '登录中…'
      try {
        const res = await API.login(username, password)
        API.setToken(res.token)
        App.user = res.user
        toast('欢迎回来，' + res.user.username)
        location.hash = '#/'
        await boot()
      } catch (e) {
        toast((e && e.message) || '登录失败')
        btn.disabled = false; btn.textContent = '登录'
      }
    }
    $('#btnLogin').addEventListener('click', submit)
    $('#loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  }

  async function pageSetup() {
    // 服务器还没建账号时，把配置里预填的用户名带上 —— 省得用户再想一遍叫什么
    const presetUser = (window.LXApp && window.LXApp.serverUser) || ''
    view.innerHTML = '<div class="login-wrap">'
      + '<h1>初始化</h1><p>数据库还是空的，先创建一个管理员账号吧。这个账号同时用于 Subsonic 客户端登录。</p>'
      + '<div class="field"><div class="field__label">用户名</div><input class="input" id="setupUser" autocomplete="username" value="' + esc(presetUser) + '"></div>'
      + '<div class="field"><div class="field__label">密码（至少 4 位）</div><input class="input" id="setupPwd" type="password" autocomplete="new-password"></div>'
      + '<button class="btn btn--block" id="btnSetup" style="margin-top:8px">创建并进入</button>'
      + serverEntryHtml()
      + '</div>'
    $('#btnSetup').addEventListener('click', async () => {
      const username = $('#setupUser').value.trim()
      const password = $('#setupPwd').value
      if (!username || password.length < 4) { toast('用户名不能为空，密码至少 4 位'); return }
      const btn = $('#btnSetup')
      btn.disabled = true; btn.textContent = '创建中…'
      try {
        const res = await API.setup(username, password)
        API.setToken(res.token)
        App.user = res.user
        toast('初始化完成')
        location.hash = '#/'
        await boot()
      } catch (e) {
        toast((e && e.message) || '创建失败')
        btn.disabled = false; btn.textContent = '创建并进入'
      }
    })
  }

  /* ================= 抽屉 / 队列 ================= */

  function openSheet(node) {
    if (!node) return
    clearTimeout(node.__hideTimer)
    node.hidden = false
    requestAnimationFrame(() => node.classList.add('is-open'))
  }
  function closeSheet(node) {
    if (!node) return
    node.classList.remove('is-open')
    clearTimeout(node.__hideTimer)
    node.__hideTimer = setTimeout(() => { node.hidden = true }, 300)
  }

  function openDrawer(title, html, onMount) {
    if (drawerTitle) drawerTitle.textContent = title || ''
    if (drawerBody) drawerBody.innerHTML = html || ''
    openSheet(drawer)
    if (typeof onMount === 'function') onMount()
  }

  function openQueue() {
    renderQueue()
    openSheet(queueSheet)
  }

  /* ---------------- 音质 / 音色 ---------------- */

  /**
   * 音质面板。
   * 之前 `#btnQuality` 是「连点循环切换」—— 四档要试到想要的得点好几次，
   * 而且切到哪一档只有底栏那三个字符能看出来。改成面板直接点选。
   */
  function openQualitySheet() {
    const qs = Player.QUALITIES.map(q =>
      '<button class="chip' + (q.key === Player.state.quality ? ' is-active' : '') + '" data-act="set-quality" data-key="' + q.key + '">'
      + esc(q.name) + '</button>').join('')
    openDrawer('音质',
      '<div style="padding:4px 16px 18px">'
      + '<div class="chips" style="padding:0;flex-wrap:wrap">' + qs + '</div>'
      + '<div class="note" style="margin-top:14px">无损 / Hi-Res 需要对应插件支持；'
      + '取不到时会自动降到可用音质，不会没声音。切换时会保留当前播放位置。</div>'
      + '</div>')
  }

  /**
   * 音色面板（均衡器预设）。
   *
   * 选完要做的第一件事是**跨域预检**：Web Audio 挂在没有 CORS 头的音源上会输出静音
   * （详见 public/js/tone.js 顶部）。判定不通过就退回服务端中转播放；
   * 壳内没有代理这一级，只能明确告诉用户「这首用不了音效」。
   */
  function openToneSheet() {
    const ok = typeof Tone !== 'undefined' && Tone.supported()
    const cur = ok ? Tone.preset : 'flat'
    const chips = (ok ? Tone.PRESETS : []).map(p =>
      '<button class="chip' + (p.key === cur ? ' is-active' : '') + '" data-act="set-tone" data-key="' + p.key + '">'
      + esc(p.name) + '</button>').join('')
    const info = ok ? Tone.presetInfo : null
    openDrawer('音色',
      '<div style="padding:4px 16px 18px">'
      + (ok
        ? '<div class="chips" style="padding:0;flex-wrap:wrap">' + chips + '</div>'
          + '<div class="note" style="margin-top:12px">当前：<b>' + esc(info.name) + '</b>　'
          + esc(info.desc || '') + '</div>'
          + '<div class="note" style="margin-top:12px">音效由浏览器的 Web Audio 实现，'
          + '要求音源允许跨域。遇到不带跨域许可的音源时：'
          + (window.LX_NATIVE && !window.LX_REMOTE
            ? '本机版会提示并自动关掉音效（本机版没有服务端中转这一级）。'
            : '会自动改用服务端中转播放，声音照常，只是多占一点服务器流量。')
          + '</div>'
        : '<div class="note" style="color:var(--brand)">当前运行环境不支持音效（没有 Web Audio）。</div>')
      + '</div>')
  }

  async function pickTone(key) {
    if (typeof Tone === 'undefined' || !Tone.supported()) { toast('当前环境不支持音效'); return }
    if (!Tone.PRESETS.some(p => p.key === key)) return
    if (key === 'flat') {
      Tone.reset()
      Player.reloadForTone()
      openToneSheet()
      toast('已关闭音效')
      return
    }
    const a = Player.audio
    const src = (a && a.getAttribute('src')) || ''
    if (!src) { toast('先放一首歌再调音色'); return }

    const usable = await Tone.canUse(src)
    if (!usable && window.LX_NATIVE && !window.LX_REMOTE) {
      toast('这个音源不支持音效（没有跨域许可），换一首或换音质再试')
      return
    }
    if (!usable && !confirm('当前音源不支持音效（服务器没给跨域许可）。\n\n'
      + '改用服务端中转播放可以开启音效，声音正常，但音频会多走一跳服务器。是否切换？')) {
      return
    }
    if (!Tone.setPreset(key)) { toast('音效不可用'); return }
    const running = await Tone.resume()
    if (!running) toast('音效已选中，点一下播放即可生效')
    if (!usable) Player.reloadForTone()     // 直连没跨域许可 → 走代理
    openToneSheet()
    toast('音色：' + Tone.presetInfo.name)
  }

  function renderQueue() {
    const q = Player.queue
    if (queueCount) queueCount.textContent = q.length + ' 首'
    if (!queueList) return
    if (!q.length) {
      queueList.innerHTML = emptyState('队列是空的', '在歌曲列表点击任意一首开始播放')
      return
    }
    queueList.innerHTML = q.map((s, i) =>
      '<div class="song song--rich' + (i === Player.index ? ' is-current' : '') + '" data-q="' + i + '">'
      + '<div class="song__cover">' + coverTag(s.img, s.name, 120) + '</div>'
      + '<div class="song__meta"><div class="song__name"' + (i === Player.index ? ' style="color:var(--brand)"' : '') + '>' + esc(s.name) + '</div>'
      + '<div class="song__sub">' + esc(s.singer || '') + '</div></div>'
      + '<button class="song__act" data-qdel="' + i + '" aria-label="移出队列">' + ICON.trash + '</button>'
      + '</div>').join('')
  }

  /* ================= 歌单选择（收藏到歌单） ================= */

  async function openPlaylistPicker(songIds, defaultName) {
    let list = []
    try { list = (await API.playlists()).list || [] } catch { /* ignore */ }
    const body = '<div style="padding:0 0 8px">'
      + '<div class="menu-item" data-act="pick-new-playlist"><span class="quick__icon c-red" style="width:34px;height:34px;border-radius:8px">' + ICON.plus + '</span>'
      + '<div class="menu-item__text">新建歌单并加入</div></div>'
      + list.map(p => '<div class="menu-item" data-act="pick-playlist" data-id="' + esc(p.id) + '" data-ids="' + esc(songIds.join(',')) + '">'
        + '<span class="quick__icon c-gray" style="width:34px;height:34px;border-radius:8px">' + ICON.list + '</span>'
        + '<div class="menu-item__text">' + esc(p.name) + '<div class="menu-item__desc">' + (p.song_count || 0) + ' 首</div></div></div>').join('')
      + '</div>'
    openDrawer('收藏到歌单', body)
    drawerBody.dataset.pendingIds = songIds.join(',')
    drawerBody.dataset.pendingName = defaultName || '新建歌单'
  }

  /* ================= 事件委托 ================= */

  function bindGlobalEvents() {
    /* --- 主视图 --- */
    view.addEventListener('click', async (e) => {
      const quick = e.target.closest('[data-quick]')
      if (quick) { handleQuick(quick.dataset.quick); return }

      const songMenu = e.target.closest('[data-act="song-menu"]')
      if (songMenu) { openSongMenu(songMenu.dataset.list, Number(songMenu.dataset.i)); return }

      const fav = e.target.closest('[data-act="fav"]')
      if (fav) { e.stopPropagation(); Player.toggleFavorite({ id: fav.dataset.id }); return }

      const act = e.target.closest('[data-act]')
      if (act) { await handleAction(act); return }

      // 搜索结果里的「＋ 加入歌单」：必须先于下面那行「点整行就播放」拦住，
      // 否则点按钮会连带把这首播出来。
      const plAdd = e.target.closest('[data-pl-add]')
      if (plAdd) { e.stopPropagation(); await addSongFromSearch(Number(plAdd.dataset.plAdd)); return }

      const row = e.target.closest('.song[data-list]')
      if (row) {
        const songs = lists[row.dataset.list] || []
        const i = Number(row.dataset.i) || 0
        if (songs.length) Player.playList(songs, i)
        return
      }
    })

    view.addEventListener('keydown', (e) => {
      if (e.target.id === 'searchInput' && e.key === 'Enter') doSearch()
    })

    /* --- 队列抽屉 --- */
    queueSheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { closeSheet(queueSheet); return }
      const del = e.target.closest('[data-qdel]')
      if (del) { e.stopPropagation(); Player.removeAt(Number(del.dataset.qdel)); renderQueue(); return }
      const row = e.target.closest('[data-q]')
      if (row) {
        const i = Number(row.dataset.q)
        if (i !== Player.index) Player.playList(Player.queue.slice(), i)
        closeSheet(queueSheet)
      }
    })

    /* --- 通用抽屉 --- */
    drawer.addEventListener('click', async (e) => {
      if (e.target.closest('[data-close]')) { closeSheet(drawer); return }
      const item = e.target.closest('[data-act]')
      if (!item) return
      await handleAction(item)
    })

    /* --- 顶部栏 --- */
    $('#btnMenu').addEventListener('click', () => {
      openDrawer('菜单',
        '<div class="menu-item" data-act="nav" data-href="#/"><span class="quick__icon c-red">' + ICON.sound + '</span><div class="menu-item__text">发现音乐</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/charts"><span class="quick__icon c-orange">' + ICON.chart + '</span><div class="menu-item__text">排行榜</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/library"><span class="quick__icon c-blue">' + ICON.list + '</span><div class="menu-item__text">我的歌单</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/favorite"><span class="quick__icon c-pink">' + ICON.heart + '</span><div class="menu-item__text">我喜欢的音乐</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/history"><span class="quick__icon c-purple">' + ICON.history + '</span><div class="menu-item__text">播放历史</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/import"><span class="quick__icon c-teal">' + ICON.link + '</span><div class="menu-item__text">导入歌单</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/settings"><span class="quick__icon c-gray">' + ICON.settings + '</span><div class="menu-item__text">设置</div></div>'
        + '<div class="menu-item" data-act="nav" data-href="#/about"><span class="quick__icon c-gray">' + ICON.info + '</span><div class="menu-item__text">Subsonic 接入</div></div>')
    })
    $('#btnAccount').addEventListener('click', () => go('#/mine'))

    /* --- 搜索入口 --- */
    $('#topSearch').addEventListener('click', (e) => {
      e.preventDefault()
      go('#/search')
    })

    /* --- 迷你播放条 --- */
    $('#miniNext').addEventListener('click', (e) => { e.stopPropagation(); Player.next(true) })

    /* --- 全屏播放器 --- */
    $('#playerCollapse').addEventListener('click', () => Player.closePlayer())
    $('#btnPlay').addEventListener('click', () => Player.toggle())
    $('#btnPrev').addEventListener('click', () => Player.prev(true))
    $('#btnNext').addEventListener('click', () => Player.next(true))
    $('#btnMode').addEventListener('click', () => Player.cycleMode())
    $('#btnQuality').addEventListener('click', () => openQualitySheet())
    $('#btnTone').addEventListener('click', () => openToneSheet())
    $('#btnQueue').addEventListener('click', () => openQueue())
    $('#btnFav').addEventListener('click', () => Player.toggleFavorite())
    $('#playerStage').addEventListener('click', () => {
      const stage = $('#playerStage')
      stage.classList.toggle('show-lyric')
      if (stage.classList.contains('show-lyric')) {
        setTimeout(() => Player.emit('line', Player.state.lineIndex), 60)
        // 只在「这辈子第一次看歌词」时提示一次校准入口。
        // 为什么需要它：歌词高亮的判定依据只有 audio.currentTime（解码位置），
        // 而真正出声还要过输出缓冲 + 蓝牙编解码，这段延迟网页读不到。
        // 所以默认严格按时间戳，剩下的偏差交给用户按耳朵校准一次。
        if (!U.store.get('lx.lyricHinted', false)) {
          U.store.set('lx.lyricHinted', true)
          U.toast('歌词比声音早？点歌词下方 − / + 校准一次')
        }
      }
    })
    $('#playerBg').addEventListener('click', () => Player.closePlayer())

    /* --- 播放器状态同步 --- */
    Player.on('song', (song) => {
      if (song) document.title = (song.name || brandName()) + ' - ' + (song.singer || '')
      renderQueueIfOpen()
      syncFavIcons(song)
    })
    Player.on('queue', () => renderQueueIfOpen())
    Player.on('state', () => renderQueueIfOpen())
    Player.on('favorite', () => renderQueueIfOpen())

    /* --- 触摸返回手势（左滑） --- */
    bindSwipeBack()

    /* --- 路由 --- */
    window.addEventListener('hashchange', route)
  }

  function renderQueueIfOpen() {
    if (queueSheet && !queueSheet.hidden) renderQueue()
    const btn = $('#btnFav')
    if (btn && Player.current()) btn.style.opacity = '1'
  }

  function syncFavIcons() {
    // 列表中的收藏图标在重新渲染时刷新即可，这里只保证当前页状态一致
  }

  async function handleAction(node) {
    const act = node.dataset.act
    switch (act) {
      case 'back': back(); break
      case 'nav': closeSheet(drawer); go(node.dataset.href); break
      case 'reload-home': App.home = null; pageHome(); break
      case 'do-search': doSearch(); break
      case 'switch-source': {
        const src = node.dataset.source
        go(searchHash(searchState.q, src, searchState.type))
        break
      }
      case 'switch-type': {
        const t = node.dataset.type === 'album' ? 'album' : 'song'
        if (t === searchState.type) break
        go(searchHash(searchState.q, searchState.source, t))
        break
      }
      case 'album-blocked': {
        const src = node.dataset.source
        toast((App.platformNames[src] || src) + '暂不支持查看专辑曲目，可切到「综合」或其它平台再试')
        break
      }
      case 'del-history': {
        const kw = node.dataset.keyword || ''
        if (!kw) break
        try { await API.deleteHistory(kw) } catch { /* ignore */ }
        pageSearch(parseHash())
        break
      }
      case 'clear-history':
        try { await API.deleteHistory() } catch { /* ignore */ }
        pageSearch(parseHash())
        break
      /* --- 播放历史（注意和上面「搜索历史」不是一回事） --- */
      case 'clear-play-history': {
        if (!confirm('清空全部播放历史？')) return
        try {
          await API.clearPlayHistory()
          toast('已清空播放历史')
          pageHistory()
        } catch (e) { toast((e && e.message) || '清空失败') }
        break
      }
      case 'del-play-history': {
        try {
          await API.clearPlayHistory(node.dataset.id)
          pageHistory()
        } catch (e) { toast((e && e.message) || '删除失败') }
        break
      }
      case 'play-list': {
        const songs = lists[node.dataset.list] || []
        if (!songs.length) { toast('列表为空'); return }
        closeSheet(drawer)
        Player.playList(songs, 0)
        break
      }
      case 'enqueue-list': {
        const songs = lists[node.dataset.list] || []
        const n = Player.enqueue(songs)
        if (n) toast('已加入队列 ' + n + ' 首')
        break
      }
      case 'import-to': {
        const songs = lists[node.dataset.list] || []
        closeSheet(drawer)
        await openPlaylistPicker(songs.map(s => s.id), node.dataset.name)
        break
      }
      case 'new-playlist': {
        const name = prompt('新歌单名称', '我的歌单')
        if (!name) return
        try {
          const res = await API.createPlaylist(name.trim(), [])
          toast('已创建')
          go('#/playlist?id=' + encodeURIComponent(res.playlist.id))
        } catch (e) { toast((e && e.message) || '创建失败') }
        break
      }
      case 'del-playlist': {
        if (!confirm('确定删除这个歌单吗？')) return
        try {
          await API.deletePlaylist(node.dataset.id)
          toast('已删除')
          plCtx = null
          App.home = null
          back()
        } catch (e) { toast((e && e.message) || '删除失败') }
        break
      }
      /* --- 自建歌单：加歌 / 移除 / 调序 / 改名 --- */
      case 'add-songs': {
        const id = node.dataset.id || (plCtx && plCtx.id) || ''
        if (!id) { toast('歌单不存在'); return }
        closeSheet(drawer)
        go('#/playlist-add?id=' + encodeURIComponent(id))
        break
      }
      case 'rename-playlist': {
        if (!plCtx) return
        const name = prompt('歌单名称', plCtx.name || '')
        if (!name || !name.trim()) return
        try {
          await API.renamePlaylist(node.dataset.id || plCtx.id, name.trim())
          toast('已重命名')
          reloadPlaylist()
        } catch (e) { toast((e && e.message) || '重命名失败') }
        break
      }
      case 'pl-remove': {
        if (!plCtx) return
        const i = Number(node.dataset.i)
        const song = (lists[node.dataset.list] || [])[i]
        closeSheet(drawer)
        if (!song) return
        if (!confirm('把「' + song.name + '」从这个歌单里移除？')) return
        try {
          await API.removePlaylistSong(plCtx.id, i)
          toast('已移除')
          reloadPlaylist()
        } catch (e) { toast((e && e.message) || '移除失败') }
        break
      }
      case 'pl-up':
      case 'pl-down': {
        if (!plCtx) return
        const up = node.dataset.act === 'pl-up'
        const i = Number(node.dataset.i)
        const songs = lists[node.dataset.list] || []
        const to = i + (up ? -1 : 1)
        closeSheet(drawer)
        if (to < 0 || to >= songs.length) { toast(up ? '已经是第一首了' : '已经是最后一首了'); return }
        try {
          await API.movePlaylistSong(plCtx.id, i, to)
          reloadPlaylist()
        } catch (e) { toast((e && e.message) || '调整顺序失败') }
        break
      }
      /* --- 搜索结果里加歌 --- */
      case 'pl-add-search': doPlAddSearch(); break
      case 'open-queue': openQueue(); break
      case 'clear-queue': Player.clearQueue(); closeSheet(drawer); toast('已清空队列'); break
      case 'set-quality': {
        Player.setQuality(node.dataset.key)
        // 同一个动作被两处用：设置页的 chips（重绘整页）和播放器里的音质面板（重绘抽屉）
        if (drawer && !drawer.hidden) openQualitySheet()
        else pageSettings()
        break
      }
      case 'set-tone': {
        node.disabled = true
        await pickTone(node.dataset.key)
        node.disabled = false
        break
      }
      case 'set-mode': Player.setMode(node.dataset.key); pageSettings(); break
      /* ---- 服务端地址（仅安卓壳） ---- */
      case 'open-server': openServerSheet(); break
      case 'test-server': {
        const input = ($('#serverInput') || {}).value || ''
        if (!input.trim()) { toast('请先填服务器地址'); return }
        await testServerFrom(input)
        break
      }
      case 'save-server': {
        const input = ($('#serverInput') || {}).value || ''
        const user = ($('#serverUserInput') || {}).value || ''
        applyServerFrom(input, user)
        break
      }
      case 'use-local': applyServerFrom(''); break
      /* ---- 系统播放控制：状态、权限、诊断（仅安卓壳） ---- */
      case 'media-refresh': pageSettings(); break
      case 'media-ask-notif': {
        const H = window.AndroidHost
        if (!H || typeof H.askNotificationPermission !== 'function') { toast('这版 APK 不支持，请更新安装包'); return }
        H.askNotificationPermission()
        toast('已向系统申请通知权限')
        setTimeout(pageSettings, 1200)
        break
      }
      case 'media-open-settings': {
        const H = window.AndroidHost
        if (!H || typeof H.openAppSettings !== 'function') { toast('这版 APK 不支持，请更新安装包'); return }
        H.openAppSettings()
        break
      }
      case 'media-test-push': {
        if (typeof window.__lxMediaWake !== 'function') { toast('诊断入口未装配'); return }
        const n = window.__lxMediaWake()
        toast(n ? '已补报一次（累计 ' + n + ' 次）' : '暂时没有可上报的内容')
        setTimeout(pageSettings, 800)
        break
      }
      case 'media-diag': openMediaDiag(); break
      case 'change-pwd': {
        const oldPwd = $('#oldPwd').value
        const newPwd = $('#newPwd').value
        if (newPwd.length < 4) { toast('新密码至少 4 位'); return }
        try {
          await API.changePassword(oldPwd, newPwd)
          toast('密码已更新')
          $('#oldPwd').value = ''
          $('#newPwd').value = ''
        } catch (e) { toast((e && e.message) || '修改失败') }
        break
      }
      case 'logout': {
        if (!confirm('确定退出登录吗？')) return
        API.setToken('')
        App.user = null
        closeSheet(drawer)
        await boot()
        break
      }
      /* --- 插件相关 --- */
      case 'open-import-plugin': closeSheet(drawer); openPluginImport(); break
      /* --- 服务器模式的插件导入（见 remotePluginNoteHtml） --- */
      case 'srv-import-url': {
        const url = (($('#srvPluginUrl') || {}).value || '').trim()
        if (!url) { toast('请先填插件 URL'); return }
        await importPluginToServer({ url }, node)
        break
      }
      case 'srv-import-open': {
        const box = $('#srvImportBox')
        if (box) box.hidden = !box.hidden
        break
      }
      case 'srv-import-text': {
        const text = (($('#srvPluginText') || {}).value || '').trim()
        if (text.length < 50) { toast('脚本体太短了'); return }
        await importPluginToServer({ script: text }, node)
        break
      }
      case 'srv-del-plugin': {
        if (!confirm('从服务器删除这个插件？删掉后取流就不会再用它了。')) return
        node.disabled = true
        try {
          await API.deletePlugin(node.dataset.id)
          toast('已删除')
          await refreshServerPlugins()
        } catch (e) {
          node.disabled = false
          toast((e && e.message) || '删除失败')
        }
        break
      }
      case 'import-preset': {
        const preset = LXP.PRESETS[Number(node.dataset.i)]
        if (!preset) return
        node.disabled = true
        node.textContent = '导入中…'
        await importPluginByUrl(preset.url)
        break
      }
      case 'toggle-plugin': {
        const on = node.dataset.on === '1'
        await LXP.setEnabled(node.dataset.id, !on)
        await reloadLocalPlugins()
        break
      }
      case 'del-plugin': {
        if (!confirm('删除该插件？')) return
        await LXP.remove(node.dataset.id)
        await reloadLocalPlugins()
        toast('已删除')
        break
      }
      /* --- 歌曲更多菜单 --- */
      case 'play-now': Player.playList(lists[node.dataset.list] || [], Number(node.dataset.i)); closeSheet(drawer); break
      case 'add-queue': {
        const song = (lists[node.dataset.list] || [])[Number(node.dataset.i)]
        if (song && Player.enqueue([song])) toast('已加入队列')
        closeSheet(drawer)
        break
      }
      case 'fav-song': {
        const song = (lists[node.dataset.list] || [])[Number(node.dataset.i)]
        if (song) await Player.toggleFavorite(song)
        closeSheet(drawer)
        break
      }
      case 'collect-song': {
        const song = (lists[node.dataset.list] || [])[Number(node.dataset.i)]
        closeSheet(drawer)
        if (song) await openPlaylistPicker([song.id], song.name)
        break
      }
      case 'copy-song': {
        const song = (lists[node.dataset.list] || [])[Number(node.dataset.i)]
        if (song) copyText(song.name + ' - ' + (song.singer || ''))
        closeSheet(drawer)
        break
      }
      // 下载要先把菜单收掉：下载进度写在 toast 上，抽屉挡着就看不见
      case 'download-song': {
        const song = (lists[node.dataset.list] || [])[Number(node.dataset.i)]
        closeSheet(drawer)
        if (song) downloadSong(song, null)
        break
      }
      /* --- 播放缓存页 --- */
      case 'set-cache-limit': {
        const n = window.LXAudioCache && window.LXAudioCache.setLimitMb(Number(node.dataset.key))
        toast('缓存上限已设为 ' + (n >= 1024 ? (n / 1024) + 'GB' : n + 'MB'))
        fillCacheBlock()
        break
      }
      case 'set-cache-auto': {
        const on = node.dataset.key === '1'
        if (window.LXAudioCache) window.LXAudioCache.setAuto(on)
        toast(on ? '已开启自动缓存' : '已关闭自动缓存')
        // 重画这一块，让 chip 的选中态跟上
        const blk = document.getElementById('cacheBlock')
        if (blk) { blk.innerHTML = cacheBlockHtml(); fillCacheBlock() }
        break
      }
      case 'open-cache-list':
        go('#/cache')
        break
      case 'clear-cache': {
        if (!confirm('清空全部播放缓存？已下载到本机的文件不受影响。')) return
        const ok = window.LXAudioCache && await window.LXAudioCache.clear()
        toast(ok ? '缓存已清空' : '清空失败')
        fillCacheBlock()
        break
      }
      case 'cache-play': {
        /**
         * 缓存清单里只有「平台 + 歌曲 id」（Cache 里存不下歌名与歌手），
         * 要播就得先把这两个还原成一个完整的 song 对象。
         *
         * 没有「按 id 取详情」的接口，所以用搜索接口反查：拿 id 当关键词去搜，
         * 再在结果里挑 id 对得上的那条。命中率不高是正常的 —— id 不是歌名，
         * 各平台搜索未必把它当一回事。**因此必须给一句诚实的失败提示**，
         * 而不是默默什么都不做（那样用户只会以为缓存页坏了）。
         *
         * 真正的用途是「我缓存过这首歌，想再听一遍」——这条路径更稳的做法是
         * 从播放历史/歌单里点它，缓存会在那一刻直接命中。这里是给没留记录的场景兜底。
         */
        const key = node.dataset.key || ''
        const meta = (key.match(/\/audio\/([^/]+)\/([^/]+)\/([^/]+)$/) || [])
        const src = meta[1] ? decodeURIComponent(meta[1]) : ''
        const id = meta[2] ? decodeURIComponent(meta[2]) : ''
        if (!id) { toast('这条缓存记录不完整'); return }
        const who = (App.platformShort[src] || src) + ' ' + id
        if (node) { node.disabled = true; node.textContent = '查找中…' }
        try {
          const r = await API.search(id, { source: src, limit: 30 })
          const hit = ((r && r.list) || []).find(s => String(s.id) === id)
          if (hit) {
            Player.playSong(hit)
            toast('播放：' + (hit.name || ''))
          } else {
            toast('没能按 id 找回「' + who + '」的信息（缓存还在，从历史或歌单里点它会直接命中）', 5000)
          }
        } catch (e) {
          toast('查找失败：' + ((e && e.message) || ''), 5000)
        } finally {
          if (node) { node.disabled = false; node.textContent = '播放' }
        }
        break
      }
      case 'cache-del': {
        const ok = window.LXAudioCache && await window.LXAudioCache.dropKey(node.dataset.key)
        toast(ok ? '已删除' : '删除失败')
        if (ok) pageCache()
        break
      }
      /* --- 歌单选择器 --- */
      case 'pick-new-playlist': {
        const ids = (drawerBody.dataset.pendingIds || '').split(',').filter(Boolean)
        const name = prompt('新歌单名称', drawerBody.dataset.pendingName || '新建歌单')
        if (!name) return
        try {
          const res = await API.createPlaylist(name.trim(), ids.map(id => ({ id })))
          closeSheet(drawer)
          toast('已新建歌单并收藏')
          App.home = null
          go('#/playlist?id=' + encodeURIComponent(res.playlist.id))
        } catch (e) { toast((e && e.message) || '创建失败') }
        break
      }
      case 'pick-playlist': {
        const ids = (node.dataset.ids || drawerBody.dataset.pendingIds || '').split(',').filter(Boolean)
        if (!ids.length) { toast('没有歌曲'); return }
        try {
          await API.addToPlaylist(node.dataset.id, ids)
          closeSheet(drawer)
          toast('已添加到歌单')
        } catch (e) { toast((e && e.message) || '添加失败') }
        break
      }
      default: break
    }
  }

  function authHeader() {
    const t = API.getToken()
    return t ? { Authorization: 'Bearer ' + t } : {}
  }

  function openSongMenu(listKey, i) {
    const song = (lists[listKey] || [])[i]
    if (!song) return
    // 在歌单详情页里打开时，多三项「上移 / 下移 / 移出歌单」——
    // 自建歌单必须能改：只能建、不能删歌不能调序的话，用户建完就只能删掉重来。
    const inPl = !!(plCtx && plCtx.listKey === listKey)
    openDrawer(song.name,
      '<div style="padding:0 0 6px">'
      + '<div class="note" style="padding:4px 18px 10px">' + esc(song.singer || '') + (song.albumName ? ' · ' + esc(song.albumName) : '') + '</div>'
      + menuItem('play-now', listKey, i, ICON.play, '立即播放')
      + menuItem('add-queue', listKey, i, ICON.plus, '加入播放队列')
      + menuItem('fav-song', listKey, i, ICON.heart, '收藏 / 取消收藏')
      + menuItem('collect-song', listKey, i, ICON.list, '收藏到歌单')
      + menuItem('download-song', listKey, i, ICON.download, '下载到本机')
      + (inPl
        ? menuItem('pl-up', listKey, i, ICON.arrowUp, '上移一位')
          + menuItem('pl-down', listKey, i, ICON.arrowDown, '下移一位')
          + menuItem('pl-remove', listKey, i, ICON.trash, '从歌单中移除')
        : '')
      + menuItem('copy-song', listKey, i, ICON.link, '复制歌曲名')
      + '</div>')
  }

  function menuItem(act, listKey, i, icon, text) {
    return '<div class="menu-item" data-act="' + act + '" data-list="' + esc(listKey) + '" data-i="' + i + '">'
      + icon + '<div class="menu-item__text">' + text + '</div></div>'
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast(text))
    } else {
      toast(text)
    }
  }

  /* --- 左滑返回 --- */
  function bindSwipeBack() {
    let startX = 0, startY = 0, tracking = false
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      tracking = startX < 40 && !Player.isPlayerOpen() && drawer.hidden && queueSheet.hidden
    }, { passive: true })
    document.addEventListener('touchend', (e) => {
      if (!tracking) return
      tracking = false
      const t = e.changedTouches[0]
      if (t.clientX - startX > 70 && Math.abs(t.clientY - startY) < 60) {
        if (parseHash().path !== '/') back()
      }
    }, { passive: true })
  }

  /* ================= 启动 ================= */

  async function boot() {
    // 品牌名要在**最早**就确认，而且与登录状态无关 —— 放在这里而不是下面
    // 「已登录」之后，是因为未登录时走的是两个提前 return 的分支
    // （需要初始化 / 需要登录），那两页恰恰是**最需要正确品牌名**的：
    // 登录页正中就是一个大标题。放晚了它永远显示兜底猜的名字。
    // 本函数不 await（见它的说明），所以放这儿不会拖慢首屏。
    bindBrand()

    let status = { needsSetup: false }
    try { status = await API.setupStatus() } catch { /* ignore */ }

    if (status.needsSetup) {
      App.user = null
      location.hash = '#/setup'
      await route()
      return
    }

    if (!API.getToken()) {
      App.user = null
      location.hash = '#/login'
      await route()
      return
    }

    try {
      const me = await API.me()
      App.user = me.user
    } catch {
      API.setToken('')
      App.user = null
      location.hash = '#/login'
      await route()
      return
    }

    App.ready = true
    try {
      const s = await API.sources()
      App.sources = s.platforms || []
    } catch { /* ignore */ }
    Player.loadFavorites().catch(() => {})
    // 远程模式下音源插件在服务器那一侧跑，本机不加载插件池 ——
    // 少一批 Worker 的启动开销，也免得本机那套空池子被误当成「候选源」
    if (!window.LX_REMOTE) LXP.init().catch(() => {})

    await route()
  }

  function init() {
    Player.init()
    bindGlobalEvents()
    watchBrandForLogin()
    // 安卓壳里不注册 Service Worker：页面资源整包都在 APK 内（由原生按需提供），
    // 离线本来就成立；再叠一层 SW 缓存只会带来「改了包但页面还是旧的」这类时序问题。
    if ('serviceWorker' in navigator && !window.LX_NATIVE) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {})
      })
    }
    boot()
  }

  global.App = App
  global.__lx = { route, lists, go, openDrawer, closeSheet, reload: boot, searchPageDone, MAX_SEARCH_PAGE, searchPlaceholder, openQualitySheet, openToneSheet, pickTone }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})(window)
