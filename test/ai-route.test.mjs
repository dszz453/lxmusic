// AI 歌单路由端到端测试：验证 /ai-config + /ai-playlist 编排逻辑。
// AI 出网 mock 掉，聚焦「配置读取 → AI 解析 → 返回歌名列表」链路。
// 匹配与落库由前端逐首调 /suggest + POST /playlist 完成（见 public/js/app.js pageAi）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(__dirname, '..', 'public', 'js', 'backend.bundle.js')

// 加载 bundle（IIFE，暴露 globalThis.LXBackend）
globalThis.window = globalThis
globalThis.self = globalThis

// 内存 DB（仅够 settings / playlists / playlist_songs 用）
const store = new Map()
function table(name) {
  if (!store.has(name)) store.set(name, [])
  return store.get(name)
}
const NodeDb = {
  prepare(sql) {
    const s = sql.trim().toUpperCase()
    const t = () => {
      if (s.includes('FROM SETTINGS')) return table('settings')
      if (s.includes('FROM PLAYLISTS')) return table('playlists')
      if (s.includes('FROM PLAYLIST_SONGS')) return table('playlist_songs')
      if (s.includes('FROM USERS')) return table('users')
      return []
    }
    const chain = {
      bind(...args) { this._args = args; return this },
      _args: [],
      async first() {
        // 按 WHERE k = ? 过滤（settings 表），否则按 id 匹配
        const a = this._args
        if (s.includes('FROM SETTINGS') && a.length) {
          return table('settings').find(r => r.k === a[0]) || null
        }
        if (s.includes('FROM USERS') && a.length) {
          return table('users').find(r => r.id === a[0] || r.username === a[0]) || null
        }
        return t()[0] || null
      },
      async all() { return { results: t() } },
      async run() {
        const args = this._args
        if (s.includes('INSERT OR REPLACE INTO SETTINGS')) {
          const k = args[0]; const v = args[1]
          const rows = table('settings'); const i = rows.findIndex(r => r.k === k)
          if (i >= 0) rows[i] = { k, v }; else rows.push({ k, v })
        } else if (s.includes('INSERT INTO USERS')) {
          table('users').push({ id: args[0], username: args[1], password: args[2], is_admin: args[3], created_at: args[4] })
        } else if (s.includes('INSERT INTO PLAYLISTS')) {
          table('playlists').push({ id: args[0], user_id: args[1], name: args[2], cover: args[3], source: args[4], source_id: args[5], created_at: args[6], updated_at: args[7] })
        } else if (s.includes('INSERT OR REPLACE INTO PLAYLIST_SONGS')) {
          table('playlist_songs').push({ playlist_id: args[0], position: args[1], song_id: args[2], song_json: args[3] })
        } else if (s.includes('SELECT COALESCE(MAX(POSITION)')) {
          // appendSongs 先查 max position；这里直接返回一个能算的占位
        }
        return { results: [] }
      },
      async batch() { return {} },
    }
    return chain
  },
}

// mock 出网：AI 请求返回假歌单；搜索请求返回一首假歌曲（验证命中链路）
let aiCallCount = 0
let searchCallCount = 0
let lastAiBody = null
let aiUrl = ''
globalThis.__lxFetch = (url, opts) => {
  const u = String(url)
  if (u.includes('/chat/completions')) {
    aiUrl = u
    aiCallCount++
    lastAiBody = JSON.parse(opts.body)
    const content = JSON.stringify({
      title: '测试AI歌单',
      songs: [
        { name: '歌A', singer: '歌手A' },
        { name: '歌B', singer: '歌手B' },
      ],
    })
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  // 音乐搜索接口 mock：每首歌都返回一个可用的结果
  searchCallCount++
  const song = {
    source: 'wy', id: '123', name: '歌A', singer: '歌手A', albumName: '专辑', albumId: '9',
    img: 'https://p2.music.126.net/x.jpg', interval: 200, types: [{ type: '320k' }],
  }
  return Promise.resolve(new Response(JSON.stringify({ list: [song], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

// 执行 bundle
const code = readFileSync(BUNDLE, 'utf8')
eval(code)
const LB = globalThis.LXBackend

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}

const env = {
  DB: NodeDb,
  PLUGIN_POOL: { summary: () => [], musicUrlPlugins: () => [], supports: () => false },
  SESSION_SECRET: 'test-secret',
  // 通过 env 提供 AI 配置（模拟 wrangler [vars]）
  AI_PROVIDER: 'qwen',
  AI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  AI_MODEL: 'qwen-plus',
  AI_API_KEY: 'sk-test-123',
}

async function call(path, method = 'GET', body) {
  const req = new Request('https://test.local/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await LB.handleApi(req, env, new URL(req.url))
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

// 需要先建一个管理员用户 + token
const setup = await call('/setup', 'POST', { username: 'admin', password: '1234' })
const token = setup.data.token
async function auth(path, method = 'GET', body) {
  const req = new Request('https://test.local/api' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await LB.handleApi(req, env, new URL(req.url))
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

console.log('== 1. /ai-config 读取 ==')
let r = await auth('/admin/ai-config')
ok('返回 configured=true', r.data.configured === true, JSON.stringify(r.data))
ok('provider=qwen', r.data.provider === 'qwen')
ok('model=qwen-plus', r.data.model === 'qwen-plus')
ok('hasKey 脱敏（不返回明文）', r.data.hasKey === true && r.data.apiKey === undefined)
ok('providers 含千问 / OpenAI / Gemini', Array.isArray(r.data.providers) && r.data.providers.some(p => p.key === 'qwen') && r.data.providers.some(p => p.key === 'openai') && r.data.providers.some(p => p.key === 'gemini'))

console.log('== 2. /ai-config 保存 ==')
r = await auth('/admin/ai-config', 'POST', { provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-new' })
ok('保存返回 ok', r.data.ok === true, JSON.stringify(r.data))
r = await auth('/admin/ai-config')
ok('保存后 provider=openai', r.data.provider === 'openai', r.data.provider)
ok('保存后 model 生效', r.data.model === 'gpt-4o-mini', r.data.model)

console.log('== 3. /ai-playlist 编排（两阶段制：服务端只出 AI 列表，匹配由前端逐首完成） ==')
// 第 2 组已把 provider 改成 openai + gpt-4o-mini，所以这里 AI 请求应带 gpt-4o-mini
r = await auth('/ai-playlist', 'POST', { prompt: '深夜开车', count: 2 })
ok('AI 被调用', aiCallCount === 1, String(aiCallCount))
ok('AI 请求携带 model（第2组已改为 gpt-4o-mini）', lastAiBody && lastAiBody.model === 'gpt-4o-mini', lastAiBody && lastAiBody.model)
ok('AI 请求 messages 含用户 prompt', lastAiBody && Array.isArray(lastAiBody.messages) && lastAiBody.messages.some(m => m.role === 'user' && m.content.includes('深夜开车')), JSON.stringify(lastAiBody && lastAiBody.messages))
ok('AI 请求 URL 指向 OpenAI（api.openai.com）', aiUrl.includes('api.openai.com'), aiUrl)

console.log('== 4. 响应只含 AI 列表，服务端不做音源搜索 ==')
ok('返回 ok', r.data.ok === true, JSON.stringify(r.data).slice(0, 200))
ok('返回 AI 歌单标题', r.data.title === '测试AI歌单', r.data.title)
ok('返回歌名列表（2 首）', Array.isArray(r.data.songs) && r.data.songs.length === 2, JSON.stringify(r.data.songs))
ok('歌名字段为 {name, singer}', r.data.songs && r.data.songs[0] && r.data.songs[0].name === '歌A' && r.data.songs[0].singer === '歌手A', JSON.stringify(r.data.songs && r.data.songs[0]))
ok('服务端不做音源搜索（searchCallCount=0，匹配在前端）', searchCallCount === 0, String(searchCallCount))

console.log('== 5. 未配置 AI 时明确报错（全新 env，无 D1 残留）==')
// 用全新的 DB 与 env 模拟「完全没配置」的冷启动，验证错误提示。
// 需要在新 DB 里重新 setup 才能拿到有效 token。
const store2 = new Map()
function table2(n) { if (!store2.has(n)) store2.set(n, []); return store2.get(n) }
const NodeDb2 = { prepare(sql) { const s = sql.trim().toUpperCase(); const t = () => { if (s.includes('FROM USERS')) return table2('users'); if (s.includes('FROM SETTINGS')) return table2('settings'); return [] }; const c = { _args: [], bind(...a) { this._args = a; return this }, first() { const a = this._args; if (s.includes('FROM USERS') && a.length) return table2('users').find(r => r.id === a[0] || r.username === a[0]) || null; return null }, all() { return { results: t() } }, run() { const a = this._args; if (s.includes('INSERT INTO USERS')) table2('users').push({ id: a[0], username: a[1], password: a[2], is_admin: a[3], created_at: a[4] }); return { results: [] } }, batch() { return {} } }; return c } }
const env2 = { DB: NodeDb2, PLUGIN_POOL: { summary: () => [], musicUrlPlugins: () => [], supports: () => false }, SESSION_SECRET: 'test-secret' }
const setup2Req = new Request('https://test.local/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '1234' }) })
const setup2 = await LB.handleApi(setup2Req, env2, new URL(setup2Req.url))
const token2 = (await setup2.json()).token
const req2 = new Request('https://test.local/api/ai-playlist', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token2 },
  body: JSON.stringify({ prompt: '测试', count: 5 }),
})
const res2 = await LB.handleApi(req2, env2, new URL(req2.url))
const d2 = await res2.json()
ok('未配置报错 500', res2.status === 500, String(res2.status))
ok('错误信息含「未配置」', /未配置/.test(d2.error || ''), d2.error)

console.log('== 6. 切到 Gemini：走 Google 兼容层，且不发 response_format ==')
// 模拟管理后台的点选行为：切 provider 时 base_url / model 会一起被预设填上再保存
// （admin.js 的 applyPreset）。只改 provider 而留着旧 base_url 是无效的 ——
// loadAiConfig 里 DB 的值优先于 provider 预设。
r = await auth('/admin/ai-config', 'POST', {
  provider: 'gemini',
  base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-2.5-flash',
})
ok('保存 gemini 配置成功', r.data.ok === true, JSON.stringify(r.data))
r = await auth('/admin/ai-config')
ok('provider=gemini、protocol 仍是 openai（兼容层与 OpenAI 同形，不另写协议）',
  r.data.provider === 'gemini' && r.data.protocol === 'openai', JSON.stringify(r.data))

aiUrl = ''; lastAiBody = null
r = await auth('/ai-playlist', 'POST', { prompt: '深夜开车', count: 2 })
ok('请求打到 generativelanguage.googleapis.com 的兼容层',
  /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/.test(aiUrl), aiUrl)
ok('带上了 Gemini 模型名', lastAiBody && lastAiBody.model === 'gemini-2.5-flash', lastAiBody && lastAiBody.model)
/**
 * 这条是本轮的兼容性要害：Gemini 兼容层支持的是 **JSON Schema 变体**，
 * 对 OpenAI 的 `{"type":"json_object"}` 不作保证 —— 发过去有吃 400 的风险。
 * 所以 provider 上关掉 jsonMode，改靠 system prompt + parsePlaylist 的三级兜底解析。
 */
ok('⚠ 不发 response_format（Gemini 只保证 JSON Schema 变体）',
  lastAiBody && lastAiBody.response_format === undefined, JSON.stringify(lastAiBody && lastAiBody.response_format))
ok('仍能解析出歌单（没有 response_format 也不影响这条链路）',
  r.data.ok === true && Array.isArray(r.data.songs) && r.data.songs.length === 2, JSON.stringify(r.data).slice(0, 160))

console.log('== 7. 结构护栏：Gemini 接线 + 三层超时对齐 ==')
const AISRC = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ai.js'), 'utf8')
const APISRC = readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8')
ok('gemini 的 baseURL 指向 Google 官方 OpenAI 兼容层',
  /gemini:\s*\{[\s\S]{0,400}?generativelanguage\.googleapis\.com\/v1beta\/openai/.test(AISRC))
ok('⚠ gemini 的 jsonMode = false（否则会带上兼容层不保证的 json_object）',
  /gemini:\s*\{[\s\S]{0,1600}?jsonMode:\s*false/.test(AISRC))
ok('能力位默认「能吃」，只有显式 false 才关',
  /jsonMode:\s*base\.jsonMode !== false/.test(AISRC))
ok('buildAiRequest 把能力位接进了 json_mode 判断',
  /extra\.json_mode && cfg\.jsonMode !== false/.test(AISRC))
/**
 * AI 生成歌单偶发超时（2026-10-09 老板报障）的根因是三层超时错配：
 * 服务端肯等 180s，而网页端只有 40s、壳内桥只有 30s —— 慢过 30~40s 必被掐断。
 * 下面几条把「谁该比谁晚」钉住，改任何一层都要回来看这张表。
 */
ok('api.js 给 AI 单独一条长超时，不用默认的 40s',
  /const AI_TIMEOUT = 200000/.test(APISRC))
ok('generatePlaylist 真的用上了 AI_TIMEOUT（否则常量是摆设）',
  /generatePlaylist:\s*\(prompt, count\) => post\('\/ai-playlist', \{ prompt, count \}, \{ timeout: AI_TIMEOUT \}\)/.test(APISRC))
ok('req 把页面侧超时透给壳内的桥（少了它，AI 在 APP 里仍被 30s 掐断）',
  /lxTimeout:\s*ms/.test(APISRC))
/**
 * 90 这个数同时被两堵墙夹着：
 *   · 上前端 —— 必须小于 api.js 的 AI_TIMEOUT（200s），否则服务端还在算、前端已掐断；
 *   · 上网关 —— 必须小于「Docker 挂 Cloudflare 代理」时 CF 到源站的 100s 硬超时，
 *     否则用户看到的是一句没头没尾的 524，而不是「AI 慢，可减少歌曲数量」。
 * 老板补报「docker 也存在 AI 生成超时」后才收到 90 —— 别随手调大。
 */
ok('服务端 AI 上限 90s：既小于前端 200s，也小于 CF 代理到源站的 100s 硬超时',
  /Math\.min\(90000, Math\.max\(60000, n \* 4000\)\)/.test(AISRC))

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
