/**
 * 通用工具：名称解码、时长/体积格式化、Buffer 垫片、zlib 垫片
 */
import {
  bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, latin1Decode, concatBytes, bytesToHex, hexToBytes,
} from './crypto.js'

/* ---------------- 文本 ---------------- */

const ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
  '&#39;': "'", '&#34;': '"', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
}

/**
 * 解码音乐平台返回文本里的 HTML 实体与 \uXXXX 转义。
 * 各平台返回的歌手/歌名经常是双重编码，必须同时处理。
 */
export function decodeName(str) {
  if (str == null) return ''
  let s = String(str)
  if (/&[a-zA-Z#0-9]{2,8};/.test(s)) {
    s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    s = s.replace(/&[a-zA-Z]+;/g, m => (ENTITY_MAP[m] !== undefined ? ENTITY_MAP[m] : m))
  }
  if (s.includes('\\u')) {
    try { s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) } catch { /* ignore */ }
  }
  return s
}

/** 从 HTML 页面里抠出赋值语句的 JSON，做容错解析（平台常返回非严格 JSON） */
export function parseLooseJson(text) {
  try { return JSON.parse(text) } catch { /* fallthrough */ }
  try {
    // 单引号 + 无引号 key 的伪 JSON
    const fixed = text
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
    return JSON.parse(fixed)
  } catch { return null }
}

/* ---------------- 格式化 ---------------- */

export function formatPlayTime(seconds, length = 2) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(length, '0')}:${String(sec).padStart(2, '0')}`
}

export function sizeFormate(bytes) {
  const n = Number(bytes) || 0
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`
}

export function durationToSeconds(duration) {
  if (typeof duration === 'number') return duration
  const parts = String(duration || '00:00').split(':').map(n => parseInt(n, 10) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] * 60 + (parts[1] || 0)
}

/** 歌手字段统一为「、」分隔的字符串 */
export function formatSingerName(singers, nameKey = 'name', join = '、') {
  if (Array.isArray(singers)) {
    const names = []
    for (const it of singers) {
      const n = it && it[nameKey]
      if (n) names.push(n)
    }
    return decodeName(names.join(join))
  }
  return decodeName(String(singers ?? ''))
}

/** 咪咕等平台的歌手串带分隔符，统一处理后返回数组 */
export function splitSingers(str) {
  return String(str || '')
    .split(/[、,&/]|\s+&\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/* ---------------- Buffer 垫片（供 lx.utils.buffer 使用） ---------------- */

export function createBufferShim() {
  class ByteBuf extends Uint8Array {
    static from(value, encoding = 'utf8') {
      if (value instanceof Uint8Array) return new ByteBuf(value)
      if (value instanceof ArrayBuffer) return new ByteBuf(new Uint8Array(value))
      if (Array.isArray(value)) return new ByteBuf(Uint8Array.from(value))
      if (typeof value === 'string') {
        if (encoding === 'hex') return new ByteBuf(hexToBytes(value))
        if (encoding === 'base64') return new ByteBuf(base64ToBytes(value))
        if (encoding === 'latin1' || encoding === 'binary') {
          const out = new Uint8Array(value.length)
          for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
          return new ByteBuf(out)
        }
        return new ByteBuf(utf8Encode(value))
      }
      return new ByteBuf(0)
    }
    static alloc(size) { return new ByteBuf(size) }
    static concat(list) { return new ByteBuf(concatBytes(...list.map(b => (b instanceof Uint8Array ? b : ByteBuf.from(b))))) }
    static isBuffer(v) { return v instanceof ByteBuf || v instanceof Uint8Array }
    toString(encoding = 'utf8') {
      if (encoding === 'hex') return bytesToHex(this)
      if (encoding === 'base64') return bytesToBase64(this)
      if (encoding === 'latin1' || encoding === 'binary') return latin1Decode(this)
      return utf8Decode(this)
    }
    toStringUtf8() { return utf8Decode(this) }
  }
  return ByteBuf
}

/** 复刻 lx.utils.buffer.bufToString(buffer, format) */
export function bufToString(buf, format = 'utf8') {
  if (buf == null) return ''
  if (typeof buf === 'string') return buf
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (format === 'hex') return bytesToHex(bytes)
  if (format === 'base64') return bytesToBase64(bytes)
  if (format === 'latin1' || format === 'binary') return latin1Decode(bytes)
  return utf8Decode(bytes)
}

/* ---------------- zlib 垫片（DecompressionStream 实现 deflate-raw） ---------------- */

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function inflateRaw(bytes) {
  try {
    return await streamThrough(bytes, new DecompressionStream('deflate-raw'))
  } catch {
    return streamThrough(bytes, new DecompressionStream('deflate'))
  }
}

export async function deflateRaw(bytes) {
  return streamThrough(bytes, new CompressionStream('deflate-raw'))
}

/* ---------------- 音频伴随信息 ---------------- */

/** 由文件名/URL 推断扩展名与 mime */
export function guessAudioFormat(url, fallback = 'mp3') {
  const clean = String(url || '').split('?')[0].toLowerCase()
  const m = clean.match(/\.(mp3|flac|m4a|aac|ogg|opus|wav|ape|wma)$/)
  return m ? m[1] : fallback
}

export const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', ape: 'audio/x-ape', wma: 'audio/x-ms-wma',
}

export function audioMime(url, fallback = 'mp3') {
  return MIME_BY_FORMAT[guessAudioFormat(url, fallback)] || 'audio/mpeg'
}

/* ---------------- 其他 ---------------- */

export function safeInt(v, def = 0) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

/** 简易稳定哈希，用于生成可复现的 ID */
export function stableHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 并发限制映射 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
