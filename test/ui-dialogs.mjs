/**
 * 站内对话框与菜单去重 —— 真浏览器验收（需要本地服务在跑）。
 *
 * 为什么非要有这么一份「真点一遍」的测试：
 * 本轮把 app.js 里 9 处系统 prompt/confirm 换成了站内对话框。这类替换的
 * 典型故障不是报错，而是**静默失效**：
 *   · 忘了 await → 拿到 Promise 对象，`if (!name)` 恒为假，流程带着 [object Promise] 往下走；
 *   · 忘了 async → 语法/运行时才炸，静态看不出来；
 *   · 事件绑定写成每次叠加 → 开关几次之后一次点击触发多个回调。
 * 静态审计抓不住这些，只有真点一遍才知道。
 *
 * 跑法（先起服务）：
 *   LX_PORT=8791 node server/index.mjs
 *   LX_PASS='口令' node test/ui-dialogs.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.LX_BASE || 'http://127.0.0.1:8791'
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fails.push(name + (detail ? '  → ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

/* ---------- 登录 ---------- */
const lr = await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const token = (await lr.json()).token
if (!token) { console.error('❌ 登录失败，先确认本地服务在跑且账号存在'); process.exit(1) }

/* ---------- Chrome ---------- */
const PORT = 9500 + Math.floor(Math.random() * 300)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxd-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=<-loopback>', '--ignore-certificate-errors',
  '--window-size=390,844', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

let wsUrl = ''
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch { /* 还没起来 */ }
  await sleep(250)
}
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const pageErrors = []
const nativeDialogs = []          // 系统弹窗 —— 出现就说明还有漏网的 prompt/confirm
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 220))
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    nativeDialogs.push(m.params.type + ' · ' + String(m.params.message).slice(0, 80))
    send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
  }
}
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) } }, 45000)
  })
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}
async function waitFor(expr, { timeout = 15000, interval = 200 } = {}) {
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    try { last = await evaluate(expr) } catch { last = null }
    if (last) return last
    await sleep(interval)
  }
  return last
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('lx.token', ${JSON.stringify(JSON.stringify(token))}) } catch (e) {}`,
})

const open = async (hash) => {
  await send('Page.navigate', { url: BASE + '/?t=' + Date.now() + '#' + hash })
  await sleep(2200)
}

/* 歌单清单 —— 断言一律看「改动前后差了几条」，不写死绝对条数。
   写死 0 的话，只要账号里本来就有一张歌单（上一轮跑挂了没清掉、或老板自己建的）
   就会假红，而假红比漏测更糟：它会训练人忽略红色。 */
const PL_LIST_EXPR = `(async () => (await fetch('/api/playlists', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('lx.token')) } }).then(r => r.json())).list)()`
const plList = () => evaluate(PL_LIST_EXPR)

/* ================= 1. 新建歌单走的是站内对话框 ================= */

console.log('\n== 1. 我的歌单 → 新建：必须是站内对话框，不能是系统 prompt ==')
await open('/library')
ok('歌单页渲染出来了（标题栏有「新建」）',
  !!(await waitFor(`document.querySelector('[data-act="new-playlist"]') ? 1 : 0`)))

const before0 = (await plList() || []).length

await evaluate(`document.querySelector('[data-act="new-playlist"]').click(); true`)
const dlgOpen = await waitFor(`document.querySelector('#dialog.is-open') ? 1 : 0`)
ok('点「新建」弹出了站内对话框 #dialog', !!dlgOpen)
ok('对话框里有输入框', !!(await evaluate(`document.querySelector('#dialog #dlgInput') ? 1 : 0`)))
ok('对话框里有取消 / 确定两个按钮',
  (await evaluate(`document.querySelectorAll('#dialog [data-dialog]').length`)) === 2)
ok('页面里**没有**出现系统弹窗（那才会带网址）', nativeDialogs.length === 0, nativeDialogs.join(' | '))
ok('对话框标题是「新建歌单」',
  (await evaluate(`(document.querySelector('#dialogTitle')||{}).textContent||''`)).includes('新建歌单'))

/* 空名字不能建出来 */
await evaluate(`document.querySelector('#dlgInput').value = ''; document.querySelector('#dialog [data-dialog="ok"]').click(); true`)
await sleep(600)
const after0 = (await plList() || []).length
ok('名字留空时没有建出歌单', after0 === before0, before0 + ' → ' + after0 + ' 个')
ok('对话框已关闭', !(await evaluate(`document.querySelector('#dialog.is-open') ? 1 : 0`)))

/* 真建一个 */
const NAME = '验收歌单-' + Date.now().toString().slice(-6)
await evaluate(`document.querySelector('[data-act="new-playlist"]').click(); true`)
await waitFor(`document.querySelector('#dialog.is-open') ? 1 : 0`)
await evaluate(`document.querySelector('#dlgInput').value = ${JSON.stringify(NAME)}; document.querySelector('#dialog [data-dialog="ok"]').click(); true`)
await sleep(1200)
const listAfter = await evaluate(`(async () => (await fetch('/api/playlists', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('lx.token')) } }).then(r => r.json())).list)()`)
const made = (listAfter || []).find((p) => p.name === NAME)
ok('填名字后歌单建出来了', !!made, JSON.stringify((listAfter || []).map((p) => p.name)))
ok('并且只多出这一张', (listAfter || []).length === before0 + 1,
  before0 + ' → ' + (listAfter || []).length + ' 个')
ok('并且跳到了这张歌单的详情页', (await evaluate(`location.hash`)).includes('/playlist'), await evaluate(`location.hash`))

/* ================= 2. 取消 / 遮罩关闭都不能把 Promise 悬住 ================= */

console.log('\n== 2. 取消与遮罩关闭：不能留下悬着的 Promise ==')
await open('/mine')
await evaluate(`document.querySelector('[data-act="logout"]').click(); true`)
await waitFor(`document.querySelector('#dialog.is-open') ? 1 : 0`)
ok('退出登录弹的是站内确认框（不是系统 confirm）', nativeDialogs.length === 0, nativeDialogs.join(' | '))
await evaluate(`document.querySelector('#dialog [data-dialog="cancel"]').click(); true`)
await sleep(500)
ok('点「取消」对话框关掉了', !(await evaluate(`document.querySelector('#dialog.is-open') ? 1 : 0`)))
ok('取消后没有真的退出登录（还在我的页）',
  (await evaluate(`location.hash`)) === '#/mine' && !!(await evaluate(`document.querySelector('.menu-item') ? 1 : 0`)))

// 连开三次再关，检查事件监听没有叠加（叠加的话一次「确定」会触发多个回调）
for (let i = 0; i < 3; i++) {
  await evaluate(`document.querySelector('[data-act="logout"]').click(); true`)
  await waitFor(`document.querySelector('#dialog.is-open') ? 1 : 0`)
  await evaluate(`document.querySelector('#dialog [data-dialog="cancel"]').click(); true`)
  await sleep(350)
}
await evaluate(`document.querySelector('[data-act="logout"]').click(); true`)
await waitFor(`document.querySelector('#dialog.is-open') ? 1 : 0`)
await evaluate(`document.querySelector('#dialog [data-dialog="cancel"]').click(); true`)
await sleep(500)
ok('开关多次后仍然正常（监听没有叠加）',
  !(await evaluate(`document.querySelector('#dialog.is-open') ? 1 : 0`))
  && (await evaluate(`location.hash`)) === '#/mine')

/* ================= 3. 菜单去重 ================= */

console.log('\n== 3. 菜单去重 ==')
await open('/mine')
const mineItems = await evaluate(`[...document.querySelectorAll('#view .menu-item')].map(e => (e.getAttribute('href')||'') + '|' + (e.querySelector('.menu-item__text')||{}).textContent)`)
const hrefs = mineItems.map((x) => x.split('|')[0])
ok('「我的」里不再有与底部标签重复的 #/library', !hrefs.includes('#/library'), hrefs.join(' '))
ok('「我的」里不再有与底部标签重复的 #/favorite', !hrefs.includes('#/favorite'), hrefs.join(' '))
ok('「我的」里不再有 Subsonic 接入', !mineItems.join(' ').includes('Subsonic'), mineItems.join(' '))
ok('「我的」项数收敛到 7 以内', mineItems.length <= 7, mineItems.length + ' 项')

await open('/settings')
const srvLinks = await evaluate(`[...document.querySelectorAll('#view a')].filter(a => (a.getAttribute('href')||'').includes('/admin')).length`)
ok('设置页没有重复的管理后台链接', srvLinks === 0, srvLinks + ' 个')
const logoutBtns = await evaluate(`document.querySelectorAll('#view [data-act="logout"]').length`)
ok('设置页不再有重复的「退出登录」按钮', logoutBtns === 0, logoutBtns + ' 个')
const presetHidden = await evaluate(`(document.querySelector('#presetBox')||{}).hidden`)
ok('「常用音源一键导入」默认收起', presetHidden === true, String(presetHidden))
ok('设置页高度明显变短（列表墙没了）',
  (await evaluate(`document.querySelector('#view').scrollHeight`)) < 1500,
  (await evaluate(`document.querySelector('#view').scrollHeight`)) + 'px')

/* ================= 4. 关于页 + 管理端客户端接入 ================= */

console.log('\n== 4. Subsonic 接入信息的位置 ==')
await open('/about')
const aboutText = await evaluate(`document.querySelector('#view').textContent`)
ok('关于页不再展示服务器地址 / 端口 / Token 这些接入参数',
  !/认证方式|Token（|端口/.test(aboutText), aboutText.slice(0, 120))
ok('关于页有开源仓库链接', aboutText.includes('github.com/dszz453/lxmusic'))
ok('关于页有版本信息', /版本/.test(aboutText))

await open('')
await send('Page.navigate', { url: BASE + '/admin#connect' })
await sleep(3000)
const adminText = await evaluate(`document.body.textContent`)
ok('/admin 新增了「客户端接入」标签页', adminText.includes('客户端接入'))
ok('管理端里有服务器地址与认证方式说明',
  /服务器地址/.test(adminText) && /认证方式/.test(adminText))
ok('管理端里列出了已验证的客户端', /Feishin|substreamer/.test(adminText))

/* ================= 收尾 ================= */

console.log('\n== 5. 页面没有未捕获异常 ==')
ok('全程没有未捕获异常', pageErrors.length === 0, [...new Set(pageErrors)].join(' | ').slice(0, 300))
ok('全程没有系统弹窗（否则安卓里会露出网址）', nativeDialogs.length === 0, nativeDialogs.join(' | '))

/* 清理：把验收用的歌单删掉。
   注意端点是 **单数** `/api/playlist?id=`（列表才是复数 `/api/playlists`）——
   写错会回 404，而被 .catch(() => {}) 吃掉 → 你以为清理了，其实账号里越堆越多。
   所以这里**不吞错误**，删不掉就明说。 */
const delPlaylist = async (id) => {
  const r = await fetch(BASE + '/api/playlist?id=' + encodeURIComponent(id), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
  })
  return r.ok
}
if (made && made.id) {
  const gone = await delPlaylist(made.id).catch(() => false)
  console.log('\n' + (gone ? '（已清理验收歌单 ' + NAME + '）' : '⚠ 验收歌单没删掉（' + NAME + '），请手动清理'))
}

/* 顺带扫掉历史遗留：上一轮跑挂了/被中断时留下的验收歌单，会让下次
   「空名字不建歌单」这类断言看不出真假。名字前缀是我们专有的，删了不影响真数据。 */
const leftovers = (await plList() || []).filter((p) => /^验收歌单-/.test(p.name || ''))
for (const p of leftovers) await delPlaylist(p.id).catch(() => {})
if (leftovers.length) console.log('（顺带清掉 ' + leftovers.length + ' 张历史遗留验收歌单）')

console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of fails) console.log('  ✗ ' + f)
} else {
  console.log('全部 ' + pass + ' 项通过')
}

ws.close()
chrome.kill()
process.exit(fails.length ? 1 : 0)
