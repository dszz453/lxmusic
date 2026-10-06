/**
 * 多平台聚合层：统一搜索 / 取流 / 歌词 / 封面 / 歌单导入
 * 取流优先级：落雪插件 > 平台原生接口
 */
import kg from './kg.js'
import wy from './wy.js'
import kw from './kw.js'
import tx from './tx.js'
import mg from './mg.js'
import xm from './xm.js'
import { matchQishuiShort, matchDouyinShare, expandQishuiShare, getQishuiPlaylist } from './qishui.js'
import { request, UA_MOBILE } from '../lib/http.js'
import { decodeName, safeInt, userError } from '../lib/util.js'

export const PROVIDERS = { kg, wy, kw, tx, mg, xm }

export const SOURCE_META = {
  kg: { key: 'kg', name: '酷狗音乐', short: '酷狗' },
  wy: { key: 'wy', name: '网易云音乐', short: '网易' },
  kw: { key: 'kw', name: '酷我音乐', short: '酷我' },
  tx: { key: 'tx', name: 'QQ音乐', short: 'QQ' },
  mg: { key: 'mg', name: '咪咕音乐', short: '咪咕' },
  // 喜马拉雅是音频节目平台（有声书/播客/电台），不是音乐平台 ——
  // 「一首歌」在这里是一集音频，UI 上按「单集/专辑」措辞更贴切。
  xm: { key: 'xm', name: '喜马拉雅', short: '喜马', audio: true },
}

export const ALL_SOURCES = Object.keys(PROVIDERS)

export function getProvider(source) {
  return PROVIDERS[source] || null
}

/** 解析 `wy:周杰伦` 这类前缀写法；无前缀时选第一个可用平台 */
export function parseQuery(input, fallbackSources = ALL_SOURCES) {
  const raw = String(input || '').trim()
  const m = raw.match(/^(all|online|local|[a-z]{2})\s*[:：]\s*(.*)$/i)
  if (m) {
    const key = m[1].toLowerCase()
    if (PROVIDERS[key]) return { sources: [key], keyword: m[2].trim() }
    if (key === 'all' || key === 'online') return { sources: fallbackSources, keyword: m[2].trim() }
  }
  return { sources: fallbackSources, keyword: raw }
}

/**
 * 在线搜索。多平台并发；单平台失败不影响整体。
 */
/**
 * 单个平台搜索的硬超时（毫秒）。
 * 实测：QQ 在 Cloudflare 出口被拒时，4 个域名逐一重试要 12~17 秒，
 * 会把「综合搜索」从 1.5 秒拖到 10 秒以上 —— 用户等不起。
 * 超时即跳过并记一条错误，绝不阻塞其它平台。
 */
export const SOURCE_TIMEOUT = 7000

export async function searchOnline(keyword, { sources = ALL_SOURCES, page = 1, limit = 30, pluginPool = null, timeout = SOURCE_TIMEOUT } = {}) {
  const targets = sources.filter(s => PROVIDERS[s])
  if (!targets.length || !keyword) return { list: [], total: 0, source: 'all', errors: [] }

  const perSource = Math.max(5, Math.ceil(limit / targets.length) + 5)
  const errors = []
  const settled = await Promise.all(targets.map(async src => {
    const short = SOURCE_META[src] ? SOURCE_META[src].short : src
    let timer = null
    const result = await Promise.race([
      PROVIDERS[src].search(keyword, page, perSource)
        .then(r => ({ ok: true, list: r.list || [] }))
        .catch(e => ({ ok: false, error: (e && e.message) || String(e) })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, timeout: true }), timeout)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (result.ok) return result.list
    errors.push(result.timeout
      ? `${short}: 响应超时（${timeout}ms 内未返回，已跳过）`
      : `${short}: ${result.error}`)
    return []
  }))

  const list = interleave(settled).slice(0, limit)
  const total = settled.reduce((acc, l) => acc + l.length, 0)
  return { list, total, source: targets.length === 1 ? targets[0] : 'all', errors }
}

/**
 * 专辑搜索：与 searchOnline 同一套并发 / 超时 / 交错合并逻辑，
 * 只是把各平台的方法换成 searchAlbum。没实现的平台自动跳过。
 */
export async function searchAlbums(keyword, { sources = ALL_SOURCES, page = 1, limit = 20, timeout = SOURCE_TIMEOUT } = {}) {
  const targets = sources.filter(s => PROVIDERS[s] && typeof PROVIDERS[s].searchAlbum === 'function')
  if (!targets.length || !keyword) return { list: [], total: 0, errors: [] }

  const perSource = Math.max(5, Math.ceil(limit / targets.length) + 5)
  const errors = []
  const settled = await Promise.all(targets.map(async src => {
    const short = SOURCE_META[src] ? SOURCE_META[src].short : src
    let timer = null
    const result = await Promise.race([
      PROVIDERS[src].searchAlbum(keyword, page, perSource)
        .then(r => ({ ok: true, list: r.list || [] }))
        .catch(e => ({ ok: false, error: (e && e.message) || String(e) })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, timeout: true }), timeout)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (result.ok) return result.list
    errors.push(result.timeout
      ? `${short}: 专辑搜索响应超时（${timeout}ms 内未返回，已跳过）`
      : `${short}: ${result.error}`)
    return []
  }))

  return {
    list: interleave(settled).slice(0, limit),
    total: settled.reduce((acc, l) => acc + l.length, 0),
    errors,
  }
}

/**
 * 打开一张专辑 = 列出它的全部曲目。
 *
 * 各平台支持情况（实测 2026-10）：
 *   kg  手机版 album/song（注意必须 http）      ✅
 *   wy  eapi /api/v1/album/{id}                ✅
 *   tx  fcg_v8_album_info_cp（按 albummid）     ✅
 *   xm  mobile others/ca/album/track           ✅
 *   kw  web 接口要 csrf token（需两跳取 cookie），r.s?op=album 已返回 TOTAL=0
 *   mg  MIGUM2.0 下除 search/listenSong 外的路由全部「路由请求不支持」
 *   → kw / mg 目前只能搜到专辑、点不开，上层据此给出明确提示，不要假装成功。
 */
export async function fetchAlbumTracks(source, albumId, limit = 200) {
  const provider = PROVIDERS[source]
  if (!provider) throw new Error('不支持的平台')
  if (typeof provider.getAlbum !== 'function') {
    throw new Error(`${SOURCE_META[source] ? SOURCE_META[source].name : source}暂不支持查看专辑曲目`)
  }
  return provider.getAlbum(albumId, limit)
}

/** 轮转交错合并，避免单一平台占满首屏 */
function interleave(groups) {
  const out = []
  const max = Math.max(0, ...groups.map(g => g.length))
  for (let i = 0; i < max; i++) {
    for (const g of groups) {
      if (g[i]) out.push(g[i])
    }
  }
  return out
}

/**
 * 播放地址「候选流」：插件按声明顺序排列，原生接口兜底。
 * 返回一串惰性 thunk —— 调用方可以逐个尝试，直到拿到真正能播的地址。
 * 这是「保覆盖」的关键：单个插件源失效不应导致整首歌播不了。
 *
 * @returns {Array<() => Promise<{url:string, from:string}|null>>}
 */
export function musicUrlCandidateList(song, quality = '320k', pluginPool = null, opts = {}) {
  if (!song || !song.source) return []

  const pluginThunks = () => {
    const out = []
    if (pluginPool && typeof pluginPool.musicUrlPlugins === 'function') {
      for (const plugin of pluginPool.musicUrlPlugins(song.source, 'musicUrl')) {
        out.push(async () => {
          const r = await pluginPool.invokePlugin(plugin, song.source, 'musicUrl', { type: quality, musicInfo: song })
          return r.ok ? { url: r.value, from: `plugin:${r.plugin}` } : null
        })
      }
    } else if (pluginPool && pluginPool.supports(song.source, 'musicUrl')) {
      out.push(async () => {
        const res = await pluginPool.invoke(song.source, 'musicUrl', { type: quality, musicInfo: song })
        return res.value ? { url: res.value, from: `plugin:${res.plugin}` } : null
      })
    }
    return out
  }

  const nativeThunks = () => {
    const out = []
    const provider = PROVIDERS[song.source]
    if (provider && typeof provider.getMusicUrlCandidates === 'function') {
      // 原生接口本身可能返回多条直链（如酷狗），一次调用摊成多个候选槽位
      let cache = null
      const load = async () => {
        if (cache === null) {
          cache = await provider.getMusicUrlCandidates(song, quality).catch(() => [])
        }
        return cache
      }
      for (let i = 0; i < 3; i++) {
        out.push(async () => {
          const list = await load()
          return list[i] ? { url: list[i], from: 'native' } : null
        })
      }
    } else if (provider && typeof provider.getMusicUrl === 'function') {
      out.push(async () => {
        try {
          const url = await provider.getMusicUrl(song, quality)
          return url ? { url, from: 'native' } : null
        } catch { return null }
      })
    }
    return out
  }

  // 默认插件优先（服务端代理播放沿用的既有顺序）；
  // prefer='native' 时原生优先 —— 官方 CDN 直链比第三方插件中转稳，
  // 浏览器直连播放走这条路（实测第三方插件源 music-dl.sayqz.com 常年 530）。
  return opts.prefer === 'native'
    ? nativeThunks().concat(pluginThunks())
    : pluginThunks().concat(nativeThunks())
}

/**
 * 解析播放地址：返回候选列表里第一个能给出地址的（不做可用性探测）
 * @returns {{url:string|null, from:string, errors:string[]}}
 */
export async function resolveMusicUrl(song, quality = '320k', pluginPool = null) {
  if (!song || !song.source) return { url: null, from: 'none', errors: ['无效歌曲'] }
  const thunks = musicUrlCandidateList(song, quality, pluginPool)
  for (const thunk of thunks) {
    const cand = await thunk()
    if (cand && cand.url) return { url: cand.url, from: cand.from, errors: [] }
  }
  return { url: null, from: 'none', errors: ['所有音源均未返回可用地址'] }
}

/**
 * 从一份歌词返回值里抠出「歌词正文」。
 *
 * 为什么要这一步：插件（LX 格式）即使取不到词，也会**成功地**返回
 * `{ lyric: '', tlyric: null, rlyric: null, lxlyric: null }` —— 对象是真的、
 * 里面一个字都没有。而 /api/lyric 的判空只看 `if (res.value)`，
 * 于是一个空壳对象就把后面所有能用的源全挡掉了。
 * 线上表现就是「全平台都没有歌词」：插件先手拿到「成功」，原生接口根本没被调用过。
 *
 * 所以这里统一以「有没有正文」为准：字符串直接用；对象取 lyric / lrc 字段。
 */
function lyricText(v) {
  if (!v) return ''
  if (typeof v === 'string') return v
  return String(v.lyric || v.lrc || v.tlyric || '')
}

/**
 * 取歌词：插件优先，但**只有真的带回正文才算数**，否则退到平台原生接口。
 * 两边都没有就返回 null —— 界面老老实实显示「暂无歌词」，
 * 不要拿一个空壳当成「有歌词」交上去。
 */
export async function resolveLyric(song, pluginPool = null) {
  if (pluginPool && pluginPool.supports(song.source, 'lyric')) {
    const res = await pluginPool.invoke(song.source, 'lyric', { musicInfo: song })
    if (lyricText(res.value)) return res.value
  }
  const provider = PROVIDERS[song.source]
  if (provider && provider.getLyric) {
    try {
      const r = await provider.getLyric(song)
      if (lyricText(r)) return r
    } catch { /* ignore */ }
  }
  return null
}

export async function resolvePic(song, pluginPool = null) {
  if (song && song.img) return song.img
  const provider = PROVIDERS[song.source]
  if (provider && provider.getPic) {
    try { return await provider.getPic(song) } catch { /* ignore */ }
  }
  return null
}

/**
 * 从「歌单链接或 ID」解析出平台与 ID
 * 支持：
 *   酷狗 https://www.kugou.com/yy/special/single/519669.html  / 纯数字
 *   网易 https://music.163.com/#/playlist?id=3778678  / 纯数字
 *   酷我 https://www.kuwo.cn/playlist_detail/123456
 *   QQ   https://y.qq.com/n/ryqq/playlist/7011264340
 *   网易分享短链  https://163cn.tv/KYUDUJAZ        （short:true，需联网展开，见 resolvePlaylistRef）
 *   汽水分享短链  https://qishui.douyin.com/s/ix9JA2oW/
 *   汽水落地页    https://music.douyin.com/qishui/share/playlist?playlist_id=...
 *
 * 这里只做「认得出」这一步，**不发网络请求**：这个函数在同步路径上被人调用，
 * 加个 await 会把调用方全拖成异步。需要联网展开的短链只标 short:true，
 * 由 resolvePlaylistRef 去补。
 */
export function parsePlaylistRef(input, defaultSource = null) {
  const raw = String(input || '').trim()
  if (!raw) return null

  // 从分享文案里粘过来的整段（「分享一首歌给你：… https://…」）也要能认。
  // 手机上的分享默认就是带文案的，让用户自己删干净不现实。
  const embed = raw.match(/https?:\/\/[^\s"'）)】]+/i)
  if (embed && embed[0] !== raw) {
    const inner = parsePlaylistRef(embed[0], defaultSource)
    if (inner) return inner
  }

  // 显式前缀：wy:3778678 / kg:519669 / xm:28971059
  const prefixed = raw.match(/^(kg|wy|kw|tx|mg|xm)\s*[:：]\s*(.+)$/i)
  if (prefixed) {
    const id = (prefixed[2].match(/\d+/) || [])[0]
    if (id) return { source: prefixed[1].toLowerCase(), id }
  }

  const urlMatch = raw.match(/^https?:\/\//i)
  if (urlMatch) {
    let host = ''
    let id = ''
    let u = null          // 163cn.tv 那一段要用到 pathname，得提到 try 外面
    try {
      u = new URL(raw)
      host = u.hostname.toLowerCase()
      const q = u.searchParams
      id = q.get('id') || q.get('specialid') || q.get('disstid') || q.get('pid') || ''
      if (!id) {
        const m = u.pathname.match(/(\d{3,})/)
        id = m ? m[1] : ''
      }
      if (!id && u.hash) {
        const hm = u.hash.match(/(\d{3,})/)
        id = hm ? hm[1] : ''
      }
    } catch { return null }

    // 汽水：短链 / 落地页。id 可能是纯字母短码，所以不能走上面那套「抓数字」的逻辑
    const qsShort = matchQishuiShort(raw)
    if (qsShort) return { source: 'qs', id: qsShort, short: true }
    const dy = matchDouyinShare(raw)
    if (dy) {
      if (dy.kind === 'playlist') return { source: 'qs', id: dy.id }
      if (dy.kind === 'track') return { source: 'qs', id: dy.id, kind: 'track' }
      return { source: 'qs', id: dy.id, kind: 'video' }
    }

    // 网易分享短链：163cn.tv/<code>。域名不带 id，必须联网展开。
    if (/(^|\.)163cn\.tv$/i.test(host)) {
      const code = (u.pathname.match(/\/([A-Za-z0-9_-]{3,})/) || [])[1]
      if (!code) return null
      return { source: 'wy', id: code, short: true }
    }

    if (/kugou\.com/.test(host)) return id ? { source: 'kg', id } : null
    if (/163\.com/.test(host)) return id ? { source: 'wy', id } : null
    if (/kuwo\.cn/.test(host)) return id ? { source: 'kw', id } : null
    if (/ximalaya\.com/.test(host)) return id ? { source: 'xm', id } : null
    if (/migu\.cn/.test(host)) return id ? { source: 'mg', id } : null
    if (/qq\.com/.test(host)) return id ? { source: 'tx', id } : null
    return id ? { source: defaultSource || 'wy', id } : null
  }

  const digits = raw.match(/\d{3,}/)
  if (digits) return { source: defaultSource || 'wy', id: digits[0] }
  return null
}

/**
 * 把短链展开成「真正的平台 + 数字 id」，其余情况原样返回。
 *
 * 为什么要单独一步：判定短链需要联网（网易 163cn.tv 是 302，汽水短链也是 302），
 * 而 parsePlaylistRef 被同步调用（比如前端拿着 id 直接拼链接），不能在里面发请求。
 * 于是「认得出」与「解得开」分成两步：同步的那步每个调用方都能用，
 * 要导入这种真需要联网的场景再来调这里。
 *
 * 展开失败不抛异常，而是挂一个 `expandFailed` 标记 —— 由调用方翻成人话。
 * 这个标记是必要的：短链失效时**两边都不报错**。抖音那边返回 200 + {"message":"404 not found"}，
 * 网易那边 302 到一个 404 的落地页。要是只看状态码，就会一路走到「歌单为空」，
 * 用户看到的是「解析失败」，完全猜不到真正的原因是「你这条分享链接过期了」。
 */
export async function resolvePlaylistRef(input, defaultSource = null) {
  const ref = parsePlaylistRef(input, defaultSource)
  if (!ref) return null

  if (ref.source === 'qs') {
    // 已经是落地页链接的话不用再跳一次；短码才需要展开
    const direct = matchDouyinShare(String(input))
    if (direct && direct.kind === 'playlist') return { source: 'qs', id: direct.id, kind: 'playlist' }
    const expanded = await expandQishuiShare(String(input).trim())
    if (!expanded) return { ...ref, expandFailed: true }
    return { source: 'qs', id: expanded.id, kind: expanded.kind, expandedFrom: ref.id }
  }

  if (ref.short) {
    const finalUrl = await expandShortLink(String(input).trim())
    if (!finalUrl) return { ...ref, expandFailed: true }
    const inner = parsePlaylistRef(finalUrl, defaultSource)
    // 展开出来的还是短链（自己指自己）或者压根认不出来 → 当作失效
    if (!inner || (inner.short && inner.id === ref.id) || !/\d{3,}/.test(inner.id || '')) {
      return { ...ref, expandFailed: true }
    }
    return { ...inner, expandedFrom: ref.id }
  }

  return ref
}

/** 跟随 302 拿到最终 URL；拿不到返回 ''。 */
async function expandShortLink(url) {
  try {
    const res = await request(url, { raw: true, redirect: 'follow', timeout: 12000, headers: { 'User-Agent': UA_MOBILE }, retry: 1 })
    return (res && res.url) || ''
  } catch {
    return ''
  }
}

/**
 * 导入歌单
 */
export async function importPlaylist(ref) {
  // 汽水：只有曲目清单，没有可播直链 —— 交给调用方去现有音源里逐首匹配
  if (ref && ref.source === 'qs') {
    if (ref.kind === 'track' || ref.kind === 'video') {
      throw userError('这是汽水音乐的「单曲 / 视频」分享链接，不是歌单。请在汽水 App 里进入歌单页后重新分享')
    }
    const data = await getQishuiPlaylist(ref.id)
    return { ...data, name: decodeName(data.name || '未命名歌单'), total: data.songs.length }
  }

  const provider = PROVIDERS[ref && ref.source]
  if (!provider || !provider.getPlaylist) throw userError('不支持的歌单来源')
  const data = await provider.getPlaylist(ref.id)
  return {
    ...data,
    name: decodeName(data.name || '未命名歌单'),
    songs: (data.songs || []).filter(s => s && s.name),
    total: (data.songs || []).length,
  }
}

export function normalizeSong(song) {
  return {
    ...song,
    name: decodeName(song.name || ''),
    singer: decodeName(song.singer || ''),
    albumName: decodeName(song.albumName || ''),
    interval: safeInt(song.interval),
  }
}

/** 平台官方榜单列表（目前只有网易云提供，失败时返回空数组，不阻断首页） */
export async function fetchToplists() {
  try { return await wy.getToplists() } catch { return [] }
}

/** 榜单/歌单曲目（不落库，供「排行榜」页直接播放） */
export async function fetchChart(ref, limit = 100) {
  const provider = PROVIDERS[ref && ref.source]
  if (!provider || !provider.getPlaylist) throw new Error('不支持的榜单来源')
  const data = await provider.getPlaylist(ref.id, limit)
  return {
    source: data.source,
    sourceId: data.sourceId,
    name: data.name,
    cover: data.cover || '',
    songs: (data.songs || []).filter(s => s && s.name),
  }
}

/**
 * 榜单卡片图：由「榜首单曲」构造。
 *
 * 优先用榜首歌手的**头像**（`getArtistPortrait`），拿不到才退回**专辑封面**。
 * 为什么不是直接用榜单自带的 coverImgUrl —— 网易云的榜单封面是官方设计图，
 * 一块纯色渐变 + 榜单名，铺成三列栅格后整屏都是色块，看着跟没图一样；
 * 而专辑封面里混着新歌的自动生成文字图（红底歌名）。歌手头像最稳，也最贴「某个歌手的图」。
 */
export async function buildChartHead(source, first) {
  if (!first || !first.name) return null
  const song = decodeName(first.name || '')
  const artist = decodeName(first.singer || '')
  const provider = PROVIDERS[source]
  if (provider && typeof provider.getArtistPortrait === 'function' && first.artistId) {
    try {
      const pic = await provider.getArtistPortrait(first.artistId)
      if (pic) return { cover: pic, song, artist, kind: 'artist' }
    } catch { /* 退回专辑封面 */ }
  }
  if (!first.img) return null
  return { cover: first.img, song, artist, kind: 'album' }
}

/**
 * 榜单「头图」：取该榜单第一名歌曲的封面 + 歌手。
 * 内部会重新拉一次歌单详情，适合「只知道榜单 id」的场景（如首页栅格批量换图）。
 * 已经拿到曲目列表的调用方（如 /chart）直接用 buildChartHead，别再拉一次上游。
 */
export async function fetchChartHead(ref) {
  const provider = PROVIDERS[ref && ref.source]
  if (!provider || !provider.getPlaylist) return null
  // 只要第一首，但网易的 getPlaylist 内部下限是 10 条，多拿几条当保险（可能含下架曲）
  const data = await provider.getPlaylist(ref.id, 10)
  const first = (data.songs || []).find(s => s && s.name && (s.img || s.artistId))
  if (!first) return null
  return buildChartHead(ref.source, first)
}
