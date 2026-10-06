/**
 * LX 插件执行 Worker
 *
 * 落雪插件的官方宿主协议（globalThis.lx）在这里复刻：
 *   - on(EVENT_NAMES.request, handler)  注册取流/歌词/封面处理器
 *   - send(EVENT_NAMES.inited, {sources}) 声明支持的平台与音质
 *   - request(url, options, cb)         受控 HTTP（转发到主线程，经服务端代理绕过 CORS）
 *   - utils.{buffer,crypto,zlib}        与桌面版行为对齐的垫片
 *
 * 放在独立 Worker 里执行的原因：插件是第三方代码，隔离在 Worker 中既不阻塞界面，
 * 也拿不到页面 DOM / localStorage / 登录态。
 */
import {
  md5, aesEncryptRaw, aesDecryptRaw, rsaEncryptRaw, randomBytes, utf8Encode,
} from './lib/crypto.js'
import { createBufferShim, bufToString, inflateRaw, deflateRaw } from './lib/util.js'

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

const handlers = new Map()
const pendingHttp = new Map()
let httpSeq = 0
let state = { inited: null, updateAlert: null }

const ByteBuf = createBufferShim()

function toBytes(v) {
  if (v == null) return new Uint8Array(0)
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (typeof v === 'string') return utf8Encode(v)
  if (Array.isArray(v)) return Uint8Array.from(v)
  return utf8Encode(String(v))
}

function normalizeMode(mode) {
  return String(mode || 'cbc').toLowerCase().includes('ecb') ? 'ecb' : 'cbc'
}

const lx = {
  version: '2.0.0',
  env: 'desktop',
  EVENT_NAMES,
  currentScriptInfo: null,

  on(eventName, handler) {
    if (typeof handler === 'function') handlers.set(eventName, handler)
  },

  send(eventName, data) {
    if (eventName === EVENT_NAMES.inited) state.inited = data || null
    else if (eventName === EVENT_NAMES.updateAlert) { if (!state.updateAlert) state.updateAlert = data || null }
  },

  request(url, options, callback) {
    let cancelled = false
    const id = ++httpSeq
    const payload = sanitizeOptions(options || {})
    pendingHttp.set(id, (result) => {
      if (cancelled) return
      if (result.error) return callback(new Error(result.error), null, null)
      const resp = {
        statusCode: result.status,
        status: result.status,
        headers: result.headers || {},
        raw: result.raw,
        body: result.body,
      }
      callback(null, resp, resp.body)
    })
    self.postMessage({ type: 'http', id, url: String(url), options: payload })
    return function cancelHttp() {
      cancelled = true
      pendingHttp.delete(id)
    }
  },

  utils: {
    buffer: {
      from: (value, encoding) => ByteBuf.from(value, encoding),
      bufToString: (buf, format) => bufToString(buf, format),
    },
    crypto: {
      md5: (str) => md5(typeof str === 'string' ? str : bufToString(str)),
      randomBytes: (size) => ByteBuf.from(randomBytes(Number(size) || 16)),
      aesEncrypt(buffer, mode, key, iv) {
        return ByteBuf.from(aesEncryptRaw(toBytes(buffer), toBytes(key), normalizeMode(mode), iv ? toBytes(iv) : undefined))
      },
      aesDecrypt(buffer, mode, key, iv) {
        return ByteBuf.from(aesDecryptRaw(toBytes(buffer), toBytes(key), normalizeMode(mode), iv ? toBytes(iv) : undefined))
      },
      rsaEncrypt(buffer, key) {
        return ByteBuf.from(rsaEncryptRaw(toBytes(buffer), bufToString(key, 'utf8')))
      },
    },
    zlib: {
      async inflate(buffer) { return ByteBuf.from(await inflateRaw(toBytes(buffer))) },
      async deflate(buffer) { return ByteBuf.from(await deflateRaw(toBytes(buffer))) },
    },
  },
}

/** options 里可能带函数/循环引用，postMessage 前清理 */
function sanitizeOptions(options) {
  const out = {}
  for (const key of ['method', 'headers', 'body', 'form', 'formData', 'timeout', 'json']) {
    const v = options[key]
    if (v === undefined || typeof v === 'function') continue
    if (key === 'headers' || key === 'form' || key === 'formData') {
      if (v && typeof v === 'object') {
        const o = {}
        for (const [k, val] of Object.entries(v)) {
          if (val === undefined || typeof val === 'function') continue
          o[k] = typeof val === 'string' ? val : String(val)
        }
        out[key] = o
      }
      continue
    }
    if (key === 'body') {
      out.body = typeof v === 'string' ? v : safeStringify(v)
      continue
    }
    out[key] = v
  }
  return out
}

function safeStringify(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 轮询等插件的异步 inited（多数插件会先请求一次源信息再声明 sources） */
function waitForInited(timeout) {
  const limit = Math.max(1000, Number(timeout) || 8000)
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (state.inited) return resolve(state.inited)
      if (Date.now() - t0 >= limit) return resolve(null)
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** 解析脚本头部注释元信息 */
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

self.onmessage = async (event) => {
  const msg = event.data || {}
  try {
    if (msg.type === 'load') {
      // 每个 Worker 只加载一个插件，避免插件之间互相污染 globalThis.lx
      handlers.clear()
      state = { inited: null, updateAlert: null }
      const meta = parseMeta(msg.script)
      lx.currentScriptInfo = { ...meta, rawScript: null }
      globalThis.lx = lx
      // eslint-disable-next-line no-new-func
      const fn = new Function(String(msg.script))
      fn.call(globalThis)
      // 相当一部分插件的 inited 是在 Promise 链里异步发出的（典型：先拉一次
      // 源信息/检查更新，再声明 sources）。脚本体本身是同步执行的，所以这里必须
      // 等一等，否则会把「还没初始化完」误判成「脚本不合法」。
      // 服务端版本（src/lib/lxruntime.js）是同步读的，因此在 CF 上这批插件全挂。
      const inited = state.inited || await waitForInited(msg.initTimeout || 8000)
      if (!inited || !inited.sources || typeof inited.sources !== 'object') {
        throw new Error('脚本未发送 inited 事件或未声明 sources')
      }
      self.postMessage({
        type: 'loaded',
        id: msg.id,
        meta,
        sources: inited.sources,
        updateAlert: state.updateAlert || null,
      })
      return
    }

    if (msg.type === 'invoke') {
      const handler = handlers.get(EVENT_NAMES.request)
      if (!handler) throw new Error('插件未注册 request 处理器')
      const result = await Promise.resolve(handler({ source: msg.source, action: msg.action, info: msg.info }))
      self.postMessage({ type: 'result', id: msg.id, result })
      return
    }

    if (msg.type === 'httpResponse') {
      const resolve = pendingHttp.get(msg.id)
      if (resolve) {
        pendingHttp.delete(msg.id)
        resolve(msg.result || { error: 'empty' })
      }
      return
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, error: String((e && e.message) || e), stage: msg.type })
  }
}

self.postMessage({ type: 'ready' })
