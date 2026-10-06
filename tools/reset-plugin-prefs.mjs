/**
 * 线上插件调度的检查 / 复原小工具。
 *
 * 为什么需要它：验收脚本里有一组「人工排序 / 停用」的用例，它们在线上**真的会改数据**。
 * 用例失败时（这一组本来就偶发不稳），停用状态会留在线上，影响所有人 —— 跑完必须确认干净。
 *
 * 用法（走 IPv6 边缘，沙箱里 IPv4 到 CF 不通）：
 *   LX_PASS=密码 node tools/reset-plugin-prefs.mjs          # 只看
 *   LX_PASS=密码 node tools/reset-plugin-prefs.mjs --fix    # 复位成 全自动 + 不停用
 */
import https from 'node:https'

const PASS = process.env.LX_PASS || ''
const CF_IP = '2606:4700:3030::6815:ada'
const HOST = 'music.zyplnn.dpdns.org'
const FIX = process.argv.includes('--fix')

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const headers = { Host: HOST }
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload) }
    if (token) headers.Authorization = 'Bearer ' + token
    const r = https.request({ host: CF_IP, family: 6, servername: HOST, port: 443, path, method, headers }, (res) => {
      let s = ''
      res.on('data', d => { s += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(s) }) } catch { resolve({ status: res.statusCode, json: null, raw: s.slice(0, 200) }) }
      })
    })
    r.on('error', reject)
    r.setTimeout(25000, () => r.destroy(new Error('超时')))
    if (payload) r.write(payload)
    r.end()
  })
}

if (!PASS) { console.error('缺 LX_PASS'); process.exit(1) }

const login = await req('POST', '/api/login', { username: process.env.LX_USER || 'admin', password: PASS })
const token = login.json && login.json.token
if (!token) { console.error('登录失败:', login.status, JSON.stringify(login.json)); process.exit(1) }

const cur = await req('GET', '/api/admin/plugin-prefs', null, token)
const prefs = (cur.json && cur.json.prefs) || {}
console.log('mode      =', prefs.mode)
console.log('disabled  =', JSON.stringify(prefs.disabled || []))
console.log('order 平台 =', Object.keys(prefs.order || {}).join(',') || '（无）')

const dirty = (prefs.disabled || []).length > 0 || prefs.mode !== 'auto'
if (!dirty) { console.log('✅ 状态干净（全自动、无停用），不需要处理'); process.exit(0) }

if (!FIX) { console.log('⚠️  有残留在线上（加 --fix 才会改）'); process.exit(0) }

const r = await req('POST', '/api/admin/plugin-prefs', { mode: 'auto', disabled: [], order: prefs.order || {} }, token)
console.log('复原 ->', r.status, JSON.stringify(r.json).slice(0, 200))
const after = await req('GET', '/api/admin/plugin-prefs', null, token)
const p2 = (after.json && after.json.prefs) || {}
console.log('复核 mode =', p2.mode, '| disabled =', JSON.stringify(p2.disabled || []))
console.log((p2.mode === 'auto' && !(p2.disabled || []).length) ? '✅ 已复原' : '❌ 复原没生效')
