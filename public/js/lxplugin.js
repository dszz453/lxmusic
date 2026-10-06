/**
 * 浏览器端落雪插件管理器
 *
 * 与服务端内置插件互补：服务端插件在构建期固化（供 Subsonic 客户端使用），
 * 这里的插件可在手机上随时按 URL 导入、即时生效（浏览器允许 new Function）。
 * 取流时优先用这里的插件，失败再退回服务端。
 */
(function (global) {
  'use strict'

  const STORE_KEY = 'lxplugins'
  const WORKER_URL = '/js/lxworker.js'

  const instances = new Map()   // id -> { worker, meta, sources, ready, error }
  let plugins = []              // 持久化的插件定义
  let loaded = false
  let seq = 0
  const pending = new Map()     // 调用等待

  /* ---------------- 持久化 ---------------- */

  async function loadStore() {
    try {
      const raw = await U.idb.get(STORE_KEY)
      plugins = Array.isArray(raw) ? raw : []
    } catch {
      plugins = U.store.get(STORE_KEY, [])
    }
    loaded = true
    return plugins
  }

  async function saveStore() {
    try {
      await U.idb.set(STORE_KEY, plugins)
    } catch {
      U.store.set(STORE_KEY, plugins)
    }
  }

  /* ---------------- 元信息解析 ---------------- */

  function parseMeta(script) {
    const head = String(script).slice(0, 4000)
    const block = head.match(/\/\*\*([\s\S]*?)\*\//) || head.match(/\/\*([\s\S]*?)\*\//)
    const region = block ? block[1] : head
    const meta = {}
    for (const line of region.split('\n')) {
      const m = line.match(/@(\w+)\s+(.*)/)
      if (!m) continue
      const key = m[1].toLowerCase()
      if (['name', 'version', 'author', 'description', 'homepage', 'repository'].includes(key)) {
        meta[key] = m[2].trim().replace(/\*\/\s*$/, '').trim()
      }
    }
    return {
      name: meta.name || '未命名音源',
      version: meta.version || '1.0.0',
      author: meta.author || '未知',
      description: meta.description || '',
      homepage: meta.homepage || meta.repository || '',
    }
  }

  /* ---------------- Worker 生命周期 ---------------- */

  function startWorker(def) {
    const existing = instances.get(def.id)
    if (existing) return existing

    const record = { id: def.id, worker: null, meta: null, sources: null, ready: false, error: null }
    instances.set(def.id, record)

    let worker
    try {
      worker = new Worker(WORKER_URL, { type: 'module' })
    } catch (e) {
      record.error = '浏览器不支持 Worker 模块，插件无法运行'
      return record
    }
    record.worker = worker

    worker.onmessage = (event) => {
      const msg = event.data || {}
      if (msg.type === 'http') return handleHttp(msg, record)
      if (msg.type === 'loaded') {
        record.meta = msg.meta
        record.sources = msg.sources
        record.updateAlert = msg.updateAlert || null
        record.ready = true
        record.error = null
        return
      }
      if (msg.type === 'result' || msg.type === 'error') {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (msg.type === 'error') p.reject(new Error(msg.error))
          else p.resolve(msg.result)
        }
        if (msg.type === 'error' && msg.stage === 'load') {
          record.ready = false
          record.error = msg.error
        }
      }
    }
    worker.onerror = (e) => {
      record.error = (e && e.message) || '插件运行异常'
      record.ready = false
    }

    const loadId = 'load_' + (++seq)
    try {
      worker.postMessage({ type: 'load', id: loadId, script: def.script })
    } catch (e) {
      record.error = '插件脚本发送失败: ' + ((e && e.message) || e)
    }
    return record
  }

  /**
   * 插件发起的 HTTP 请求 —— 浏览器直接请求音乐平台会被 CORS 拦，
   * 因此统一转发到服务端 /api/proxy（服务端带登录态校验）。
   */
  async function handleHttp(msg, record) {
    const { id, url, options } = msg
    let result
    try {
      const token = API.getToken()
      const res = await fetch('/api/proxy?url=' + encodeURIComponent(url), {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: 'Bearer ' + token } : {}
        ),
        body: JSON.stringify({ options }),
      })
      const text = await res.text()
      let parsed = text
      if (options && options.json !== false) {
        try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
      }
      result = {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || '' },
        raw: text,
        body: parsed,
        ...(res.ok ? {} : { error: 'HTTP ' + res.status }),
      }
    } catch (e) {
      result = { error: String((e && e.message) || e) }
    }
    // 必须用调用方传进来的 record 回投递。
    // 历史写法是 `find(r => r.worker === msg.__worker)`，但 msg 是 Worker 主动
    // postMessage 出来的，里面从来没有 __worker 字段 → rec 恒为 null → 响应永远发不回去，
    // 插件的 lx.request 会一直挂着。attachWorkerTag 也没人调用过。
    if (record && record.worker) {
      record.worker.postMessage({ type: 'httpResponse', id, result })
    }
  }

  function invoke(record, source, action, info, timeout) {
    return new Promise((resolve, reject) => {
      if (!record || !record.worker || !record.ready) return reject(new Error(record && record.error ? record.error : '插件未就绪'))
      const id = 'inv_' + (++seq) + '_' + Math.random().toString(36).slice(2, 6)
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('插件调用超时'))
        }
      }, timeout || 20000)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      record.worker.postMessage({ type: 'invoke', id, source, action, info })
    })
  }

  /* ---------------- 对外接口 ---------------- */

  async function init() {
    if (loaded) return plugins
    await loadStore()
    for (const p of plugins) {
      if (p.enabled !== false) startWorker(p)
    }
    return plugins
  }

  function summary() {
    return plugins.map(p => {
      const inst = instances.get(p.id)
      return {
        id: p.id,
        name: (inst && inst.meta && inst.meta.name) || p.meta && p.meta.name || p.name || '未命名音源',
        version: (inst && inst.meta && inst.meta.version) || p.meta && p.meta.version || '',
        author: (inst && inst.meta && inst.meta.author) || p.meta && p.meta.author || '',
        description: (inst && inst.meta && inst.meta.description) || p.meta && p.meta.description || '',
        homepage: (inst && inst.meta && inst.meta.homepage) || p.meta && p.meta.homepage || '',
        url: p.url || '',
        enabled: p.enabled !== false,
        ready: !!(inst && inst.ready),
        error: (inst && inst.error) || null,
        sources: (inst && inst.sources ? Object.keys(inst.sources) : (p.sources || [])),
        updateAlert: (inst && inst.updateAlert) || null,
      }
    })
  }

  /** 从 URL 导入插件（走服务端代理抓取，绕过 GitHub 的 CORS 与直连问题） */
  async function importFromUrl(url) {
    const token = API.getToken()
    const res = await fetch('/api/proxy?url=' + encodeURIComponent(url), {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    })
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status)
    const script = await res.text()
    return importFromText(script, url)
  }

  async function importFromText(script, url) {
    if (!script || script.length < 50) throw new Error('脚本内容过短，可能不是有效的落雪插件')
    const meta = parseMeta(script)
    const id = 'u_' + Math.abs(hash(meta.name + url)).toString(36)
    const existing = plugins.findIndex(p => p.id === id)
    const def = {
      id,
      name: meta.name,
      meta,
      url: url || '',
      script,
      enabled: true,
      importedAt: Date.now(),
    }
    if (existing >= 0) {
      plugins[existing] = def
      const old = instances.get(id)
      if (old && old.worker) old.worker.terminate()
      instances.delete(id)
    } else {
      plugins.push(def)
    }
    await saveStore()
    const record = startWorker(def)
    // 等待加载结果，便于前端即时反馈
    await waitReady(record, 4000)
    return { def, record, meta }
  }

  function waitReady(record, timeout) {
    return new Promise(resolve => {
      const start = Date.now()
      const tick = () => {
        if (record.ready || record.error || Date.now() - start > timeout) return resolve(record)
        setTimeout(tick, 120)
      }
      tick()
    })
  }

  function hash(str) {
    let h = 5381
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
    return h
  }

  async function setEnabled(id, enabled) {
    const p = plugins.find(x => x.id === id)
    if (!p) return
    p.enabled = !!enabled
    await saveStore()
    if (enabled) {
      startWorker(p)
    } else {
      const inst = instances.get(id)
      if (inst && inst.worker) inst.worker.terminate()
      instances.delete(id)
    }
  }

  async function remove(id) {
    plugins = plugins.filter(p => p.id !== id)
    const inst = instances.get(id)
    if (inst && inst.worker) inst.worker.terminate()
    instances.delete(id)
    await saveStore()
  }

  /** 某平台是否可用客户端插件 */
  function supports(source, action) {
    for (const inst of instances.values()) {
      if (!inst.ready || !inst.sources) continue
      const info = inst.sources[source]
      if (!info) continue
      const actions = Array.isArray(info.actions) ? info.actions : ['musicUrl']
      if (!action || actions.includes(action)) return true
    }
    return false
  }

  /**
   * 常用音源清单（一键导入用）。
   *
   * 通过服务端 /api/proxy 下载（浏览器直连 raw.githubusercontent.com 不通），
   * 再由 Web Worker 沙箱执行。
   *
   * 这份清单与 build.mjs 的 PLUGIN_MANIFEST 是**两套东西**，别搞混：
   *   · 服务端 bundle（build.mjs）—— 部署时就固化进 Worker，不需要用户操作；
   *   · 这份清单 —— 用户在自己手机上按需导入，跑在浏览器侧。
   * 内容大致对应，但手机的网络出口和构建机不同：构建机上拉不到远端配置的源
   * （野花、野草这类开局要拉 88.lxmusic.中国 的），在手机上往往是好用的。
   * 所以这里保留得比服务端更全，不做剪枝。
   */
  const PRESETS = [
    { name: 'SixYin 六音', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js' },
    { name: 'Huibq', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js' },
    { name: 'Flower 野花', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js' },
    { name: 'Grass 野草', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js' },
    { name: 'LX', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js' },
    { name: 'IKun', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js' },
    { name: 'JuheApi', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/juhe/latest.js' },
    { name: 'ChangQing 长青', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js' },
    { name: 'HuanYin 幻音', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huanyin/latest.js' },
    { name: 'QDY', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/qdy/latest.js' },
    { name: 'LX Music 源（落雪播放源）', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/lx-music.js' },
    { name: 'Nya 源', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/nya.js' },
    // —— 社区聚合源：同一份代码被多个仓库镜像，这里只收一份，按实测得分从高到低 ——
    { name: '星海音乐源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/星海音乐源v2.3.14.js' },
    { name: '墨澜聚合音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/墨澜聚合音源v2.2.0.js' },
    { name: '全豆要聚合音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/全豆要[聚合音源]v9.3.js' },
    { name: '聚合音源·净化版', url: 'https://raw.githubusercontent.com/fengs2021/lx-music-merged-source/main/merged-source.js' },
    { name: '杰翔聚合音源', url: 'https://raw.githubusercontent.com/haonanren118/jiexiang-Music-Source/main/杰翔音乐源.js' },
    { name: 'K×H 测试', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/k-htest.js' },
    { name: 'HYWmusic 公益测试', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/hywmusic-beta-gongyitest.js' },
    { name: '浮光音乐', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/fuguang-music-helloworldsource-e093f5.js' },
    { name: 'LXMusic 免费源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/lx-music-source-free.js' },
    { name: 'Free Music', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/free-music.js' },
    { name: '梓橙公益音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/梓橙公益音源2代.js' },
  ]

  global.LXP = {
    init, summary, importFromUrl, importFromText, setEnabled, remove, supports, PRESETS,
    get plugins() { return plugins },

    /** 依次尝试客户端插件取流 */
    async resolveMusicUrl(song, quality) {
      const errors = []
      for (const inst of instances.values()) {
        if (!inst.ready || !inst.sources || !inst.sources[song.source]) continue
        const info = inst.sources[song.source]
        const actions = Array.isArray(info.actions) ? info.actions : ['musicUrl']
        if (!actions.includes('musicUrl')) continue
        try {
          const url = await invoke(inst, song.source, 'musicUrl', { type: quality, musicInfo: song })
          if (typeof url === 'string' && /^https?:\/\//.test(url)) {
            return { url, from: '插件:' + (inst.meta && inst.meta.name || '未知') }
          }
          errors.push((inst.meta && inst.meta.name) + ': 返回空')
        } catch (e) {
          errors.push((inst.meta && inst.meta.name) + ': ' + ((e && e.message) || e))
        }
      }
      return { url: null, errors }
    },

    async resolveLyric(song) {
      for (const inst of instances.values()) {
        if (!inst.ready || !inst.sources || !inst.sources[song.source]) continue
        try {
          const res = await invoke(inst, song.source, 'lyric', { musicInfo: song })
          if (res && (res.lyric || res.tlyric)) return res
        } catch { /* 试下一个 */ }
      }
      return null
    },
  }
})(window)
