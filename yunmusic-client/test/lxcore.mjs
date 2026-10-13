/**
 * 本地插件运行时产物验证 —— 校验 assets/web/lxcore.js 与 plugins.data.js。
 *
 * 为什么单独有这个脚本、而不是塞进 smoke.js：
 *   smoke.js 跑的是 index.html 的页面逻辑（jsdom 里没有 Worker、没有 Blob URL），
 *   验证不了「产物本身是不是好的」。而产物是 esbuild 打出来的，一旦
 *   crypto/util/lxworker 的源码引入了 esbuild 降级不了的新语法，构建会**静默**
 *   产出一个加载即报错的文件 —— 页面上的表现只是「本地插件打不开」，很容易被
 *   当成网络问题。所以这里用 node:vm 起一个隔离环境，把产物当普通脚本跑一遍。
 *
 * 两种模式：
 *   node test/lxcore.mjs          离线：只校验挂载、md5 向量、Worker 源码可解析、
 *                                 插件数据完整性（不发任何网络请求，CI 可跑）
 *   node test/lxcore.mjs --live   联网：再在隔离环境里真加载几个插件，看能不能
 *                                 声明 sources（会访问插件自己的接口，慢）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(__dirname, '..', 'assets', 'web')
const LIVE = process.argv.includes('--live')

/**
 * 插件内部对 lx.request 的失败回调常常没人接（`request(...).catch()` 写得敷衍），
 * 于是变成 unhandled rejection 把整个测试进程带走 —— 那样后面的用例一条都跑不到，
 * 看到的现象是「测到一半莫名退出」，会误以为是运行时坏了。
 * 这里统一吞掉：插件的网络失败本身不影响「运行时能不能加载插件」这个结论。
 */
process.on('unhandledRejection', () => {})

let pass = 0, fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  [' + extra + ']' : '')) }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }

const corePath = path.join(WEB_DIR, 'lxcore.js')
const dataPath = path.join(WEB_DIR, 'plugins.data.js')

console.log('== 本地插件运行时产物验证 ==')
ok(fs.existsSync(corePath), 'assets/web/lxcore.js 存在')
ok(fs.existsSync(dataPath), 'assets/web/plugins.data.js 存在')
if (!fs.existsSync(corePath) || !fs.existsSync(dataPath)) {
  console.log('\n产物缺失 —— 先跑 `node tools/build-client-lxcore.mjs`')
  process.exit(1)
}

const coreSrc = fs.readFileSync(corePath, 'utf8')
const dataSrc = fs.readFileSync(dataPath, 'utf8')

/* ---------------- 1. lxcore.js 在隔离环境里加载 ---------------- */

function makeSandbox(extra) {
  const box = {
    console: { log() {}, warn() {}, error() {} },
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, BigInt,
    Math, Date, JSON, Promise, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Object, Array, RegExp, Map, Set, WeakMap, setTimeout, clearTimeout,
    Blob, Response, URL, URLSearchParams, FormData,
    ...(extra || {}),
  }
  box.globalThis = box
  vm.createContext(box)
  return box
}

const win = {}
const box = makeSandbox({ window: win, self: win })
vm.runInContext(coreSrc, box, { filename: 'lxcore.js' })
const LX = win.LXCore

ok(!!LX, 'window.LXCore 已挂载')
if (!LX) { console.log(`\n${pass} 通过 / ${fail} 失败`); process.exit(1) }
ok(/^[0-9a-f]{16}$/.test(String(LX.SOURCE_DIGEST || '')), 'SOURCE_DIGEST 是 16 位 hex', LX.SOURCE_DIGEST)
ok(typeof LX.WORKER_SRC === 'string' && LX.WORKER_SRC.length > 5000, 'WORKER_SRC 是一段非空源码', String(LX.WORKER_SRC && LX.WORKER_SRC.length))

// MD5 标准测试向量 —— 光「有 md5 函数」不算数，得算对。
// 插件签名（酷狗 signature、网易 eapi 的 md5forencrypt）全靠它，算错就是静默取流失败。
eq(LX.crypto.md5(''), 'd41d8cd98f00b204e9800998ecf8427e', 'md5("") 对上标准向量')
eq(LX.crypto.md5('abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5("abc") 对上标准向量')
eq(LX.crypto.md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6', 'md5(长句) 对上标准向量')

// AES：ECB 模式对固定输入必须稳定；CBC 解密要能还原
{
  const key = LX.crypto.utf8Encode('e82ckenh8dichen8')
  const data = LX.crypto.utf8Encode('hello lxmusic')
  const enc1 = LX.crypto.aesEncryptRaw(data, key, 'ecb')
  const enc2 = LX.crypto.aesEncryptRaw(data, key, 'ecb')
  eq(Buffer.from(enc1).toString('hex'), Buffer.from(enc2).toString('hex'), 'AES-ECB 同一输入两次结果一致')
  eq(enc1.length % 16, 0, 'AES-ECB 输出按 16 字节对齐（PKCS7 填充生效）')
  const back = LX.crypto.utf8Decode(LX.crypto.aesDecryptRaw(enc1, key, 'ecb'))
  eq(back, 'hello lxmusic', 'AES-ECB 解密还原原文')
  const iv = LX.crypto.utf8Encode('0102030405060708')
  const cbc = LX.crypto.aesEncryptRaw(data, LX.crypto.utf8Encode('0CoJUm6Qyw8W8jud'), 'cbc', iv)
  eq(LX.crypto.utf8Decode(LX.crypto.aesDecryptRaw(cbc, LX.crypto.utf8Encode('0CoJUm6Qyw8W8jud'), 'cbc', iv)), 'hello lxmusic', 'AES-CBC 解密还原原文')
}
{
  const b = LX.crypto.bytesToBase64(LX.crypto.utf8Encode('云音乐'))
  eq(LX.crypto.utf8Decode(LX.crypto.base64ToBytes(b)), '云音乐', 'base64 编解码往返一致')
  eq(LX.crypto.bytesToHex(LX.crypto.hexToBytes('deadbeef')), 'deadbeef', 'hex 编解码往返一致')
}

// Buffer 垫片（6 个插件用它）
{
  const B = LX.util.createBufferShim()
  eq(B.from('68656c6c6f', 'hex').toString('utf8'), 'hello', 'ByteBuf.from(hex).toString(utf8)')
  eq(B.from('hello').toString('base64'), 'aGVsbG8=', 'ByteBuf.from(str).toString(base64)')
  eq(B.isBuffer(B.from('x')), true, 'ByteBuf.isBuffer 认自己的实例')
  eq(LX.util.bufToString(B.from('hi'), 'hex'), '6869', 'bufToString(buf, hex)')
}

/* ---------------- 2. Worker 源码必须是能解析的合法脚本 ---------------- */

{
  let err = null
  try { new vm.Script(LX.WORKER_SRC, { filename: 'lxworker.js' }) } catch (e) { err = e }
  ok(!err, 'WORKER_SRC 能被解析成合法脚本', err && err.message)
  ok(/postMessage\s*\(\s*\{\s*type:\s*['"]ready['"]/.test(LX.WORKER_SRC), 'WORKER_SRC 里有 ready 握手（否则主线程会一直等）')
  ok(LX.WORKER_SRC.indexOf('EVENT_NAMES') >= 0, 'WORKER_SRC 里有 EVENT_NAMES（LX 宿主协议已复刻）')
}

/* ---------------- 3. 插件数据 ---------------- */

const win2 = {}
const box2 = makeSandbox({ window: win2, self: win2 })
vm.runInContext(dataSrc, box2, { filename: 'plugins.data.js' })
const plugins = win2.LX_BUNDLED_PLUGINS

ok(Array.isArray(plugins), 'window.LX_BUNDLED_PLUGINS 是数组')
ok(plugins.length >= 20, `内置插件数量 ${plugins && plugins.length} 个`)
if (Array.isArray(plugins) && plugins.length) {
  const bad = plugins.filter(p => !p || !p.id || !p.script)
  eq(bad.length, 0, '每个插件都有 id 与 script')
  const ids = plugins.map(p => p.id)
  eq(new Set(ids).size, ids.length, '插件 id 不重复')
  // 按「协议符号」判定而不是按 `globalThis.lx` 这个写法：插件里解构、别名、
  // 甚至 `globalThis['lx']` 都有（实测 5 个不是直写），拿字面量去卡会误判。
  // EVENT_NAMES 是 LX 宿主协议里躲不掉的一个符号，只有重度混淆的 pdone-lx 没有。
  const hasProto = plugins.filter(p => /EVENT_NAMES/.test(p.script)).length
  ok(hasProto >= plugins.length - 2, `${hasProto}/${plugins.length} 个插件声明了 EVENT_NAMES（LX 宿主协议）`)
}

/* ---------------- 4. 真加载插件（--live） ---------------- */

if (LIVE && Array.isArray(plugins)) {
  console.log('\n-- 联网实测（--live）--')
  const picks = ['pdone-huibq', 'pdone-ikun', 'liuyun-nya', 'liuyun-yc', 'cloud-fuguang', 'wsl-quandou']

  function runWorker(plugin) {
    return new Promise((resolve) => {
      const wself = { postMessage: onMsg }
      const wbox = makeSandbox({ self: wself, window: undefined, fetch: globalThis.fetch })
      let timer = setTimeout(() => resolve({ timeout: true }), 15000)
      function onMsg(m) {
        const msg = m.data || m
        if (msg.type === 'ready') return
        if (msg.type === 'http') {
          // 真的发出去 —— 这样才叫「实测」。失败也要回，否则插件会一直等。
          const opt = msg.options || {}
          fetch(msg.url, { method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body })
            .then(r => r.text().then(text => {
              let body = text
              try { body = JSON.parse(text) } catch { /* 保留原文 */ }
              wself.onmessage({ data: { type: 'httpResponse', id: msg.id, result: { status: r.status, raw: text, body, headers: {} } } })
            }))
            .catch(e => wself.onmessage({ data: { type: 'httpResponse', id: msg.id, result: { error: String(e && e.message || e) } } }))
          return
        }
        if (msg.type === 'loaded') { clearTimeout(timer); resolve({ loaded: msg }); return }
        if (msg.type === 'error') { clearTimeout(timer); resolve({ error: msg }); return }
      }
      vm.runInContext(LX.WORKER_SRC, wbox, { filename: 'lxworker.js' })
      wself.onmessage({ data: { type: 'load', id: 'x', script: plugin.script, initTimeout: 8000 } })
    })
  }

  for (const id of picks) {
    const p = plugins.find(x => x.id === id)
    if (!p) continue
    const r = await runWorker(p)
    if (r.loaded) {
      const srcs = Object.keys(r.loaded.sources || {})
      ok(srcs.length > 0, `${id} 加载成功，声明 ${srcs.length} 个平台（${srcs.join(',')}）`)
    } else if (r.error) {
      // 联网环境下插件加载失败是正常的（源站挂了 / 出口不通），记下来但不判失败
      console.log(`  · ${id} 未加载：${r.error.error}`)
    } else {
      console.log(`  · ${id} 超时（在等远端配置）`)
    }
  }
} else if (!LIVE) {
  console.log('  （跳过联网实测；加 --live 可真实加载插件）')
}

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
