// 对照 Node 内置 crypto 验证自研加密实现
import crypto from 'node:crypto'
import {
  md5, aesEncryptRaw, aesDecryptRaw, bytesToHex, hexToBytes, base64ToBytes, bytesToBase64,
  weapi, eapi, rsaEncryptNetease, rsaEncryptRaw,
} from '../src/lib/crypto.js'

const WYMOD = 'e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      got=${String(actual).slice(0, 120)}\n      exp=${String(expected).slice(0, 120)}`)
}

/* ---- MD5 ---- */
const md5cases = [
  '', 'abc', 'hello world',
  'The quick brown fox jumps over the lazy dog',
  'a'.repeat(1000),
  '中文测试🔥',
  JSON.stringify({ keyword: '周杰伦', offset: 0, limit: 30 }),
]
for (const c of md5cases) {
  check(`md5(${JSON.stringify(c).slice(0, 36)})`, md5(c), crypto.createHash('md5').update(c, 'utf8').digest('hex'))
}

/* ---- AES ---- */
function nodeAesEnc(data, key, mode, iv) {
  const cipher = mode === 'cbc' ? crypto.createCipheriv('aes-128-cbc', key, iv) : crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('hex')
}

const k1 = '0CoJUm6Qyw8W8jud', iv1 = '0102030405060708'
const k2 = 'e82ckenh8dichen8'
for (const plain of ['', 'a', '1234567890123456', 'hello 中文 world 12345', 'x'.repeat(200)]) {
  check(`AES-CBC enc len=${plain.length}`,
    bytesToHex(aesEncryptRaw(new TextEncoder().encode(plain), k1, 'cbc', iv1)),
    nodeAesEnc(Buffer.from(plain, 'utf8'), k1, 'cbc', iv1))
  const ecb = bytesToHex(aesEncryptRaw(new TextEncoder().encode(plain), k2, 'ecb'))
  check(`AES-ECB enc len=${plain.length}`, ecb, nodeAesEnc(Buffer.from(plain, 'utf8'), k2, 'ecb', null))
  check(`AES-ECB roundtrip len=${plain.length}`, new TextDecoder().decode(aesDecryptRaw(hexToBytes(ecb), k2, 'ecb')), plain)
}

/* ---- AES-256 ---- */
const k256 = '0123456789abcdef0123456789abcdef'
const c256 = crypto.createCipheriv('aes-256-ecb', k256, null)
check('AES-256-ECB',
  bytesToHex(aesEncryptRaw(new TextEncoder().encode('test message'), k256, 'ecb')),
  Buffer.concat([c256.update(Buffer.from('test message')), c256.final()]).toString('hex'))

/* ---- base64 ---- */
const raw = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 64, 32])
check('base64 roundtrip', bytesToHex(base64ToBytes(bytesToBase64(raw))), bytesToHex(raw))
check('base64 vs node', bytesToBase64(raw), Buffer.from(raw).toString('base64'))

/* ---- weapi 结构 ---- */
const payload = { s: '周杰伦', type: 1, limit: 30, offset: 0 }
const { params, encSecKey } = weapi(payload)
check('weapi params 可 base64 解码且为 16 倍数', base64ToBytes(params).length % 16, 0)
check('weapi encSecKey 长度(hex 256=1024bit)', encSecKey.length, 256)
console.log('      params 前 64:', params.slice(0, 64))
console.log('      encSecKey 前 64:', encSecKey.slice(0, 64))

/* ---- eapi 结构 ---- */
const e = eapi('/api/search/song/list/page', { keyword: 'test', limit: 10 })
check('eapi 为大写 hex', /^[0-9A-F]+$/.test(e), true)
check('eapi 长度为 32 倍数', e.length % 32, 0)

/* ---- RSA PKCS#1 v1.5 ---- */
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
const pem = publicKey.export({ type: 'spki', format: 'pem' })
const cipherText = Buffer.from(rsaEncryptRaw(new TextEncoder().encode('secret123'), pem))
const dec = crypto.privateDecrypt(
  { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
  cipherText
).toString()
check('RSA PKCS1 往返（对标 Node publicEncrypt）', dec, 'secret123')
// 同时也对齐 Node 自己的 publicEncrypt，确保与 lx.utils.crypto.rsaEncrypt 行为一致
const nodeCipher = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from('secret123'))
check('RSA 密文长度与 Node 一致', cipherText.length, nodeCipher.length)
check('RSA 密文可被 Node 解密',
  crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, nodeCipher).toString(), 'secret123')

/* ---- 网易 encSecKey ---- */
check('netease encSecKey 长度', rsaEncryptNetease('0123456789abcdef', '010001', WYMOD).length, 256)

/* ---- 酷狗签名格式 ---- */
import { kugouSignature } from '../src/lib/crypto.js'
const sig = kugouSignature({ a: '1', b: '2' })
check('kugou signature 为 md5', /^[0-9a-f]{32}$/.test(sig), true)

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
