/**
 * 喜马拉雅（xm）—— 音频节目平台（有声书 / 播客 / 电台）
 *
 * 接入拆成两段，各用各的接口，原因记在这里免得以后有人再踩：
 *
 *   1) 搜索 —— 走「喜马拉雅开放平台」 api.ximalaya.com
 *      web 端那个 /revision/search/main 会返回 `risk invalid`（riskLevel 5）。
 *      实测结论：即使在真实浏览器里、带着喜马拉雅自己下发的全部 cookie
 *      （HWWAFSESID / wfp / assva6 …）请求，依旧是 risk invalid ——
 *      风控判的是登录态，必须带 1&_token 才放行，所以 web 接口这条路不通。
 *      开放平台是标准签名鉴权，不需要账号。
 *
 *      ⚠️ 用的 app_key / app_secret 是**官方文档里的测试应用**凭据
 *      （open.ximalaya.com/doc/detailDev?articleId=78），属公开信息，
 *      有配额上限、也可能被回收。所以留了 configureXm() 供线上覆盖。
 *
 *   2) 取流 / 曲目 —— 走 mobile.ximalaya.com
 *      · 单条：/mobile/v1/track/{trackId}          → playUrl64 / playPathAacv224
 *      · 专辑：/mobile/others/ca/album/track/{albumId}/{isAsc}/{page}/{size}
 *      这个域名没上 WAF，不需要任何 cookie（实测 CF 出口 200 / ~1.1s）。
 *      开放平台的 play_url_* 对测试应用恒为空串，所以取流必须走这里。
 *
 * 音质说明：喜马拉雅只有 64k / 24k 两档，没有无损，音质选择对它没有意义。
 * 返回的地址是 **http**（aod.cos.tx.xmcdn.com），网页端属混合内容，
 * 必须走 /api/stream 代理；安卓壳里可以直接放。
 */
import { request, UA_PC, UA_MOBILE } from '../lib/http.js'
import { bytesToBase64, utf8Encode, md5 } from '../lib/crypto.js'
import { decodeName, safeInt, durationToSeconds } from '../lib/util.js'

const SOURCE = 'xm'
const OPEN_API = 'https://api.ximalaya.com'
const MOBILE_API = 'https://mobile.ximalaya.com'

const DEFAULT_CRED = {
  appKey: 'b617866c20482d133d5de66fceb37da3',
  appSecret: '4d8e605fa7ed546c4bcb33dee1381179',
  staticKey: 'z0hh5l9A',
}

let CRED = { ...DEFAULT_CRED }

/** 线上可用 env 覆盖测试凭据（配了就用配置的，没配就退回文档测试应用） */
export function configureXm(cfg = {}) {
  const next = { ...DEFAULT_CRED }
  if (cfg.appKey) next.appKey = String(cfg.appKey)
  if (cfg.appSecret) next.appSecret = String(cfg.appSecret)
  if (cfg.staticKey) next.staticKey = String(cfg.staticKey)
  CRED = next
}

/* ---------------- 开放平台签名 ---------------- */

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes)
  return new Uint8Array(sig)
}

/**
 * 官方签名算法：参数按名排序 → `k=v&…` → Base64 → HMAC-SHA1 → **对字节做 MD5**。
 * 最后一步官方文档特意强调「是字节数组不是 hex 字符串」，写成 hex 会一直 401。
 */
async function openApiUrl(pathname, biz) {
  const params = {
    app_key: CRED.appKey,
    client_os_type: '4',
    nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    timestamp: String(Date.now()),
    server_api_version: '1.0.0',
    ...biz,
  }
  const raw = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
  const b64 = bytesToBase64(utf8Encode(raw))
  const hmac = await hmacSha1(utf8Encode(CRED.appSecret + CRED.staticKey), utf8Encode(b64))
  const sig = md5(hmac)
  const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
  return `${OPEN_API}${pathname}?${qs}&sig=${sig}`
}

/* ---------------- 字段映射 ---------------- */

/** 把开放平台的 track 转成本项目通用的 song 结构 */
function trackToSong(t) {
  if (!t || !t.id) return null
  const album = t.subordinated_album || {}
  const img = t.cover_url_middle || t.cover_url_large || t.cover_url_small || ''
  return {
    source: SOURCE,
    // 喜马拉雅主键叫 trackId，统一塞进 id/songmid —— 播放地址要靠它换
    id: String(t.id),
    songmid: String(t.id),
    trackId: String(t.id),
    name: decodeName(t.track_title || ''),
    singer: decodeName((t.announcer && t.announcer.nickname) || ''),
    albumName: decodeName(album.album_title || ''),
    albumId: String(album.id || ''),
    interval: safeInt(t.duration),
    img: img ? String(img).replace(/^http:/, 'https:') : '',
    // 喜马拉雅没有音质档位，types 留空 —— 上层会跳过音质选择直接取流
    types: [],
    _types: {},
    // 标记为「音频节目」，界面上可以用不同措辞（单集 / 专辑）
    isAudio: true,
    isPaid: !!t.is_paid,
  }
}

/** mobile 端 tracks.list 里的一条 → song（曲目接口用，字段名不一样） */
function mobileTrackToSong(t) {
  if (!t || !t.trackId) return null
  return {
    source: SOURCE,
    id: String(t.trackId),
    songmid: String(t.trackId),
    trackId: String(t.trackId),
    name: decodeName(t.title || ''),
    singer: decodeName(t.nickname || ''),
    albumName: '',
    albumId: String(t.albumId || ''),
    interval: safeInt(t.duration),
    img: t.coverSmall ? String(t.coverSmall).replace(/^http:/, 'https:') : '',
    types: [],
    _types: {},
    isAudio: true,
    isPaid: !!t.isPaid,
  }
}

/* ---------------- provider ---------------- */

export default {
  id: SOURCE,
  name: '喜马拉雅',

  /** 搜声音（单集）。喜马拉雅的「一首歌」就是一集音频 */
  async search(keyword, page = 1, limit = 30) {
    const url = await openApiUrl('/v2/search/tracks', {
      title: keyword,
      page: String(page),
      count: String(Math.min(Math.max(limit, 1), 50)),
      sort_by: 'created_at',
      desc: 'false',
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1, timeout: 15000 })
    if (!json || !Array.isArray(json.tracks)) throw new Error('喜马拉雅搜索失败')
    const list = json.tracks.map(trackToSong).filter(Boolean)
    return { list, total: safeInt(json.total_count), page, limit, source: SOURCE }
  },

  /** 搜专辑（整本有声书 / 播客） */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const url = await openApiUrl('/v2/search/albums', {
      q: keyword,
      page: String(page),
      count: String(Math.min(Math.max(limit, 1), 50)),
      category_id: '0',
      calc_dimension: '1',
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1, timeout: 15000 })
    if (!json || !Array.isArray(json.albums)) throw new Error('喜马拉雅专辑搜索失败')
    const list = json.albums.map(a => ({
      source: SOURCE,
      id: String(a.id || ''),
      name: decodeName(a.album_title || ''),
      singer: decodeName((a.announcer && a.announcer.nickname) || ''),
      img: (a.cover_url_large || a.cover_url_middle || a.cover_url_small || '').replace(/^http:/, 'https:'),
      trackCount: safeInt(a.include_track_count),
      playCount: safeInt(a.play_count),
      isPaid: !!a.is_paid,
      intro: String(a.album_intro || '').slice(0, 120),
      isAudio: true,
    })).filter(a => a.id && a.name)
    return { list, total: safeInt(json.total_count), page, limit, source: SOURCE }
  },

  /**
   * 取流：单条 track 接口直接给地址。
   * 优先 64k mp3，退回 aac —— 实测 aac 也是完整音频，只是容器不同。
   */
  async getMusicUrl(song, _quality = '320k') {
    const list = await this.getMusicUrlCandidates(song)
    return list[0] || null
  },

  async getMusicUrlCandidates(song) {
    const id = song && (song.trackId || song.id)
    if (!id) return []
    const url = `${MOBILE_API}/mobile/v1/track/${encodeURIComponent(id)}`
    try {
      const { json } = await request(url, { headers: { 'User-Agent': UA_MOBILE }, retry: 0, timeout: 12000 })
      if (!json) return []
      const out = []
      for (const k of ['playUrl64', 'playPathAacv224', 'playUrl32', 'playPathAacv164']) {
        const v = json[k]
        if (typeof v === 'string' && /^https?:\/\//.test(v) && !out.includes(v)) out.push(v)
      }
      return out
    } catch { return [] }
  },

  /**
   * 歌词：喜马拉雅是有声书平台，绝大多数条目没有歌词（track 接口的 lyric 字段为空串）。
   * 这里如实返回 null，让上层走「暂无歌词」分支，不要硬凑。
   */
  async getLyric(song) {
    const id = song && (song.trackId || song.id)
    if (!id) return null
    try {
      const { json } = await request(`${MOBILE_API}/mobile/v1/track/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': UA_MOBILE }, retry: 0, timeout: 12000,
      })
      const lyric = json && typeof json.lyric === 'string' ? json.lyric.trim() : ''
      if (!lyric) return null
      return { lyric }
    } catch { return null }
  },

  async getPic(song) {
    if (song && song.img) return String(song.img)
    const id = song && (song.trackId || song.id)
    if (!id) return null
    try {
      const { json } = await request(`${MOBILE_API}/mobile/v1/track/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': UA_MOBILE }, retry: 0, timeout: 12000,
      })
      const raw = json && (json.coverLarge || json.albumImage)
      return raw ? String(raw).replace(/^http:/, 'https:') : null
    } catch { return null }
  },

  /** 喜马拉雅的「专辑」和「歌单」是同一个东西 —— 直接复用 */
  async getAlbum(albumId, limit = 200) {
    return this.getPlaylist(albumId, limit)
  },

  /**
   * 「歌单」= 一本专辑的全部曲目。
   * 用户粘一个喜马拉雅专辑链接进来，就能整本导入。
   */
  async getPlaylist(albumId, limit = 200) {
    const id = String(albumId).replace(/[^0-9]/g, '')
    if (!id) throw new Error('无效的喜马拉雅专辑 ID')

    const pageSize = 30
    const songs = []
    let albumTitle = ''
    let cover = ''
    let page = 1
    let maxPage = 1

    while (page <= Math.min(maxPage, 40) && songs.length < limit) {
      const url = `${MOBILE_API}/mobile/others/ca/album/track/${id}/true/${page}/${pageSize}`
      const { json } = await request(url, { headers: { 'User-Agent': UA_MOBILE }, retry: 1, timeout: 15000 })
      if (!json || json.ret !== 0) break

      const album = json.album || {}
      if (!albumTitle) {
        albumTitle = decodeName(album.title || '')
        const c = album.coverOrigin || album.coverMiddle || album.coverSmall || ''
        cover = c ? String(c).replace(/^http:/, 'https:') : ''
        maxPage = Math.ceil(safeInt((json.tracks && json.tracks.totalCount) || 0) / pageSize) || 1
      }

      const list = (json.tracks && json.tracks.list) || []
      if (!list.length) break
      for (const t of list) {
        const s = mobileTrackToSong(t)
        if (!s) continue
        s.albumName = albumTitle
        songs.push(s)
        if (songs.length >= limit) break
      }
      page++
    }

    if (!songs.length) throw new Error('该喜马拉雅专辑没有可用的音频')
    return {
      source: SOURCE,
      sourceId: id,
      name: albumTitle || `喜马拉雅专辑 ${id}`,
      cover,
      songs,
    }
  },
}
