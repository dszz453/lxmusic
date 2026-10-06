/**
 * 落雪音乐（LX Music）自定义源插件运行时
 *
 * 关键约束（实测）：
 *   Cloudflare Workers 在「请求处理阶段」禁止 eval / new Function，
 *   但自 compatibility_date >= 2025-06-01 起，`allow_eval_during_startup` 默认开启，
 *   「启动阶段」（模块顶层）允许动态代码生成。
 *   => 插件脚本必须在模块顶层求值注册；请求阶段只能调用已注册的 handler。
 *
 * 同时：启动阶段禁止任何 I/O（fetch / setTimeout / 随机数），
 *   所以 lx.request 只定义闭包、不在启动阶段调用；插件脚本自身也不能在顶层发请求。
 */
import { md5, aesEncryptRaw, aesDecryptRaw, rsaEncryptRaw, randomBytes, bytesToBase64, base64ToBytes, hexToBytes, utf8Encode, utf8Decode } from './crypto.js'
import { createBufferShim, bufToString, inflateRaw, deflateRaw } from './util.js'
import { outboundFetch } from './http.js'

const LX_API_VERSION = '2.0.0'

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
}

/**
 * 构造一个 lx 宿主对象。
 * @param {(url:string, options:object, cb:Function)=>Function} httpImpl 实际发起 HTTP 的实现
 */
function createLxHost(httpImpl, scriptInfo) {
  const handlers = new Map()
  const state = { inited: null, updateAlert: null, logs: [] }

  const ByteBuf = createBufferShim()

  const lx = {
    version: LX_API_VERSION,
    env: 'desktop',
    currentScriptInfo: scriptInfo || null,
    EVENT_NAMES,

    on(eventName, handler) {
      if (typeof handler !== 'function') return
      handlers.set(eventName, handler)
    },

    send(eventName, data) {
      if (eventName === EVENT_NAMES.inited) {
        state.inited = data || null
      } else if (eventName === EVENT_NAMES.updateAlert) {
        if (!state.updateAlert) state.updateAlert = data || null
      }
    },

    request(url, options, callback) {
      return httpImpl(url, options || {}, callback)
    },

    utils: {
      buffer: {
        from: (value, encoding) => ByteBuf.from(value, encoding),
        bufToString: (buf, format) => bufToString(buf, format),
      },
      crypto: {
        md5: str => md5(typeof str === 'string' ? str : bufToString(str)),
        randomBytes: size => ByteBuf.from(randomBytes(Number(size) || 16)),
        aesEncrypt(buffer, mode, key, iv) {
          const data = toBytes(buffer)
          const k = toBytes(key)
          const normalizedMode = normalizeMode(mode)
          const out = aesEncryptRaw(data, k, normalizedMode, iv ? toBytes(iv) : undefined)
          return ByteBuf.from(out)
        },
        aesDecrypt(buffer, mode, key, iv) {
          const data = toBytes(buffer)
          const k = toBytes(key)
          const normalizedMode = normalizeMode(mode)
          const out = aesDecryptRaw(data, k, normalizedMode, iv ? toBytes(iv) : undefined)
          return ByteBuf.from(out)
        },
        rsaEncrypt(buffer, key) {
          const out = rsaEncryptRaw(toBytes(buffer), bufToString(key, 'utf8'))
          return ByteBuf.from(out)
        },
      },
      zlib: {
        async inflate(buffer) {
          const out = await inflateRaw(toBytes(buffer))
          return ByteBuf.from(out)
        },
        async deflate(buffer) {
          const out = await deflateRaw(toBytes(buffer))
          return ByteBuf.from(out)
        },
      },
    },
  }

  return { lx, handlers, state }
}

function toBytes(v) {
  if (v == null) return new Uint8Array(0)
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (typeof v === 'string') return utf8Encode(v)
  if (Array.isArray(v)) return Uint8Array.from(v)
  return utf8Encode(String(v))
}

/** 兼容 crypto-js / Node / 字符串三种 mode 写法 */
function normalizeMode(mode) {
  const s = String(mode || 'cbc').toLowerCase()
  if (s.includes('ecb')) return 'ecb'
  return 'cbc'
}

/** 从脚本头部注释里解析 @name / @version / @author / @description / @homepage */
export function parseScriptMeta(script) {
  const head = String(script).slice(0, 4000)
  const block = head.match(/\/\*\*([\s\S]*?)\*\//) || head.match(/\/\*([\s\S]*?)\*\//)
  const meta = {}
  const region = block ? block[1] : head
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

/**
 * 请求阶段使用的 HTTP 实现，语义对齐 LX 的 lx.request：
 *   lx.request(url, options, (err, resp, body) => {}) => cancelHttp
 * options 支持 method / headers / body / form / formData / timeout
 */
function makeHttpImpl() {
  return function httpImpl(url, options, callback) {
    const controller = new AbortController()
    const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 15000
    const timer = setTimeout(() => controller.abort(), timeout)

    const finish = (err, resp, body) => {
      clearTimeout(timer)
      try { callback(err, resp, body) } catch (e) { console.warn('[lx] request 回调异常:', e && e.message) }
    }

    ;(async () => {
      try {
        const method = String(options.method || 'get').toUpperCase()
        const headers = { ...(options.headers || {}) }
        let payload
        if (options.form) {
          payload = new URLSearchParams(options.form).toString()
          if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
        } else if (options.formData) {
          const fd = new FormData()
          for (const [k, v] of Object.entries(options.formData)) fd.append(k, v)
          payload = fd
        } else if (options.body !== undefined) {
          payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
          if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
        }

        const res = await outboundFetch(url, { method, headers, body: payload, signal: controller.signal, redirect: 'follow' })
        const text = await res.text()
        let parsed = text
        if (options.json !== false) {
          try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
        }
        const resp = {
          statusCode: res.status,
          status: res.status,
          headers: Object.fromEntries(res.headers),
          raw: text,
          body: parsed,
        }
        finish(null, resp, resp.body)
      } catch (e) {
        finish(e, null, null)
      }
    })()

    return () => {
      clearTimeout(timer)
      try { controller.abort() } catch { /* ignore */ }
    }
  }
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some(k => k.toLowerCase() === lower)
}

/**
 * 在启动阶段求值一个插件脚本。必须只在模块顶层调用。
 * @returns {{ok:boolean, meta:object, sources:object, error?:string, host:object}}
 */
export function evaluatePluginAtStartup(id, script, scriptInfo) {
  const host = createLxHost(makeHttpImpl(), scriptInfo)
  const previous = globalThis.lx
  globalThis.lx = host.lx
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(String(script))
    fn.call(globalThis)
    const inited = host.state.inited
    if (!inited || !inited.sources || typeof inited.sources !== 'object') {
      throw new Error('脚本未发送 inited 事件或未声明 sources')
    }
    return {
      ok: true,
      id,
      meta: parseScriptMeta(script),
      sources: inited.sources,
      updateAlert: host.state.updateAlert,
      host,
    }
  } catch (e) {
    return {
      ok: false,
      id,
      meta: parseScriptMeta(script),
      error: String((e && e.message) || e),
      host,
    }
  } finally {
    if (previous === undefined) delete globalThis.lx
    else globalThis.lx = previous
  }
}

/**
 * 插件池：管理已注册插件，按优先级为 (source, action) 选择可用插件
 */
export class PluginPool {
  constructor() {
    this.plugins = []
    this.bySource = new Map() // source -> plugin[]
    this.rank = null          // { source: [pluginId, ...] }，实测得分降序
    this._rankIndex = null
    this.userPrefs = null     // 见 setUserPrefs()
    this._prefIndex = null
  }

  /**
   * 装载「插件实测得分排序表」，让候选顺序由实测结果决定，而不是写入 manifest 的顺序。
   *
   * 为什么需要：取流时只会试候选列表的前 N 个（resolveMusicUrlFast 的 maxTries、
   * openAudioStream 的 maxCandidates）。池子里插件一多，排在后面的根本轮不到，
   * 而「谁排前面」原本只取决于构建时的书写顺序 —— 等于随机。
   *
   * 排序是**按平台各自排**的：同一个插件可能在网易云上很稳、在咪咕上一塌糊涂，
   * 一个全局名次表达不了这种差异。
   *
   * 未上榜（新加的、没测过的）排在已上榜之后；同档内保持原注册顺序（稳定排序）。
   * @param {{[source:string]: string[]}} rankBySource
   */
  setRank(rankBySource) {
    this.rank = (rankBySource && typeof rankBySource === 'object') ? rankBySource : null
    this._rankIndex = null
    if (!this.rank) return 0
    this._rankIndex = new Map()
    for (const [src, ids] of Object.entries(this.rank)) {
      if (!Array.isArray(ids)) continue
      this._rankIndex.set(src, new Map(ids.map((id, i) => [id, i])))
    }
    return this._rankIndex.size
  }

  /**
   * 装载「用户调度偏好」—— 管理员在「音源与插件」页手动设的那份。
   *
   * 两种模式：
   *   auto   —— 吃实测排序表（setRank 那份），系统自己挑最优的排在前面；
   *   manual —— 吃用户给每个平台排的顺序；用户没排过的平台仍回落实测排序。
   *
   * `disabled` 是全局停用清单，两种模式下都生效（用户说不用就不用）。
   *
   * 这里是 isolate 级单例状态，但设置本来就是全局唯一的一份（不是按用户存的），
   * 所以并发请求之间不存在「串用户」的问题 —— 最坏情况是某个请求读到上一版
   * 偏好，而偏好本身是幂等的（顺序变一变，取流结果不会错，只是可能多试一个插件）。
   *
   * @param {{mode?:'auto'|'manual', order?:{[source:string]:string[]}, disabled?:string[]}} prefs
   * @returns {{mode:string, disabled:number, manualSources:number}}
   */
  setUserPrefs(prefs) {
    this.userPrefs = (prefs && typeof prefs === 'object') ? prefs : null
    this._prefIndex = null
    if (!this.userPrefs) return { mode: 'auto', disabled: 0, manualSources: 0 }
    const mode = this.userPrefs.mode === 'manual' ? 'manual' : 'auto'
    const disabled = new Set(Array.isArray(this.userPrefs.disabled) ? this.userPrefs.disabled : [])
    const order = new Map()
    const rawOrder = this.userPrefs.order
    if (rawOrder && typeof rawOrder === 'object') {
      for (const [src, ids] of Object.entries(rawOrder)) {
        if (Array.isArray(ids) && ids.length) order.set(src, new Map(ids.map((id, i) => [id, i])))
      }
    }
    this._prefIndex = { disabled, order }
    return { mode, disabled: disabled.size, manualSources: order.size }
  }

  /**
   * 取某平台所有可用的 musicUrl 插件。
   *
   * 排序分两层，缺一不可：
   *   ① 人工模式下用户排过的插件按他的顺序；
   *   ② 剩下的按**实测评分**垫后 —— 注意不是按注册顺序。
   *      这里踩过坑：一开始人工模式未排到的插件落回注册顺序，于是用户一切到
   *      人工模式，他没动过的十几个插件顺序整体重排一遍（wsl-quandou 从第 3
   *      掉到第 17），看起来像设置被重置了。
   *
   * 两种模式都先把「用户停用」的插件剔掉。
   */
  musicUrlPlugins(source, action = 'musicUrl') {
    let list = (this.bySource.get(source) || []).filter(p => this._supportsAction(p, source, action))
    const disabled = this._prefIndex && this._prefIndex.disabled
    if (disabled && disabled.size) list = list.filter(p => !disabled.has(p.id))
    if (list.length < 2) return list

    const MAX = Number.MAX_SAFE_INTEGER
    const rankIdx = (this._rankIndex && this._rankIndex.get(source)) || null
    const manual = (this._prefIndex && this.userPrefs && this.userPrefs.mode === 'manual')
      ? this._prefIndex.order.get(source) || null
      : null
    if (!rankIdx && !manual) return list // 没有任何排序依据，保持注册顺序

    return list
      .map((p, i) => ({
        p, i,
        m: manual && manual.has(p.id) ? manual.get(p.id) : MAX,
        r: rankIdx && rankIdx.has(p.id) ? rankIdx.get(p.id) : MAX,
      }))
      .sort((a, b) => (a.m - b.m) || (a.r - b.r) || (a.i - b.i))
      .map(x => x.p)
  }

  add(entry) {
    if (!entry.ok) {
      this.plugins.push({ ...entry, enabled: false, sources: entry.sources || {} })
      return
    }
    const record = { ...entry, enabled: true }
    this.plugins.push(record)
    for (const sourceKey of Object.keys(entry.sources)) {
      if (!this.bySource.has(sourceKey)) this.bySource.set(sourceKey, [])
      this.bySource.get(sourceKey).push(record)
    }
  }

  /** 某平台是否有插件支持 */
  supports(source, action = 'musicUrl') {
    const list = this.bySource.get(source) || []
    return list.some(p => this._supportsAction(p, source, action))
  }

  _supportsAction(plugin, source, action) {
    const info = plugin.sources && plugin.sources[source]
    if (!info) return false
    const actions = info.actions
    if (!Array.isArray(actions)) return action === 'musicUrl'
    return actions.includes(action)
  }

  /** 调用单个插件；返回 {ok, value, plugin} 或 {ok:false, error, plugin} */
  async invokePlugin(plugin, source, action, info, { timeout = 20000 } = {}) {
    const name = (plugin.meta && plugin.meta.name) || '未命名音源'
    const handler = plugin.host.handlers.get(EVENT_NAMES.request)
    if (!handler) return { ok: false, plugin: name, error: '未注册 request 处理器' }
    try {
      const result = await withTimeout(
        Promise.resolve(handler({ source, action, info })),
        timeout,
        `${name} 调用超时`
      )
      if (action === 'musicUrl') {
        if (typeof result === 'string' && /^https?:\/\//.test(result)) return { ok: true, plugin: name, value: result }
      } else if (result) {
        return { ok: true, plugin: name, value: result }
      }
      return { ok: false, plugin: name, error: '返回空结果' }
    } catch (e) {
      return { ok: false, plugin: name, error: (e && e.message) || String(e) }
    }
  }

  /** 依次尝试各插件，返回第一个成功的结果 */
  async invoke(source, action, info, opts = {}) {
    const candidates = this.musicUrlPlugins(source, action)
    const errors = []
    for (const plugin of candidates) {
      const r = await this.invokePlugin(plugin, source, action, info, opts)
      if (r.ok) return { value: r.value, plugin: r.plugin }
      errors.push(`${r.plugin}: ${r.error}`)
    }
    return { value: null, errors }
  }

  /** 支持的各平台音质定义，供前端选择 */
  qualityMap(source) {
    const list = this.bySource.get(source) || []
    const qualities = new Set()
    for (const p of list) {
      const info = p.sources && p.sources[source]
      if (info && Array.isArray(info.qualitys)) info.qualitys.forEach(q => qualities.add(q))
    }
    return Array.from(qualities)
  }

  summary() {
    return this.plugins.map(p => ({
      id: p.id,
      ok: !!p.ok,
      error: p.error || null,
      name: p.meta.name,
      version: p.meta.version,
      author: p.meta.author,
      description: p.meta.description,
      homepage: p.meta.homepage,
      sources: Object.keys(p.sources || {}),
      updateAlert: p.updateAlert || null,
    }))
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}
