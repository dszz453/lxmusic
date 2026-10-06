/**
 * 纯 JS 加密/编码工具集
 * 同时服务于两处：
 *  1) 各音乐平台接口签名（MD5 / AES / RSA）
 *  2) LX 插件的 globalThis.lx.utils（buffer / crypto / zlib）
 * 全部基于无依赖纯 JS + WebCrypto 随机数，可在 Cloudflare Workers 中运行。
 */

/* ---------------- 编码工具 ---------------- */

export function bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16)
  return out
}

export function hexToBytes(hex) {
  const n = hex.length >> 1
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64CHARS[b0 >> 2]
    out += B64CHARS[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)]
    out += b1 === undefined ? '=' : B64CHARS[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)]
    out += b2 === undefined ? '=' : B64CHARS[b2 & 63]
  }
  return out
}

export function base64ToBytes(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '')
  const len = clean.length
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const out = new Uint8Array(((len * 3) >> 2) - pad)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const c0 = B64CHARS.indexOf(clean[i])
    const c1 = B64CHARS.indexOf(clean[i + 1])
    const c2 = B64CHARS.indexOf(clean[i + 2])
    const c3 = B64CHARS.indexOf(clean[i + 3])
    out[p++] = (c0 << 2) | (c1 >> 4)
    if (p < out.length) out[p++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (p < out.length) out[p++] = ((c2 & 3) << 6) | c3
  }
  return out
}

export function utf8Encode(str) {
  return new TextEncoder().encode(String(str))
}

export function utf8Decode(bytes) {
  return new TextDecoder('utf-8').decode(bytes)
}

export function latin1Decode(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

export function concatBytes(...arrs) {
  let total = 0
  for (const a of arrs) total += a.length
  const out = new Uint8Array(total)
  let p = 0
  for (const a of arrs) { out.set(a, p); p += a.length }
  return out
}

export function randomBytes(size) {
  const b = new Uint8Array(size)
  crypto.getRandomValues(b)
  return b
}

/* ---------------- MD5（纯 JS） ---------------- */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const MD5_K = new Uint32Array(64)
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

function md5Words(input) {
  let bytes = typeof input === 'string' ? utf8Encode(input) : input
  const bitLen = bytes.length * 8
  const withPad = ((bytes.length + 8) >> 6) * 64 + 64
  const buf = new Uint8Array(withPad)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  // 长度小端 64 位
  const dv = new DataView(buf.buffer)
  dv.setUint32(withPad - 8, bitLen >>> 0, true)
  dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296) >>> 0, true)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const M = new Uint32Array(16)
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      const tmp = D
      D = C
      C = B
      const sum = (A + F + MD5_K[i] + M[g]) >>> 0
      const rot = MD5_S[i]
      B = (B + (((sum << rot) | (sum >>> (32 - rot))) >>> 0)) >>> 0
      A = tmp
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }
  const out = new Uint8Array(16)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, a0, true)
  odv.setUint32(4, b0, true)
  odv.setUint32(8, c0, true)
  odv.setUint32(12, d0, true)
  return out
}

export function md5(input) {
  return bytesToHex(md5Words(input))
}

export function md5Bytes(input) {
  return md5Words(input)
}

/* ---------------- AES（纯 JS，支持 ECB / CBC） ---------------- */

const SBOX = new Uint8Array(256)
const INV_SBOX = new Uint8Array(256)

// GF(2^8) 乘法（AES 多项式 x^8+x^4+x^3+x+1 = 0x11b）
function gmul(a, b) {
  let r = 0
  while (b > 0) {
    if (b & 1) r ^= a
    a <<= 1
    if (a & 0x100) a ^= 0x11b
    b >>= 1
  }
  return r & 0xff
}

;(function initSbox() {
  // 直白实现：穷举求乘法逆元 + 仿射变换。
  // 不用网上常见的位运算生成法——那种写法对运算顺序极敏感，容易静默出错。
  // 这里只有 256×256 次乘法，冷启动一次性开销可忽略。
  const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff
  const inverse = new Uint8Array(256)
  for (let a = 1; a < 256; a++) {
    for (let b = 1; b < 256; b++) {
      if (gmul(a, b) === 1) { inverse[a] = b; break }
    }
  }
  inverse[0] = 0
  for (let a = 0; a < 256; a++) {
    const inv = inverse[a]
    SBOX[a] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i
})()

function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff }
function mul(a, b) {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a = xtime(a)
    b >>= 1
  }
  return r & 0xff
}

function expandKey(key) {
  const nk = key.length / 4
  const nr = nk + 6
  const w = new Uint8Array(16 * (nr + 1))
  w.set(key)
  let rcon = 1
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4)
    if (i % nk === 0) {
      t = new Uint8Array([t[1], t[2], t[3], t[0]])
      t[0] = SBOX[t[0]]; t[1] = SBOX[t[1]]; t[2] = SBOX[t[2]]; t[3] = SBOX[t[3]]
      t[0] ^= rcon
      rcon = xtime(rcon)
    } else if (nk > 6 && i % nk === 4) {
      t = new Uint8Array([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]])
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j]
  }
  return { w, nr }
}

function addRoundKey(s, w, round) {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]
}
function subBytes(s, box) { for (let i = 0; i < 16; i++) s[i] = box[s[i]] }
function shiftRows(s) {
  let t
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
  t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t
}
function invShiftRows(s) {
  let t
  t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t
}
function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]
    s[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3
    s[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3
    s[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3)
    s[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2)
  }
}
function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]
    s[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9)
    s[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13)
    s[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11)
    s[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14)
  }
}

function encryptBlock(block, ks) {
  const s = Uint8Array.from(block)
  addRoundKey(s, ks.w, 0)
  for (let r = 1; r < ks.nr; r++) {
    subBytes(s, SBOX); shiftRows(s); mixColumns(s); addRoundKey(s, ks.w, r)
  }
  subBytes(s, SBOX); shiftRows(s); addRoundKey(s, ks.w, ks.nr)
  return s
}

function decryptBlock(block, ks) {
  const s = Uint8Array.from(block)
  addRoundKey(s, ks.w, ks.nr)
  for (let r = ks.nr - 1; r > 0; r--) {
    invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, ks.w, r); invMixColumns(s)
  }
  invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, ks.w, 0)
  return s
}

function pkcs7Pad(data, blockSize = 16) {
  const pad = blockSize - (data.length % blockSize)
  const out = new Uint8Array(data.length + pad)
  out.set(data)
  out.fill(pad, data.length)
  return out
}
function pkcs7Unpad(data) {
  if (!data.length) return data
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 16 || pad > data.length) return data
  return data.slice(0, data.length - pad)
}

function toKeyBytes(key) {
  if (typeof key === 'string') return utf8Encode(key)
  return key
}

/** AES 加解密。mode: 'ecb' | 'cbc'。返回 Uint8Array（cbc 加密时自动 PKCS7 填充） */
export function aesEncryptRaw(data, key, mode = 'cbc', iv) {
  const kb = toKeyBytes(key)
  const ks = expandKey(kb)
  const padded = pkcs7Pad(data)
  const out = new Uint8Array(padded.length)
  if (mode === 'cbc') {
    let prev = iv ? toKeyBytes(iv) : new Uint8Array(16)
    for (let i = 0; i < padded.length; i += 16) {
      const blk = new Uint8Array(16)
      for (let j = 0; j < 16; j++) blk[j] = padded[i + j] ^ prev[j]
      const enc = encryptBlock(blk, ks)
      out.set(enc, i)
      prev = enc
    }
  } else {
    for (let i = 0; i < padded.length; i += 16) out.set(encryptBlock(padded.slice(i, i + 16), ks), i)
  }
  return out
}

export function aesDecryptRaw(data, key, mode = 'cbc', iv) {
  const kb = toKeyBytes(key)
  const ks = expandKey(kb)
  const out = new Uint8Array(data.length)
  if (mode === 'cbc') {
    let prev = iv ? toKeyBytes(iv) : new Uint8Array(16)
    for (let i = 0; i < data.length; i += 16) {
      const blk = data.slice(i, i + 16)
      const dec = decryptBlock(blk, ks)
      for (let j = 0; j < 16; j++) out[i + j] = dec[j] ^ prev[j]
      prev = blk
    }
  } else {
    for (let i = 0; i < data.length; i += 16) out.set(decryptBlock(data.slice(i, i + 16), ks), i)
  }
  return pkcs7Unpad(out)
}

/* ---------------- RSA PKCS#1 v1.5（裸实现，用于网易 weapi） ---------------- */

function bytesToBigIntBE(bytes) {
  let hex = bytesToHex(bytes)
  return BigInt('0x' + (hex || '0'))
}
function bigIntToBytesBE(n, len) {
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const b = hexToBytes(hex)
  if (len && b.length < len) {
    const out = new Uint8Array(len)
    out.set(b, len - b.length)
    return out
  }
  return b
}
function modPow(base, exp, mod) {
  let result = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

/**
 * 网易 encSecKey：网易用的不是标准 PKCS#1，而是「把 16 字节密钥字节逆序后直接做裸 RSA 幂运算」，
 * 结果左侧补零到 256 个 hex 字符（1024bit）。这是网易客户端的历史实现，必须照抄才能对上。
 * @param {string} keyHex 16 字节密钥的 32 位 hex 字符串
 */
export function rsaEncryptNetease(keyHex, pubKeyHex = '010001', modulusHex = WY_MODULUS) {
  const hex = String(keyHex)
  if (hex.length === 0 || hex.length % 2 !== 0) throw new Error('netease secKey must be an even-length hex string')
  const reversed = hexToBytes(hex).reverse() // 字符逆序 == 字节逆序
  const m = bytesToBigIntBE(reversed)
  const e = BigInt('0x' + pubKeyHex)
  const n = BigInt('0x' + modulusHex)
  return modPow(m, e, n).toString(16).padStart(256, '0')
}

/**
 * lx.utils.crypto.rsaEncrypt(buffer, key) —— 对齐 Node crypto.publicEncrypt(PKCS1_PADDING)
 * 支持 SPKI PEM（BEGIN PUBLIC KEY）与 PKCS#1 PEM（BEGIN RSA PUBLIC KEY）
 */
export function rsaEncryptRaw(data, pemKey) {
  const body = String(pemKey).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = base64ToBytes(body)
  const { modulus, exponent } = parseRsaPublicKey(der)
  const bytes = typeof data === 'string' ? utf8Encode(data) : data
  const k = modulus.length
  const psLen = k - 3 - bytes.length
  if (psLen < 8) throw new Error('RSA message too long')
  const ps = new Uint8Array(psLen)
  let filled = 0
  while (filled < psLen) {
    const r = randomBytes(psLen - filled)
    for (let i = 0; i < r.length && filled < psLen; i++) if (r[i] !== 0) ps[filled++] = r[i]
  }
  const em = concatBytes(new Uint8Array([0x00, 0x02]), ps, new Uint8Array([0x00]), bytes)
  const c = modPow(bytesToBigIntBE(em), bytesToBigIntBE(exponent), bytesToBigIntBE(modulus))
  return bigIntToBytesBE(c, k)
}

/** DER 读取器：返回 { tag, val } 并推进游标 */
function derReader(der) {
  let p = 0
  return {
    get done() { return p >= der.length },
    read() {
      const tag = der[p++]
      let len = der[p++]
      if (len & 0x80) {
        const n = len & 0x7f
        len = 0
        for (let i = 0; i < n; i++) len = (len << 8) | der[p++]
      }
      const val = der.slice(p, p + len)
      p += len
      return { tag, val }
    },
  }
}

/** 解析 RSA 公钥 DER，自动识别 SPKI(0x30{0x30...,0x03...}) 与裸 PKCS#1(0x30{0x02 modulus, 0x02 exponent}) */
function parseRsaPublicKey(der) {
  const outer = derReader(der)
  const top = outer.read()
  if (top.tag !== 0x30) throw new Error('invalid RSA public key: expect SEQUENCE')
  const inner = derReader(top.val)
  const first = inner.read()
  let seq
  if (first.tag === 0x30) {
    // SPKI：跳过 AlgorithmIdentifier，取 BIT STRING
    const bits = inner.read()
    if (bits.tag !== 0x03) throw new Error('invalid SPKI: expect BIT STRING')
    const pkcs1 = bits.val.slice(1) // 去掉 unused-bits 字节
    seq = derReader(pkcs1).read()
  } else {
    // 裸 PKCS#1：first 就是 modulus INTEGER
    seq = first
  }
  const intReader = derReader(seq.val)
  const mod = intReader.read()
  const exp = intReader.read()
  const strip = b => (b.length > 1 && b[0] === 0x00 ? b.slice(1) : b)
  return { modulus: strip(mod.val), exponent: strip(exp.val) }
}

/* ---------------- 网易 weapi / eapi ---------------- */

const WY_PRESET_KEY = '0CoJUm6Qyw8W8jud'
const WY_IV = '0102030405060708'
const WY_PUBKEY = '010001'
const WY_MODULUS =
  'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const EAPI_KEY = 'e82ckenh8dichen8'

export function weapi(object) {
  const text = JSON.stringify(object)
  const secKey = bytesToHex(randomBytes(16)).slice(0, 16)
  const params = bytesToBase64(
    aesEncryptRaw(utf8Encode(bytesToBase64(aesEncryptRaw(utf8Encode(text), WY_PRESET_KEY, 'cbc', WY_IV))), secKey, 'cbc', WY_IV)
  )
  const encSecKey = rsaEncryptNetease(secKey, WY_PUBKEY, WY_MODULUS)
  return { params, encSecKey }
}

export function eapi(path, object, extraHeader = {}) {
  const header = {
    osver: '15.0',
    deviceId: 'unknown',
    appver: '9.1.28',
    versioncode: '140',
    mobilename: 'unknown',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    __csrf: '',
    os: 'android',
    channel: '',
    requestId: `${Date.now()}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`,
    ...extraHeader,
  }
  const text = JSON.stringify({ ...object, header })
  const message = `nobody${path}use${text}md5forencrypt`
  const digest = md5(message)
  const data = `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return bytesToHex(aesEncryptRaw(utf8Encode(data), EAPI_KEY, 'ecb')).toUpperCase()
}

export function eapiDecrypt(hexStr) {
  return utf8Decode(aesDecryptRaw(hexToBytes(hexStr), EAPI_KEY, 'ecb'))
}

/* ---------------- 酷狗签名 ---------------- */

const KG_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'

/** 酷狗接口 signature：md5(md5(sortedParams) + salt) */
export function kugouSignature(params) {
  const keys = Object.keys(params).sort()
  const str = keys.map(k => `${k}=${params[k]}`).join('')
  return md5(md5(str) + KG_SALT)
}
