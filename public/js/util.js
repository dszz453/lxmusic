/* 通用工具：DOM、格式化、存储、提示 */
(function (global) {
  'use strict'

  const $ = (sel, root) => (root || document).querySelector(sel)
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel))

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else if (k === 'html') node.innerHTML = v
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
        else node.setAttribute(k, v)
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
      }
    }
    return node
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  /* ============================ 封面 ============================ */

  /**
   * 直连 or 走代理？
   *
   * 实测（真实 Chrome，2026-09-30，同一张 800x800 榜单封面）：
   *   浏览器直连网易云 CDN      59–201 ms     并发 12 张共 367 ms
   *   走本站 /api/cover 代理   891–1779 ms    并发 6 张共 2204 ms   ← 慢 6~10 倍
   * 而首页一次要出 6 张歌单封面 + 12 首歌曲封面，全走代理就是「看着像没图」。
   * 所以 https 源站一律直连；只有 http 源站（酷狗等）才走代理 ——
   * https 页面加载 http 图片会被浏览器当混合内容直接拦掉。
   */

  /**
   * 封面协议升级。
   *
   * 网易云的专辑封面大量返回 http://p2.music.126.net/...（榜单榜首、搜索结果都是），
   * 在 https 页面里会被浏览器当混合内容直接拦掉，只能退回 /api/cover 代理 —— 慢 6~10 倍。
   * 实测这些 CDN 的 https 与 http 返回完全一致（含 ?param= 缩略图参数），
   * 所以白名单内的域名一律把协议升成 https，直连就成立了。
   *
   * 不在白名单里的 http 源仍走代理：升协议不能瞎猜，猜错就是白屏。
   */
  const HTTPS_COVER_HOSTS = [
    /(^|\.)music\.126\.net$/i,
    /(^|\.)kuwo\.cn$/i,
    /(^|\.)kugou\.com$/i,
    /(^|\.)kglink\.cn$/i,
    /(^|\.)qqmusic\.qq\.com$/i,
    /(^|\.)music\.qq\.com$/i,
    /(^|\.)y\.qq\.com$/i,
  ]

  function upgradeCoverUrl(url) {
    const u = String(url || '')
    if (!/^http:\/\//i.test(u)) return u
    let host = ''
    try { host = new URL(u).hostname } catch { return u }
    return HTTPS_COVER_HOSTS.some(re => re.test(host)) ? u.replace(/^http:/i, 'https:') : u
  }

  /**
   * 证书坏掉的图床：这些域名**必须**用 http，https 一定失败。
   *
   * 实测：kuwo 的 img2.sycdn.kuwo.cn 从 Cloudflare 出口请求返回
   * **526（源站证书无效）**，而 http 是 200、图也正常。
   * 这类域名之前被「协议升级白名单」升成了 https，结果是整批酷我专辑封面破图。
   *
   * 两边处置不一样：
   *   · 网页端 —— 走 /api/cover 代理（服务端取图不受混合内容限制，且它内部会自动降协议）
   *   · 安卓壳 —— 直接把协议降回 http（WebView 已放行混合内容）
   */
  const TLS_BROKEN_COVER_HOSTS = [
    /(^|\.)sycdn\.kuwo\.cn$/i,
  ]

  function isTlsBrokenCover(url) {
    let host = ''
    try { host = new URL(String(url || '')).hostname } catch { return false }
    return TLS_BROKEN_COVER_HOSTS.some(re => re.test(host))
  }

  /** 网易云支持官方缩略图参数：800x800 原图 540KB，缩到 300x300 只剩 19KB 左右，观感无差 */
  function thumbUrl(url, size) {
    const u = upgradeCoverUrl(url)
    const n = size || 200
    if (/music\.126\.net/i.test(u)) {
      return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'param=' + n + 'y' + n
    }
    return u
  }

  /**
   * 代理地址。/api/cover 需要登录态，而 <img> 带不了 Authorization 头，
   * 所以把会话 token 拼进 query —— 服务端 currentUser 同时认 header 与 ?token=。
   */
  function coverProxy(url, size) {
    /**
     * 安卓壳里不走代理：
     *   · /api/cover 是服务端接口，壳里没有「服务端」，这种 <img src="/api/cover?...">
     *     的元素级请求 JS 拦不住，只会打到一个并不存在的远端；
     *   · 壳里也不需要它 —— 代理存在的理由是绕「https 页面加载 http 图片」的混合内容
     *     限制，而这个限制已被 WebView 的 MIXED_CONTENT_ALWAYS_ALLOW 关掉。
     * 所以直接返回源地址，让 <img> 自己去取，协议保持原样（升协议要源站支持，不能瞎猜）。
     */
    if (window.LX_NATIVE) {
      const raw = String(url || '')
      const n = size || 200
      // 证书坏掉的图床在壳里直接降到 http —— WebView 放行了混合内容，http 反而通
      const downgraded = isTlsBrokenCover(raw) ? raw.replace(/^https:/i, 'http:') : raw
      if (/music\.126\.net/i.test(downgraded)) {
        return downgraded + (downgraded.indexOf('?') >= 0 ? '&' : '?') + 'param=' + n + 'y' + n
      }
      return downgraded
    }
    const t = (window.API && API.getToken && API.getToken()) || ''
    return '/api/cover?url=' + encodeURIComponent(upgradeCoverUrl(url))
      + (size ? '&size=' + size : '')
      + (t ? '&token=' + encodeURIComponent(t) : '')
  }

  /**
   * 取封面地址。参数可以是歌曲对象或图片 URL 字符串。
   * 没有 img 时返回空串：用 id 去请求 /api/cover 必然 404，只会让浏览器画出破图。
   */
  function coverUrl(songOrImg, size) {
    const img = typeof songOrImg === 'string' ? songOrImg : (songOrImg && songOrImg.img)
    if (!img) return ''
    const u = upgradeCoverUrl(img)
    if (isTlsBrokenCover(u)) return coverProxy(u, size)
    return /^https:/i.test(u) ? thumbUrl(u, size) : coverProxy(u, size)
  }

  /**
   * 产出封面 <img> 标签。直连的图会因网络抖动偶发失败（实测出现过），
   * 所以直连时带上 data-fallback=代理地址，交给下面的全局监听兜底换源。
   */
  function coverTag(img, alt, size) {
    if (!img) return ''
    const u = upgradeCoverUrl(img)
    // 证书坏掉的图床一律走代理：直连是必然失败的一次请求，白等一轮还会闪一下破图
    const direct = !isTlsBrokenCover(u) && /^https:/i.test(u)
    const src = direct ? thumbUrl(u, size) : coverProxy(u, size)
    const fb = direct ? coverProxy(u, size) : ''
    return '<img src="' + escapeHtml(src) + '"'
      + (fb ? ' data-fallback="' + escapeHtml(fb) + '"' : '')
      + ' loading="lazy" decoding="async" alt="' + escapeHtml(alt || '') + '">'
  }

  /**
   * 图片兜底：直连失败 → 自动换服务端代理重试；代理也失败 → 隐藏图片，
   * 露出容器的渐变底，免得浏览器画出「破图」图标。
   * error 事件不冒泡，必须用捕获阶段监听。
   */
  document.addEventListener('error', (e) => {
    const t = e.target
    if (!t || t.tagName !== 'IMG' || !t.dataset || !t.dataset.fallback) return
    if (!t.dataset.fallbackUsed) {
      t.dataset.fallbackUsed = '1'
      t.src = t.dataset.fallback
      return
    }
    t.style.opacity = 0
  }, true)

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const m = Math.floor(s / 60)
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
  }

  /** 播放量/歌曲数格式化：12345 -> 1.2万 */
  function formatCount(n) {
    const v = Number(n) || 0
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万'
    return String(v)
  }

  let toastTimer = null
  function toast(message, duration) {
    const node = $('#toast')
    if (!node) return
    node.textContent = String(message || '')
    node.hidden = false
    requestAnimationFrame(() => node.classList.add('is-show'))
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      node.classList.remove('is-show')
      setTimeout(() => { node.hidden = true }, 220)
    }, duration || 2000)
  }

  const store = {
    get(key, def) {
      try {
        const raw = localStorage.getItem(key)
        if (raw == null) return def
        return JSON.parse(raw)
      } catch { return def }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 配额满等 */ }
    },
    remove(key) {
      try { localStorage.removeItem(key) } catch { /* ignore */ }
    },
  }

  /** 极简 IndexedDB 键值存储（插件脚本可达数百 KB，localStorage 存不下） */
  const idb = {
    _db: null,
    async open() {
      if (this._db) return this._db
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('lxmusic', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      return this._db
    },
    async set(key, value) {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(value, key)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    },
    async get(key) {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly')
        const r = tx.objectStore('kv').get(key)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
    },
    async del(key) {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').delete(key)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    },
  }

  function debounce(fn, wait) {
    let timer = null
    return function (...args) {
      clearTimeout(timer)
      timer = setTimeout(() => fn.apply(this, args), wait)
    }
  }

  /** 触底加载 */
  function onReachBottom(container, handler, offset) {
    let busy = false
    container.addEventListener('scroll', () => {
      if (busy) return
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - (offset || 200)) {
        busy = true
        Promise.resolve(handler()).finally(() => setTimeout(() => { busy = false }, 300))
      }
    }, { passive: true })
  }

  global.U = {
    $, $$, el, escapeHtml, coverUrl, coverTag, coverProxy, thumbUrl, upgradeCoverUrl,
    formatTime, formatCount, toast, store, idb, debounce, onReachBottom,
  }
})(window)
