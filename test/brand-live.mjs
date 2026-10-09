/**
 * 客户端品牌名 —— 真浏览器实测
 *
 * 与 test/brand.test.mjs 的分工：
 *   · brand.test.mjs 查**源码接线**（文件有没有引、顺序对不对、服务端有没有声明）；
 *   · 本文件查**运行时真实结果** —— 真的开一个无头 Chrome 打开页面，
 *     读 document.title 与合成出来的 manifest，看到底显示的是哪个名字。
 *
 * 为什么非要真开浏览器：品牌名是「判定 + DOM 改写 + 时序」三件事的结果，
 * 任何一环错了（判据读早了、接口没接上、manifest 没换成 Blob）静态检查都看不出来。
 * 本项目的教训是「接线对不对」和「跑起来对不对」是两回事。
 *
 * 用法（需先起一个服务）：
 *   LX_BASE=http://127.0.0.1:8795 node test/brand-live.mjs
 *
 * 断言的是**期望值**，不是「等于 Docker 那个」——
 * 同一个脚本既能验 Docker 也能验 CF，靠 LX_EXPECT 指定：
 *   Docker：LX_BASE=http://127.0.0.1:8795 LX_EXPECT=LX-MUSIC node test/brand-live.mjs
 *   CF    ：LX_BASE=https://<你的站点域名> LX_EXPECT=music-edge node test/brand-live.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const BASE = process.env.LX_BASE || 'http://127.0.0.1:8795'
const EXPECT = process.env.LX_EXPECT || 'LX-MUSIC'
const CHROME = process.env.CHROME || findChrome()

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ]
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ } }
  return 'chrome'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}

const PORT = 9900 + Math.floor(Math.random() * 90)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxbrand-'))
/**
 * 额外的 Chrome 启动参数（用 @@ 分隔多条，LX_CHROME_EXTRA 传入）。
 *
 * 为什么用 @@ 而不是空格：有的参数值本身就带空格（host-resolver-rules 的
 * 「MAP 域名 [IP]」），按空格切会把一条参数拆成三段。
 *
 * 为什么需要：测 localhost 时要 --no-proxy-server（直连本机）；
 * 测 CF 线上时沙箱 IPv4 到 Cloudflare 不通，得靠 host-resolver-rules
 * 把域名钉到已知可达的边缘 IPv6 上，例如：
 *   LX_CHROME_EXTRA='--host-resolver-rules=MAP <你的站点域名> [2606:4700:3030::6815:ada]'
 */
const EXTRA = (process.env.LX_CHROME_EXTRA || '').split('@@').map((s) => s.trim()).filter(Boolean)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  '--window-size=390,844', 'about:blank',
  ...EXTRA,
], { stdio: 'ignore' })

let wsUrl = ''
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (p) wsUrl = p.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) { console.log('❌ Chrome 未就绪'); chrome.kill(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
  return r.result.value
}
function bail(msg) { console.log('\n' + msg); ws.close(); chrome.kill(); process.exit(1) }

console.log(`=== 品牌实测：BASE=${BASE} 期望=${EXPECT} ===\n`)

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: BASE + '/' })
await sleep(2500)

// 1) brand.js 是否真的跑起来了
const hasBrand = await ev('typeof window.LXBrand === "object" && !!window.LXBrand')
ok('页面里存在 window.LXBrand', hasBrand === true)
if (!hasBrand) bail('❌ brand.js 没加载 —— 后面的断言都没意义')

// 2) 首屏同步判据给出的名字
const early = await ev('window.LXBrand.name')
ok('LXBrand.name 是个非空字符串', typeof early === 'string' && early.length > 0, '实际: ' + early)

// 3) 等 /api/version 回来纠正（boot() 里的 bindBrand）
await sleep(3000)
const hostKind = await ev('window.LXBrand.host')
const finalName = await ev('window.LXBrand.name')
const resolved = await ev('window.LXBrand.resolved')

// 关键断言：resolved 为真 = 服务端确认过了，而不是停在兜底猜测上。
// 若为假，说明 /api/version 没回 host、或 bindBrand 没接上
ok('品牌已由服务端确认（不是停在兜底猜测）', resolved === true, 'resolved=' + resolved)
ok('LXBrand.host 与服务器类型一致', hostKind === (EXPECT === 'LX-MUSIC' ? 'docker' : 'cf'), '实际: ' + hostKind)
ok(`显示名是 ${EXPECT}`, finalName === EXPECT, '实际: ' + finalName)

// 4) document.title 是否跟着改了
const title = await ev('document.title')
ok(`document.title 含 ${EXPECT}`, String(title).includes(EXPECT), '实际: ' + title)

// 5) apple 短名 meta
const appleTitle = await ev('(document.querySelector(\'meta[name="apple-mobile-web-app-title"]\')||{}).content || ""')
ok(`apple-mobile-web-app-title 是 ${EXPECT}`, appleTitle === EXPECT, '实际: ' + appleTitle)

// 6) 合成出来的 manifest 名字对不对（这是「装到桌面显示什么」的最终依据）
const man = await ev(`(async () => {
  const link = document.querySelector('link[rel="manifest"]')
  if (!link) return { err: 'no link' }
  const href = link.getAttribute('href')
  if (!href.startsWith('blob:')) return { err: 'link 没被换成 blob（manifest 未合成）', href }
  const r = await fetch(href)
  const j = await r.json()
  return { name: j.name, short: j.short_name, id: j.id, icons: (j.icons||[]).length, start: j.start_url }
})()`)
if (man && man.err) {
  ok('manifest 已被合成（名字随宿主变）', false, man.err + (man.href ? ' href=' + man.href : ''))
} else {
  ok('manifest 已被合成（名字随宿主变）', true)
  ok(`manifest.name 含 ${EXPECT}`, String(man.name).includes(EXPECT), '实际: ' + man.name)
  ok(`manifest.short_name 是 ${EXPECT}`, man.short === EXPECT, '实际: ' + man.short)
  ok('manifest.id 按宿主区分（两客户端可并存）',
    man.id === (EXPECT === 'LX-MUSIC' ? '/docker/' : '/cf/'), '实际: ' + man.id)
  // 图标、start_url 这些必须透传 —— 合成时漏掉会让 PWA 装不上或启动页错
  ok('manifest 的图标没在合成时丢掉', man.icons >= 4, 'icons=' + man.icons)
  ok('manifest 的 start_url 透传了', man.start === '/#/', '实际: ' + man.start)
}

console.log('\n' + '='.repeat(46))
console.log(fail ? `失败 ${fail} 项 / 通过 ${pass} 项` : `全部 ${pass} 项通过`)
ws.close()
chrome.kill()
try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* Windows 下可能还占着，无所谓 */ }
process.exit(fail ? 1 : 0)
