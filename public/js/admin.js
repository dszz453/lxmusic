/**
 * 管理后台（/admin）
 *
 * 职责边界（这是本次改造的核心，别再把东西塞回用户端）：
 *
 *   管理端  —— 谁在用这台服务器、用哪些音源、插件按什么顺序取流、
 *              AI 接口怎么配、大家听了什么
 *   用户端  —— 听歌、搜索、歌单、收藏、播放历史、自己的播放设置
 *
 * 判据很简单：**改了会影响所有人的，是管理端；只影响自己的，是用户端。**
 * 按这条，「默认搜索源」归管理端（它决定全站综合搜索查哪些平台），
 * 而「默认音质」「音色」归用户端（只影响自己这次听感）。
 *
 * 接口全部走 /api/admin/*，服务端按前缀统一鉴权 —— 前端这层只负责「不该看的
 * 不给进」，真正的权限在服务端。所以这里不做「藏起来就算了」的事。
 */
(function (global) {
  'use strict'

  const $ = U.$
  const esc = U.escapeHtml
  const toast = U.toast

  const ICON = {
    dashboard: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
    plugin: '<svg viewBox="0 0 24 24"><path d="M9 4v5H5.5a2 2 0 0 0 0 4H9v5a2 2 0 0 0 4 0v-5h3.5a2 2 0 0 0 0-4H13V4a2 2 0 0 0-4 0z"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    ai: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
  }

  const TABS = [
    { key: 'overview', name: '概览', icon: 'dashboard', render: renderOverview },
    { key: 'sources', name: '音源与插件', icon: 'plugin', render: renderSources },
    { key: 'users', name: '用户管理', icon: 'user', render: renderUsers },
    { key: 'plays', name: '播放记录', icon: 'play', render: renderPlays },
    { key: 'ai', name: 'AI 歌单接口', icon: 'ai', render: renderAi },
  ]

  const state = { user: null, tab: '', loading: false }

  /* ================= 启动 ================= */

  boot()

  async function boot() {
    // 桌面端直接打开 /admin 时常用 hash 记住当前页签
    const hash = (location.hash || '').replace(/^#\/?/, '')
    if (hash && TABS.some(t => t.key === hash)) state.tab = hash

    if (!API.getToken()) return renderLogin()

    try {
      const res = await API.me()
      if (!res || !res.user) throw new Error('未登录')
      if (!res.user.isAdmin) return renderForbidden(res.user)
      state.user = res.user
    } catch {
      API.setToken('')
      return renderLogin()
    }
    renderShell()
  }

  function renderLogin(errText) {
    $('#adminRoot').innerHTML =
      '<div class="admin-login">'
      + '<h1>管理后台</h1>'
      + '<p>需要管理员账号</p>'
      + '<div class="admin-card">'
      + '<div class="field"><div class="field__label">用户名</div>'
      + '<input class="input" id="au" autocomplete="username" placeholder="admin"></div>'
      + '<div class="field"><div class="field__label">密码</div>'
      + '<input class="input" id="ap" type="password" autocomplete="current-password"></div>'
      + '<div id="aerr" class="note" style="color:#d73535;min-height:16px"></div>'
      + '<button class="btn btn--block" id="abtn">登录</button>'
      + '</div>'
      + '<div class="note" style="text-align:center;margin-top:14px">'
      + '<a href="/" style="color:var(--brand)">← 回到用户端</a></div>'
      + '</div>'
    if (errText) $('#aerr').textContent = errText
    const submit = async () => {
      const u = $('#au').value.trim()
      const p = $('#ap').value
      if (!u || !p) { $('#aerr').textContent = '请填写用户名和密码'; return }
      $('#abtn').disabled = true
      try {
        const r = await API.login(u, p)
        if (!r.user || !r.user.isAdmin) {
          API.setToken('')
          throw new Error('这个账号不是管理员')
        }
        API.setToken(r.token)
        state.user = r.user
        renderShell()
      } catch (e) {
        $('#aerr').textContent = (e && e.message) || '登录失败'
      } finally {
        $('#abtn').disabled = false
      }
    }
    $('#abtn').addEventListener('click', submit)
    $('#ap').addEventListener('keydown', e => { if (e.key === 'Enter') submit() })
    $('#au').focus()
  }

  function renderForbidden(user) {
    $('#adminRoot').innerHTML =
      '<div class="admin-login">'
      + '<h1>没有权限</h1>'
      + '<p>账号「' + esc(user.username) + '」不是管理员。</p>'
      + '<div class="admin-card" style="text-align:center">'
      + '<a class="btn" href="/" style="display:inline-block">回到用户端</a>'
      + '<button class="btn btn--ghost" id="aout" style="margin-left:8px">换个账号登录</button>'
      + '</div></div>'
    $('#aout').addEventListener('click', () => { API.setToken(''); renderLogin() })
  }

  function renderShell() {
    $('#adminRoot').innerHTML =
      '<div class="admin-shell">'
      + '<aside class="admin-side">'
      + '<div class="admin-brand">管理后台<small>' + esc(state.user.username) + ' · 管理员</small></div>'
      + '<nav class="admin-nav">'
      + TABS.map(t => '<div class="admin-nav__item" data-tab="' + t.key + '">'
        + ICON[t.icon] + '<span>' + t.name + '</span></div>').join('')
      + '</nav>'
      + '<div style="margin-top:16px;padding:0 12px">'
      + '<a href="/" style="font-size:12.5px;color:var(--text-3);text-decoration:none">← 回到用户端</a><br>'
      + '<a href="javascript:void(0)" id="aout" style="font-size:12.5px;color:var(--text-3);text-decoration:none">退出登录</a>'
      + '</div>'
      + '<div style="margin-top:14px;padding:0 12px" id="resStamp"></div>'
      + '</aside>'
      + '<main class="admin-main" id="adminMain"></main>'
      + '</div>'

    showResourceStamp()

    document.querySelectorAll('.admin-nav__item').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.tab))
    })
    $('#aout').addEventListener('click', async () => {
      API.setToken('')
      state.user = null
      renderLogin()
    })
    switchTab(state.tab || 'overview')
  }

  /**
   * 左下角那一行小字：当前跑的是哪份代码。
   *
   * 为什么值得占这一点地方：管理后台曾经被 Service Worker 的 stale-while-revalidate
   * 长期停住过 —— 全新环境打开一切正常，只有装着 PWA 的手机永远看旧页面。那种故障
   * 的唯一症状是人的口头描述（「评分没了」「看不到插件」），排查只能靠猜。
   * 现在把这个版本摆出来，读者一眼就能回答「是新版还是旧版」：
   *
   *   SW v14 · 资源 v14   —— 都是最新的
   *   SW v13 · 资源 v14   —— SW 还没接管更新（等一次刷新或硬刷）
   *   SW v13 · 资源 v13   —— 整个页面都停在旧版本，需要硬刷新
   *
   * 「资源」是既有 Service Worker 正在用的静态缓存名（lxmusic-static-vXX）。
   * 拿不到就什么也不显示 —— 这是辅助信息，任何失败都不该影响真正的管理功能。
   */
  async function showResourceStamp() {
    try {
      const host = document.getElementById('resStamp')
      if (!host || !('serviceWorker' in navigator)) return
      const res = await fetch('/sw.js', { cache: 'no-store' })
      const src = await res.text()
      const live = (src.match(/const VERSION = '(v\d+)'/) || [, ''])[1]
      let owned = ''
      try {
        const keys = await caches.keys()
        const hit = keys.find(k => k.startsWith('lxmusic-static-'))
        if (hit) owned = hit.replace('lxmusic-static-', '')
      } catch { /* 没开过 App 就没有这个缓存 */ }
      if (!live && !owned) return
      // 判定的三种情况要分清，否则会把「根本没缓存过」误报成「停在旧版本」：
      //   没有静态缓存  —— 说明这台浏览器还没被 SW 缓存过任何东西，本来就是新的
      //   有且版本号一致 —— 正常
      //   有但对不上    —— 才是真的停在旧版本，需要硬刷新
      const stale = !!(owned && live && owned !== live)
      host.innerHTML = '<div style="font-size:11.5px;color:var(--text-3);line-height:1.6">'
        + '资源 SW ' + esc(live || '—') + ' · 缓存 ' + esc(owned || '（还没缓存）')
        + (stale ? '<br><span style="color:#b26a00">'
          + '缓存的版本落后于线上，硬刷新（Ctrl+F5 / 长按刷新）后再看这一页</span>' : '')
        + '</div>'
    } catch { /* 取不到版本号就算了，不影响使用 */ }
  }

  function switchTab(key) {
    if (!TABS.some(t => t.key === key)) key = 'overview'
    // 顺序改了一半就切页签，等于把改动悄悄丢掉 —— 先问一句。
    if (key !== state.tab && !confirmDiscardSources()) return
    state.tab = key
    location.hash = key
    document.querySelectorAll('.admin-nav__item').forEach(el => {
      el.classList.toggle('is-active', el.dataset.tab === key)
    })
    TABS.find(t => t.key === key).render()
  }

  /**
   * 「默认搜索源」有未保存改动时的离场确认。返回 true 表示可以走。
   *
   * 为什么需要它：顺序保存改成了**显式按钮**之后，拖动/勾选只动界面不动服务端。
   * 没有这道闸，用户拖完顺手点别的页签，回来一看又变回去了 —— 那正是之前那个
   * 「拖了没用」的观感，只不过换了个成因。改动没提交就得让人知道。
   */
  function confirmDiscardSources() {
    if (!sourcesDirty) return true
    let leave = true
    try { leave = confirm('「默认搜索源」的顺序还没保存，离开会丢掉这次改动。确定离开吗？') } catch { leave = true }
    if (leave) sourcesDirty = false
    return leave
  }

  // 关标签页/刷新整页时也拦一下（管理后台常年开着，这是最容易丢掉改动的一条路）
  window.addEventListener('beforeunload', (e) => {
    if (!sourcesDirty) return
    e.preventDefault()
    e.returnValue = ''
  })

  /** 统一的页面骨架：标题 + 刷新按钮 + 内容宿主 */
  function shell(title, opts) {
    const o = opts || {}
    const main = $('#adminMain')
    main.innerHTML = '<div class="admin-head"><h1>' + esc(title) + '</h1>'
      + '<button class="btn btn--sm btn--ghost" id="areload">刷新</button></div>'
      + '<div id="apane">' + '<div class="skeleton"><div class="skeleton__row"></div>'
      + '<div class="skeleton__row"></div><div class="skeleton__row"></div></div>' + '</div>'
    const btn = $('#areload')
    // canLeave：这一页有未提交的改动时，刷新会把它抹掉，先问一句
    if (btn) btn.addEventListener('click', () => {
      if (o.canLeave && !o.canLeave()) return
      if (o.reload) o.reload()
      else switchTab(state.tab)
    })
    return $('#apane')
  }

  function fail(pane, e) {
    pane.innerHTML = '<div class="admin-card"><div class="note" style="color:#d73535">'
      + esc((e && e.message) || '加载失败') + '</div></div>'
  }

  /**
   * 时间戳 → YYYY-MM-DD。
   *
   * 别用 `String(ts).slice(0, 10)` 糊弄：那是毫秒时间戳的前 10 位数字
   * （形如 "1759…"），看着像日期其实不是，用户管理页之前一直显示的就是这个。
   */
  function fmtDate(ts) {
    const n = Number(ts)
    if (!n) return '—'
    const d = new Date(n)
    const p = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function fmtDateTime(ts) {
    const n = Number(ts)
    if (!n) return '—'
    const d = new Date(n)
    const p = (x) => String(x).padStart(2, '0')
    return fmtDate(n) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function mmss(s) {
    const n = Math.max(0, Math.floor(Number(s) || 0))
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0')
  }

  /* ================= 概览 ================= */

  async function renderOverview() {
    const pane = shell('概览', { reload: renderOverview })
    try {
      const [stats, users] = await Promise.all([API.adminStats(), API.adminUsers()])
      const c = stats.counts || {}
      const kpi = (n, l) => '<div class="admin-kpi"><div class="admin-kpi__n">' + n
        + '</div><div class="admin-kpi__l">' + l + '</div></div>'
      pane.innerHTML =
        '<div class="admin-grid">'
        + kpi(c.users || 0, '用户')
        + kpi(c.playlists || 0, '歌单')
        + kpi(c.favorites || 0, '收藏')
        + kpi(c.plays || 0, '累计播放次数')
        + kpi(c.progressRows || 0, '有播放记录的曲目')
        + kpi((stats.plugins && stats.plugins.ready || 0) + ' / ' + (stats.plugins && stats.plugins.total || 0), '插件就绪')
        + '</div>'
        + '<div class="admin-card" style="margin-top:14px">'
        + '<div class="field__label" style="margin-bottom:8px">账号</div>'
        + '<div class="admin-scroll"><table class="admin-table"><thead><tr>'
        + '<th>用户名</th><th>角色</th><th>创建时间</th></tr></thead><tbody>'
        + (users.list || []).map(u => '<tr><td>' + esc(u.username) + '</td><td>'
          + (u.is_admin ? '管理员' : '普通用户') + '</td><td class="num">'
          + fmtDate(u.created_at) + '</td></tr>').join('')
        + '</tbody></table></div></div>'
        + '<div class="admin-card"><div class="note">服务端插件：'
        + (stats.plugins && stats.plugins.ready) + ' 个就绪 / 共 '
        + (stats.plugins && stats.plugins.total) + ' 个。到「音源与插件」里调顺序或停用。</div></div>'
    } catch (e) { fail(pane, e) }
  }

  /* ================= 音源与插件 ================= */

  // 以服务端返回的平台为准，不在前端写死列表 —— 写死的话加个平台就要改两处
  const scoreState = { platforms: [], tab: '', data: null, prefs: null, busy: false, err: null, rescoring: false }

  /*
    「默认搜索源」是否有没提交的改动。

    用 var 而不是 let：switchTab / confirmDiscardSources 会在 renderShell 里被调用，
    而那一句可能跑在本行之前 —— let 的话读它就是 TDZ 报错，var 顶多是 undefined（= 没改过），
    beforeunload 那道闸也不会因此哑掉。
  */
  var sourcesDirty = false

  async function renderSources() {
    const pane = shell('音源与插件', { reload: renderSources, canLeave: confirmDiscardSources })
    let server = { platforms: [], active: [] }
    let scores = null
    scoreState.err = null
    sourcesDirty = false   // 这一页是照着服务端重画的，之前的未保存状态作废
    try {
      /**
       * /admin/health 刻意不在这里等。
       *
       * 它要对每个平台各发一次**真实搜索**（实测 6s+，还会随出口网络更慢），而
       * 用户点进来第一眼要看的是下面的「插件调度顺序」。三个接口用 Promise.all
       * 一起等的结果是：调度顺序被一个跟它毫无关系的体检接口卡住，整页停在骨架屏
       * 上好几秒 —— 看起来就像「插件看不到了」，其实是还没画出来。
       * 所以 health 单独后台跑，回来再补徽标。
       */
      const [s, sc] = await Promise.all([
        API.sources(),
        // 失败要**留住错误对象**，不能图省事 .catch(() => null) 一带而过。
        // 那样 403（不是管理员）、500（服务端报错）、超时、断网在界面上长得一模一样，
        // 都是「评分没了」，既没法用、也没法报障 —— 用户只能回来问「为什么看不到」。
        API.pluginScores().catch(e => { scoreState.err = e || new Error('未知错误'); return null }),
      ])
      server = s || server
      scores = sc
    } catch (e) { return fail(pane, e) }

    scoreState.data = scores
    scoreState.prefs = (scores && scores.prefs) || { mode: 'auto', order: {}, disabled: [] }
    const keys = ((scores && scores.platforms) || []).map(p => p.key)
    scoreState.platforms = keys.length ? keys : ['wy', 'kg', 'kw', 'tx']
    if (!scoreState.tab || scoreState.platforms.indexOf(scoreState.tab) < 0) {
      scoreState.tab = firstScorePlatform(scores) || scoreState.platforms[0]
    }

    const activeSet = new Set(server.active || [])

    /*
      默认搜索源：决定「综合搜索 / 首页推荐 / AI 歌单匹配」查哪几个平台。

      这一列现在是**可拖动排序**的 —— 顺序不是装饰，它就是搜索的尝试优先级。
      所以列表要按服务端的 order 渲染（含未勾选的平台），而不是按平台清单的固定顺序：
      否则拖完一刷新位置就回去了。见 saveSourceList 的注释。
    */
    const platformByKey = new Map((server.platforms || []).map(p => [p.key, p]))
    const orderKeys = ((server.order && server.order.length ? server.order : (server.platforms || []).map(p => p.key)) || [])
      .filter(k => platformByKey.has(k))
    for (const p of (server.platforms || [])) if (orderKeys.indexOf(p.key) < 0) orderKeys.push(p.key)

    const srcRows = orderKeys.map((k, i) =>
      '<div class="srcrow" data-key="' + esc(k) + '">'
      + '<span class="srcrow__grip" data-grip title="拖动调整顺序" aria-label="拖动调整顺序">'
      + '<svg viewBox="0 0 24 24"><path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"/></svg>'
      + '</span>'
      + '<span class="srcrow__no">' + (i + 1) + '</span>'
      + '<span class="srcrow__name">' + esc((platformByKey.get(k) || {}).name || k) + '</span>'
      + '<label class="switch"><input type="checkbox" data-act="toggle-source"'
      + (activeSet.has(k) ? ' checked' : '') + '><i></i></label>'
      + '</div>').join('')

    const sourceToggle = '<div class="admin-card"><div class="field__label">默认搜索源</div>'
      + '<div class="note" style="margin:2px 0 10px">按住左侧手柄拖动即可调整顺序 —— '
      + '越靠上的平台在「综合搜索 / 首页推荐」里越先被查。右侧开关决定它是否参与。</div>'
      + '<div class="srclist" id="srcSort">' + srcRows + '</div>'
      + '<div class="srcfoot">'
      + '<span class="srcfoot__state" id="srcState">拖动或开关改动后，点右侧按钮保存</span>'
      + '<button class="btn btn--sm" id="srcSave" data-act="save-sources" disabled>保存顺序</button>'
      + '</div>'
      + '<div class="note" style="margin-top:10px">勾选的平台参与综合搜索与首页推荐。'
      + '全部取消会退回全部平台。</div></div>'

    const serverPlugins = (scores && scores.plugins) || []
    const load = (scores && scores.load) || {}
    const pluginRows = serverPlugins.map(p => {
      const info = load[p.id] || null
      const name = (info && info.label) || p.name
      const built = (!info || info.serverOk) ? ''
        : '<span class="pill ' + (info.failKind === 'env' ? 'pill--warn' : 'pill--bad') + '">'
          + (info.failKind === 'env' ? '取不到远端配置' : '脚本自身异常') + '</span>'
      return '<tr><td>' + esc(name) + '</td>'
        + '<td>' + (p.sources || []).map(s => '<span class="pill">' + esc(shortOf(s)) + '</span>').join('') + '</td>'
        + '<td>' + (p.version ? '<span class="pill">v' + esc(p.version) + '</span>' : '—')
        + (info ? ' <span class="pill">' + info.kb + 'KB</span>' : '') + '</td>'
        + '<td>' + (p.ok ? '<span class="pill pill--ok">线上正常</span>' : '<span class="pill pill--bad">加载失败</span>') + built + '</td></tr>'
    }).join('')

    /**
     * 「导入插件」卡片。
     *
     * 这块是用户端那句「需要增删插件请到管理端」的落点 —— 在此之前管理端只有
     * 列表/评分/启停，没有导入，那句话等于把人指到一个不存在的地方。
     *
     * 拆分：内置插件**不可删**（它们是构建产物，删了下次构建又回来，只会造成
     * 「删了又出现」的困惑 —— 想让它别上岗应该用「停用」）；所以下面这张表只列
     * 用户导入的那批，删除按钮也只给它们。
     */
    const userPlugins = serverPlugins.filter(p => p.origin === 'user')
    const importBlock = '<div class="admin-card" id="plgImport">'
      + '<div class="field__label">导入插件</div>'
      + '<div class="note" style="margin:2px 0 10px">从 URL 导入（GitHub 地址会自动走镜像），'
      + '或直接粘贴脚本正文。导入后立刻加载并参与取流，不用重启服务。</div>'
      + '<input class="input" id="plgUrl" placeholder="https://.../latest.js" autocomplete="off">'
      + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'
      + '<button class="btn btn--sm" id="plgUrlBtn">从 URL 导入</button>'
      + '<button class="btn btn--sm btn--ghost" id="plgPasteBtn">粘贴脚本</button>'
      + '</div>'
      + '<div id="plgPasteBox" hidden style="margin-top:10px">'
      + '<textarea class="textarea" id="plgText" placeholder="/* @name ... */&#10;(function(){ ... })()"></textarea>'
      + '<button class="btn btn--sm" id="plgTextBtn" style="margin-top:8px">解析并导入</button>'
      + '</div>'
      + '<div class="note" id="plgState" style="margin-top:10px"></div>'
      + (userPlugins.length
        ? '<div class="admin-scroll" style="margin-top:12px"><table class="admin-table"><thead><tr>'
          + '<th>已导入</th><th>支持音源</th><th>版本</th><th>大小</th><th></th></tr></thead><tbody>'
          + userPlugins.map(p => '<tr><td>' + esc(p.name)
            + (p.ok ? '' : ' <span class="pill pill--bad">加载失败</span>') + '</td>'
            + '<td>' + ((p.sources || []).map(s => '<span class="pill">' + esc(shortOf(s)) + '</span>').join('') || '—') + '</td>'
            + '<td>' + (p.version ? '<span class="pill">v' + esc(p.version) + '</span>' : '—') + '</td>'
            + '<td class="num">' + (p.bytes ? Math.round(p.bytes / 1024) + 'KB' : '—') + '</td>'
            + '<td><button class="btn btn--sm btn--ghost" data-del-plugin="' + esc(p.id) + '">删除</button></td>'
            + '</tr>').join('')
          + '</tbody></table></div>'
        : '<div class="note" style="margin-top:10px">还没有导入过插件。</div>')
      + '</div>'

    pane.innerHTML =
      sourceToggle
      + importBlock
      + '<div class="admin-card" id="scoreBlock">' + scoreBlockHtml() + '</div>'
      + '<div id="platHealth">' + platformTableHtml(server, null) + '</div>'
      + '<div class="admin-card"><div class="field__label" style="margin-bottom:8px">服务端内置插件（'
      + serverPlugins.length + ' 个）</div>'
      + (serverPlugins.length
        ? '<div class="admin-scroll"><table class="admin-table"><thead><tr>'
          + '<th>插件</th><th>支持音源</th><th>版本</th><th>状态</th></tr></thead><tbody>'
          + pluginRows + '</tbody></table></div>'
        : '<div class="admin-empty">没有读取到插件清单</div>')
      + '<div class="note" style="margin-top:10px">「取不到远端配置」指这类插件初始化时要先拉一份远端配置，'
      + '当前出口取不到，整份脚本就没起来。它们不会被自动删除 —— 那个站点恢复后插件会自己回来。</div></div>'

    bindScoreBlock()
    bindPluginImport(pane)

    // 体检在后台跑，回来只重绘「平台可用性」那一张表。
    // 失败也不打扰本页 —— 那块本来就是辅助信息。
    API.health().then(h => {
      const host = pane.querySelector('#platHealth')
      if (!host || !h || !Array.isArray(h.list)) return
      const map = {}
      for (const x of h.list) map[x.key] = x
      host.innerHTML = platformTableHtml(server, map)
    }).catch(() => { /* 体检失败不影响本页其它内容 */ })

    const srcList = pane.querySelector('#srcSort')
    // 拖动与开关都只标记「有改动」，不直接提交 —— 提交统一走下面那个保存按钮。
    // 之前是拖完即存，看着省事，但只要那次请求失败、或者顺序读回来时丢了，
    // 用户看到的就是「拖了没反应」，而且没有任何可重试的动作。按钮把这件事变明确。
    if (srcList) makeSortable(srcList, '.srcrow', '[data-grip]', () => markSourcesDirty(pane))
    pane.querySelectorAll('[data-act="toggle-source"]').forEach(cb => {
      cb.addEventListener('change', () => markSourcesDirty(pane))
    })
    const saveBtn = pane.querySelector('#srcSave')
    if (saveBtn) saveBtn.addEventListener('click', () => saveSourceList(pane))
  }

  /** 把「有未保存改动」这件事显示出来，并把保存按钮点亮。 */
  function markSourcesDirty(pane) {
    sourcesDirty = true
    const btn = pane.querySelector('#srcSave')
    if (btn) btn.disabled = false
    const st = pane.querySelector('#srcState')
    if (st) {
      st.textContent = '有未保存的改动'
      st.classList.add('is-dirty')
    }
  }

  /**
   * 存回「默认搜索源」的当前排布（由「保存顺序」按钮触发）。
   *
   * 一次送两样，缺一不可：
   *   sources —— 勾选的平台，顺序就是搜索优先级（真正生效的那份）
   *   order   —— 整列的完整顺序，含**没勾选**的平台（只影响界面）
   * 只送 sources 的话，取消勾选某个平台再刷新，它会自己蹦到队尾 ——
   * 用的人只会得出「拖了没用」的结论。
   *
   * 注意这里是**唯一**的写入点：拖动与勾选只改界面。所以本次改动的成败要如实回显 ——
   * 成功给出「已保存 · 时间」，失败把界面拉回服务端真实状态并说明原因，
   * 不能只弹一个 toast 就没了（toast 会自己消失，用户回来就不知道到底存没存上）。
   */
  async function saveSourceList(pane) {
    const rows = Array.from(pane.querySelectorAll('#srcSort .srcrow'))
    if (!rows.length) return
    const order = rows.map(r => r.dataset.key)
    const sources = rows.filter(r => {
      const cb = r.querySelector('input[type="checkbox"]')
      return cb && cb.checked
    }).map(r => r.dataset.key)
    const btn = pane.querySelector('#srcSave')
    const st = pane.querySelector('#srcState')
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    try {
      const r = await API.saveSearchSources(sources.join(','), order.join(','))
      const active = (r && r.active) || []
      sourcesDirty = false
      if (st) {
        const now = new Date()
        const hh = String(now.getHours()).padStart(2, '0')
        const mm = String(now.getMinutes()).padStart(2, '0')
        st.textContent = '已保存 · ' + hh + ':' + mm + '（' + order.length + ' 个平台）'
        st.classList.remove('is-dirty')
      }
      toast('已保存默认搜索源：' + (active.length ? active.map(shortOf).join(' / ') : '全部平台'))
    } catch (e) {
      toast((e && e.message) || '保存失败')
      // 存不上就得把界面拉回服务端的真实状态：否则这一列显示的排布和实际生效的
      // 搜索源对不上，而且下一次进这一页才会发现。
      sourcesDirty = false
      renderSources()
      return
    } finally {
      if (btn) btn.textContent = '保存顺序'
    }
  }

  /**
   * 通用「按住手柄拖动排序」。
   *
   * 为什么不用 HTML5 的 draggable / dragstart：那套在**触摸屏上根本不触发** ——
   * 手指长按走的是系统的选中/长按菜单，drag 事件一次都不发。管理后台经常在手机上
   * 开着看，所以这里用 pointer 事件自己实现，鼠标与手指走同一条路径。
   *
   * 做法是最朴素的一种：被拖的行跟手位移，其余行按目标位置让出/收回一格高度。
   * **松手之前不动 DOM、也不动数据**，中途翻车也不会把顺序写坏。
   *
   * rowSel 与 handleSel 必须分开传：这一列里「行」和「行内的控件」都带过 data-* 属性，
   * 用一个宽松的选择器抓行会把勾选框也算进来 —— 那样行数、行下标全错，
   * 拖动会落到莫名其妙的位置（这个坑被 test/_newfeat-ui.mjs 抓到过一次）。
   */
  function makeSortable(list, rowSel, handleSel, onCommit) {
    const rowsOf = () => Array.from(list.querySelectorAll(rowSel))
    let st = null

    const onMove = (e) => {
      if (!st) return
      if (e.cancelable) e.preventDefault()
      const dy = e.clientY - st.startY
      st.dy = dy
      let to = Math.round(st.i + dy / st.h)
      to = Math.max(0, Math.min(st.rows.length - 1, to))
      st.to = to
      st.row.style.transform = 'translateY(' + dy + 'px)'
      st.rows.forEach((r, k) => {
        if (r === st.row) return
        let ty = 0
        if (k > st.i && k <= to) ty = -st.h
        else if (k < st.i && k >= to) ty = st.h
        r.style.transform = ty ? 'translateY(' + ty + 'px)' : ''
      })
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      const s = st
      st = null
      if (!s) return
      s.rows.forEach(r => { r.style.transform = '' })
      s.row.classList.remove('is-dragging')
      list.classList.remove('is-sorting')
      if (s.to === s.i) return
      // 落位：往上拖就插到目标行前面，往下拖插到目标行后面
      const ref = s.to < s.i ? s.rows[s.to] : s.rows[s.to].nextSibling
      list.insertBefore(s.row, ref)
      // 序号跟着重编 —— 它就是「第几个被查」，不刷新会跟实际顺序对不上
      rowsOf().forEach((r, i) => {
        const no = r.querySelector('.srcrow__no')
        if (no) no.textContent = String(i + 1)
      })
      if (typeof onCommit === 'function') onCommit()
    }

    list.addEventListener('pointerdown', (e) => {
      if (st) return
      if (e.button != null && e.button !== 0) return
      const grip = e.target.closest(handleSel)
      if (!grip) return
      const row = grip.closest(rowSel)
      if (!row) return
      const rows = rowsOf()
      if (rows.length < 2) return
      const h = row.getBoundingClientRect().height
      if (!h) return
      st = { row, rows, i: rows.indexOf(row), to: rows.indexOf(row), startY: e.clientY, dy: 0, h }
      row.classList.add('is-dragging')
      list.classList.add('is-sorting')
      document.addEventListener('pointermove', onMove, { passive: false })
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
      // 别顺手选中文字：手机上那样会弹出复制菜单，把拖动打断
      if (e.cancelable) e.preventDefault()
    })
  }

  /**
   * 平台可用性表格。
   * healthMap 传 null 表示还没体检完 —— 徽标显示「体检中…」，等后台体检回来后
   * 用真实结果重绘（见 renderSources）。整块独立成函数就是为了这次重绘。
   */
  function platformTableHtml(server, healthMap) {
    const rows = (server.platforms || []).map(p => {
      const h = healthMap && healthMap[p.key]
      const ok = h ? h.ok : null
      const badge = !h ? '<span class="pill">体检中…</span>'
        : ok ? '<span class="pill pill--ok">搜索正常 ' + h.ms + 'ms</span>'
          : '<span class="pill pill--bad">接口受限</span>'
      return '<tr><td>' + esc(p.name) + '</td>'
        + '<td>' + (p.pluginSupported ? '<span class="pill pill--ok">插件可用</span>' : '<span class="pill">仅原生</span>') + '</td>'
        + '<td class="num">' + ((p.plugins || []).length) + '</td>'
        + '<td>' + badge + '</td></tr>'
    }).join('')
    return '<div class="admin-card"><div class="field__label" style="margin-bottom:8px">平台可用性（实测）</div>'
      + '<div class="admin-scroll"><table class="admin-table"><thead><tr>'
      + '<th>平台</th><th>插件</th><th>内置插件数</th><th>官方接口</th></tr></thead><tbody>'
      + rows + '</tbody></table></div>'
      + '<div class="note" style="margin-top:10px">「接口受限」表示该平台官方接口在<b>当前服务器出口</b>被拒绝'
      + '（Cloudflare 出口拒绝 QQ 音乐是已知现象，换到自建 Docker 出口通常就通了）。'
      + '此时该平台只是搜不到，不影响其它平台与插件取流。</div></div>'
  }

  /**
   * 把错误对象翻成人话。
   *
   * 关键是区分「没权限」和「服务端出错」：前者换个账号就好，后者是要修代码的。
   * 之前两者都显示成「服务端未就绪」，等于把最有用的那条信息丢掉了。
   */
  function scoreErrText() {
    const e = scoreState.err
    if (!e) return '服务端没有返回评分数据（多为构建期生成的评分文件缺失）。'
    const st = e.status
    if (st === 403 || st === 401) {
      return 'HTTP ' + st + '：当前账号不是管理员，服务端的 /admin/* 一律拒绝。'
        + '请换成管理员账号登录后再看这一页 —— 登录状态存在浏览器里，'
        + '从 App 里登出、到 /admin 重新登录即可。'
    }
    if (st >= 500) return 'HTTP ' + st + '：服务端处理时报错。' + (e.message ? ' 原文：' + e.message : '')
    if (st) return 'HTTP ' + st + (e.message ? '：' + e.message : '')
    return '请求没能到达服务端（网络失败或超时）。' + (e.message ? ' 原文：' + e.message : '')
  }

  function shortOf(key) {
    const p = ((scoreState.data && scoreState.data.platforms) || []).find(x => x.key === key)
    return (p && p.short) || key
  }

  function firstScorePlatform(d) {
    if (!d || !d.live) return ''
    for (const k of scoreState.platforms) if ((d.live[k] || []).length) return k
    return scoreState.platforms[0] || ''
  }

  /**
   * 当前平台「实际会按什么顺序去试」。
   *
   * 基准顺序直接用后端给的 live —— 它就是「当前偏好下真正会按什么顺序去试」。
   * 前端另算一套必然和后端漂移（光是「人工模式下没排到的插件按什么垫后」
   * 这一条，之前就在两边写出了不同答案）。
   */
  function scoreRowsFor(src) {
    const d = scoreState.data || {}
    const prefs = scoreState.prefs || {}
    const load = d.load || {}
    const scored = (d.byPlatform && d.byPlatform[src]) || []
    const live = (d.live && d.live[src]) || []

    const order = []
    const seen = new Set()
    const push = (id) => { if (id && !seen.has(id)) { seen.add(id); order.push(id) } }
    for (const id of live) push(id)
    // 被停用的插件不会出现在 live 里，得从评分表补回来 —— 否则关掉之后
    // 那一行就消失了，再也没法重新启用
    for (const r of scored) push(r.id)
    for (const [id, info] of Object.entries(load)) {
      if ((info.sources || []).includes(src)) push(id)
    }

    const byId = new Map(scored.map(r => [r.id, r]))
    const disabled = new Set(prefs.disabled || [])
    return order.map(id => ({ id, row: byId.get(id) || null, info: load[id] || null, off: disabled.has(id) }))
  }

  /**
   * 评分状态条 —— 「按时间间隔自动评分，或者手动」这条需求的界面。
   *
   * 三件事要一眼看到（缺一个用户就得猜）：
   *   ① **这份成绩是什么时候测的、在哪测的** —— 构建机测的和你服务器上测的，
   *      结论可能完全不同，界面不写清楚就等于误导；
   *   ② **自动评分开着吗、下一轮什么时候** —— 否则用户不知道要不要点手动；
   *   ③ **手动入口** —— 刚换网络环境、或者觉得某个源不对时想立刻重测一次。
   *
   * 线上（CF Worker）跑不了运行时评分，这张条会显示「不支持 + 该怎么做」，
   * 而不是干脆不渲染 —— 用户看不到入口会以为是 bug。
   */
  function rescoreBarHtml() {
    const d = scoreState.data || {}
    const rs = d.rescore || {}
    const meta = d.meta || {}
    const live = rs.live || {}
    const last = rs.last || (rs.live && rs.live.last) || null
    const running = !!live.running
    const supported = rs.supported !== false

    const pills = []

    // ① 成绩来源与时间
    if (meta.source === 'runtime') {
      pills.push('<span class="pill pill--ok">本机实测</span>')
    } else if (meta.generatedAt) {
      pills.push('<span class="pill pill--warn" title="这份成绩是在打包镜像的那台机器上测的，'
        + '与你服务器的网络出口未必一致">构建机实测</span>')
    } else {
      pills.push('<span class="pill">未评分</span>')
    }
    if (meta.generatedAt) pills.push('<span class="pill">' + esc(meta.generatedAt) + '</span>')

    // ② 自动评分的状态
    if (!supported) {
      pills.push('<span class="pill">自动评分不可用</span>')
    } else if (live.intervalMs) {
      pills.push('<span class="pill pill--ok">自动 ' + esc(live.intervalText || '') + '</span>')
    } else {
      pills.push('<span class="pill">自动已关</span>')
    }

    // 上一轮的结果。区分「这次进程跑过」（live）与「上次跑过」（last，跨重启）
    const hist = (live.rounds > 0) ? live : last
    if (running) {
      pills.push('<span class="pill pill--warn">正在评分…</span>')
    } else if (hist && hist.lastRunAt) {
      const when = String(hist.lastRunAt).replace('T', ' ').slice(0, 16)
      pills.push(hist.lastOk
        ? '<span class="pill pill--ok">上轮成功 ' + esc(when) + '</span>'
        : '<span class="pill pill--bad" title="' + esc(hist.lastError || '') + '">上轮失败 ' + esc(when) + '</span>')
      if (hist.lastElapsedMs) pills.push('<span class="pill">耗时 ' + Math.round(hist.lastElapsedMs / 1000) + 's</span>')
    }

    // 下一轮时间：只在自动开着且没在跑时显示（在跑的时候显示它没意义）
    if (supported && !running) {
      const nextAt = (live.rounds > 0 || live.nextAt) ? live.nextAt : (rs.live && rs.live.nextAt)
      const n = nextAt || (live.nextAt)
      if (n) pills.push('<span class="pill">下轮 ' + esc(String(n).replace('T', ' ').slice(5, 16)) + '</span>')
    }

    // ③ 手动按钮 + 说明
    const btn = supported
      ? '<button class="btn btn--sm" id="rsNow" data-act="rescore-now"' + (running ? ' disabled' : '') + '>'
        + (running ? '正在评分…' : '立即重评') + '</button>'
      : ''

    const note = supported
      ? '「立即重评」会让服务器**按它自己的网络**实测一遍各插件（真打音乐平台，几分钟），'
        + '结果只对本机生效，不影响别人。评分期间照常听歌。'
      : esc(rs.note || '当前宿主不支持运行时评分。')
        + ' 线上版请在本地跑 <code>node tools/plugin-score.mjs</code> 后重新部署。'

    // 失败时把原因摆出来 —— 只说「失败」用户没法判断是网络问题还是代码问题
    const errLine = (hist && !hist.lastOk && hist.lastError && !running)
      ? '<div class="note" style="color:var(--danger,#c33);margin-top:6px">上次失败：' + esc(hist.lastError) + '</div>'
      : ''

    return '<div class="rescore-bar">'
      + '<div class="rescore-bar__pills">' + pills.join('') + '</div>'
      + (btn ? '<div class="rescore-bar__act">' + btn + '</div>' : '')
      + '</div>'
      + '<div class="note" style="margin:2px 0 10px">' + note + '</div>'
      + errLine
  }

  function scoreBlockHtml() {
    const d = scoreState.data
    const prefs = scoreState.prefs || { mode: 'auto', order: {}, disabled: [] }
    const tab = scoreState.tab
    const manual = prefs.mode === 'manual'

    const tabs = scoreState.platforms.map(k =>
      '<button class="chip' + (k === tab ? ' is-active' : '') + '" data-act="score-tab" data-key="' + esc(k) + '">'
      + esc(shortOf(k)) + '</button>').join('')

    const head = '<div class="field__label" style="margin-bottom:8px">插件调度顺序</div>'
      + rescoreBarHtml()
      + '<div class="chips chips--tight" style="padding:0 0 8px">' + tabs + '</div>'
      + '<div class="chips chips--tight" style="padding:0 0 10px">'
      + '<button class="chip' + (manual ? '' : ' is-active') + '" data-act="score-mode" data-mode="auto">自动 · 按实测评分</button>'
      + '<button class="chip' + (manual ? ' is-active' : '') + '" data-act="score-mode" data-mode="manual">人工 · 自定义顺序</button>'
      + '</div>'

    // 评分取不到时，把**原因**摆在明面上。
    // 之前这里只有一句「服务端未就绪」，于是「不是管理员」「服务端报错」「已经写的
    // 评分文件是空的」三种完全不同的情况共用同一句提示。改的人看不到线索，用的人
    // 只能回来问「为什么评分没有了」。
    if (!d) {
      return head + '<div class="admin-empty" style="text-align:left">'
        + '<div style="font-weight:600;margin-bottom:6px">插件评分暂时取不到</div>'
        + '<div>' + esc(scoreErrText()) + '</div></div>'
    }

    const rows = scoreRowsFor(tab)
    if (!rows.length) {
      return head + '<div class="note">「' + esc(shortOf(tab))
        + '」目前没有插件声明支持，取流只会走官方接口。</div>'
    }

    const list = rows.map((it, i) => {
      const r = it.row
      const info = it.info
      const pills = []
      if (r && r.unmeasured) {
        pills.push('<span class="pill pill--warn">未测到</span>')
      } else if (r) {
        pills.push('<span class="pill ' + (r.rate === 100 ? 'pill--ok' : (r.rate === 0 ? 'pill--bad' : '')) + '">成功 '
          + (r.rate == null ? '—' : r.rate + '%') + '</span>')
        if (r.play != null) pills.push('<span class="pill ' + (r.play === 100 ? 'pill--ok' : (r.play === 0 ? 'pill--bad' : '')) + '">可播 ' + r.play + '%</span>')
        if (r.p50 != null) pills.push('<span class="pill">' + r.p50 + 'ms</span>')
        if (r.fake) pills.push('<span class="pill pill--bad">假成功</span>')
      } else {
        pills.push('<span class="pill">未参与评分</span>')
      }
      if (info && !info.serverOk) {
        const isEnv = info.failKind === 'env'
        pills.push('<span class="pill ' + (isEnv ? 'pill--warn' : 'pill--bad') + '" title="'
          + esc(info.serverError || '') + '">' + (isEnv ? '取不到远端配置' : '脚本自身异常') + '</span>')
      }
      const name = (info && info.label) || (info && info.name) || (r && r.name) || it.id
      const acts = (manual
        ? '<button class="icon-btn" data-act="rank-up" data-id="' + esc(it.id) + '"' + (i === 0 ? ' disabled' : '') + ' title="上移">↑</button>'
        + '<button class="icon-btn" data-act="rank-down" data-id="' + esc(it.id) + '"' + (i === rows.length - 1 ? ' disabled' : '') + ' title="下移">↓</button>'
        : '')
        + '<button class="icon-btn' + (it.off ? ' is-on' : '') + '" data-act="rank-off" data-id="' + esc(it.id)
        + '" title="' + (it.off ? '重新启用' : '停用') + '">' + (it.off ? '↺' : '✕') + '</button>'

      return '<div class="rank-row' + (it.off ? ' is-off' : '') + '">'
        + '<div class="rank-row__no">' + (i + 1) + '</div>'
        + '<div class="rank-row__main"><div class="rank-row__name">' + esc(name) + '</div>'
        + '<div class="rank-row__meta">' + pills.join('') + '</div></div>'
        + '<div class="rank-row__score">' + (r && !r.unmeasured ? r.score.toFixed(1) : '—') + '</div>'
        + '<div class="rank-row__acts">' + acts + '</div>'
        + '</div>'
    }).join('')

    const when = (d.meta && d.meta.generatedAt) || ''
    const note = '<div class="note" style="margin-top:10px">'
      + (manual ? '人工模式：按你排的顺序依次尝试，没排到的按评分垫后。' : '自动模式：按实测评分从高到低依次尝试。')
      + ' 分数来自' + (when ? ' ' + esc(when) + ' ' : ' ')
      + '在评测机上的实测。被停用的插件（灰行）不参与取流。</div>'

    return head + '<div id="rankList">' + list + '</div>' + note
  }

  function paintScoreBlock() {
    const host = $('#scoreBlock')
    if (!host) return
    host.innerHTML = scoreBlockHtml()
    bindScoreBlock()
  }

  async function savePluginPrefs(patch) {
    if (scoreState.busy) return false
    const cur = scoreState.prefs || { mode: 'auto', order: {}, disabled: [] }
    const next = {
      mode: patch.mode || cur.mode || 'auto',
      order: patch.order || cur.order || {},
      disabled: patch.disabled || cur.disabled || [],
    }
    scoreState.busy = true
    try {
      const r = await API.savePluginPrefs(next)
      scoreState.prefs = r.prefs || next
      try {
        const fresh = await API.pluginScores()
        if (fresh) { scoreState.data = fresh; scoreState.prefs = fresh.prefs || scoreState.prefs }
      } catch { /* 拉不到就先用本地 prefs 顶着 */ }
      paintScoreBlock()
      return true
    } catch (e) {
      toast((e && e.message) || '保存失败')
      return false
    } finally {
      scoreState.busy = false
    }
  }

  /** 上移 / 下移。第一次动箭头就顺手切到人工模式（不然排了也不生效） */
  async function moveRank(id, dir) {
    const src = scoreState.tab
    const cur = scoreState.prefs || { mode: 'auto', order: {}, disabled: [] }
    const ids = scoreRowsFor(src).map(x => x.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    const swapped = ids.slice()
    swapped[i] = ids[j]
    swapped[j] = id
    const order = Object.assign({}, cur.order)
    order[src] = swapped
    const wasAuto = cur.mode !== 'manual'
    if (await savePluginPrefs({ mode: 'manual', order }) && wasAuto) toast('已切到人工调度')
  }

  async function togglePluginOff(id) {
    const cur = scoreState.prefs || { mode: 'auto', order: {}, disabled: [] }
    const set = new Set(cur.disabled || [])
    const turningOff = !set.has(id)
    if (turningOff) set.add(id); else set.delete(id)
    if (!(await savePluginPrefs({ disabled: Array.from(set) }))) return
    const info = (scoreState.data && scoreState.data.load && scoreState.data.load[id]) || null
    toast((turningOff ? '已停用 ' : '已启用 ') + ((info && (info.label || info.name)) || id))
  }

  function bindScoreBlock() {
    const host = $('#scoreBlock')
    if (!host) return
    host.querySelectorAll('[data-act="score-tab"]').forEach(b => b.addEventListener('click', () => {
      scoreState.tab = b.dataset.key
      paintScoreBlock()
    }))
    host.querySelectorAll('[data-act="score-mode"]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.mode === (scoreState.prefs || {}).mode) return
      await savePluginPrefs({ mode: b.dataset.mode })
    }))
    host.querySelectorAll('[data-act="rank-up"], [data-act="rank-down"]').forEach(b => b.addEventListener('click', () => {
      moveRank(b.dataset.id, b.dataset.act === 'rank-up' ? -1 : 1)
    }))
    host.querySelectorAll('[data-act="rank-off"]').forEach(b => b.addEventListener('click', () => {
      togglePluginOff(b.dataset.id)
    }))
    const rsBtn = host.querySelector('[data-act="rescore-now"]')
    if (rsBtn) rsBtn.addEventListener('click', rescoreNow)
  }

  /**
   * 「导入插件」卡片的交互。
   *
   * 两处刻意为之：
   *
   * ① **失败时把原因留在页面上**（#plgState），而不只是弹个 toast 就没了。
   *    toast 两秒后消失，而「URL 不通 / 内容不像插件脚本 / 脚本自身加载失败」
   *    这三类原因的处置办法完全不同（换地址 / 换文件 / 换插件），用户需要边看边改。
   *
   * ② 成功后**重画整页**（renderSources）。不这么做的话，下面「服务端内置插件」
   *    那张表和池子里的真实状态就对不上了 —— 刚导进来的插件在界面上看不见，
   *    用户第一反应一定是「导入没生效」然后重复导一遍。
   */
  function bindPluginImport(pane) {
    const host = pane.querySelector('#plgImport')
    if (!host) return
    const st = pane.querySelector('#plgState')

    const submit = async (payload, btn, busyText) => {
      const old = btn.textContent
      btn.disabled = true
      btn.textContent = busyText
      if (st) { st.textContent = '正在下载并加载插件…（大脚本可能要十几秒）'; st.style.color = '' }
      try {
        const r = await API.importPlugin(payload)
        const name = (r.plugin && r.plugin.name) || '插件'
        toast((r.replaced ? '已更新：' : '已导入：') + name + (r.from ? '（经 ' + r.from + '）' : ''))
        renderSources()
      } catch (e) {
        const msg = (e && e.message) || '导入失败'
        if (st) { st.textContent = msg; st.style.color = '#d73535' }
        btn.disabled = false
        btn.textContent = old
      }
    }

    const urlBtn = pane.querySelector('#plgUrlBtn')
    if (urlBtn) urlBtn.addEventListener('click', () => {
      const url = (pane.querySelector('#plgUrl').value || '').trim()
      if (!url) { if (st) { st.textContent = '请先填插件 URL'; st.style.color = '#d73535' } return }
      submit({ url }, urlBtn, '导入中…')
    })

    const pasteBtn = pane.querySelector('#plgPasteBtn')
    if (pasteBtn) pasteBtn.addEventListener('click', () => {
      const box = pane.querySelector('#plgPasteBox')
      box.hidden = !box.hidden
      pasteBtn.textContent = box.hidden ? '粘贴脚本' : '收起'
    })

    const textBtn = pane.querySelector('#plgTextBtn')
    if (textBtn) textBtn.addEventListener('click', () => {
      const text = (pane.querySelector('#plgText').value || '').trim()
      if (text.length < 50) { if (st) { st.textContent = '脚本体太短了'; st.style.color = '#d73535' } return }
      submit({ script: text }, textBtn, '导入中…')
    })

    pane.querySelectorAll('[data-del-plugin]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.delPlugin
      if (!confirm('删除这个插件？删掉后取流就不会再用它了。')) return
      b.disabled = true
      try {
        await API.deletePlugin(id)
        toast('已删除')
        renderSources()
      } catch (e) {
        b.disabled = false
        toast((e && e.message) || '删除失败')
      }
    }))
  }

  /**
   * 手动触发一轮评分。
   *
   * **不是长请求，而是「触发 + 轮询」**：服务端收到就立刻回 202（已经开跑），
   * 我们这边按间隔查 /admin/plugin-rescore 看 live.running 与上轮结果，跑完了自动刷新排序表。
   *
   * 为什么不挂一个长请求等结果：一轮几分钟，中途用户刷新/切页签就断了，
   * 他会以为失败然后重点，而服务端那轮其实还在跑 —— 状态彻底不一致。
   * 反代默认 60s 也会把长请求掐成 504，同样误导。
   */
  async function rescoreNow() {
    if (scoreState.rescoring) return
    scoreState.rescoring = true
    paintScoreBlock()   // 立刻把按钮画成「正在评分…」并禁用
    try {
      const r = await API.pluginRescoreNow()
      if (r && r.accepted) toast('已开始评分，完成后会自动刷新（几分钟）')
      else if (r && r.ok) toast('评分完成，排序已更新')
    } catch (e) {
      // 409 = 服务端确实还有一轮在跑（可能是另一个标签页、或定时那轮）。
      // 这不是「你的操作失败了」，所以措辞要说明它会自己完成。
      if (e && e.status === 409) toast('服务端已有一轮评分在进行中，等它跑完即可')
      else if (e && e.status === 501) { toast('当前宿主不支持运行时评分（需要自托管/Docker 版）'); scoreState.rescoring = false; paintScoreBlock(); return }
      else { toast((e && e.message) || '评分未能开始') }
      if (!(e && e.status === 409)) { scoreState.rescoring = false; paintScoreBlock(); return }
    }

    // 轮询：先快后慢。评分头几十秒在加载插件、还没什么可看的，不需要一直密查；
    // 但也不能太疏 —— 跑完要尽快把新排序画出来（这是用户点这个按钮的目的）。
    const started = Date.now()
    const MAX_WAIT = 30 * 60 * 1000
    let interval = 2500
    for (;;) {
      await new Promise(res => setTimeout(res, interval))
      interval = Math.min(interval + 1500, 8000)   // 2.5s → 8s 封顶
      if (Date.now() - started > MAX_WAIT) { toast('评分仍在后台运行，可稍后刷新查看'); break }
      let st = null
      try {
        const rs = await API.pluginRescoreStatus()
        st = rs && rs.status
      } catch { continue }   // 单次查询失败不算结束，继续轮询
      if (!st) continue
      const live = st.live || {}
      // 每轮都把上轮结果显示出来，用户能看到「它真的在动」
      scoreState.data = scoreState.data || {}
      scoreState.data.rescore = st
      paintScoreBlock()
      if (!live.running) {
        // 跑完了：把新排序拉回来（不重拉的话列表还是旧顺序，跟「已生效」自相矛盾）
        const hist = live.rounds > 0 ? live : (st.last || null)
        if (hist && hist.lastOk === false) toast('评分未成功：' + (hist.lastError || '未知原因'))
        else toast('评分完成，排序已更新')
        break
      }
    }

    try {
      const fresh = await API.pluginScores()
      if (fresh) { scoreState.data = fresh; scoreState.prefs = fresh.prefs || scoreState.prefs }
    } catch { /* 拉不到就保留轮询期间的显示 */ }
    scoreState.rescoring = false
    paintScoreBlock()
  }

  /* ================= 用户管理 ================= */

  async function renderUsers() {
    const pane = shell('用户管理', { reload: renderUsers })
    let list = []
    try {
      const res = await API.adminUsers()
      list = res.list || []
    } catch (e) { return fail(pane, e) }

    pane.innerHTML =
      '<div class="admin-card"><div class="field__label" style="margin-bottom:8px">新建账号</div>'
      + '<div class="admin-grid" style="grid-template-columns:1fr 1fr">'
      + '<div class="field" style="margin:0"><input class="input" id="nu" placeholder="用户名" autocomplete="off"></div>'
      + '<div class="field" style="margin:0"><input class="input" id="np" type="password" placeholder="密码（至少 4 位）" autocomplete="new-password"></div>'
      + '</div>'
      + '<label class="note" style="display:flex;align-items:center;gap:6px;margin:10px 0">'
      + '<input type="checkbox" id="nuAdmin" style="width:auto"> 设为管理员</label>'
      + '<button class="btn btn--block" id="nubtn">创建</button></div>'
      + '<div class="admin-card"><div class="field__label" style="margin-bottom:8px">共 ' + list.length + ' 个账号</div>'
      + '<div class="admin-scroll"><table class="admin-table"><thead><tr>'
      + '<th>用户名</th><th>角色</th><th>创建</th><th>操作</th></tr></thead><tbody>'
      + list.map(u =>
        '<tr><td>' + esc(u.username) + (u.id === state.user.id ? ' <span class="pill">本人</span>' : '') + '</td>'
        + '<td>' + (u.is_admin ? '<span class="pill pill--ok">管理员</span>' : '普通用户') + '</td>'
        + '<td class="num">' + fmtDate(u.created_at) + '</td>'
        + '<td class="num">'
        + '<button class="btn btn--sm btn--ghost" data-act="resetpwd" data-id="' + esc(u.id) + '" data-name="' + esc(u.username) + '">改密码</button>'
        + (u.id === state.user.id ? '' : '<button class="btn btn--sm btn--ghost" data-act="deluser" data-id="' + esc(u.id) + '" data-name="' + esc(u.username) + '">删除</button>')
        + '</td></tr>').join('')
      + '</tbody></table></div></div>'

    $('#nubtn').addEventListener('click', async () => {
      const username = $('#nu').value.trim()
      const password = $('#np').value
      if (!username || password.length < 4) return toast('用户名不能为空，密码至少 4 位')
      try {
        await API.adminCreateUser(username, password, $('#nuAdmin').checked)
        toast('已创建 ' + username)
        renderUsers()
      } catch (e) { toast((e && e.message) || '创建失败') }
    })

    pane.querySelectorAll('[data-act="resetpwd"]').forEach(b => b.addEventListener('click', async () => {
      const p = prompt('给「' + b.dataset.name + '」设置新密码（至少 4 位）')
      if (!p) return
      if (String(p).length < 4) return toast('新密码至少 4 位')
      try {
        await API.adminSetPassword(b.dataset.id, p)
        toast('已更新密码')
      } catch (e) { toast((e && e.message) || '修改失败') }
    }))

    pane.querySelectorAll('[data-act="deluser"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('删除账号「' + b.dataset.name + '」？\n它的歌单、收藏、播放记录会一并删除，不可恢复。')) return
      try {
        await API.adminDeleteUser(b.dataset.id)
        toast('已删除')
        renderUsers()
      } catch (e) { toast((e && e.message) || '删除失败') }
    }))
  }

  /* ================= 播放记录 ================= */

  async function renderPlays() {
    const pane = shell('播放记录', { reload: renderPlays })
    let list = []
    try {
      const res = await API.adminPlayHistory(300)
      list = res.list || []
    } catch (e) { return fail(pane, e) }

    const fmt = (ts) => fmtDateTime(ts)

    pane.innerHTML =
      '<div class="admin-card"><div class="note">'
      + '每「用户 × 歌曲」一行，记录最后一次播放位置与真正听过的次数。'
      + '共 ' + list.length + ' 条（最多显示 300 条）。</div></div>'
      + '<div class="admin-card">'
      + (list.length
        ? '<div class="admin-scroll"><table class="admin-table"><thead><tr>'
          + '<th>用户</th><th>歌曲</th><th>歌手</th><th>进度</th><th>次数</th><th>最后播放</th><th></th></tr></thead><tbody>'
          + list.map((r, i) =>
            '<tr>'
            + '<td>' + esc(r.username) + '</td>'
            + '<td>' + esc((r.song && r.song.name) || '?') + '</td>'
            + '<td>' + esc((r.song && r.song.singer) || '—') + '</td>'
            + '<td class="num">' + mmss(r.position) + (r.duration ? ' / ' + mmss(r.duration) : '') + '</td>'
            + '<td class="num">' + (r.playCount || 0) + '</td>'
            + '<td class="num">' + fmt(r.lastPlayedAt) + '</td>'
            + '<td><button class="btn btn--sm btn--ghost" data-act="clearuser" data-uid="' + esc(r.userId)
            + '" data-name="' + esc(r.username) + '">清该用户</button></td>'
            + '</tr>').join('')
          + '</tbody></table></div>'
        : '<div class="admin-empty">还没有播放记录</div>')
      + '</div>'

    pane.querySelectorAll('[data-act="clearuser"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('清空「' + b.dataset.name + '」的全部播放记录？')) return
      try {
        await API.adminClearPlayHistory(b.dataset.uid)
        toast('已清空')
        renderPlays()
      } catch (e) { toast((e && e.message) || '清空失败') }
    }))
  }

  /* ================= AI 歌单接口 ================= */

  const AI_PRESET = {
    qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    openai: ['https://api.openai.com/v1', 'gpt-4o-mini'],
    cloudflare: ['', '@cf/qwen/qwen3.8-27b'],
  }
  const AI_HINT = {
    qwen: '',
    openai: '',
    cloudflare: '（可留空自动拼装；填 .../ai/v1 则走 OpenAI 兼容层）',
    '': '（OpenAI 兼容格式，填到 /v1 为止）',
  }

  async function renderAi() {
    const pane = shell('AI 歌单接口', { reload: renderAi })
    let cfg = {}
    try {
      cfg = await API.aiConfig()
    } catch (e) { return fail(pane, e) }

    pane.innerHTML =
      '<div class="admin-card">'
      + '<div id="aiStatus" class="note" style="margin-bottom:12px">'
      + (cfg.configured
        ? '已配置：<b>' + esc(cfg.provider) + '</b> · ' + esc(cfg.model)
        : '尚未配置，用户端的「AI 生成歌单」不可用')
      + '</div>'
      + '<div class="field"><div class="field__label" style="font-size:12px">提供商</div>'
      + '<select class="select" id="aiProvider">'
      + '<option value="qwen">通义千问（阿里云百炼）</option>'
      + '<option value="openai">OpenAI</option>'
      + '<option value="cloudflare">Cloudflare Workers AI</option>'
      + '<option value="">自定义（OpenAI 兼容）</option>'
      + '</select></div>'
      + '<div class="field" id="aiAccountRow" style="display:none"><div class="field__label" style="font-size:12px">Account ID（仅 Cloudflare）</div>'
      + '<input class="input" id="aiAccountId" placeholder="a4c5bc91293aa67de46a7067e07633da" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label" style="font-size:12px">Base URL <span id="aiBaseHint" class="note" style="display:inline"></span></div>'
      + '<input class="input" id="aiBaseURL" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label" style="font-size:12px">模型名</div>'
      + '<input class="input" id="aiModel" placeholder="qwen-plus / gpt-4o-mini / @cf/qwen/qwen3.8-27b" autocomplete="off"></div>'
      + '<div class="field"><div class="field__label" style="font-size:12px">API Key'
      + (cfg.hasKey ? '（已保存，留空表示不改）' : '') + '</div>'
      + '<input class="input" id="aiKey" type="password" placeholder="sk-... / cfut_..." autocomplete="off"></div>'
      + '<div style="display:flex;gap:8px;margin-top:12px">'
      + '<button class="btn btn--ghost" id="aiTestBtn" style="flex:1">测试连接</button>'
      + '<button class="btn" id="aiSaveBtn" style="flex:1">保存配置</button></div>'
      + '<div id="aiTestResult" class="note" style="margin-top:8px"></div></div>'
      + '<div class="admin-card"><div class="note">'
      + '这里配的是<b>服务端</b>调用 AI 用的凭据，用户端不接触 API Key。'
      + '「AI 生成歌单」这个功能本身属于用户端，不需要在这里开。</div></div>'

    const provSelect = $('#aiProvider')
    const baseInput = $('#aiBaseURL')
    const modelInput = $('#aiModel')
    const accRow = $('#aiAccountRow')

    function applyPreset(v) {
      const p = AI_PRESET[v]
      if (p) { baseInput.value = p[0]; modelInput.value = p[1] }
      accRow.style.display = (v === 'cloudflare') ? '' : 'none'
      const hint = $('#aiBaseHint')
      if (hint) hint.textContent = AI_HINT[v] || ''
      baseInput.placeholder = (v === 'cloudflare')
        ? '留空即可（自动拼装）；或填 https://api.cloudflare.com/client/v4/accounts/…/ai/v1'
        : 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    }
    provSelect.addEventListener('change', () => applyPreset(provSelect.value))

    if (cfg.provider) provSelect.value = cfg.provider
    baseInput.value = cfg.baseURL || ''
    modelInput.value = cfg.model || ''
    $('#aiAccountId').value = cfg.accountId || ''
    accRow.style.display = (cfg.provider === 'cloudflare') ? '' : 'none'
    $('#aiBaseHint').textContent = AI_HINT[cfg.provider] || ''

    $('#aiTestBtn').addEventListener('click', async () => {
      const box = $('#aiTestResult')
      box.textContent = '测试中…'
      $('#aiTestBtn').disabled = true
      try {
        const r = await API.aiTest()
        box.innerHTML = r.ok
          ? '<span style="color:#0a7d33">连接正常，' + r.latency + 'ms，回复：' + esc(r.reply) + '</span>'
          : '<span style="color:#d73535">失败：' + esc(r.error || r.reply || '未知错误') + '</span>'
      } catch (e) {
        box.innerHTML = '<span style="color:#d73535">' + esc((e && e.message) || '测试失败') + '</span>'
      } finally { $('#aiTestBtn').disabled = false }
    })

    $('#aiSaveBtn').addEventListener('click', async () => {
      const body = {
        provider: provSelect.value,
        base_url: baseInput.value.trim(),
        model: modelInput.value.trim(),
        account_id: $('#aiAccountId').value.trim(),
      }
      const key = $('#aiKey').value.trim()
      if (key) body.api_key = key
      try {
        await API.saveAiConfig(body)
        toast('AI 配置已保存')
        renderAi()
      } catch (e) { toast((e && e.message) || '保存失败') }
    })
  }
})(window)
