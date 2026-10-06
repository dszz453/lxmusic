/**
 * 网易云音乐（wy）
 * 关键结论（实测）：网页版 /api/search/get/web 会被风控返回 code:-462，
 * 但 eapi 接口（interface.music.163.com，AES-ECB 加密）不受影响 —— 本模块统一走 eapi。
 */
import { request, UA_PC } from '../lib/http.js'
import { eapi } from '../lib/crypto.js'
import { decodeName, formatSingerName, safeInt } from '../lib/util.js'

const SOURCE = 'wy'

const APP_COOKIE = 'os=android; appver=9.1.28; channel=netease; _ntes_nuid=0e6d5e2b0e2c4b8c9f1a2b3c4d5e6f70; NMTID=00Oabcdefg'
const APP_UA = 'NeteaseMusic/9.1.28.240206163722(140);Dalvik/2.1.0 (Linux; U; Android 12; EBG-AN10 Build/HUAWEIEBG-AN10)'

/** 榜单列表在 isolate 内缓存 30 分钟，避免首页每次访问都打 75KB */
const TOPLIST_TTL = 30 * 60 * 1000
const toplistStore = { ts: 0, list: null }
function readToplistCache() {
  if (toplistStore.list && Date.now() - toplistStore.ts < TOPLIST_TTL) return toplistStore.list
  return null
}
function writeToplistCache(list) {
  toplistStore.list = list
  toplistStore.ts = Date.now()
}

async function eapiRequest(path, payload, { timeout = 15000, retry = 1 } = {}) {
  const params = eapi(path, payload)
  const { json, text } = await request(`https://interface.music.163.com/eapi${path}`, {
    method: 'POST',
    form: { params },
    headers: { 'User-Agent': APP_UA, Cookie: APP_COOKIE, 'X-Real-IP': '114.114.114.114' },
    timeout,
    retry,
  })
  return json || safeJson(text)
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/** 兼容新旧两种歌曲结构：ar/al（新）与 artists/album（老） */
function normalize(raw) {
  const artists = raw.ar || raw.artists || []
  const album = raw.al || raw.album || {}
  const durationMs = raw.dt || raw.duration || 0
  const privilege = raw.privilege || (raw.privileges && raw.privileges[0]) || {}
  const maxbr = safeInt(privilege.maxbr || privilege.pl || 320000)

  const types = []
  const _types = {}
  const push = (type, bitrate) => {
    if (types.some(t => t.type === type)) return
    types.push({ type, size: null })
    _types[type] = { bitrate }
  }
  push('128k', 128000)
  if (maxbr >= 320000 || privilege.downloadMaxBrLevel || raw.h) push('320k', 320000)
  if (maxbr >= 999000 || raw.sq || privilege.playMaxBrLevel === 'lossless') push('flac', 999000)
  if (raw.hr || privilege.playMaxBrLevel === 'hires') push('flac24bit', 1900000)

  const isVip = !!(privilege.st === 0 || raw.fee === 1)
  return {
    source: SOURCE,
    name: decodeName(raw.name || ''),
    singer: decodeName(formatSingerName(artists, 'name')),
    // 榜首歌手的 ID：榜单卡片要拿歌手头像时用（专辑封面缺失或只是自动生成文字图时）
    artistId: String((artists[0] || {}).id || ''),
    albumName: decodeName(album.name || ''),
    albumId: String(album.id || ''),
    songmid: String(raw.id),
    id: String(raw.id),
    interval: Math.floor(durationMs / 1000),
    img: album.picUrl || null,
    types,
    _types,
    fee: raw.fee,
    vip: isVip,
    _raw: null,
  }
}

/**
 * 补封面：实测 eapi/api/search/get 返回的每条歌曲 al.picUrl 恒为 null
 * （5/5 全缺），但 /api/v3/song/detail 能拿到真实封面。
 * 所以搜索后用一次批量详情请求把封面补齐，避免列表里全是破图。
 */
async function fillCovers(songs) {
  const missing = songs.filter(s => !s.img && s.id).slice(0, 50)
  if (!missing.length) return songs
  try {
    const json = await eapiRequest('/api/v3/song/detail', {
      c: JSON.stringify(missing.map(s => ({ id: Number(s.id) }))),
    }, { retry: 0, timeout: 12000 })
    const map = new Map()
    for (const d of (json && json.songs) || []) {
      const pic = (d.al && d.al.picUrl) || null
      if (pic) map.set(String(d.id), pic)
    }
    if (map.size) for (const s of songs) if (!s.img && map.has(String(s.id))) s.img = map.get(String(s.id))
  } catch { /* 补图失败不影响搜索 */ }
  return songs
}

export default {
  id: SOURCE,
  name: '网易云音乐',

  async search(keyword, page = 1, limit = 30) {
    const offset = (page - 1) * limit
    let json = await eapiRequest('/api/search/get', {
      s: keyword, type: 1, limit, offset, total: page === 1,
    })
    let songs = json && json.result && json.result.songs
    let total = json && json.result && json.result.songCount

    // eapi/api/search/get 偶发返回空，退到新版分页接口
    if (!songs || !songs.length) {
      json = await eapiRequest('/api/search/song/list/page', {
        keyword, needCorrect: '1', channel: 'typing', offset, scene: 'normal', total: page === 1, limit,
      })
      const resources = (json && json.data && json.data.resources) || []
      songs = resources
        .map(r => (r.baseInfo && r.baseInfo.simpleSongData ? r.baseInfo.simpleSongData : null))
        .filter(Boolean)
      total = json && json.data && json.data.totalCount
    }
    if (!songs) throw new Error('网易云搜索失败')
    const list = await fillCovers(songs.map(normalize))
    return {
      list,
      total: safeInt(total, songs.length),
      page,
      limit,
      source: SOURCE,
    }
  },

  /**
   * 搜专辑。复用 eapi 的 cloudsearch/pc（type=10 即专辑），
   * 与歌曲搜索同一条通道 —— 网页版 /api/search/get/web 会被风控返回 code:-462，
   * 但 eapi 不受影响，所以这里也走 eapi。
   */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const offset = (page - 1) * limit
    const json = await eapiRequest('/api/cloudsearch/pc', {
      s: keyword, type: 10, limit, offset, total: true,
    })
    const albums = json && json.result && json.result.albums
    if (!Array.isArray(albums)) throw new Error('网易云专辑搜索失败')
    const list = albums.map(a => ({
      source: SOURCE,
      id: String(a.id || ''),
      name: decodeName(a.name || ''),
      singer: decodeName((a.artist && a.artist.name)
        || (a.artists || []).map(x => x.name).filter(Boolean).join('、')
        || ''),
      img: a.picUrl || a.blurPicUrl || '',
      trackCount: safeInt(a.size),
      publishDate: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : '',
      intro: String(a.description || a.briefDesc || '').slice(0, 120),
    })).filter(a => a.id && a.name)
    return { list, total: safeInt(json.result.albumCount), page, limit, source: SOURCE }
  },

  /** 原生取流（兜底）：eapi 播放地址接口 → 老版重定向接口 */
  async getMusicUrl(song, quality = '320k') {
    const id = song && (song.id || song.songmid)
    if (!id) return null
    const levelMap = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless', flac24bit: 'hires' }
    const brMap = { '128k': 128000, '320k': 320000, flac: 999000, flac24bit: 1900000 }
    for (const level of [levelMap[quality] || 'exhigh', 'exhigh', 'standard']) {
      try {
        const json = await eapiRequest('/api/song/enhance/player/url/v1', {
          ids: `[${id}]`, level, encodeType: 'flac', br: brMap[quality] || 320000,
        }, { retry: 0, timeout: 12000 })
        const item = json && json.data && json.data[0]
        if (item && item.url && /^https?:/.test(item.url)) return item.url
      } catch { /* 试下一个音质 */ }
    }
    try {
      const json = await eapiRequest('/api/song/enhance/player/url', {
        ids: `[${id}]`, br: brMap[quality] || 320000,
      }, { retry: 0, timeout: 12000 })
      const item = json && json.data && json.data[0]
      if (item && item.url && /^https?:/.test(item.url)) return item.url
    } catch { /* ignore */ }

    // 最终兜底：302 跳转到 CDN（VIP 歌曲会返回非音频内容，交由调用方校验）
    return `https://music.163.com/song/media/outer/url?id=${id}.mp3`
  },

  async getLyric(song) {
    const id = song && (song.id || song.songmid)
    if (!id) return null
    try {
      const json = await eapiRequest('/api/song/lyric', { id, lv: -1, kv: -1, tv: -1 })
      if (json && (json.lrc || json.tlyric)) {
        return {
          lyric: (json.lrc && json.lrc.lyric) || '',
          tlyric: (json.tlyric && json.tlyric.lyric) || null,
          romalrc: (json.romalrc && json.romalrc.lyric) || null,
        }
      }
    } catch { /* ignore */ }
    try {
      const { json } = await request(`https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
        retry: 0,
      })
      if (json && json.lrc) return { lyric: json.lrc.lyric || '', tlyric: (json.tlyric && json.tlyric.lyric) || null }
    } catch { /* ignore */ }
    return null
  },

  async getPic(song) {
    return (song && song.img) || null
  },

  /** 专辑曲目：eapi 的 /api/v1/album/{id} 会连曲目一起返回 */
  async getAlbum(albumId, limit = 200) {
    const id = String(albumId).replace(/[^0-9]/g, '')
    if (!id) throw new Error('无效的网易云专辑 ID')
    const json = await eapiRequest(`/api/v1/album/${id}`, {}, { timeout: 20000 })
    const songs = json && json.songs
    if (!Array.isArray(songs) || !songs.length) throw new Error('网易云专辑曲目获取失败')
    const album = (json && json.album) || {}
    const list = await fillCovers(songs.slice(0, limit).map(normalize))
    return {
      source: SOURCE,
      sourceId: id,
      name: decodeName(album.name || ''),
      cover: album.picUrl || '',
      songs: list,
    }
  },

  /** 官方榜单列表（含封面 / 播放量），供首页「推荐歌单」栅格使用 */
  async getToplists() {
    const cached = readToplistCache()
    if (cached) return cached
    let list = null
    try {
      const { json } = await request('https://music.163.com/api/toplist', {
        headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
        retry: 1,
      })
      if (json && json.code === 200) list = json.list
    } catch { /* 退回 eapi */ }
    if (!list || !list.length) {
      const json = await eapiRequest('/api/toplist', {}, { retry: 0 })
      list = json && json.list
    }
    if (!Array.isArray(list)) return []
    const mapped = list
      .filter(p => p && p.id && p.name)
      .map(p => ({
        source: SOURCE,
        id: String(p.id),
        name: decodeName(p.name),
        cover: p.coverImgUrl || '',
        trackCount: safeInt(p.trackCount, 100),
        playCount: safeInt(p.playCount, 0),
        updateFrequency: p.updateFrequency || '',
      }))
    writeToplistCache(mapped)
    return mapped
  },

  /**
   * 歌手头像。
   *
   * 用途：榜单卡片的图。网易云的榜单 `coverImgUrl` 是官方设计图（一块纯色 + 榜单名），
   * 铺成三列栅格整屏都是色块；专辑封面又有一部分是新歌的自动生成文字图。
   * 歌手头像基本都是一张真人照片，观感最稳。
   *
   * 实测 `music.163.com/api/artist/{id}` 在 CF 出口可用（8/8 有图），
   * 失败时返回 null 交给调用方退回专辑封面。
   */
  async getArtistPortrait(artistId) {
    const id = String(artistId || '').replace(/[^0-9]/g, '')
    if (!id) return null
    try {
      const { json } = await request(`https://music.163.com/api/artist/${id}`, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
        retry: 0,
      })
      const pic = json && json.artist && json.artist.picUrl
      if (pic) return pic
    } catch { /* 退回 eapi */ }
    try {
      const json = await eapiRequest('/api/artist/head/info/get', { id }, { retry: 0 })
      return (json && json.data && json.data.avatarUrl) || null
    } catch { return null }
  },

  /** 歌单详情：实测 /api/v6/playlist/detail 在 CF 出口可用 */
  async getPlaylist(id, limit = 1000) {    const pid = String(id).replace(/[^0-9]/g, '')
    const n = Math.max(10, Math.min(safeInt(limit, 1000) || 1000, 1000))
    let playlist = null
    try {
      const { json } = await request(`https://music.163.com/api/v6/playlist/detail?id=${pid}&n=${n}&s=0`, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' },
        retry: 1,
      })
      playlist = json && json.playlist
    } catch { /* ignore */ }

    if (!playlist) {
      const json = await eapiRequest('/api/v6/playlist/detail', { id: pid, n, s: 0 })
      playlist = json && json.playlist
    }
    if (!playlist) throw new Error('网易云歌单获取失败')

    const songs = (playlist.tracks || []).map(t => {
      // 详情接口返回的 tracks 字段较精简，补齐 album 信息
      if (!t.al && t.album) t.al = t.album
      if (!t.ar && t.artists) t.ar = t.artists
      if (!t.dt && t.duration) t.dt = t.duration
      return normalize(t)
    })
    return {
      source: SOURCE,
      sourceId: pid,
      name: playlist.name,
      cover: playlist.coverImgUrl,
      songs,
    }
  },
}
