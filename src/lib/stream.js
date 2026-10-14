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

  const pluginThunks = musicUrlCandidateList(song, quality, pluginPool).slice(0, maxCandidates)
  result = await tryCandidates(pluginThunks, song, errors, seen, opts)
  if (result) return result

  return await crossSourceFallback(song, quality, pluginPool, opts, errors, seen)
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
  if (!thunks.length) {
    return { url: null, from: null, tried, error: '当前歌曲来源没有启用取流插件' }
  }
  for (const thunk of thunks) {
    let cand = null
    try { cand = await thunk() } catch { continue }
    if (!cand || !cand.url) continue
    tried.push(cand.from)
    if (await probeAudioUrl(cand.url)) return { url: cand.url, from: cand.from, tried }
  }
  // 全都探测失败时，仍把第一个插件返回的地址给出去（客户端也许能放）
  for (const thunk of thunks) {
    try {
      const cand = await thunk()
      if (cand && cand.url) return { url: cand.url, from: cand.from, tried, unverified: true }
    } catch { /* ignore */ }
  }
  return { url: null, from: null, tried, error: '所有取流插件均未返回可用地址' }
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
 *   urls 由插件取流候选组成，并按「体积、来源健康度与插件评分序」交给客户端降级。
 *   全部探测失败时不返回空，而是兜底给出第一个插件返回的 https 候选（unverified），
 *   让客户端自己试 —— 不会转而调用 provider 的官方直连接口。
 */
export async function resolveMusicUrlFast(song, quality, pluginPool, options = {}) {
  // 宿主默认预算（网页紧、壳内宽），调用方传入的 options 优先 —— 见 http.js 的 resolveBudget
  const {
    maxTries = 12, deadline = 1600, probeDeadline = 1200, totalBudget = 1800,
  } = { ...resolveBudget(), ...options }
  // 候选只来自 musicUrl 插件；按插件池的评分序并行解析，不调用 provider 官方取流接口。
  // 放到 12 是为了不让前面的空槽位挤掉评分靠后的插件；并行解析 + totalBudget
  // 只增加并发数，不增加等待时间（到点就带着已解析出的插件候选返回）。
  const thunks = musicUrlCandidateList(song, quality, pluginPool).slice(0, maxTries)
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

  const flow = Promise.all(thunks.map(async (t, rank) => {
    let r = null
    try { r = await withDeadline(t(), deadline) } catch { return }
    if (!r || !r.url) return

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
    if (!x.ok) tried.push(`${x.from}: 探测未通过(${x.status || x.err || '未完成'})`)
  }
  const ordered = cands.slice().sort(compareCandidates)
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
