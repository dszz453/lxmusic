/**
 * 音频缓存 + 下载 —— 播放过的歌不再重新取流，也能导出成文件。
 *
 * ── 为什么缓存要放在「字节」这一层，而不是「地址」这一层 ─────────────
 * 音乐源给的直链基本都带时效（几十分钟到几小时），且大量绑 IP / 绑 UA。
 * 缓存「解析出来的直链」= 缓存了一个很快会烂掉的东西，第二次点歌照样要重解析。
 * 所以这里缓存的是**音频字节本体**，键是「平台:id:音质」这种不随时间变的东西。
 *
 * ── 为什么用 Cache Storage ──────────────────────────────────────
 * 三个宿主共用一个前端，能同时覆盖网页与安卓壳的办法只有一个：Cache Storage API。
 *   · 网页 / PWA —— 原生支持，容量由浏览器配额管（通常给站点磁盘的百分之几十）
 *   · 安卓壳 —— WebView 里同样可用，落在 App 私有目录下，卸载即清
 *   · 它天然按 URL 建索引，且 Range 请求能被它的 match 命中（下面有说明）
 * 换成 IndexedDB 存 Blob 也能做，但要自己实现一套「按 URL 查 + 拼 Range 响应」，
 * 还得自己管配额；Cache Storage 把这部分直接给掉了。
 *
 * ── 「整个文件」还是「边听边存」────────────────────────────────────
 * 边听边存听起来省流量，实际做不对：<audio> 播到哪就下到哪，中途切歌会留下一堆
 * 残缺的半个文件，下一次命中反而放不出来（表现为「缓存了却播不了」）。
 * 所以策略是**放完整就存**：整首下完再落缓存，宁可不命中也不留半成品。
 * 代价是首听要等完整下载，但这正好被「下载」这个功能覆盖了 —— 想要的就手动下载。
 *
 * ── 关于 Range 与缓存命中 ────────────────────────────────────────
 * 缓存里存的是一条**不带 Range 的完整响应**。命中时：
 *   · 播放器发的是普通请求 → 直接返回整条
 *   · 播放器发的是 Range（seek / 部分加载）→ 用整条自己切出 206 响应
 * 浏览器**不会**把 Range 请求和普通缓存的 match 对上（`Vary`/`Range` 语义），
 * 所以这里不依赖 cache.match 处理 Range —— 自己切，逻辑反而是确定的。
 */
(function (global) {
  'use strict'

  /** 缓存名。带版本，改这里就能整批作废旧缓存 */
  const CACHE = 'lxmusic-audio-v1'
  /** 设置项：单首缓存后的大小上限（字节） */
  const KEY_LIMIT = 'lx.cache.limitMb'
  const KEY_AUTO = 'lx.cache.auto'
  /** 默认上限 500MB。手机上一个小时的 320k 音频大约 150MB，这个数够听很久 */
  const DEFAULT_LIMIT_MB = 500
  const MIN_LIMIT_MB = 100
  const MAX_LIMIT_MB = 4096

  /** 缓存在不在浏览器/壳里可用（隐私模式下 Cache API 可能不存在） */
  const supported = (() => {
    try { return typeof caches !== 'undefined' && !!caches.open } catch { return false }
  })()

  const mem = {
    inflight: new Map(),   // key -> Promise，同一首并发请求只下一次
    bytes: 0,              // 已缓存字节（启动时盘点一次，之后增量维护）
    ready: false,          // 是否已盘点过
    writing: 0,            // 正在写入的数量，用于「正在缓存」提示
  }

  /* ---------------- 设置 ---------------- */

  function num(v, def, lo, hi) {
    const n = Number(v)
    if (!isFinite(n)) return def
    return Math.max(lo, Math.min(hi, Math.round(n)))
  }

  function limitMb() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(KEY_LIMIT)
      return num(raw, DEFAULT_LIMIT_MB, MIN_LIMIT_MB, MAX_LIMIT_MB)
    } catch { return DEFAULT_LIMIT_MB }
  }

  function setLimitMb(v) {
    const n = num(v, DEFAULT_LIMIT_MB, MIN_LIMIT_MB, MAX_LIMIT_MB)
    try { global.localStorage.setItem(KEY_LIMIT, String(n)) } catch { /* 无痕模式忽略 */ }
    prune().catch(() => {})
    return n
  }

  /** 自动缓存开关：关掉就只手动下载，不悄悄占用户空间 */
  function autoEnabled() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(KEY_AUTO)
      return raw === null ? true : raw === '1'
    } catch { return true }
  }

  function setAuto(on) {
    try { global.localStorage.setItem(KEY_AUTO, on ? '1' : '0') } catch { /* ignore */ }
    return autoEnabled()
  }

  /* ---------------- 键 ---------------- */

  /**
   * 缓存键。
   *
   * 用**合成 URL** 而不是音频真实地址 —— 真实地址带时效签名，每次都不一样，
   * 拿它当键等于永远不命中。`id` 里已经含平台（见 encodeSongId），
   * 所以这个键天然区分不同平台可能撞号的 id。
   *
   * 音质进键是必须的：同一首歌的 128k 与 320k 是两份不同的字节，
   * 混在一起会出现「选了 320k 却放出 128k」这种最难查的问题。
   */
  function keyFor(song, quality) {
    const q = quality || '320k'
    return 'https://lxmusic-cache.invalid/audio/' + encodeURIComponent(song.source || '') +
      '/' + encodeURIComponent(String(song.id || '')) + '/' + encodeURIComponent(q)
  }

  /** 从缓存键反解出歌曲信息（导出文件名、清单展示用） */
  function parseKey(key) {
    try {
      const u = new URL(key)
      const seg = u.pathname.split('/').filter(Boolean) // ['audio', source, id, q]
      if (seg[0] !== 'audio') return null
      return { source: decodeURIComponent(seg[1] || ''), id: decodeURIComponent(seg[2] || ''), quality: decodeURIComponent(seg[3] || '') }
    } catch { return null }
  }

  /* ---------------- 存取 ---------------- */

  async function openCache() {
    if (!supported) return null
    try { return await caches.open(CACHE) } catch { return null }
  }

  /** 缓存里有没有这一首 */
  async function has(song, quality) {
    const c = await openCache()
    if (!c) return false
    try { return !!(await c.match(keyFor(song, quality))) } catch { return false }
  }

  /**
   * 取一条完整响应。命中返回 Response，未命中返回 null。
   *
   * 注意 `ignoreVary`：某些源站响应带 `Vary`，而 cache.match 默认会拿当前请求的
   * 头去比对。我们用的是合成 URL、请求头与当初存的时候不同 —— 不带这个开关会
   * 「存进去了却匹配不到」，这是 Cache API 上最容易踩的一个坑。
   */
  async function get(song, quality) {
    const c = await openCache()
    if (!c) return null
    try {
      const hit = await c.match(keyFor(song, quality), { ignoreVary: true })
      return hit || null
    } catch { return null }
  }

  /** 把一条完整响应写进缓存（已有则覆盖），随后按上限淘汰 */
  async function put(song, quality, response) {
    const c = await openCache()
    if (!c) return false
    const key = keyFor(song, quality)
    try {
      // 必须先 clone：Response 的 body 只能读一次，原对象要留给播放器
      await c.put(key, response.clone())
    } catch { return false }
    await refreshBytes(true)
    prune().catch(() => {})
    return true
  }

  /**
   * 盘点缓存占用。
   *
   * 只统计我们自己写进去的那一类键（/audio/ 前缀）。不这么做的话，
   * 浏览器上同一个 origin 下还有 SW 的静态缓存，读出来的数字会莫名其妙地大。
   */
  async function refreshBytes(force) {
    if (!supported) return mem.bytes
    if (mem.ready && !force) return mem.bytes
    const c = await openCache()
    if (!c) return mem.bytes
    let total = 0
    try {
      const keys = await c.keys()
      for (const req of keys) {
        const p = parseKey(req.url)
        if (!p) continue
        const res = await c.match(req, { ignoreVary: true })
        if (!res) continue
        // Content-Length 是首选；拿不到就量 blob（对已缓存的对象不需要再走网络）
        const len = Number(res.headers.get('content-length') || 0)
        if (len > 0) { total += len; continue }
        try { total += (await res.clone().blob()).size } catch { /* 读不出就跳过 */ }
      }
    } catch { /* 配额/权限问题，保持上次的值 */ }
    mem.bytes = total
    mem.ready = true
    return total
  }

  /** 列表：[{key, song, quality, bytes, playlist, createdAt}] */
  async function list() {
    const c = await openCache()
    if (!c) return []
    const out = []
    try {
      const keys = await c.keys()
      for (const req of keys) {
        const p = parseKey(req.url)
        if (!p) continue
        const res = await c.match(req, { ignoreVary: true })
        if (!res) continue
        let size = Number(res.headers.get('content-length') || 0)
        if (!size) { try { size = (await res.clone().blob()).size } catch { size = 0 } }
        out.push({
          key: req.url,
          song: { id: p.id, source: p.source },
          quality: p.quality,
          bytes: size,
          // 存的时机（拿 Cache 对象自己的元数据，Date 头不一定有）
          createdAt: Number(res.headers.get('x-lx-cached-at') || 0),
        })
      }
    } catch { /* 读不了就当空 */ }
    // 最近存的排前面
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  /** 删掉一首的缓存 */
  async function drop(song, quality) {
    const c = await openCache()
    if (!c) return false
    try {
      const ok = await c.delete(keyFor(song, quality), { ignoreVary: true })
      if (ok) await refreshBytes(true)
      return ok
    } catch { return false }
  }

  /** 按 key 删（清单里点删除用；清单拿不到完整 song 对象） */
  async function dropKey(key) {
    const c = await openCache()
    if (!c) return false
    try {
      const ok = await c.delete(key, { ignoreVary: true })
      if (ok) await refreshBytes(true)
      return ok
    } catch { return false }
  }

  /** 清空全部音频缓存 */
  async function clear() {
    if (!supported) return false
    try {
      const ok = await caches.delete(CACHE)
      mem.bytes = 0
      mem.ready = true
      return ok
    } catch { return false }
  }

  /**
   * 按上限淘汰。
   *
   * 淘汰顺序是「最久没被用过的先删」。Cache API 自己不带访问时间，
   * 所以这里另外记一份访问时间在 localStorage（`lx.cache.hit`），
   * 读取顺序按它排。这份记录丢失时退化成按写入时间，仍然可用。
   */
  const HIT_KEY = 'lx.cache.hit'

  function hitTable() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(HIT_KEY)
      const o = raw ? JSON.parse(raw) : {}
      return (o && typeof o === 'object') ? o : {}
    } catch { return {} }
  }

  function saveHitTable(t) {
    try {
      // 只留最近 800 条，免得这份表自己无限长大
      const keys = Object.keys(t)
      if (keys.length > 800) {
        keys.sort((a, b) => (t[b] || 0) - (t[a] || 0))
        for (const k of keys.slice(800)) delete t[k]
      }
      global.localStorage.setItem(HIT_KEY, JSON.stringify(t))
    } catch { /* ignore */ }
  }

  function touch(key) {
    const t = hitTable()
    t[key] = Date.now()
    saveHitTable(t)
  }

  async function prune() {
    const limit = limitMb() * 1024 * 1024
    const items = await list()
    let total = items.reduce((s, x) => s + x.bytes, 0)
    if (total <= limit) { mem.bytes = total; mem.ready = true; return { removed: 0, bytes: total } }

    const t = hitTable()
    // 越「久没被用过」越靠前 —— 没记录过的用写入时间兜底，保证顺序是全序
    const ranked = items.slice().sort((a, b) => (t[a.key] || a.createdAt || 0) - (t[b.key] || b.createdAt || 0))
    const c = await openCache()
    let removed = 0
    for (const it of ranked) {
      if (total <= limit) break
      try {
        if (c && await c.delete(it.key, { ignoreVary: true })) {
          total -= it.bytes
          removed++
          delete t[it.key]
        }
      } catch { /* 删不掉就继续试下一条 */ }
    }
    saveHitTable(t)
    mem.bytes = total
    mem.ready = true
    return { removed, bytes: total }
  }

  /* ---------------- 抓取并缓存 ---------------- */

  /**
   * 把一条音频地址整首下下来存进缓存。
   *
   * 这里用 fetch 直接抓，**不经过 <audio>** —— 三个原因：
   *   ① <audio> 不会把完整字节交出来，拿不到 Blob；
   *   ② 解析地址的那套逻辑（三级降级、音效路由）已经在 player.js 里，
   *      这里只负责「给一条能用的地址，我要完整字节」；
   *   ③ 下载可以在后台跑，不影响正在播的那首歌。
   *
   * @param {{id:string, source:string, name?:string}} song
   * @param {string} quality
   * @param {{ url:string, from?:string }} hit 一条**已验证可用**的地址
   * @param {(p:number)=>void} [onProgress] 0~1；拿不到总长度时给 -1
   */
  async function fetchAndStore(song, quality, hit, onProgress) {
    if (!supported || !hit || !hit.url) return { ok: false, error: '没有可用地址' }
    const url = hit.url
    let res
    try {
      res = await fetch(url, { credentials: 'omit', mode: 'cors' })
    } catch (e) {
      // 跨域被拦时退回同源代理：音频走代理比「完全下不了」好
      try {
        const pxy = global.LX_REMOTE_BASE || ''
        const qs = new URLSearchParams({ id: song.id, q: quality, token: tokenOf() })
        res = await fetch(pxy + '/api/stream?' + qs.toString(), { credentials: 'omit' })
      } catch (e2) {
        return { ok: false, error: '下载失败：' + ((e2 && e2.message) || '网络不可达') }
      }
    }
    if (!res || !res.ok) return { ok: false, error: '下载失败：HTTP ' + (res ? res.status : '未知') }

    const total = Number(res.headers.get('content-length') || 0)
    let body
    if (onProgress && total > 0 && res.body && typeof Response === 'function') {
      // 带进度地把流读完，再拼成一条完整 Response 存进去
      try {
        const reader = res.body.getReader()
        const chunks = []
        let got = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          got += value.length
          onProgress(Math.min(1, got / total))
        }
        const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' })
        body = new Response(blob, {
          status: 200,
          headers: {
            'content-type': blob.type,
            'content-length': String(blob.size),
            'x-lx-cached-at': String(Date.now()),
          },
        })
      } catch {
        return { ok: false, error: '读取音频流失败' }
      }
    } else {
      let blob
      try { blob = await res.blob() } catch { return { ok: false, error: '读取音频失败（可能跨域被拦）' } }
      if (!blob || !blob.size) return { ok: false, error: '音频为空' }
      body = new Response(blob, {
        status: 200,
        headers: {
          'content-type': blob.type || res.headers.get('content-type') || 'audio/mpeg',
          'content-length': String(blob.size),
          'x-lx-cached-at': String(Date.now()),
        },
      })
    }

    const okPut = await put(song, quality, body)
    if (!okPut) return { ok: false, error: '写入缓存失败（可能存储空间不足）' }
    return { ok: true, bytes: Number(body.headers.get('content-length') || 0) }
  }

  function tokenOf() {
    try { return global.localStorage.getItem('lx.token') || '' } catch { return '' }
  }

  /**
   * 后台「听完整首就存」。
   *
   * 由 player.js 在音频自然播到结尾（ended）时调用。不去干扰播放过程本身 ——
   * 播放期间任何额外的字节抓取都会和 <audio> 抢带宽，那正是「越听越卡」的成因。
   */
  async function cacheAfterPlay(song, quality, hit) {
    if (!supported || !autoEnabled()) return { ok: false, error: '已关闭自动缓存' }
    if (!song || !hit || !hit.url) return { ok: false, error: '没有可用地址' }
    if (await has(song, quality)) return { ok: true, skipped: true }

    const key = keyFor(song, quality)
    if (mem.inflight.has(key)) return mem.inflight.get(key)
    const task = (async () => {
      mem.writing++
      try {
        const r = await fetchAndStore(song, quality, hit, null)
        if (r.ok) global.dispatchEvent(new CustomEvent('lx:cache', { detail: { song, quality, action: 'add', bytes: r.bytes } }))
        return r
      } finally {
        mem.writing--
        mem.inflight.delete(key)
      }
    })()
    mem.inflight.set(key, task)
    return task
  }

  /* ---------------- Range 支持 ---------------- */

  /**
   * 从缓存里取一条能直接喂给 <audio> 的响应。
   *
   * `range` 形如 `bytes=1000-2000`（播放器 seek 时会带）。有 range 就切出 206，
   * 否则整条给出去。切不出来（比如 range 超出文件尾）就返回 null，
   * 让调用方退回网络 —— 宁可重新下载，也不要给浏览器一条不合法的 206。
   */
  async function getForPlayback(song, quality, range) {
    const hit = await get(song, quality)
    if (!hit) return null
    touch(keyFor(song, quality))

    if (!range) {
      // 补上 Content-Length：某些 WebView 版本没有这个头就不认时长
      const buf = await hit.clone().arrayBuffer()
      return new Response(buf, {
        status: 200,
        headers: {
          'content-type': hit.headers.get('content-type') || 'audio/mpeg',
          'content-length': String(buf.byteLength),
          'accept-ranges': 'bytes',
        },
      })
    }

    const m = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim())
    if (!m) return null
    const buf = await hit.clone().arrayBuffer()
    const size = buf.byteLength
    let start = m[1] === '' ? null : Number(m[1])
    let end = m[2] === '' ? null : Number(m[2])
    if (start === null && end === null) return null
    if (start === null) {           // bytes=-500 → 最后 500 字节
      start = Math.max(0, size - end)
      end = size - 1
    } else if (end === null || end >= size) {
      end = size - 1
    }
    if (start > end || start >= size) return null
    const slice = buf.slice(start, end + 1)
    return new Response(slice, {
      status: 206,
      headers: {
        'content-type': hit.headers.get('content-type') || 'audio/mpeg',
        'content-length': String(slice.byteLength),
        'content-range': 'bytes ' + start + '-' + end + '/' + size,
        'accept-ranges': 'bytes',
      },
    })
  }

  /* ---------------- 导出下载 ---------------- */

  /** 文件名里不能有的字符换掉 —— 各平台歌名里 `/\:*?"<>|` 都出现过 */
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  /** 音频容器的后缀。源站给的 content-type 常常缺，靠扩展名兜底 */
  function extOf(url, type) {
    const m = /\.(mp3|flac|m4a|aac|wav|ogg|opus|ape)(\?|$)/i.exec(String(url || ''))
    if (m) return '.' + m[1].toLowerCase()
    const t = String(type || '').toLowerCase()
    if (t.includes('flac')) return '.flac'
    if (t.includes('mp4') || t.includes('m4a')) return '.m4a'
    if (t.includes('aac')) return '.aac'
    if (t.includes('ogg') || t.includes('opus')) return '.ogg'
    if (t.includes('wav')) return '.wav'
    return '.mp3'
  }

  /** 触发浏览器/壳的「保存文件」 */
  function saveBlob(blob, filename) {
    try {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        try { document.body.removeChild(a) } catch { /* 已被移除 */ }
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      }, 4000)
      return true
    } catch { return false }
  }

  /**
   * 导出一首歌到「下载」目录。
   *
   * 优先用缓存（既然听过了，就不必再下一次）；没有缓存就现抓一份，
   * 抓到之后顺手缓存 —— 用户既然要下载，多半也会再听。
   */
  async function exportSong(song, quality, resolveHit, onProgress) {
    const based = safeName(song.artist) ? safeName(song.artist) + ' - ' + safeName(song.name) : safeName(song.name)
    let blobSource = null
    let ext = '.mp3'

    const cached = await get(song, quality)
    if (cached) {
      try {
        blobSource = await cached.clone().blob()
        ext = extOf('', cached.headers.get('content-type'))
      } catch { blobSource = null }
    }

    if (!blobSource) {
      if (typeof resolveHit !== 'function') return { ok: false, error: '无法解析这首歌的地址' }
      let hit
      try { hit = await resolveHit() } catch { hit = null }
      if (!hit || !hit.url) return { ok: false, error: '没有可用的音频地址' }
      ext = extOf(hit.url)
      const r = await fetchAndStore(song, quality, hit, onProgress)
      if (!r.ok) return r
      const putRes = await get(song, quality)
      if (putRes) { try { blobSource = await putRes.clone().blob() } catch { blobSource = null } }
      if (!blobSource) return { ok: false, error: '文件已取到但读不出来' }
    }

    const filename = (based || 'audio') + ext
    // 壳里优先交原生写「下载」目录 —— 见 exportViaNative 的说明
    if (await exportViaNative(blobSource, filename)) {
      return { ok: true, filename, bytes: blobSource.size, via: 'native' }
    }
    const ok = saveBlob(blobSource, filename)
    if (!ok) return { ok: false, error: '浏览器拒绝了保存' }
    return { ok: true, filename, bytes: blobSource.size, via: 'blob' }
  }

  /**
   * 壳内导出：交给原生写进系统「下载」目录。
   *
   * WebView 的 `a[download]` 在部分机型上只是静默失败（尤其非 https 的本地页），
   * 所以壳里优先走原生。原生没有这个能力时返回 false，调用方回退到 saveBlob。
   */
  async function exportViaNative(blob, filename) {
    const host = global.AndroidHost
    if (!host || typeof host.saveAudio !== 'function') return false
    try {
      const buf = await blob.arrayBuffer()
      const b64 = base64FromBytes(new Uint8Array(buf))
      const r = host.saveAudio(filename, b64)
      // 原生侧**成功时返回落地路径**（失败返回空串），不是布尔值。
      // 这里一开始只认 true/''true''，结果壳里明明存成功了页面却当失败，
      // 又回退到 a[download] 那条在 WebView 里会静默失败的老路 ——
      // 症状正好是「提示保存了，下载目录里却找不到」。
      if (r === false || r === null || r === undefined) return false
      if (r === true || r === 'true') return true
      const s = String(r)
      // 非空字符串按「路径」对待：有 '/' 或带扩展名的都算成功
      return s.length > 0 && s !== 'false'
    } catch { return false }
  }

  /** 大文件不能靠 apply/spread 拼字符串（会爆栈），分块来 */
  function base64FromBytes(bytes) {
    let s = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) {
      const chunk = bytes.subarray(i, Math.min(i + CH, bytes.length))
      let part = ''
      for (let j = 0; j < chunk.length; j++) part += String.fromCharCode(chunk[j])
      s += part
    }
    return global.btoa(s)
  }

  /* ---------------- 统计 ---------------- */

  async function stats() {
    const used = await refreshBytes(true)
    const items = await list()
    return {
      supported,
      auto: autoEnabled(),
      limitMb: limitMb(),
      usedBytes: used,
      count: items.length,
      writing: mem.writing,
    }
  }

  global.LXAudioCache = {
    supported,
    keyFor,
    has,
    get: getForPlayback,
    list,
    drop,
    dropKey,
    clear,
    prune,
    touch,
    stats,
    limitMb,
    setLimitMb,
    autoEnabled,
    setAuto,
    cacheAfterPlay,
    exportSong,
    exportViaNative,
    saveBlob,
    fetchAndStore,
  }
})(typeof window !== 'undefined' ? window : globalThis)
