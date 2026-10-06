// Cloudflare Workers AI provider 端到端测试。
// 验证：cloudflare 协议走 /accounts/{id}/ai/run/{model} 端点、响应包一层 result 能正确解包、
// account_id 缺失时正确判定未配置、/ai-test 接口可用。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(__dirname, '..', 'public', 'js', 'backend.bundle.js')

globalThis.window = globalThis
globalThis.self = globalThis

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra === undefined ? '' : '→ ' + extra) }
}

// 内存 DB（settings 表按 k 过滤）
const store = new Map()
function table(n) { if (!store.has(n)) store.set(n, []); return store.get(n) }
const NodeDb = {
  prepare(sql) {
    const s = sql.trim().toUpperCase()
    const t = () => {
      if (s.includes('FROM SETTINGS')) return table('settings')
      if (s.includes('FROM USERS')) return table('users')
      return []
    }
    return {
      _args: [],
      bind(...a) { this._args = a; return this },
      async first() {
        const a = this._args
        if (s.includes('FROM SETTINGS') && a.length) return table('settings').find(r => r.k === a[0]) || null
        if (s.includes('FROM USERS') && a.length) return table('users').find(r => r.id === a[0] || r.username === a[0]) || null
        return t()[0] || null
      },
      async all() { return { results: t() } },
      async run() {
        const a = this._args
        if (s.includes('INSERT OR REPLACE INTO SETTINGS')) {
          const k = a[0], v = a[1]; const rows = table('settings')
          const i = rows.findIndex(r => r.k === k); if (i >= 0) rows[i] = { k, v }; else rows.push({ k, v })
        } else if (s.includes('INSERT INTO USERS')) {
          table('users').push({ id: a[0], username: a[1], password: a[2], is_admin: a[3], created_at: a[4] })
        }
        return { results: [] }
      },
      async batch() { return {} },
    }
  },
}

// mock 出网：按实际端点返回对应格式（ai/run → result 包裹；ai/v1/chat/completions → 标准 OpenAI）
let capturedUrl = ''
let capturedBody = null
let capturedAuth = ''
globalThis.__lxFetch = (url, opts) => {
  const u = String(url)
  capturedUrl = u
  capturedBody = opts.body ? JSON.parse(opts.body) : null
  capturedAuth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || ''
  const songs = JSON.stringify({
    title: 'CF测试歌单',
    songs: [{ name: '歌A', singer: '歌手A' }, { name: '歌B', singer: '歌手B' }],
  })
  if (u.includes('/ai/run/')) {
    // CF 原生端点：外层 result 包 choices
    return Promise.resolve(new Response(JSON.stringify({
      success: true,
      result: { choices: [{ message: { content: songs } }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  if (u.includes('/ai/v1/chat/completions')) {
    // CF OpenAI 兼容层：标准 OpenAI 结构，无 result 包裹
    return Promise.resolve(new Response(JSON.stringify({
      id: 'x', object: 'chat.completion',
      choices: [{ message: { content: songs } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  // 搜索等其它请求返回空
  return Promise.resolve(new Response(JSON.stringify({ list: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

eval(readFileSync(BUNDLE, 'utf8'))
const LB = globalThis.LXBackend

const env = {
  DB: NodeDb,
  PLUGIN_POOL: { summary: () => [], musicUrlPlugins: () => [], supports: () => false },
  SESSION_SECRET: 'test-secret',
}

async function main() {
  // setup 拿 admin token
  const r1 = new Request('https://t.local/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '1234' }) })
  const d1 = await (await LB.handleApi(r1, env, new URL(r1.url))).json()
  const token = d1.token
  const auth = (p, m, body) => new Request('https://t.local' + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })

  console.log('== 1. 保存 cloudflare 配置 ==')
  let r = await LB.handleApi(auth('/admin/ai-config', 'POST', { provider: 'cloudflare', model: '@cf/qwen/qwen3.8-27b', account_id: 'a4c5bc91293aa67de46a7067e07633da', api_key: 'cfut_test' }), env, new URL('https://t.local/api/admin/ai-config'))
  let d = await r.json()
  ok('保存返回 ok', d.ok === true, JSON.stringify(d))

  console.log('== 2. 读回配置 ==')
  r = await LB.handleApi(auth('/admin/ai-config', 'GET'), env, new URL('https://t.local/api/admin/ai-config'))
  d = await r.json()
  ok('provider=cloudflare', d.provider === 'cloudflare', d.provider)
  ok('protocol=cloudflare', d.protocol === 'cloudflare', d.protocol)
  ok('configured=true', d.configured === true, String(d.configured))
  ok('accountId 回传', d.accountId === 'a4c5bc91293aa67de46a7067e07633da', d.accountId)
  ok('hasKey=true', d.hasKey === true, String(d.hasKey))

  console.log('== 3. /ai-test 连通性测试 ==')
  r = await LB.handleApi(auth('/admin/ai-test', 'POST', {}), env, new URL('https://t.local/api/admin/ai-test'))
  d = await r.json()
  ok('ai-test 返回 ok', d.ok === true, JSON.stringify(d))
  ok('有回复内容', !!d.reply, d.reply)
  ok('有耗时', typeof d.latency === 'number', String(d.latency))
  ok('请求走 ai/run 端点', capturedUrl.includes('/ai/run/'), capturedUrl)
  ok('端点含 account_id', capturedUrl.includes('a4c5bc91293aa67de46a7067e07633da'), capturedUrl)
  ok('端点含模型名', capturedUrl.includes('@cf/qwen/qwen3.8-27b') || capturedUrl.includes('qwen3.8-27b'), capturedUrl)
  ok('带 Bearer 认证', capturedAuth.startsWith('Bearer '), capturedAuth)
  ok('请求体含 messages', capturedBody && Array.isArray(capturedBody.messages), JSON.stringify(capturedBody))

  console.log('== 4. /ai-playlist 走 CF 生成歌单 ==')
  // 搜索 mock 返回空 → 会走到「没有一首能搜到」，但 AI 侧已正确驱动
  // 先记录 AI 调用次数，避免被后续搜索请求覆盖 capturedUrl
  let aiRunCount = 0
  const origFetch = globalThis.__lxFetch
  globalThis.__lxFetch = (url, opts) => {
    if (String(url).includes('/ai/run/')) aiRunCount++
    return origFetch(url, opts)
  }
  r = await LB.handleApi(auth('/ai-playlist', 'POST', { prompt: 'CF 测试', count: 2 }), env, new URL('https://t.local/api/ai-playlist'))
  d = await r.json()
  ok('AI 被调用（走 ai/run）', aiRunCount === 1, String(aiRunCount))
  // 两阶段制：服务端只出 AI 列表，不做音源搜索（匹配由前端逐首完成）
  ok('服务端只返回 AI 列表（不做搜索）', d.ok === true && Array.isArray(d.songs) && d.songs.length === 2, JSON.stringify(d).slice(0, 200))

  console.log('== 5. 缺少 account_id 时判定未配置 ==')
  // 把 account_id 清空，仅保留 api_key + model，验证 configured 变 false
  await LB.handleApi(auth('/admin/ai-config', 'POST', { account_id: '' }), env, new URL('https://t.local/api/admin/ai-config'))
  r = await LB.handleApi(auth('/admin/ai-config', 'GET'), env, new URL('https://t.local/api/admin/ai-config'))
  d = await r.json()
  ok('清空 account_id → configured=false', d.configured === false, String(d.configured))

  console.log('== 6. 用户填 .../ai/v1 baseURL → 自动切 OpenAI 兼容层 ==')
  // 复现用户实际填法：baseURL 是 ai/v1 结尾（CF 的 OpenAI 兼容层地址）
  await LB.handleApi(auth('/admin/ai-config', 'POST', {
    account_id: 'a4c5bc91293aa67de46a7067e07633da',
    base_url: 'https://api.cloudflare.com/client/v4/accounts/a4c5bc91293aa67de46a7067e07633da/ai/v1',
  }), env, new URL('https://t.local/api/admin/ai-config'))
  r = await LB.handleApi(auth('/admin/ai-test', 'POST', {}), env, new URL('https://t.local/api/admin/ai-test'))
  d = await r.json()
  ok('ai-test 成功（不再 404）', d.ok === true, JSON.stringify(d).slice(0, 200))
  ok('走 /ai/v1/chat/completions', capturedUrl.endsWith('/ai/v1/chat/completions'), capturedUrl)
  ok('不再拼 run/ 路径', !capturedUrl.includes('/run/'), capturedUrl)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('测试异常：', e); process.exit(1) })
