/**
 * AI 歌单生成模块
 *
 * 用大模型把「一句话/关键字」理解成一份歌单（歌名 + 歌手），再交给调用方逐首搜索落库。
 * 只做「意图 → 歌名列表」这一步，不生成歌曲 ID（AI 编的 ID 不可信，播放链路靠搜索兜底）。
 *
 * 支持四类提供商，按 protocol 区分请求格式：
 *   · openai —— OpenAI 官方 / 自建 OpenAI 兼容网关（/chat/completions）
 *   · qwen   —— 阿里云百炼（DashScope 兼容模式，同样是 /chat/completions）
 *   · gemini —— Google Gemini（走官方 OpenAI 兼容层，仍是 /chat/completions；
 *     见下方 jsonMode 注释：兼容层对 response_format 的支持与 OpenAI 不同）
 *   · cloudflare —— Cloudflare Workers AI（REST 端点 /accounts/{id}/ai/run/{model}，
 *     响应包一层 result；account_id 需要额外配置）
 */

import { outboundFetch } from '../lib/http.js'

/** 默认提供商。protocol: 'openai' 走 /chat/completions；'cloudflare' 走 Workers AI REST */
export const AI_PROVIDERS = {
  qwen: {
    key: 'qwen',
    name: '通义千问（阿里云百炼）',
    protocol: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  openai: {
    key: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  gemini: {
    key: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    // 官方 OpenAI 兼容层（2026 起稳定提供）：路径与 Bearer 鉴权都与 OpenAI 一致，
    // 所以 protocol 仍是 'openai'，只是把地址换掉 —— 不需要另写一套协议。
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // 默认用 flash：生成歌单是「输出一长串 JSON」，要的是快与稳，不是推理深度。
    // 想换：gemini-2.5-pro（更聪明更慢）/ gemini-3.5-flash（更新的一代）。
    model: 'gemini-2.5-flash',
    /**
     * ⚠ 不向 Gemini 发 `response_format`。
     *
     * OpenAI 的 `{"type":"json_object"}` 是「随便给我个 JSON」；Gemini 兼容层支持的是
     * **JSON Schema 变体**（`{"type":"json_schema", ...}`），对前者的行为不作保证 ——
     * 发过去有吃到 400 的风险，而这里本来就有两道兜底（system prompt 明令只输出 JSON
     * + parsePlaylist 的「去 ``` 围栏 / 正则抠 {…} / 行文本」三级解析），
     * 不值得为一个可选字段赌一次失败。其余字段（model / messages / temperature /
     * max_tokens）兼容层都按 OpenAI 语义支持。
     */
    jsonMode: false,
  },
  cloudflare: {
    key: 'cloudflare',
    name: 'Cloudflare Workers AI',
    protocol: 'cloudflare',
    // 空 baseURL：CF 端点按 account_id 拼，见 buildAiRequest；用户可在后台覆盖
    baseURL: '',
    model: '@cf/qwen/qwen3.8-27b',
  },
}

/**
 * 读取 AI 配置。取值优先级：
 *   · D1 settings（后台保存的值）最高
 *   · provider 内置默认（千问→dashscope，openai→api.openai.com）
 *   · env 变量兜底（仅 apiKey / provider 这种没有「按 provider 区分」语义的字段）
 * 关键：baseURL / model 严格跟随 provider 的内置默认，不读 env 的全局覆盖 ——
 * 否则「切 provider 却没改 baseURL」时，全局默认会把 openai 错配到 dashscope。
 */
export async function loadAiConfig(env, db) {
  const fromDb = async (k) => {
    if (!db) return null
    const v = await db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first()
    return v && v.v ? v.v : null
  }
  const fromEnv = (envKey, def) => (env && env[envKey] != null && env[envKey] !== '' ? String(env[envKey]) : def)

  const provider = ((await fromDb('ai.provider')) || fromEnv('AI_PROVIDER', 'qwen')).trim()
  const base = AI_PROVIDERS[provider] || { key: provider, protocol: 'openai', baseURL: '', model: '', name: provider }

  let baseURL = ((await fromDb('ai.base_url')) || base.baseURL || '').trim()
  let model = ((await fromDb('ai.model')) || base.model || '').trim()
  const apiKey = ((await fromDb('ai.api_key')) || fromEnv('AI_API_KEY', '')).trim()
  const accountId = ((await fromDb('ai.account_id')) || fromEnv('AI_ACCOUNT_ID', '')).trim()

  // CF Workers AI 的「地址」由 account_id + model 拼出；没有显式 baseURL 时以能发起请求为准
  const protocol = base.protocol || 'openai'
  const configured = protocol === 'cloudflare'
    ? !!(apiKey && accountId && model)
    : !!(baseURL && apiKey)

  /**
   * jsonMode：provider 的「吃不吃 `response_format`」能力位，默认吃
   * （OpenAI / 千问 / 自建兼容网关都吃）。目前只有 Gemini 关掉，原因见
   * AI_PROVIDERS.gemini 里那段注释 —— 它的兼容层支持的是 JSON Schema 变体。
   */
  return { provider, protocol, baseURL, model, apiKey, accountId, configured, jsonMode: base.jsonMode !== false }
}

/** 把非流式 OpenAI 兼容响应解析成文本 */
function parseText(resp) {
  if (!resp || !Array.isArray(resp.choices) || !resp.choices.length) return ''
  const msg = resp.choices[0].message || {}
  return String(msg.content || '').trim()
}

/**
 * 按 provider 构建请求，返回 { url, headers, body, wire }。
 * wire 表示「实际走的线上协议」，供响应解包用：
 *  - 'openai'：标准 /chat/completions，响应直接是 OpenAI 结构
 *  - 'cloudflare'：Workers AI 原生 ai/run/{model}，响应外层包一层 result
 *
 * cloudflare protocol 的 URL 规则（实测 2026-09）：
 *  - 用户填了以 /ai/v1 结尾的 baseURL → 那是 CF 的 OpenAI 兼容层，
 *    走 {baseURL}/chat/completions（wire=openai）
 *  - 否则忽略 baseURL，按 account_id 强制拼标准原生端点：
 *    {base或client/v4}/accounts/{account_id}/ai/run/{model}（wire=cloudflare）
 */
function buildAiRequest(cfg, messages, extra = {}) {
  if (cfg.protocol === 'cloudflare') {
    const model = cfg.model.replace(/^\/+|\/+$/g, '')
    const base = (cfg.baseURL || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
    // 用户填的是 OpenAI 兼容层地址（.../ai/v1）→ 改走 chat/completions
    if (/\/ai\/v1$/.test(base)) {
      const body = {
        model: cfg.model,
        messages,
        temperature: extra.temperature ?? 0.7,
      }
      if (extra.max_tokens) body.max_tokens = extra.max_tokens
      return {
        url: base + '/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify(body),
        wire: 'openai',
      }
    }
    return {
      url: `${base}/accounts/${cfg.accountId}/ai/run/${model}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify({
        messages,
        temperature: extra.temperature ?? 0.7,
        max_tokens: extra.max_tokens ?? 2048,
      }),
      wire: 'cloudflare',
    }
  }

  // OpenAI 兼容（qwen / openai / gemini 兼容层 / 自定义网关）
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: cfg.model,
    messages,
    temperature: extra.temperature ?? 0.7,
  }
  // 部分网关不支持 response_format：既要调用方显式要求，也要 provider 的能力位允许
  // （gemini 关掉了它，理由见 AI_PROVIDERS.gemini）
  if (extra.json_mode && cfg.jsonMode !== false) body.response_format = { type: 'json_object' }
  if (extra.max_tokens) body.max_tokens = extra.max_tokens
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify(body),
    wire: 'openai',
  }
}

/**
 * 发起一次对话补全并返回模型文本。
 * 内部处理 protocol 差异（CF 解包 result、超时、错误）。供 generatePlaylist 与 /ai-test 复用。
 */
export async function chatOnce(env, db, { messages, json_mode = false, temperature = 0.7, timeout = 60000 }) {
  const cfg = await loadAiConfig(env, db)
  if (!cfg.configured) {
    throw new Error('AI 未配置：请先在设置里填 provider / base_url / api_key / account_id')
  }
  const req = buildAiRequest(cfg, messages, { json_mode, temperature })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await outboundFetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`AI 请求失败 ${resp.status}: ${text.slice(0, 200)}`)
    }
    let data
    try { data = JSON.parse(text) } catch { throw new Error('AI 返回不是合法 JSON') }
    // CF Workers AI 原生端点（ai/run）响应包一层 result；OpenAI 兼容层（ai/v1）不包
    if (req.wire === 'cloudflare' && data && data.result != null) data = data.result
    const content = parseText(data)
    if (!content) throw new Error('AI 返回为空')
    return content
  } catch (e) {
    // 超时中止的 AbortError 原文是「The operation was aborted」，用户看不懂，转成人话。
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String((e && e.message) || e)))
    if (aborted) {
      throw new Error(`AI 响应超时（${Math.round(timeout / 1000)} 秒未返回）。模型可能正忙，可重试一次或减少歌曲数量`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 让模型输出一份歌单。返回 { title, songs: [{name, singer}] }。
 * 用 JSON 输出约束，失败时兜底用行文本解析。
 */
export async function generatePlaylist(env, db, { prompt, count = 20 }) {
  const n = Math.max(1, Math.min(Number(count) || 20, 100))
  const system = [
    '你是一个音乐歌单策划。根据用户的描述，输出一份歌单。',
    '只输出 JSON，不要任何解释、markdown 代码块或多余文字。',
    'JSON 结构：{"title":"歌单名","songs":[{"name":"歌名","singer":"歌手名"},...]}',
    `歌单恰好包含 ${n} 首，songs 数组长度必须等于 ${n}。`,
    '歌名用歌曲的常见中文名（华语歌用简体中文），歌手名可省略为空字符串。',
    '确保每首歌都是真实存在的知名歌曲，不要编造。',
  ].join('\n')

  const user = `请生成一份歌单：${String(prompt || '').trim() || '随便推荐一些好听的歌'}`

  /**
   * 超时按数量放宽：实测 20 首 JSON 常要 40~80s（qwen / gemini 都差不多），50 首更慢。
   * 经验值 ~4s/首，下限 60s，**上限 90s**。
   *
   * ⚠ 上限为什么是 90 而不是更大（老板补报「docker 也存在 AI 生成超时」后收紧，2026-10-09）：
   * 这个数要同时满足两件事 ——
   *
   *   ① 必须**小于前端的等待上限**（`public/js/api.js` 的 `AI_TIMEOUT` = 200s），
   *      否则就是「服务端还在算、前端已经掐断」：用户看到超时、服务端白跑一轮，
   *      而下一轮重试大概率又撞上同一堵墙。
   *   ② 必须**小于常见网关的超时**。Docker 版另一种典型部署是「容器前面挂一层
   *      Cloudflare 代理」（橙云），而 **CF 到源站的等待上限是 100 秒**，超了直接回 524 ——
   *      那时用户看到的是一句没头没尾的错误，连「AI 慢」都看不出来。
   *      自己 90s 放弃、回一句「可重试或减少歌曲数量」，比被网关掐成 524 有用得多。
   *
   * 代价是「一次要 50 首」这类大歌单更容易撞上限 —— 那本来就不是重试能成的规模，
   * 前端也一直把 20 首作为默认值。真要更多，分几次生成即可。
   *
   * （CF Workers 那一侧没有这堵墙：HTTP 触发没有硬性墙钟上限，只要客户端还连着，
   *   I/O 等待也不计 CPU。90s 这个值是为「Docker + 反代/CF 代理」那条路兜的。）
   */
  const timeout = Math.min(90000, Math.max(60000, n * 4000))

  const content = await chatOnce(env, db, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    json_mode: true,
    temperature: 0.7,
    timeout,
  })
  return parsePlaylist(content, n)
}

/** 解析模型输出（优先 JSON，兜底行文本） */
export function parsePlaylist(content, expectCount = 20) {
  let obj = null
  // 去掉可能包裹的 ```json ... ``` 围栏
  const cleaned = content.replace(/```json?/gi, '').replace(/```/g, '').trim()
  try { obj = JSON.parse(cleaned) } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) { try { obj = JSON.parse(m[0]) } catch { obj = null } }
  }

  let title = 'AI 歌单'
  let songs = []
  if (obj && Array.isArray(obj.songs)) {
    if (obj.title) title = String(obj.title).slice(0, 60)
    songs = obj.songs.map(s => ({
      name: String((s && s.name) || '').trim(),
      singer: String((s && s.singer) || '').trim(),
    })).filter(s => s.name)
  } else {
    // 兜底：按行解析「歌名 - 歌手」
    songs = content.split(/\r?\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\s+[-—–·]\s+|\s+-\s+/)
        if (parts.length >= 2) return { name: parts[0].trim(), singer: parts[1].trim() }
        return { name: line, singer: '' }
      })
      .filter(s => s.name)
  }

  if (expectCount) songs = songs.slice(0, expectCount)
  return { title, songs }
}
