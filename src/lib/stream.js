/**
 * 统一的「逐个候选取流」逻辑
 *
 * 为什么需要它：聚合类音源里总有个别源失效（接口挂了 / 被风控 / 返回的是
 * 一个 HTML 错误页）。如果只认第一个返回地址的源，就会出现「A 源挂了 → 整首歌
 * 播不了」，即使后面还有 4 个源可用。
 *
 * 于是这里改成三级兜底：
 *   1) 本平台的所有插件 + 原生接口，逐个真拉一次，拿到音频字节才认；
 *   2) 全部失败时，跨平台搜同名歌曲（用户的诉求是「听到这首歌」，不是「必须来自酷狗」）；
 *   3) 仍失败才报错，并把每个候选的失败原因一并返回，便于排查。
 */
import { musicUrlCandidateList, searchOnline, ALL_SOURCES, SOURCE_META } from '../providers/index.js'
import { audioMime, guessAudioFormat, decodeName } from './util.js'
import { outboundFetch, allowHttpAudio, resolveBudget } from './http.js'

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

/** 明显的「不是音频」的响应类型 */
function looksLikeError(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (!ct) return false
  return ct.includes('text/html') || ct.includes('application/json')
    || ct.includes('text/plain') || ct.includes('text/xml')
}

/** 标题归一化：去掉括号补充说明与标点，用于跨平台同名匹配 */
function normTitle(name) {
  return decodeName(String(name || ''))
    .toLowerCase()
    .replace(/[（(\[【{].*?[)）\]】}]/g, '')
    .replace(/[\s\-_·、,，.。!！?？'"“”‘’&+]/g, '')
}

function singerTokens(singer) {
  return decodeName(String(singer || ''))
    .split(/[、,&/＋+]|\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 跨平台找同名歌曲（最多 limit 首），按歌手是否重合排序 */
async function crossSourceSongs(song, limit = 2) {
  const wanted = normTitle(song.name)
  if (!wanted) return []
  const tokens = singerTokens(song.singer)
  const keyword = [song.name, tokens[0]].filter(Boolean).join(' ').trim()
  if (!keyword) return []

  const sources = ALL_SOURCES.filter(s => s !== song.source)
  let list = []
  try {
    // 跨源是「兜底」，用户已经在等了，所以给搜索一个更紧的超时（默认 7s 太长）
    const res = await searchOnline(keyword, { sources, limit: 24, timeout: 4000 })
    list = res.list || []
  } catch {
    return []
  }

  return list
    .filter(s => s && s.id && normTitle(s.name) === wanted)
    .sort((a, b) => {
      const sa = tokens.some(t => (singerTokens(a.singer)).includes(t)) ? 1 : 0
      const sb = tokens.some(t => (singerTokens(b.singer)).includes(t)) ? 1 : 0
      return sb - sa
    })
    .slice(0, limit)
}

/**
 * 单个候选的最长等待时间。
 * 为什么要它：聚合源里总有「连得上但不吐数据」的地址，不加超时就会一直挂着，
 * 实测把一次代理取流从 1 秒拖到 19 秒（kg 的第三方中转源）。超时即换下一个。
 */
const CANDIDATE_TIMEOUT = 6000

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

  result = await tryCandidates(
    musicUrlCandidateList(song, quality, pluginPool).slice(0, maxCandidates),
    song, errors, seen, opts
  )
  if (result) return result

  return await crossSourceFallback(song, quality, pluginPool, opts, errors, seen)
}

/** 本平台全挂 → 跨平台搜同名歌曲（用户的诉求是「听到这首歌」，不是「必须来自酷狗」） */
async function crossSourceFallback(song, quality, pluginPool, opts, errors, seen) {
  if (opts.allowCrossSource === false) return null
  const alts = await crossSourceSongs(song, opts.crossSourceLimit || 2)
  for (const alt of alts) {
    const r = await tryCandidates(
      musicUrlCandidateList(alt, quality, pluginPool).slice(0, 4), alt, errors, seen, opts
    )
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
      ? `所有音源均无法播放（试了 ${errors.length} 个）：${errors.slice(0, 3).join('；')}`
      : '该歌曲暂无可用音源，请更换关键字或音源插件',
  }
}

/** 探测候选地址是否真的能出音频（供 /api/url 用） */
export async function probeAudioUrl(url) {
  try {
    const res = await outboundFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-1' },
      redirect: 'follow',
    })
    const ct = res.headers.get('content-type') || ''
    try { await res.body?.cancel() } catch { /* ignore */ }
    return (res.ok || res.status === 206) && !looksLikeError(ct)
  } catch {
    return false
  }
}

/**
 * 解析出一个「已探测可用」的直链，供 /api/url 使用。
 * 只探测前几个候选，避免拖慢响应。
 */
export async function resolvePlayableUrl(song, quality, pluginPool, { maxProbe = 4 } = {}) {
  const thunks = musicUrlCandidateList(song, quality, pluginPool).slice(0, maxProbe)
  const tried = []
  for (const thunk of thunks) {
    let cand = null
    try { cand = await thunk() } catch { continue }
    if (!cand || !cand.url) continue
    tried.push(cand.from)
    if (await probeAudioUrl(cand.url)) return { url: cand.url, from: cand.from, tried }
  }
  // 全都探测失败时，仍把第一个能解析出的地址给出去（客户端也许能放）
  for (const thunk of thunks) {
    try {
      const cand = await thunk()
      if (cand && cand.url) return { url: cand.url, from: cand.from, tried, unverified: true }
    } catch { /* ignore */ }
  }
  return { url: null, from: null, tried }
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

/** 同时支持 http / https 的源站白名单。只升级这些，避免把不支持 https 的源改坏 */
const HTTPS_UPGRADE_HOSTS = [
  /\.music\.126\.net$/i,   // 网易云 CDN（m701/m702/m802…）
  /\.kuwo\.cn$/i,          // 酷我
  /\.kugou\.com$/i,        // 酷狗
  /\.kglink\.cn$/i,        // 酷狗直链
  /\.qqmusic\.qq\.com$/i,  // QQ 音乐
  /\.music\.qq\.com$/i,
]

/** 官方 CDN：同一份字节少一跳，且探测得到 content-range（第三方中转往往不返回，体积算不出来） */
const OFFICIAL_HOSTS = [/\.music\.126\.net$/i, /\.kuwo\.cn$/i, /\.kugou\.com$/i,
  /\.kglink\.cn$/i, /\.qqmusic\.qq\.com$/i, /\.music\.qq\.com$/i]

/**
 * 已知的死接口，排到最后。
 * 实测 `music.163.com/song/media/outer/url?id=X.mp3` 对绝大多数曲目返回
 * 302 → http://music.163.com/404（非音频内容），把它排在前面只会白等一次超时。
 */
const WEAK_HOSTS = [/^music\.163\.com$/i]

export function upgradeToHttps(url) {
  const raw = String(url || '')
  if (!/^http:\/\//i.test(raw)) return raw
  try {
    const host = new URL(raw).hostname
    return HTTPS_UPGRADE_HOSTS.some((re) => re.test(host)) ? raw.replace(/^http:/i, 'https:') : raw
  } catch { return raw }
}

function hostMatches(url, list) {
  try { return list.some((re) => re.test(new URL(url).hostname)) } catch { return false }
}

/**
 * 只探前 2 字节，判断这个地址是不是真音频、总长多少。
 * 用 Range 而不是完整 GET：单次约 120~240ms（实测），且不消耗源站流量。
 */
async function probeAudioBytes(url) {
  try {
    const res = await outboundFetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', Range: 'bytes=0-1' },
      redirect: 'follow',
    })
    const contentType = res.headers.get('content-type') || ''
    const contentRange = res.headers.get('content-range') || ''
    const size = Number((contentRange.match(/\/(\d+)\s*$/) || [])[1] || res.headers.get('content-length') || 0)
    try { await res.body?.cancel() } catch { /* ignore */ }
    const ok = (res.ok || res.status === 206) && !looksLikeError(contentType)
    return { ok, size, status: res.status, contentType }
  } catch (e) {
    return { ok: false, size: 0, status: 0, err: (e && e.message) || String(e) }
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
 *   urls 已按「体积降序（完整版优先）、原生优先」排好，客户端按序降级即可。
 *   全部探测失败时不返回空，而是兜底给出第一个 https 候选（unverified），
 *   让客户端自己试 —— 宁可多一次尝试，也不要直接判定「无音源」。
 */
export async function resolveMusicUrlFast(song, quality, pluginPool, options = {}) {
  // 宿主默认预算（网页紧、壳内宽），调用方传入的 options 优先 —— 见 http.js 的 resolveBudget
  const {
    maxTries = 12, deadline = 1600, probeDeadline = 1200, totalBudget = 1800,
  } = { ...resolveBudget(), ...options }
  // 原生优先：官方 CDN 直链比第三方插件中转稳（实测插件源 music-dl.sayqz.com 常年 530）。
  //
  // maxTries 的取值有讲究：原生接口会占掉固定几个槽位（酷狗一次摊成 3 个直链槽），
  // 槽位空的时候也照样占名额。实测截断到 6 会把后面的插件候选挤掉，
  // 导致「明明有 5 个 wy 插件，只试了 3 个」。
  //
  // 放到 12 是为了配合「插件实测评分排序表」：池子里现在有十几个可用插件，
  // 只取 8 个的话排在第 9 位之后的等于白装。这里是**并行**解析 + totalBudget 兜底，
  // 多给几个槽位只增加并发数，不增加等待时间（到点就带着已解析的候选返回）。
  const thunks = musicUrlCandidateList(song, quality, pluginPool, { prefer: 'native' }).slice(0, maxTries)
  const tried = []
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
   */
  const SETTLE_MS = 450
  let settleTimer = null
  let releaseSettle = null
  const settle = new Promise((res) => { releaseSettle = res })
  const armSettle = () => {
    if (settleTimer) return
    settleTimer = setTimeout(releaseSettle, SETTLE_MS)
  }
  const probed = []          // 探通且 ok 的候选，供 pickBest 挑

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
   *   ① weak 最后   ② official 优先   ③ 体积大优先   ④ native 优先
   * 两边改一处就要改另一处；test/stream-pick.mjs 有一条一致性断言盯着它们。
   */
  const pickBest = (list) => {
    if (!list.length) return null
    return list.slice().sort((a, b) => {
      if (!!a.weak !== !!b.weak) return a.weak ? 1 : -1
      if (!!a.official !== !!b.official) return a.official ? -1 : 1
      const as = a.size || 0
      const bs = b.size || 0
      if (as !== bs) return bs - as               // 体积大 = 完整版
      return (b.native ? 1 : 0) - (a.native ? 1 : 0)
    })[0]
  }

  const flow = Promise.all(thunks.map(async (t) => {
    let r = null
    try { r = await withDeadline(t(), deadline) } catch { return }
    if (!r || !r.url) return
    // http 在 https 页面会被浏览器当混合内容拦掉，先升级协议再判定。
    // 例外：安卓壳允许 http 音频（见 http.js 的 allowHttpAudio），
    // 这时若还把「http 直链」丢掉，就等于白白扔掉一批本来能直连的源 ——
    // 实测就是这一条把 fast 路径打成 404 的（候选全是 http，全被丢弃）。
    const url = upgradeToHttps(r.url)
    if (!/^https:\/\//i.test(url) && !(allowHttpAudio() && /^http:\/\//i.test(url))) {
      tried.push(`${r.from}(仅 http，无法直连)`)
      return
    }
    if (seen.has(url)) return
    seen.add(url)

    const rec = {
      url,
      from: r.from,
      native: r.from === 'native',
      official: hostMatches(url, OFFICIAL_HOSTS),
      weak: hostMatches(url, WEAK_HOSTS),
      size: 0,
    }
    cands.push(rec)                       // 先入列：哪怕探测没赶上预算也要能返回
    const p = await withDeadline(probeAudioBytes(url), probeDeadline)
    Object.assign(rec, p)
    if (rec.ok) {
      probed.push(rec)
      // 探通了：不再立刻收工，而是开一个短窗口多收几条再挑（见上面 SETTLE_MS 说明）。
      // earlyPayload 仍然记第一条 —— 窗口到点时若还没第二条，用的就是它。
      if (!earlyPayload) earlyPayload = rec
      armSettle()
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
    const ordered = [best, ...probed.filter(x => x !== best)]
      .map((x) => ({ url: x.url, from: x.from, size: x.size || 0 }))
    return {
      urls: ordered,
      url: best.url,
      from: best.from,
      size: best.size || 0,
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
      tried: [...tried, `${thunks.length} 个候选在 ${deadline}ms 内均未解析出地址（多数是源站慢或不可达）`],
      unverified: true,
    }
  }

  // 预算到点（或全部跑完）仍无一条探通：把候选按可信度排好交出去，
  // 由客户端自己试。服务端探测走的是 Cloudflare 出口，和用户手机的网络不是一回事。
  for (const x of cands) {
    if (!x.ok) tried.push(`${x.from}: 探测未通过(${x.status || x.err || '未完成'})`)
  }
  const ordered = cands.slice().sort(compareCandidates)
  return {
    urls: ordered.map((x) => ({ url: x.url, from: x.from, size: x.size || 0 })),
    url: ordered[0].url,
    from: ordered[0].from,
    tried,
    unverified: true,
  }
}

/**
 * 候选排序（依次比较，先满足者胜出）：
 *   ① 已知死接口排最后 —— 网易 outer/url 实测 302 到 /404，放前面纯属白等；
 *   ② 官方 CDN 优先 —— 同字节少一跳，且能返回 content-range 算得出体积；
 *   ③ 体积大优先 —— 完整版，酷我 n1 试听片段只有 0.17MB；
 *   ④ 原生优先。
 */
function compareCandidates(a, b) {
  if (!!a.weak !== !!b.weak) return a.weak ? 1 : -1
  if (!!a.official !== !!b.official) return a.official ? -1 : 1
  if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0)
  return (b.native ? 1 : 0) - (a.native ? 1 : 0)
}
