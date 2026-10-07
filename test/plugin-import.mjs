/**
 * 服务端「手动导入插件」验收 —— 自己起一台真服务，全链路跑一遍。
 *
 *   node test/plugin-import.mjs
 *
 * 为什么必须自己起服务：这个功能的核心验收点是**重启之后还在不在**，
 * 以及**导入一个坏脚本会不会把服务搞死** —— 两条都得能控制服务进程的生死。
 *
 * 还守着一个曾经把服务打死过的坑：
 *   内置插件里有几个是重度混淆的（自研字节码解释器），求值时**直接杀死 JS 引擎**
 *   （不抛异常、try/catch 无效）。实测 plugins/pdone-lx.js 就是。
 *   手动导入如果直接在主进程里求值，用户粘一个这样的地址进来就能把整个容器弄挂。
 *   所以先丢进子进程摸底 —— 这里的用例就是把那个脚本真的导一次，断言
 *   「回 400 + 服务还活着」。
 *
 * 用法：
 *   node test/plugin-import.mjs              离线用例（默认）
 *   LX_LIVE=1 node test/plugin-import.mjs    额外跑一条真网络的 URL 导入
 */
// ⚠️ 这一行必须是第一个 import：它置位 __LX_DEFER_PLUGIN_EVAL，
//    挡住 src/plugins.js 顶层求值内置插件（pdone-lx 会把主进程直接杀死）。
//    详见 test/_flags.mjs 里的说明。
import './_flags.mjs'

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mirrorCandidates } from '../src/server/plugin-import.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0, skip = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}
function skipped(name, why) { skip++; console.log('SKIP  ' + name + ' — ' + why) }

const PORT = 9600 + Math.floor(Math.random() * 300)
const BASE = 'http://127.0.0.1:' + PORT
const PW = 'TestPlugin2026x'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lxplgimp-'))

let child = null

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        LX_DATA_DIR: DATA,
        LX_PORT: String(PORT),
        LX_SESSION_SECRET: 'test-secret',
        LX_SCORE_INTERVAL: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error('服务退出：' + code + '\n' + out.slice(-800))) })
    const timer = setTimeout(() => reject(new Error('服务启动超时\n' + out.slice(-800))), 60000)
    const tick = async () => {
      try {
        const r = await fetch(BASE + '/api/version')
        if (r.ok) { clearTimeout(timer); return resolve() }
      } catch { /* 还没起来 */ }
      setTimeout(tick, 300)
    }
    tick()
  })
}

async function stopServer() {
  if (!child) return
  const c = child
  child = null
  c.kill('SIGKILL')
  await sleep(600)
}

let token = ''
async function call(method, p, body) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { status: res.status, data }
}

/* ---------------- 0. 纯函数：镜像改写规则 ---------------- */
console.log('== 0. GitHub 镜像改写规则 ==')
const rawUrl = 'https://raw.githubusercontent.com/a/b/main/c.js'
const cand = mirrorCandidates(rawUrl)
ok('raw 地址 → 镜像优先、原地址兜底，且不重复',
  cand[0] === 'https://ghfast.top/' + rawUrl && cand[cand.length - 1] === rawUrl && new Set(cand).size === cand.length,
  cand.join(' | '))
ok('blob 地址会先转成 raw',
  mirrorCandidates('https://github.com/a/b/blob/main/c.js')[0] === 'https://ghfast.top/' + rawUrl,
  mirrorCandidates('https://github.com/a/b/blob/main/c.js')[0])
ok('非 GitHub 地址不套镜像，只有它自己',
  JSON.stringify(mirrorCandidates('https://x.com/p.js')) === JSON.stringify(['https://x.com/p.js']),
  mirrorCandidates('https://x.com/p.js').join(' | '))

/* ---------------- 起服务 ---------------- */
try {
  await startServer()
} catch (e) {
  console.log('❌ 无法启动测试服务：' + e.message)
  process.exit(1)
}

let r = await call('POST', '/api/setup', { username: 'admin', password: PW })
ok('建管理员账号', r.status === 200, 'HTTP ' + r.status)
token = (r.data && r.data.token) || ''
ok('拿到 token', !!token)

const before = await call('GET', '/api/admin/plugins')
const baseCount = ((before.data || {}).list || []).length
ok('读取初始插件清单', baseCount > 5, baseCount + ' 个')

/* ---------------- 1. 粘贴脚本导入 ---------------- */
console.log('\n== 1. 粘贴脚本导入 ==')
const MINI = `/*!
 * @name 验收用测试音源
 * @version 9.9.9
 * @author workbuddy-test
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, async ({ source }) => 'https://example.invalid/' + source + '.mp3')
send(EVENT_NAMES.inited, { status: true, sources: { wy: { name: '测试', actions: ['musicUrl'], qualitys: ['128k'] } } })
`
r = await call('POST', '/api/admin/plugins/import', { script: MINI })
ok('粘贴脚本能导入（HTTP 200）', r.status === 200, 'HTTP ' + r.status + ' ' + JSON.stringify(r.data && r.data.error || ''))
const miniId = (r.data && r.data.plugin && r.data.plugin.id) || ''
ok('返回了插件 id / 名称 / 版本', !!miniId && r.data.plugin.name === '验收用测试音源' && r.data.plugin.version === '9.9.9',
  JSON.stringify(r.data && r.data.plugin))
ok('池子里多了一个 origin=user 的插件',
  ((r.data.list || []).filter(p => p.origin === 'user').length) === 1,
  'user 条目 ' + (r.data.list || []).filter(p => p.origin === 'user').map(p => p.id).join(','))

const list1 = await call('GET', '/api/admin/plugins')
ok('清单里带 origin 与 bytes',
  ((list1.data.list || []).find(p => p.id === miniId) || {}).origin === 'user'
  && ((list1.data.list || []).find(p => p.id === miniId) || {}).bytes > 100,
  JSON.stringify((list1.data.list || []).find(p => p.id === miniId)))

const scores = await call('GET', '/api/admin/plugin-scores')
ok('新插件进入了取流候选（wy）',
  (((scores.data || {}).live || {}).wy || []).includes(miniId),
  'wy 候选 ' + (((scores.data || {}).live || {}).wy || []).length + ' 个')

r = await call('POST', '/api/admin/plugins/import', { script: MINI })
ok('重复导入同一脚本 → 是「更新」不是「又加一个」',
  r.status === 200 && r.data.replaced === true
  && ((r.data.list || []).filter(p => p.origin === 'user').length) === 1,
  'replaced=' + (r.data && r.data.replaced))

/* ---------------- 2. 坏输入不能把服务搞死 ---------------- */
console.log('\n== 2. 坏输入 ==')
const killer = fs.readFileSync(path.join(ROOT, 'plugins', 'pdone-lx.js'), 'utf8')
r = await call('POST', '/api/admin/plugins/import', { script: killer })
ok('「求值即杀死引擎」的脚本被拒绝（400）', r.status === 400, 'HTTP ' + r.status + ' ' + JSON.stringify(r.data && r.data.error || ''))
ok('拒绝理由说清了是「会搞死引擎」', /引擎|不能加载/.test(String((r.data || {}).error || '')), String((r.data || {}).error || '').slice(0, 90))
let alive = false
try { alive = (await fetch(BASE + '/api/version')).ok } catch { alive = false }
ok('★ 拒绝之后服务还活着（这条是本次修复的核心）', alive)

r = await call('POST', '/api/admin/plugins/import', { script: 'console.log(1)' })
ok('内容不像插件（太短）→ 400', r.status === 400, 'HTTP ' + r.status + ' ' + JSON.stringify(r.data && r.data.error || ''))

r = await call('POST', '/api/admin/plugins/import', { url: 'http://192.168.31.1/x.js' })
ok('内网地址被 SSRF 防护挡住（403）', r.status === 403, 'HTTP ' + r.status)

r = await call('POST', '/api/admin/plugins/import', {})
ok('既没 URL 也没脚本 → 400', r.status === 400, 'HTTP ' + r.status)

const saveTok = token
token = ''
r = await call('POST', '/api/admin/plugins/import', { script: MINI })
ok('未登录 → 401（插件池是全局的，不能谁都能改）', r.status === 401, 'HTTP ' + r.status)
token = saveTok

/* ---------------- 3. 删除 ---------------- */
console.log('\n== 3. 删除 ==')
r = await call('DELETE', '/api/admin/plugins/import?id=' + encodeURIComponent('pdone-huibq'))
ok('内置插件不可删（提示改用「停用」）', r.status === 400 && /内置/.test(String((r.data || {}).error || '')),
  'HTTP ' + r.status + ' ' + String((r.data || {}).error || ''))

r = await call('DELETE', '/api/admin/plugins/import?id=' + encodeURIComponent(miniId))
ok('删掉用户导入的插件', r.status === 200 && r.data.removed === miniId, 'HTTP ' + r.status)

r = await call('DELETE', '/api/admin/plugins/import?id=' + encodeURIComponent(miniId))
ok('重复删除 → 找不到（404）', r.status === 404, 'HTTP ' + r.status)

const afterDel = await call('GET', '/api/admin/plugin-scores')
ok('删除后它不再出现在取流候选里',
  !((((afterDel.data || {}).live || {}).wy || []).includes(miniId)),
  'wy 候选 ' + (((afterDel.data || {}).live || {}).wy || []).length + ' 个')

/* ---------------- 4. 重启后仍然有效 ---------------- */
console.log('\n== 4. 重启持久化 ==')
await call('POST', '/api/admin/plugins/import', { script: MINI })
await stopServer()
await startServer()
token = ''
r = await call('POST', '/api/login', { username: 'admin', password: PW })
token = (r.data || {}).token || ''
const after = await call('GET', '/api/admin/plugins')
const found = (after.data.list || []).find(p => p.id === miniId)
ok('重启后用户导入的插件还在且已就绪', !!found && found.origin === 'user' && found.ok === true,
  JSON.stringify(found || {}))

/* ---------------- 5.（可选）真网络 URL 导入 ---------------- */
console.log('\n== 5. 真网络 URL 导入 ==')
if (process.env.LX_LIVE === '1') {
  r = await call('POST', '/api/admin/plugins/import', {
    url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  })
  ok('从 GitHub URL 导入（服务端自动走镜像）', r.status === 200 && !!r.data.from,
    'HTTP ' + r.status + ' from=' + (r.data && r.data.from) + ' ' + JSON.stringify(r.data && r.data.error || ''))
} else {
  skipped('从 GitHub URL 导入', '需要外网，加 LX_LIVE=1 才跑')
}

await stopServer()
try { fs.rmSync(DATA, { recursive: true, force: true }) } catch { /* 临时目录 */ }

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : '') + ' =====')
process.exit(fail ? 1 : 0)
