/**
 * 统一的「逐个候选取流」逻辑
 *
 * 播放地址只来自 musicUrl 插件：平台 provider 可继续提供搜索、榜单等元数据，
 * 但此处绝不调用平台官方 getMusicUrl / getMusicUrlCandidates 直连接口。
 *
 * 取流策略：
 *   1) 本平台已启用的插件逐个真拉，拿到音频字节才认；
 *   2) 全部失败时，可跨平台搜索同名歌曲，但备用歌曲仍只调用其 musicUrl 插件；
 *   3) 仍失败就明确报错，不回退官方 provider 直连。
 */
import { musicUrlCandidateList, musicUrlCandidatesWithIds, searchOnline, ALL_SOURCES, SOURCE_META } from '../providers/index.js'
import { audioMime, guessAudioFormat, decodeName } from './util.js'
import { outboundFetch, allowHttpAudio, resolveBudget } from './http.js'
import * as pluginStats from './plugin-stats.js'

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/** 明显的「不是音频」的响应类型 */
function looksLikeError(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (!ct) return false
  return ct.includes('text/html') || ct.includes('application/json')
    || ct.includes('text/plain') || ct.includes('text/xml')
}

/**
 * 用**文件头魔数**判断这是不是音频 —— 只看 Content-Type 是不够的。
 *
 * ── 为什么必须看字节（2026-10-24 实测，用户反馈「点开专辑大部分歌放不出来」）──
 *
 * 插件池里有一批「中转站」源，典型是
 *   `https://music-dl.sayqz.com/api/?source=qq&id=...`
 *   `https://175.27.166.236/kgqq/qq.php?type=mp3&id=...`
 * 它们回 `200` + **看起来完全正常的 Content-Type**，body 却是
 * `{"code":201,"msg":"error"}` 或者一张 HTML 错误页。
 *
 * 而原来的探测是 `Range: bytes=0-1`（只拿 2 字节）+ 只信 Content-Type ——
 * 2 个字节什么也证明不了，于是这类假音源**全部探测通过**、还因为「体积未知/rank 靠前」
 * 被排到候选第一位。客户端把地址喂给 `<audio>` 立刻
 * `MEDIA_ELEMENT_ERROR: Format error`，接着要走一整轮降级
 * （重问 /url → 退 /api/stream → 跳歌），用户看到的就是
 * 「点开一张专辑，13 首里只有 2 首能播」。
 *
 * 实测代价：`bytes=0-11` 与 `bytes=0-1` 耗时无差别（都 120~240ms），
 * 但能一刀切掉整类假音源。多花的 10 个字节换掉一整轮降级，非常值。
 *
 * 认的容器：ID3 标签 / 裸 MPEG 帧（MP3、AAC-ADTS）/ Ogg / FLAC / WAV / MP4-M4A / APE。
 * 认不出就一律当作「不是音频」—— 宁可少给一条，也不要给一条必然报 Format error 的。
 */
export function looksLikeAudioBytes(bytes) {
  if (!bytes || bytes.length < 4) return false
  const at = (o, n) => {
    if (bytes.length < o + n) return ''
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[o + i])
    return s
  }
  // ID3v2 标签（绝大多数 MP3 都有）
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true   // "ID3"
  // 裸 MPEG / ADTS 帧同步字：0xFF 后跟 111xxxxx
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return true
  if (at(0, 4) === 'OggS') return true        // Ogg（Vorbis / Opus）
  if (at(0, 4) === 'fLaC') return true        // FLAC
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WAVE') return true   // WAV
  if (at(4, 4) === 'ftyp') return true        // MP4 / M4A（前 4 字节是 box 长度）
  if (at(0, 4) === 'MAC ') return true        // APE
  return false
}

/**
 * 读响应体的**前 n 个字节**，读完立刻取消，不把整首歌下下来。
 *
 * 必须用 reader 逐块读：`res.arrayBuffer()` 会把整个文件拉完 ——
 * 那是几百毫秒到几十秒的差别，探测就失去意义了。
 */
async function readHeadBytes(res, n = 12) {
  if (!res || !res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  try {
    while (got < n) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length) { chunks.push(value); got += value.length }
    }
  } catch { /* 读到一半断了，就用已经拿到的字节判断 */ }
  try { await reader.cancel() } catch { /* 已经结束 */ }
  const out = new Uint8Array(Math.min(got, n))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off)
    if (take <= 0) break
    out.set(c.subarray(0, take), off)
    off += take
  }
  return out
}

/**
 * 标题归一化：去掉括号补充说明与标点，用于跨平台同名匹配。
 *
 * ⚠ 分隔符表里必须有**全角竖线 `｜` 和「丨」**（U+FF5C / U+4E28）。
 * 有声书标题普遍用它们当集号分隔（`李哪吒惊奇毕业旅丨33 都是因为爱`），
 * 而 QQ 侧写 `丨`、酷狗侧写 `｜` 是常事 —— 不归一化就永远匹配不上，
 * 「QQ 返回的放不出来」里有一半是这么来的。
 */
function normTitle(name) {
  return decodeName(String(name || ''))
    .toLowerCase()
    .replace(/[（(\[【{].*?[)）\]】}]/g, '')
    .replace(/[\s\-_·、,，.。!！?？'"“”‘’&+｜丨|:：\/]/g, '')
}

/**
 * 两个标题是不是「同一首」。
 *
 * 精确同名之外，还要认**歌手名被塞进标题**这种（酷狗常干）：
 *   QQ  : `李哪吒惊奇毕业旅丨33 都是因为爱`
 *   酷狗: `东海小学广播站、喜马拉雅 - 李哪吒惊奇毕业旅丨33 都是因为爱`
 * 归一化后后者 = 前者的「前缀 + 歌手名」，所以判据是
 * 「一方是另一方的前/后缀延长，且多出来的那截正好是歌手名」。
 *
 * ⚠ 不能放宽成任意「包含」：同专辑的 `…丨1 出发` 与 `…丨10 出发` 会互相包含，
 * 那就会播错集。多出来的那截必须能被歌手名解释，这条约束就是防它的。
 */
export function sameTitle(a, b, singer) {
  const x = normTitle(a)
  const y = normTitle(b)
  if (!x || !y) return false
  if (x === y) return true
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  if (s.length < 6) return false          // 太短的一律不做包含判断
  let extra = ''
  if (l.startsWith(s)) extra = l.slice(s.length)
  else if (l.endsWith(s)) extra = l.slice(0, l.length - s.length)
  else return false
  if (!extra) return true
  const who = normTitle(singer)
  if (!who) return false
  return who.includes(extra) || extra.includes(who)
}

function singerTokens(singer) {
  return decodeName(String(singer || ''))
    .split(/[、,&/＋+]|\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 跨平台找同名歌曲（最多 limit 首），按歌手是否重合排序。
 *
 * @param {number} searchTimeout 单个平台的搜索超时（毫秒）。
 *   `/stream` 那条兜底可以给 4000（用户已经在等了）；`/url?fast=1` 那条
 *   走的是「点开就要出声」的路径，必须给得更紧。
 *
 * ── 为什么逐源分开搜、而不是一次 `searchOnline` 搜全部 ──────────────
 * `searchOnline` 内部是 `Promise.all`：它要等**最慢的那个平台**。
 * 实测同一首歌，酷狗 0.6~3 秒就给出精确同名结果，而酷我/虾米经常 9~10 秒
 * （在 CF 出口上更糟）。合在一起搜 = 为了一个 1 秒就到的答案等 3.5 秒。
 *
 * 现在逐源并发，**第一个给出匹配的平台立刻收工**，剩下的不再等。
 * 命中质量不变（仍然是同一套 `sameTitle` 过滤 + 同一套排序）。
 */
async function crossSourceSongs(song, limit = 2, searchTimeout = 4000) {
  const wanted = normTitle(song.name)
  if (!wanted) return []
  const tokens = singerTokens(song.singer)
  const keyword = [song.name, tokens[0]].filter(Boolean).join(' ').trim()
  if (!keyword) return []

  const sources = ALL_SOURCES.filter(s => s !== song.source)
  const found = []
  let release = null
  const firstHit = new Promise((res) => { release = res })

  const jobs = sources.map(async (src) => {
    let list = []
    try {
      const res = await searchOnline(keyword, { sources: [src], limit: 24, timeout: searchTimeout })
      list = res.list || []
    } catch {
      return
    }
    const hit = list.filter(s => s && s.id && sameTitle(s.name, song.name, song.singer))
    if (!hit.length) return
    // 已有命中 → 其余平台不必再等（但已在飞行的请求不取消，它们自己会结束）
    if (found.length === 0) { found.push(...hit); release() }
  })

  try {
    // 谁先命中谁结束；全都没命中就等最慢的那个自己超时
    await Promise.race([Promise.all(jobs), firstHit])
  } catch { /* 单源失败不影响其它源 */ }

  return found
    .sort((a, b) => {
      const sa = tokens.some(t => (singerTokens(a.singer)).includes(t)) ? 1 : 0
      const sb = tokens.some(t => (singerTokens(b.singer)).includes(t)) ? 1 : 0
      if (sb !== sa) return sb - sa
      // 同名时**优先完全一致的那条**：`…丨33 都是因为爱` 比 `…丨33 都是因为爱（重制）` 更该先试
      const ea = normTitle(a.name) === normTitle(song.name) ? 1 : 0
      const eb = normTitle(b.name) === normTitle(song.name) ? 1 : 0
      return eb - ea
    })
    .slice(0, limit)
}

/**
 * 单个候选的最长等待时间。
 * 为什么要它：聚合源里总有「连得上但不吐数据」的地址，不加超时就会一直挂着，
 * 实测把一次代理取流从 1 秒拖到 19 秒（kg 的第三方中转源）。超时即换下一个。
 */
const CANDIDATE_TIMEOUT = 6000

/**
 * 整条取流解析链的总预算（毫秒）。
 *
 * 有可用源的歌实测 0.6~3 秒就出结果；10 秒还没结果基本就是「这首歌没源」。
 * 以前没有这个上限，14 个候选串行 × 6 秒 = 40 秒，客户端只能干等。
 * 见 openAudioStream 里的说明。
 */
const STREAM_BUDGET_MS = 10000

async function tryCandidates(thunks, song, errors, seen, opts) {
  for (const thunk of thunks) {
    let cand = null
    try {
      cand = await thunk()
    } catch (e) {
      errors.push(`候选解析异常: ${(e && e.message) || e}`)
      continue
    }
    if (!cand || !cand.url) continue
    if (seen.has(cand.url)) continue
    // 客户端已经直连试过并且失败的地址，代理不必再试一遍（省下几秒）
    if (opts.skipUrls && opts.skipUrls.has(cand.url)) { seen.add(cand.url); continue }
    seen.add(cand.url)

    const headers = {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
    }
    // 不少 CDN 做防盗链，带上来源站 Referer 命中率更高
    try { headers.Referer = new URL(cand.url).origin + '/' } catch { /* ignore */ }
    if (opts.rangeHeader) headers.Range = opts.rangeHeader

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.candidateTimeout || CANDIDATE_TIMEOUT)
    try {
      const upstream = await outboundFetch(cand.url, { headers, redirect: 'follow', signal: controller.signal })
      if (!upstream.ok && upstream.status !== 206) {
        errors.push(`${cand.from}: 上游 ${upstream.status}`)
        try { await upstream.body?.cancel() } catch { /* ignore */ }
        continue
      }
      const contentType = upstream.headers.get('content-type') || ''
      if (looksLikeError(contentType)) {
        errors.push(`${cand.from}: 返回非音频内容`)
        try { await upstream.body?.cancel() } catch { /* ignore */ }
        continue
      }
      const outHeaders = new Headers({
        'Content-Type': contentType.startsWith('audio') ? contentType : audioMime(cand.url, guessAudioFormat(cand.url)),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        // 诊断用响应头，前端不读。必须转义成 ASCII ——
        // cand.from 可能是 `plugin:未命名音源`，而 HTTP 头值按规范只能是字节串，
        // 塞中文在部分浏览器会直接抛 TypeError。要看内容就 decodeURIComponent。
        'X-Resolved-From': encodeURIComponent(cand.from || ''),
      })
      for (const k of ['content-length', 'content-range']) {
        const v = upstream.headers.get(k)
        if (v) outHeaders.set(k, v)
      }
      // 注意：这里必须先把超时清掉再返回 —— 响应体还要继续流给客户端，
      // abort 会把正在播的流掐断。
      clearTimeout(timer)
      return {
        ok: true,
        from: cand.from,
        /**
         * 这条候选**实际用的地址**（可能是升级后的 https，也可能是退回的原 http 链）。
         *
         * 为什么要带出来：调用方（`/api/stream`）拿它写「已经真的吐过字节」的
         * 直链缓存 —— 同一首歌第二次播放就能直接命中，省掉整轮解析与探测。
         * 见 src/server/api.js 的 streamUrlCache。
         */
        url: cand.url,
        response: new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: outHeaders }),
      }
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))
      const why = aborted
        ? '超时(' + (opts.candidateTimeout || CANDIDATE_TIMEOUT) + 'ms)'
        : ((e && e.message) || e)
      errors.push(`${cand.from}: ${why}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/**
 * @param {object} song        decodeSongId 后的歌曲对象
 * @param {string} quality     音质 key
 * @param {object} pluginPool  服务端插件池
 * @param {object} opts
 *        - rangeHeader       客户端的 Range 头（透传给上游，支持拖动进度）
 *        - maxCandidates     本平台最多试几个候选（默认 6）
 *        - allowCrossSource  本平台全挂时是否跨平台兜底（默认 true）
 *        - crossSourceLimit  跨平台最多找几首（默认 2）
 *        - skipUrls          Set<string>：客户端直连已经试过并失败的地址，别再试
 *        - candidateTimeout  单个候选的最长等待（默认 6000ms）
 * @returns {Promise<{ok:boolean, response?:Response, from?:string, error?:string, errors?:string[]}>}
 */
export async function openAudioStream(song, quality, pluginPool, opts = {}) {
  /**
   * ★ 整条解析链的**总预算**（2026-10-24 加）。
   *
   * 病根是实测出来的：一张喜马拉雅有声书专辑（QQ 平台）的曲目，
   * 插件池里 14 个候选只有 3 个能返回地址、且全是中转站假音源。
   * 串行试完这些候选要 **31~42 秒**（每个候选 `CANDIDATE_TIMEOUT` 6 秒，
   * 中间还夹着跨平台兜底的一次全平台搜索）。
   * 客户端那边看到的就是「一直在解析资源，播放不出来」——它默认超时 40 秒，
   * 正好卡在边界上，所以有时超时、有时勉强返回 502。
   *
   * 现在给整条链一个硬预算：到点就明确回「解析超时」。
   * 客户端拿到 502 会立刻提示 + 跳下一首，而不是干等 40 秒。
   *
   * 为什么是 10 秒：正常歌曲（有可用源）实测 0.6~3 秒就返回，
   * 10 秒已经覆盖了「插件慢但能用」的全部情况；再等下去只可能是没源。
   */
  const budgetMs = Math.max(2000, Math.min(Number(opts.budgetMs) || STREAM_BUDGET_MS, 30000))
  let budgetTimer = null
  const timedOut = new Promise((resolve) => {
    budgetTimer = setTimeout(() => resolve({
      ok: false,
      errors: [],
      error: `取流解析超过 ${Math.round(budgetMs / 1000)} 秒，已放弃（这首歌的源可能都已失效）`,
    }), budgetMs)
  })

  const work = (async () => {
  const maxCandidates = Math.max(1, Math.min(Number(opts.maxCandidates) || 6, 12))
  const errors = []
  const seen = new Set()

  // 0) 优先试「已经并发探过的地址」。
  //    这是把「串行试错」换成「并发预筛」的关键。
  //    实测：同一份候选列表，串行解析要 15.9 秒（8 个槽位里有 5 个是空的，
  //    每个空槽都要等插件内部超时 ~3 秒），而 resolveMusicUrlFast 并行解析只要 0.6~1.7 秒。
  //    所以只要调用方给了 preferUrls，就说明候选已经被并行解析过了，
  //    下面那份串行列表不必再跑一遍（skipCandidateList）。
  let result = null
  if (Array.isArray(opts.preferUrls) && opts.preferUrls.length) {
    result = await tryCandidates(opts.preferUrls.map((u) => async () => u), song, errors, seen, opts)
    if (result) return result
    if (opts.skipCandidateList) {
      // 候选已全部试过仍失败 → 直接进跨平台兜底，不再重复串行解析
      return await crossSourceFallback(song, quality, pluginPool, opts, errors, seen)
    }
  }

  const pluginThunks = musicUrlCandidateList(song, quality, pluginPool).slice(0, maxCandidates)
  result = await tryCandidates(pluginThunks, song, errors, seen, opts)
  if (result) return result

  return await crossSourceFallback(song, quality, pluginPool, opts, errors, seen)
  })()

  try {
    return await Promise.race([work, timedOut])
  } finally {
    clearTimeout(budgetTimer)
  }
}

/** 本平台全挂 → 跨平台搜同名歌曲（用户的诉求是「听到这首歌」，不是「必须来自酷狗」） */
async function crossSourceFallback(song, quality, pluginPool, opts, errors, seen) {
  if (opts.allowCrossSource === false) {
    return {
      ok: false,
      errors,
      error: errors.length
        ? `所有取流插件均无法播放（试了 ${errors.length} 个）：${errors.slice(0, 3).join('；')}`
        : '当前歌曲来源没有启用取流插件',
    }
  }
  const alts = await crossSourceSongs(song, opts.crossSourceLimit || 2)
  for (const alt of alts) {
    const pluginThunks = musicUrlCandidateList(alt, quality, pluginPool).slice(0, 4)
    const r = await tryCandidates(pluginThunks, alt, errors, seen, opts)
    if (r) {
      const srcName = (SOURCE_META[alt.source] && SOURCE_META[alt.source].name) || alt.source
      r.from = `跨源(${srcName}) ${r.from}`
      r.crossSource = { source: alt.source, name: alt.name, singer: alt.singer }
      return r
    }
  }
  return {
    ok: false,
    errors,
    error: errors.length
      ? `所有取流插件均无法播放（试了 ${errors.length} 个）：${errors.slice(0, 3).join('；')}`
      : '当前歌曲及备用结果均没有可用的取流插件地址，请检查已启用的插件',
  }
}

/** 探测候选地址是否真的能出音频（供 /api/url 用） */
/**
 * 探测一条地址，并**区分两种失败**（兜底逻辑必须知道这个区别）：
 *   · `notAudio` —— 源站回了 200，但内容不是音频（JSON / HTML / 脚本）。
 *     这条永远放不出来，兜底时不能交给客户端。
 *   · 其余（status 0 / 超时 / 4xx）—— 可能只是服务端出口不通，
 *     用户手机的网络未必不通，值得让客户端自己试一次。
 */
export async function probeAudioDetail(url, timeoutMs = 4000) {
  try {
    const res = await outboundFetch(url, {
      method: 'GET',
      // 12 字节：要能看出音频魔数，理由见 looksLikeAudioBytes
      headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-11' },
      redirect: 'follow',
      /*
       * ⚠ 必须带超时。`outboundFetch` 底下就是裸 `fetch`，**默认永不超时** ——
       * 一个「连上了但不吐数据」的中转源能把整条解析链挂死在这里。
       * 实测 QQ 专辑那批候选里就有这种，导致 /api/stream 一次要 40 秒。
       */
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ct = res.headers.get('content-type') || ''
    const head = await readHeadBytes(res, 12)
    const reachable = res.ok || res.status === 206
    const audio = looksLikeAudioBytes(head)
    return { ok: reachable && !looksLikeError(ct) && audio, notAudio: reachable && !audio, status: res.status, contentType: ct }
  } catch (e) {
    return { ok: false, notAudio: false, status: 0, err: (e && e.message) || String(e) }
  }
}

export async function probeAudioUrl(url) {
  return (await probeAudioDetail(url)).ok
}

/**
 * 解析出一个「已探测可用」的直链，供 /api/url 使用。
 * 只探测前几个候选，避免拖慢响应。
 */
export async function resolvePlayableUrl(song, quality, pluginPool, { maxProbe = 4, budgetMs = 8000 } = {}) {
  const thunks = musicUrlCandidateList(song, quality, pluginPool).slice(0, maxProbe)
  const tried = []
  if (!thunks.length) {
    return { url: null, from: null, tried, error: '当前歌曲来源没有启用取流插件' }
  }
  const t0 = Date.now()
  const soft = []   // 解析出来了、但探测没能证明它是音频（网络原因）—— 可以兜底交出去
  for (const thunk of thunks) {
    /*
     * 总预算：这是 `/api/url` 的同步路径，用户正等着这一发拿地址。
     * 没有预算时 4 个候选 × 每个最多 4 秒 = 16 秒，实测把一次 /url 拖到十几秒。
     */
    if (Date.now() - t0 > budgetMs) {
      tried.push(`解析超预算（${budgetMs}ms），剩余候选已跳过`)
      break
    }
    let cand = null
    try { cand = await thunk() } catch { continue }
    if (!cand || !cand.url) continue
    tried.push(cand.from)
    const p = await probeAudioDetail(cand.url)
    if (p.ok) return { url: cand.url, from: cand.from, tried }
    if (p.notAudio) tried.push(`${cand.from}: 返回的不是音频（${p.contentType || '无 Content-Type'}）`)
    else soft.push(cand)
  }
  /**
   * 兜底：把「没证明是音频、但也没证据说它不是」的候选交给客户端自己试。
   *
   * ⚠ 明确返回非音频内容（`notAudio`）的那批**绝不能**放进兜底。
   * 以前这里是无条件「把第一个插件返回的地址给出去」—— 于是中转站
   * （`music-dl.sayqz.com`、`175.27.166.236/kgqq/qq.php` 这类回 JSON 的）
   * 会被当成播放地址交出去，客户端 `<audio>` 必然 Format error，
   * 再走一整轮降级。宁可明确回「没有可用音源」，让客户端立刻提示 + 跳下一首。
   */
  if (soft.length) {
    return { url: soft[0].url, from: soft[0].from, tried, unverified: true }
  }
  return {
    url: null,
    from: null,
    tried,
    error: tried.length ? '所有取流插件返回的都不是音频' : '所有取流插件均未返回可用地址',
  }
}

/* ------------------------------------------------------------------ *
 * 直连播放（浏览器 <audio> 直接拉源站，不经 Worker 中转）
 *
 * 两个必须解决的硬约束，实测确定：
 *   1. 混合内容 —— 站点是 https，源站直链若是 http，<audio> 会被浏览器
 *      直接拦掉（Err 4 SRC_NOT_SUPPORTED），和防盗链无关。而插件源普遍
 *      给 http（实测 m701.music.126.net、kw-er.kuwo.cn 都是 http）。
 *      好在这批 CDN 本身支持 https：把 http 换成 https 仍是 206 + audio/mpeg
 *      （实测网易 m702 202ms / 酷我 164ms）。
 *   2. 试听片段 —— 同一个 hash 在不同路径下长短差几十倍（酷我 n1 只有
 *      0.17MB，正常 320k 完整曲约 8MB）。直接取第一个候选容易一开就断。
 * ------------------------------------------------------------------ */

/** 插件候选 URL 的已知 CDN 域名分类：只用于评估插件返回的地址，不会调用平台取流 API。 */
const OFFICIAL_HOSTS = [/\.music\.126\.net$/i, /\.kuwo\.cn$/i, /\.kugou\.com$/i,
  /\.kglink\.cn$/i, /\.qqmusic\.qq\.com$/i, /\.music\.qq\.com$/i]

/**
 * 已知的死接口，排到最后。
 * 实测 `music.163.com/song/media/outer/url?id=X.mp3` 对绝大多数曲目返回
 * 302 → http://music.163.com/404（非音频内容），把它排在前面只会白等一次超时。
 */
const WEAK_HOSTS = [/^music\.163\.com$/i]

/**
 * 把插件给的 http 直链**乐观升级**成 https。
 *
 * ⚠ 这里曾经只升一份域名白名单（网易 / 酷我 / 酷狗 / QQ 的**官方** CDN 域名）。
 *   后果是**白名单外的域名被整批丢弃**，而且丢的往往正是该平台**唯一能出声**的那几条：
 *   实测酷狗《黄昏》的 13 个候选里，只有 3 条 `http://*.bdycdn.cn/...`（第三方 CDN，
 *   路径里才含 kugou.com、域名本身不是 kugou.com）真能出声，其余不是超时就是
 *   源站回 `{"code":201,"msg":"error"}`。三条全不在白名单里 → 被丢弃 → `/url`
 *   直接 404 → 只能退到服务端代理（音源标识显示「服务端」）。用户看到的就是
 *   「网易的歌能放，酷狗的歌放不出来」。同一批里 QQ 那条 `http://175.27.166.236/...`
 *   也是纯 http 的 IP 中转，同样被丢。
 *
 * 现在**一律升级**，能不能真用交给后面的 Range 探测判定 —— 探不通时会**退回原 http 链**
 * （见下方 flow 里候选 URL 形态的处理），所以「升级」不再是一个会丢候选的破坏性动作。
 */
export function upgradeToHttps(url) {
  const raw = String(url || '')
  if (!/^http:\/\//i.test(raw)) return raw
  return raw.replace(/^http:/i, 'https:')
}

function hostMatches(url, list) {
  try { return list.some((re) => re.test(new URL(url).hostname)) } catch { return false }
}

/**
 * 只探前 2 字节，判断这个地址是不是真音频、总长多少。
 * 用 Range 而不是完整 GET：单次约 120~240ms（实测），且不消耗源站流量。
 */
async function probeAudioBytes(url, timeoutMs = 4000) {
  try {
    const res = await outboundFetch(url, {
      // ⚠ 12 字节而不是 2 字节：要看得出文件头魔数（见 looksLikeAudioBytes）
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', Range: 'bytes=0-11' },
      redirect: 'follow',
      // 同 probeAudioDetail：底层 fetch 默认永不超时，必须自己兜住
      signal: AbortSignal.timeout(timeoutMs),
    })
    const contentType = res.headers.get('content-type') || ''
    const contentRange = res.headers.get('content-range') || ''
    const size = Number((contentRange.match(/\/(\d+)\s*$/) || [])[1] || res.headers.get('content-length') || 0)
    const head = await readHeadBytes(res, 12)
    const audio = looksLikeAudioBytes(head)
    const reachable = res.ok || res.status === 206
    const ok = reachable && !looksLikeError(contentType) && audio
    /**
     * `notAudio` 与「网络没通」必须分开记：
     *   · notAudio=true  → 源站好好地回了一个**不是音频**的东西（JSON/HTML/脚本）。
     *     这条候选**永远**放不出来，兜底时不能交出去 —— 交出去只会让客户端
     *     白等一轮 Format error 再降级。
     *   · status=0（网络错误 / 超时）→ 可能只是服务端出口这会儿不通，
     *     用户的手机网络未必不通，值得让客户端自己试一次。
     */
    return { ok, size, status: res.status, contentType, notAudio: reachable && !audio }
  } catch (e) {
    return { ok: false, size: 0, status: 0, err: (e && e.message) || String(e), notAudio: false }
  }
}

/**
 * 直连地址候选：解析 → 协议升级 → 并发探测 → 按完整度排序。
 *
 * 和 resolvePlayableUrl 的分工：那个用于「服务端代理前筛死链」，串行逐个真拉，
 * 实测 6.1~13.1 秒；这里全部并发、每个只取 2 字节，实测 164~237ms。
 *
 * 参数：
 *   - maxTries   最多解析几个候选（默认 6）
 *   - deadline   单个候选的解析上限（默认 3000ms）
 *   - probeDeadline 单个候选的探测上限（默认 2000ms）
 *
 * 返回：
 *   { urls: [{url, from, size}], url, from, tried, unverified }
 *   urls 由插件取流候选组成，并按「体积、来源健康度与插件评分序」交给客户端降级。
 *   全部探测失败时不返回空，而是兜底给出第一个插件返回的 https 候选（unverified），
 *   让客户端自己试 —— 不会转而调用 provider 的官方直连接口。
 */
/**
 * `/url?fast=1` 这条路的跨平台兜底。
 *
 * ── 为什么这条兜底以前只长在 `/api/stream` 上，是个真漏洞 ──────────
 * 客户端的播放顺序是「先 `/url?fast=1` 直连，失败才降级 `/api/stream`」。
 * 而跨源逻辑（`crossSourceFallback`）只写在 `openAudioStream` 里 ——
 * 也就是说**用户要先把那条注定失败的路走完**（实测 QQ 有声书 25~33 秒）
 * 才有机会摸到跨源。可这张专辑在酷狗那边是 13/13 全播的，
 * 本来 1 秒就能出声。
 *
 * 所以兜底必须前移到 `/url`：本平台候选一个都探不通时，立刻去别的平台
 * 找同名曲目，用它的取流候选（那条链在酷狗侧是好的）。
 *
 * ⚠ 只在**彻底没戏**时才调用（全 notAudio，或一条都没探通），
 * 有可用源时绝不走这里 —— 否则每首歌都白白多一次全平台搜索。
 *
 * @returns {Promise<object|null>} 命中则返回与 resolveMusicUrlFast 同形状的结果
 */
async function crossSourceResolveFast(song, quality, pluginPool, tried, budgetMs = 5000) {
  const t0 = Date.now()
  const perf = { search: 0, resolve: 0, probe: 0 }
  let alts = []
  try {
    /**
     * 搜索给到 3.5 秒。
     *
     * 早先给的是 1.6 秒，实测**在 CF 出口上不够**：酷狗 0.6~3 秒、酷我 3~10 秒，
     * 1.6 秒经常把唯一能命中的那个平台直接掐掉 —— 表现就是「同一首歌，
     * 有时能跨源成功、有时一条都找不到」，查了半天不是匹配逻辑的问题。
     *
     * 这条路只有「本平台彻底没戏」时才会走到，用户此时本来就在等，
     * 多等 1~2 秒换「能播」是划算的；正常歌曲根本进不来。
     */
    alts = await crossSourceSongs(song, 3, Math.max(1200, budgetMs - 1500))
  } catch {
    return null
  }
  perf.search = Date.now() - t0
  if (!alts.length) return null

  /**
   * 两个备选平台**并发**解析，不串行。
   *
   * 串行时第一个平台（常是酷狗，搜索就要 3 秒）会把预算吃光，
   * 第二个平台永远只能拿到 `left < 600` 然后被 break 掉 —— 等于白找。
   * 并发之后两边各自拿完整剩余预算，谁先出来用谁（仍按 alts 的优先级取）。
   */
  const left = budgetMs - (Date.now() - t0)
  if (left < 600) return null
  /**
   * ⚠ 给备选曲目的预算要**明显小于 `left`**。
   *
   * 实测（`/url?perf=1`）：备选曲目的候选地址 1 毫秒就解析出来了，
   * 可 `resolveMusicUrlFast` 会一直等到 `totalBudget` 才返回 —— 因为它在等
   * 「探测通过」。而 CF 出口连酷我 CDN 根本连不通，探测注定超时，
   * 于是白等满整个预算（实测 3.1~3.3 秒）。
   *
   * 跨源要的是「尽快拿到那条地址」，不是「在服务端证明它能出声」——
   * 后者在 CF 上永远做不到，客户端手机侧自然会验。
   * 所以这里只给 1.6 秒：够插件解析，也够探一次（能验就验，验不了就算了）。
   */
  const altBudget = Math.min(left, 2200)
  const tResolve = Date.now()
  const attempts = await Promise.all(alts.map(async (alt) => {
    let r = null
    try {
      // 递归回到本函数解析备选曲目，但**禁止再跨源**（否则源站互相找不到时会来回打转）
      r = await resolveMusicUrlFast(alt, quality, pluginPool, {
        maxTries: 12,
        deadline: Math.min(left, 1800),
        probeDeadline: Math.min(1200, altBudget),
        totalBudget: altBudget,
        allowCrossSource: false,
      })
    } catch {
      return null
    }
    if (!r || !r.url) return null
    /**
     * 这里**不再重复探测**。
     *
     * 递归那一趟已经按 `probeDeadline` 探过了：验得通就是 `verified`，
     * 验不通就说明 CF 出口到那个 CDN 不通（酷我 CDN 就是这样）。
     * 再探一次只会同样超时 —— 实测白白多花 1.2 秒，而判据一点没变。
     *
     * 能不能出声交给客户端手机侧判断：那条地址是 CDN 直链，
     * 服务端探不通 ≠ 用户播不了（这一点和 `probeAudioDetail` 的注释是同一套口径）。
     */
    const verified = r.unverified !== true
    return { alt, r, verified }
  }))
  perf.resolve = Date.now() - tResolve - perf.probe

  const hit = attempts.find(Boolean)
  if (!hit) return null
  const { alt, r, verified } = hit
  const srcName = (SOURCE_META[alt.source] && SOURCE_META[alt.source].name) || alt.source
  tried.push(`本平台无可用源，已跨源命中「${srcName}」：${alt.name}`)
  const wrap = (x) => ({ ...x, from: `跨源(${srcName}) ${x.from}` })
  return {
    urls: (r.urls && r.urls.length ? r.urls : [{ url: r.url, from: r.from }]).map(wrap),
    url: r.url,
    from: `跨源(${srcName}) ${r.from}`,
    size: r.size || 0,
    tried,
    unverified: !verified,
    crossSource: { source: alt.source, name: alt.name, singer: alt.singer },
    crossPerf: perf,
  }
}

export async function resolveMusicUrlFast(song, quality, pluginPool, options = {}) {
  // 宿主默认预算（网页紧、壳内宽），调用方传入的 options 优先 —— 见 http.js 的 resolveBudget
  const {
    maxTries = 12, deadline = 1600, probeDeadline = 1200, totalBudget = 1800,
  } = { ...resolveBudget(), ...options }
  // 候选只来自 musicUrl 插件；按插件池的评分序并行解析，不调用 provider 官方取流接口。
  // 放到 12 是为了不让前面的空槽位挤掉评分靠后的插件；并行解析 + totalBudget
  // 只增加并发数，不增加等待时间（到点就带着已解析出的插件候选返回）。
  //
  // 候选带上插件 id（`musicUrlCandidatesWithIds`），并在下面用 `pluginStats.order()`
  // 按**线上真实命中率**再排一次 —— 静态的 plugin-rank.js 是构建机上测的，
  // 跟这台机器的出口不是一回事（见 lib/plugin-stats.js 开头）。统计没数据时
  // order() 原样返回，所以这条链路在「还没攒够样本」时与改动前完全一致。
  const list = pluginStats.order(
    song.source,
    musicUrlCandidatesWithIds(song, quality, pluginPool).slice(0, maxTries),
  )
  const thunks = list.map((x) => x.thunk)
  const tried = []
  if (!thunks.length) {
    return {
      urls: [], url: null, from: null,
      tried: ['当前歌曲来源没有启用 musicUrl 取流插件'],
      error: '当前歌曲来源没有启用取流插件',
      unverified: true,
    }
  }
  const cands = []           // 解析出来的候选，按到达顺序；可能还没探完
  const seen = new Set()

  const withDeadline = (promise, ms) => new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { done = true; resolve(null) }, ms)
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    Promise.resolve(promise).then(finish, () => finish(null))
  })

  /**
   * 三个阶段在时间上重叠：解析 → 入列 → 探测。
   *
   * 设计要点（都是被实测数字逼出来的）：
   *   · 不能「先全部解析完再统一探测」—— 耗时是两段上限相加，实测最坏 5~7 秒。
   *   · 不能只靠「探通才返回」—— 第三方插件源解析本身就要 2 秒以上，
   *     干等它会把点歌后的第一跳拖到 3~5 秒。
   *   · 所以给整体一个预算 totalBudget：谁先探通谁立刻上（正常 0.6~1.2 秒返回，
   *     且是 verified 的）；到点还没探通就先把已解析出的候选交出去（unverified），
   *     让客户端边播边试 —— 客户端本来就有插件/代理两级兜底。
   *
   * 换句话说：宁可返回一个「大概率可用」的地址，也不要为了确认它而让用户干等。
   */
  let earlyPayload = null
  let releaseBudget = null
  const budget = new Promise((res) => { releaseBudget = res })

  /**
   * 探测结果的短收敛窗口（毫秒）。
   *
   * ── 为什么需要它（这是「同一首歌选不同音质长度不一样」的真凶）──────
   * 各音源插件对不同音质返回的是**不同来源**的地址：低音质常落到第三方中转源，
   * 那些源给的是**试听片段**（三十多秒）；Hi-Res 走正版直链，给的是完整曲目。
   * 而原来的逻辑是「谁先探通就用谁」—— 试听片段只要先探通就会被选中，
   * 完整版即使也探通了也不会被看一眼。用户看到的就是「换了音质时长就变了」。
   *
   * 修法不是「全部探完再选」——那会把起播拖到 3~5 秒，得不偿失（这条是
   * 上面那段说明的核心诉求）。而是探通第一条之后**再多等一小会儿**，
   * 把同期探通的候选收进来一起挑。450ms 的依据：同一批候选的 Range 探测
   * 耗时集中在 120~240ms，多等这几百毫秒远小于「放半首就没了」的代价。
   *
   * 窗口内若收到明显更完整的候选就用它；只有片段可用时仍然用片段
   * （能出声比不出声强），但在 tried 里标明是「疑似试听片段」。
   *
   * ⚠ 2026-10-10 补了一个洞：上面这套「等 450ms 收齐再挑」有个前提 ——
   * **先探通的那条得是个正常候选**。可它是一个**试听片段**时照样会开表，
   * 450ms 一到就收工；插件那条几 MB 的完整版只晚一步到，就永远没机会看一眼。
   * 曾有平台接口返回 30 秒试听片段、而插件返回完整版本晚到一步的情况。
   * 现行播放链已禁用 provider 原生取流；这里的判据仅处理插件候选，包括
   * 网易插件透传的 freeTrialInfo 标记，以及探测到的音频体积。
   * 所以现在首条若是**可判定为片段**的候选，窗口直接放到总预算（见 armSettle）。
   */
  const SETTLE_MS = 450
  let settleTimer = null
  let settleArmedForTrial = false
  let releaseSettle = null
  const settle = new Promise((res) => { releaseSettle = res })
  const armSettle = (ms, forTrial) => {
    if (settleTimer) return
    settleArmedForTrial = !!forTrial
    settleTimer = setTimeout(releaseSettle, Math.max(0, ms))
  }
  /**
   * 已经等到一条**完整版**了 → 不必再为「等完整版」而耗满预算，窗口收回 450ms。
   * 只在「因为首条是片段而放长的那个窗口」上生效，不打扰原本就短的窗口。
   */
  const shortenSettle = () => {
    if (!settleArmedForTrial || !settleTimer) return
    clearTimeout(settleTimer)
    settleTimer = setTimeout(releaseSettle, SETTLE_MS)
    settleArmedForTrial = false
  }
  const probed = []          // 探通且 ok 的候选，供 pickBest 挑

  /**
   * 「这条候选是不是试听片段」—— 这是本轮那个「偶发只播 30 秒」的判据入口。
   *
   * 两个信号，任一成立即算：
   *   ① 源自己标的 `trial` —— 网易 eapi 的 `freeTrialInfo` 非空（实测
   *      `{fragmentType:-1,start:0,end:30}`）。这是**声明时长未知时唯一可靠**的判据。
   *   ② **按体积推算的码率低得离谱**：`体积 × 8 / 声明时长 < TRIAL_MAX_KBPS`。
   *      实测片段是 470KB / 265s ≈ 14kbps，而 128k 的完整版 ≈ 125kbps、
   *      320k ≈ 320kbps —— 64 这条线离两边都很远，不会误伤正常短歌。
   *
   * ⚠ 没有声明时长（极简 ID 形如 `wy:88926` 没带 `t`）时 ② 判不出来，只剩 ①。
   * 能判出来时**宁可多等一会儿**，也不能把 30 秒的片段当结果交出去 ——
   * 这是「起播慢 1 秒」和「放 30 秒就没了」之间的取舍，后者严重得多。
   */
  const TRIAL_MAX_KBPS = 64
  const declaredSec = Number(song && song.interval) || 0
  const looksLikeTrial = (rec) => {
    if (!rec) return false
    if (rec.trial === true) return true
    if (!rec.size || !declaredSec) return false
    return (rec.size * 8) / 1000 / declaredSec < TRIAL_MAX_KBPS
  }
  const t0 = Date.now()

  /**
   * 探通多条时怎么选 —— 与下面的 compareCandidates **必须同档位同顺序**。
   *
   * 这里曾经把 official 排在第一档、weak 排到第三档，和 compareCandidates
   * （weak → official → size）是两套顺序。后果不是「选得不最优」这么轻：
   * WEAK_HOSTS 是**已知死接口**名单（music.163.com 的 outer/url 实测
   * 302 → /404），一个死接口只要 HEAD 探测时侥幸回了 content-range，
   * 就会在 pickBest 这一路被抬到健康的官方 CDN 前面，而它恰恰是放不出声的那条。
   * 同一份文件里两个sort 顺序不一致 ⇒ 走哪条路径结果不同 ⇒ 极难复现的偶发。
   *
   * 档位与 compareCandidates 逐条对齐：
   *   ① weak 域名最后   ② trial（试听片段）最后   ③ 已知 CDN 域名特征优先
   *   ④ 体积大优先   ⑤ 插件评分序优先
   * 两边改一处就要改另一处；test/stream-pick.mjs 有一条一致性断言盯着它们。
   *
   * ⚠ trial 这一档为什么要**排在体积之前**：30 秒的**无损**片段可能有 5MB，
   * 比 128k 的完整曲目（4MB）还大 —— 只按体积排会把它选出来。所以「已知是片段」
   * 必须先于体积成立。见 looksLikeTrial。
   */
  const pickBest = (list) => {
    if (!list.length) return null
    return list.slice().sort((a, b) => {
      if (!!a.weak !== !!b.weak) return a.weak ? 1 : -1
      if (!!a.trial !== !!b.trial) return a.trial ? 1 : -1
      if (!!a.official !== !!b.official) return a.official ? -1 : 1
      const as = a.size || 0
      const bs = b.size || 0
      if (as !== bs) return bs - as               // 体积大 = 完整版
      return (Number.isFinite(a.rank) ? a.rank : Infinity) - (Number.isFinite(b.rank) ? b.rank : Infinity)
    })[0]
  }

  const flow = Promise.all(list.map(async (item, rank) => {
    const t = item.thunk
    let r = null
    try { r = await withDeadline(t(), deadline) } catch {
      // 抛异常 = 插件自己坏了，算它的账
      pluginStats.record(song.source, item.id, 'fail')
      return
    }
    if (!r || !r.url) {
      // 正常返回但没给地址：插件答了「我没有」，同样算它的账
      pluginStats.record(song.source, item.id, 'fail')
      return
    }

    /**
     * 这条候选**可以尝试的 URL 形态**，按优先级排列。
     *
     * 插件源给的直链大量是 http，而 http 在 https 页面里会被浏览器当混合内容拦掉，
     * 所以先试升级后的 https。但**不能只认 https**：有些中转源（如 QQ 的
     * `http://175.27.166.236/...`）是纯 http 的 IP，升 https 必失败 ——
     * 这时若本机允许 http 音频（安卓壳，见 http.js 的 allowHttpAudio）就退回原链，
     * 绝不因为「升级失败」白丢一条本来能播的候选。
     *
     * ⚠ 升级本身是**乐观**的（upgradeToHttps 现在一律升）：能不能真用由下面的
     * Range 探测判定。曾经只升一份域名白名单，导致酷狗 `*.bdycdn.cn` 那批
     * **唯一能出声**的 http 候选被整批丢弃、`/url` 打成 404（详见 upgradeToHttps 注释）。
     */
    const urls = []
    const up = upgradeToHttps(r.url)
    if (up !== r.url) urls.push(up)                                      // ① 升级后的 https
    if (/^https:\/\//i.test(r.url) || allowHttpAudio()) urls.push(r.url) // ② 原链（仅 http 宿主需要）
    const fresh = urls.filter(u => !seen.has(u))
    if (!fresh.length) {
      if (!urls.length) tried.push(`${r.from}(仅 http，无法直连)`)
      // URL 重复（别的插件已经给过同一地址）或纯 http 用不了 —— 这两种都
      // 不是「插件交出了坏音源」，记 skip，别冤枉它。
      pluginStats.record(song.source, item.id, 'skip')
      return
    }
    for (const u of fresh) seen.add(u)

    const rec = {
      url: fresh[0],
      from: r.from,
      official: false,
      weak: false,
      trial: r.trial === true,            // 源自己标的「这是试听片段」（见 wy.js 的 freeTrialInfo）
      size: 0,
      /**
       * 这条候选在服务端**偏好序**里的位次（0 = 服务端最想用的那条）。
       *
       * 就是 thunks 的下标，而 thunks 的顺序正是 `musicUrlCandidateList()` 给的：
       * 只包含插件，并按插件池实测评分降序（见 providers/index.js 与 plugins.js 的 setRank）。
       * 也就是说 **rank 里已经含着「哪个插件评分高」这个信息**。
       *
       * 为什么必须显式带给客户端：下面返回的 `ordered` 是
       * 「best 打头 + 其余按**探测完成先后**排列」—— 完成顺序是网络快慢，
       * 不是评分。插件评分到这一步就被冲掉了，客户端只看得到一串插件名，
       * 没法自己判断该信哪个。老板的原话是「插件也自动选择评分高的插件」。
       *
       * ⚠ 客户端**不一定会**照 rank 排：它还要优先排除试听片段、优先体积大的
       * （那条判据来自手机侧的真实网络，服务端探不出来）。rank 是给它做
       * 「同等条件下谁更该先试」的依据，不是命令。
       */
      rank,
    }
    cands.push(rec)                       // 先入列：哪怕探测没赶上预算也要能返回
    // 逐个形态探：先 https，探不通再退原 http（仅当它在 urls 里）。
    // 取**第一个探通**的形态；全都不通就保留最后一次的探测结果（ok=false）。
    let p = null
    for (const u of fresh) {
      p = await withDeadline(probeAudioBytes(u), probeDeadline)
      if (p.ok) { rec.url = u; break }
    }
    Object.assign(rec, p || { ok: false, size: 0, status: 0 })
    // official / weak 用**最终选中的那个形态**判定（升级前后域名相同，但保持口径一致）
    rec.official = hostMatches(rec.url, OFFICIAL_HOSTS)
    rec.weak = hostMatches(rec.url, WEAK_HOSTS)
    /**
     * 探测拿到体积之后**补齐** trial 标记。
     *
     * 这一步不能省：`looksLikeTrial` 的两个判据适用面不一样 ——
     * 源声明只有网易那一条链有，而「体积/声明时长推码率」对**任何**源都成立。
     * 实测同一首歌的 470KB 片段，`plugin:K×H测试` 也照样回同一个文件，
     * 只认源声明的话它就不会被标出来，客户端按体积重排时可能把它顶上去
     * （30 秒的**无损**片段体积可以超过 128k 完整版）。
     *
     * ⚠ 判据只此一份，不要再在这里另写一套体积比较。
     */
    rec.trial = looksLikeTrial(rec)
    /**
     * 记一笔在线命中率。
     *
     * 判据与下面的 `hardFail` **逐字一致**，这不是巧合：两处都在回答
     * 「这个插件这次到底行不行」，答案不一致会让排序与跨源判断互相打架。
     *
     *   · `notAudio`            → 假音源（中转站回了 JSON/HTML 却报 audio/mpeg）→ fail
     *   · `ok === false && status` → 真的被上游拒了（4xx/5xx）                  → fail
     *   · `ok === true`         → 真拉到了音频字节                              → ok
     *   · 其余（`status` 为 0）  → 预算到点、探测压根没跑完                     → skip
     *
     * 最后那条最容易写错：把它算成 fail，会让「慢但正常」的插件被降权，
     * 而它恰恰是 CF 出口上最常见的情形（酷狗 CDN 探测常常顶到 3200 的 deadline）。
     */
    if (rec.notAudio || (rec.ok === false && rec.status)) {
      pluginStats.record(song.source, item.id, 'fail')
    } else if (rec.ok) {
      pluginStats.record(song.source, item.id, 'ok')
    } else {
      pluginStats.record(song.source, item.id, 'skip')
    }
    if (rec.ok) {
      probed.push(rec)
      // 探通了：不再立刻收工，而是开一个短窗口多收几条再挑（见上面 SETTLE_MS 说明）。
      // earlyPayload 仍然记第一条 —— 窗口到点时若还没第二条，用的就是它。
      if (!earlyPayload) earlyPayload = rec
      const trial = rec.trial
      if (!settleTimer) {
        // 首条探通就开窗口。**但首条若是试听片段，窗口放到总预算** ——
        // 完整版可能只晚一步到，450ms 就收工等于把它关在门外（这就是
        // 「偶发只播 30 秒」的来源）。代价只是这一种情况下起播多等最多
        // 一个 totalBudget（网页 1.8s / 壳内 3.8s），比放 30 秒就没了划算得多。
        armSettle(trial ? Math.max(SETTLE_MS, totalBudget - (Date.now() - t0)) : SETTLE_MS, trial)
      } else if (!trial) {
        shortenSettle()                   // 已经等到完整版了，别再耗满预算
      }
    }
  }))

  const timer = setTimeout(releaseBudget, totalBudget)
  try {
    // 等三件事里先到的那个：
    //   ① 收敛窗口到点（有候选探通了）—— 正常路径，此时手上已有一批可挑的
    //   ② 全部 flow 跑完 —— 没有候选探通时的自然结束
    //   ③ 总预算到点 —— 兜底，防止个别源把整条链路拖死
    await Promise.race([budget, settle, flow.then(() => null, () => null)])
  } finally {
    clearTimeout(timer)
    if (settleTimer) clearTimeout(settleTimer)
  }

  if (earlyPayload) {
    // 在窗口内收集到的候选里挑「最完整的那条」，而不是「最先探通的那条」
    const best = pickBest(probed) || earlyPayload
    if (best !== earlyPayload) {
      tried.push(`已优先选用更完整的候选（${best.from}，${best.size ? Math.round(best.size / 1024) + 'KB' : '体积未知'}）`
        + `，放弃先探通的 ${earlyPayload.from}（${earlyPayload.size ? Math.round(earlyPayload.size / 1024) + 'KB' : '体积未知'}，疑似试听片段）`)
    }
    // 次要候选一并交出去：客户端那条首条失败就往下试的降级链正好用得上，
    // 而且它们已经被探过一遍（verified），比让客户端从零开始试要快。
    //
    // ⚠ `trial` 必须一起带上：客户端拿到 urls 后会**再按体积排一次**（第二道保险）。
    // 它要是不知道哪条是片段，就会把「30 秒的无损片段（5MB）」排在
    // 「128k 完整版（4MB）」前面 —— 体积大在这一档恰恰是错的信号。
    /*
     * ⚠ 次要候选必须按 compareCandidates 排序，**不能按「探测完成先后」交出去**。
     *
     * `probed` 的入列顺序是网络快慢，与「完整度」毫无关系：一条 30 秒试听片段
     * 先探通，就会被排到完整版前面。而 `/api/stream` 正是拿这份列表当 preferUrls
     * **串行取流**（不经过客户端那次重排）—— 于是「谁先探通就先取谁」，
     * 用户看到的就是「放 30 秒就没了」。web 端与安卓客户端都会走到这条路径
     * （直连级失败后退代理流时）。
     *
     * pickBest 与 compareCandidates 是同档位同顺序的两套实现（见各自注释），
     * 所以排序后的第一条就是 best；这里显式取一次，保证返回的 url 与 urls[0] 一致。
     */
    const ordered = probed.slice().sort(compareCandidates)
    const top = ordered[0] || best
    return {
      urls: ordered.map((x) => ({ url: x.url, from: x.from, size: x.size || 0, trial: x.trial === true, rank: x.rank })),
      url: top.url,
      from: top.from,
      size: top.size || 0,
      tried,
      unverified: false,
    }
  }

  // 一个候选都没解析出来 —— 这是「拿不到地址」里最容易被误读的一种：
  // tried 此时是空的（tried 只记录「解析出来了但被否掉」的），调用方只看到
  // 一句「无可用播放地址」，无从判断是源站慢、源站挂了，还是候选本身没建出来。
  // 所以这里补一条说明，把「候选数 + 等了多久」写进去。
  if (!cands.length) {
    return {
      urls: [],
      url: null,
      from: null,
      tried: [...tried, `${thunks.length} 个插件候选在 ${deadline}ms 内均未返回播放地址`],
      error: '取流插件未返回可用播放地址',
      unverified: true,
    }
  }

  // 预算到点（或全部跑完）仍无一条探通：把候选按可信度排好交出去，
  // 由客户端自己试。服务端探测走的是 Cloudflare 出口，和用户手机的网络不是一回事。
  for (const x of cands) {
    if (x.ok) continue
    tried.push(x.notAudio
      ? `${x.from}: 返回的不是音频（${x.contentType || '无 Content-Type'}）`
      : `${x.from}: 探测未通过(${x.status || x.err || '未完成'})`)
  }
  /**
   * ⚠ 明确「不是音频」的候选**一条都不能交出去**。
   *
   * 这批就是插件池里的中转站（回 `{"code":201,"msg":"error"}` 或 HTML 错误页）。
   * 以前这里无条件把 `cands` 全交出去，于是客户端拿到的第一条就是它们，
   * `<audio>` 立刻 `MEDIA_ELEMENT_ERROR: Format error` —— 用户看到的就是
   * 「点开专辑，大部分歌放不出来」。它们的共同特征是**已经证明放不出来**，
   * 交给客户端只是让它白等一轮，不如直接说「没有可用音源」。
   *
   * 保留的只有「网络没通」那批（status 0 / 超时）：服务端出口不通，
   * 不代表用户手机不通。
   */
  const soft = cands.filter((x) => !x.notAudio)
  if (!soft.length) {
    // 一条都没得交（全被证明是假音源）→ 立刻跨源，别让客户端去啃 /stream
    if (options.allowCrossSource !== false) {
      const tCross = Date.now()
      const x = await crossSourceResolveFast(song, quality, pluginPool, tried)
      if (x) return { ...x, perfMs: { primary: tCross - t0, cross: Date.now() - tCross } }
    }
    return {
      urls: [],
      url: null,
      from: null,
      tried,
      error: '取流插件返回的地址都不是音频（中转站/错误页）',
      unverified: true,
    }
  }
  /**
   * 有候选、但一条都没探通 —— 这时要不要跨源，判据必须收紧。
   *
   * 「没探通」有两种：① 服务端**真的拉过并被否掉**（假音源 / 4xx / 5xx）；
   * ② 预算到点，探测压根没跑完（`status` 为 0）。②里绝大多数地址其实是好的，
   * 只是慢 —— 对它做跨源等于给每首正常歌白加 2 秒。
   * 所以只在出现 ① 时才跨源。
   *
   * ⚠ 曾经试过再放宽一条「一条都没有超过 100KB 的体积也算」（想救 Docker 上
   * 那些直接 `fetch failed` 的中转站），**撤掉了**：酷狗专辑的曲目在 CF 上
   * 探测本来就常常跑不完（`totalMs` 会顶到 3200 的 deadline），放宽之后
   * 这些正常歌也会去跨源，等于把用户能播的酷狗源换成酷我源 —— 得不偿失。
   * 老板的原话：「能播放酷狗源就行，QQ 源播放不了没有关系」。
   */
  const hardFail = cands.some((x) => x.notAudio || (x.ok === false && x.status))
  if (hardFail && options.allowCrossSource !== false) {
    const tCross = Date.now()
    const x = await crossSourceResolveFast(song, quality, pluginPool, tried)
    if (x && x.url) return { ...x, perfMs: { primary: tCross - t0, cross: Date.now() - tCross } }
    // 跨源没成：留个标记，好让 /api/stream 知道「已经跨过了」而不是再试一遍
    tried.push('跨源兜底未找到可用的同名曲目')
    const ordered2 = soft.slice().sort(compareCandidates)
    return {
      urls: ordered2.map((x2) => ({ url: x2.url, from: x2.from, size: x2.size || 0, trial: x2.trial === true, rank: x2.rank })),
      url: ordered2[0].url,
      from: ordered2[0].from,
      tried,
      unverified: true,
      crossTried: true,
    }
  }
  const ordered = soft.slice().sort(compareCandidates)
  return {
    urls: ordered.map((x) => ({ url: x.url, from: x.from, size: x.size || 0, trial: x.trial === true, rank: x.rank })),
    url: ordered[0].url,
    from: ordered[0].from,
    tried,
    unverified: true,
  }
}

/**
 * 候选排序（依次比较，先满足者胜出）：
 *   ① 已知死接口排最后 —— 网易 outer/url 实测 302 到 /404，放前面纯属白等；
 *   ② **已知试听片段排最后** —— 30 秒的无损片段可能有 5MB，按体积排会把它选出来；
 *   ③ 已知 CDN 域名特征优先 —— 仅比较插件返回地址的域名，并非 provider 官方直连；
 *   ④ 体积大优先 —— 完整版，酷我 n1 试听片段只有 0.17MB；
 *   ⑤ 插件评分序优先（rank 小者先）。
 *
 * ⚠ 必须与上面的 pickBest 同档位同顺序，改一处就要改另一处。
 */
function compareCandidates(a, b) {
  if (!!a.weak !== !!b.weak) return a.weak ? 1 : -1
  if (!!a.trial !== !!b.trial) return a.trial ? 1 : -1
  if (!!a.official !== !!b.official) return a.official ? -1 : 1
  if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0)
  return (Number.isFinite(a.rank) ? a.rank : Infinity) - (Number.isFinite(b.rank) ? b.rank : Infinity)
}
