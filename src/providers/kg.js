/**
 * 酷狗音乐（kg）
 * 搜索：songsearch.kugou.com/song_search_v2（实测 CF 出口 200，无需签名）
 * 歌单：mobiles.kugou.com/api/v5/special/song（实测可用）
 * 歌词/封面：kugou 公开接口
 * 取流：原生兜底接口（优先走落雪插件）
 */
import { request, UA_PC } from '../lib/http.js'
import { decodeName, formatSingerName, splitSingers, safeInt } from '../lib/util.js'
import { md5 } from '../lib/crypto.js'

const SOURCE = 'kg'

const QUALITY_KEYS = [
  // [音质标识, 文件hash字段, 体积字段, 码率描述]
  ['128k', 'FileHash', 'FileSize', 128],
  ['320k', 'HQFileHash', 'HQFileSize', 320],
  ['flac', 'SQFileHash', 'SQFileSize', 740],
  ['flac24bit', 'ResFileHash', 'ResFileSize', 1948],
]

function buildTypes(raw) {
  const types = []
  const _types = {}
  for (const [type, hashKey, sizeKey, bitrate] of QUALITY_KEYS) {
    const hash = raw[hashKey]
    const size = raw[sizeKey]
    if (!hash || !size) continue
    types.push({ type, size, hash })
    _types[type] = { size, hash, bitrate }
  }
  return { types, _types }
}

function filterSong(raw) {
  const { types, _types } = buildTypes(raw)
  const cover = raw.Image
    ? String(raw.Image).replace('{size}', '1000')
    : (raw.trans_param && raw.trans_param.union_cover ? String(raw.trans_param.union_cover).replace('{size}', '1000') : null)
  return {
    source: SOURCE,
    name: decodeName(raw.SongName),
    singer: decodeName(formatSingerName(raw.Singers, 'name')),
    albumName: decodeName(raw.AlbumName),
    albumId: String(raw.AlbumID || ''),
    songmid: String(raw.Audioid || ''),
    hash: raw.FileHash,
    interval: Math.floor(safeInt(raw.Duration) ),
    img: cover,
    types,
    _types,
    // 酷狗取流需要 album_audio_id + 文件 hash
    albumAudioId: raw.Audioid,
    privilege: raw.Privilege,
    _raw: null,
  }
}

function pickHash(song, quality) {
  if (!song) return null
  if (quality && song._types && song._types[quality]) return song._types[quality].hash
  const order = ['flac24bit', 'flac', '320k', '128k']
  for (const q of order) if (song._types && song._types[q]) return song._types[q].hash
  return song.hash || null
}

export default {
  id: SOURCE,
  name: '酷狗音乐',

  async search(keyword, page = 1, limit = 30) {
    const url = 'https://songsearch.kugou.com/song_search_v2?' + new URLSearchParams({
      keyword,
      page: String(page),
      pagesize: String(limit),
      userid: '0',
      clientver: '',
      platform: 'WebFilter',
      filter: '2',
      iscorrection: '1',
      privilege_filter: '0',
      area_code: '1',
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 2 })
    if (!json || json.error_code !== 0 || !json.data) throw new Error('酷狗搜索失败')
    const list = []
    const seen = new Set()
    for (const item of json.data.lists || []) {
      for (const one of [item, ...(item.Grp || [])]) {
        const key = `${one.Audioid}_${one.FileHash}`
        if (seen.has(key)) continue
        seen.add(key)
        list.push(filterSong(one))
      }
    }
    return { list, total: safeInt(json.data.total), page, limit, source: SOURCE }
  },

  /**
   * 搜专辑。
   *
   * ⚠️ 这里**必须用 http**：CF 出口到酷狗 CDN 的 https 握手会直接返回 526
   * （证书与 SNI 不匹配），而 http 走 80 端口一切正常（实测 464ms）。
   * 这条是实测结论，别顺手改成 https。
   */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const url = 'http://mobilecdn.kugou.com/api/v3/search/album?' + new URLSearchParams({
      format: 'json',
      keyword,
      page: String(page),
      pagesize: String(limit),
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1, timeout: 15000 })
    const info = json && json.data && json.data.info
    if (!Array.isArray(info)) throw new Error('酷狗专辑搜索失败')
    const list = info.map(a => ({
      source: SOURCE,
      id: String(a.albumid || ''),
      name: decodeName(a.albumname || ''),
      singer: decodeName(a.singername || ''),
      // imgurl 里带 {size} 占位符，替成实际尺寸
      img: a.imgurl ? String(a.imgurl).replace('{size}', '480') : '',
      trackCount: safeInt(a.songcount),
      publishDate: String(a.publishtime || '').slice(0, 10),
      intro: String(a.intro || '').slice(0, 120),
    })).filter(a => a.id && a.name)
    return { list, total: safeInt(json.data.total), page, limit, source: SOURCE }
  },

  /**
   * 原生取流（兜底）。
   * trackercdn 的 key = md5(hash + 'kgcloudv2')，是老版网页播放器用的签名规则。
   *
   * 实测结论（2026-09）：
   *   - `status: 1` 时返回 `url`，且该字段是**多个地址用英文逗号拼接**的字符串，
   *     以前直接返回整串会导致 URL 非法 —— 必须按逗号拆开取第一个（这里把
   *     备选地址一并返回给上层做兜底）。
   *   - `status: 2` 表示该曲受版权限制（搜索结果里 Privilege > 0 的基本都是），
   *     此时任何 br / pid 组合都拿不到地址，无需重试。
   */
  async getMusicUrl(song, quality = '320k') {
    const hash = pickHash(song, quality)
    if (!hash) return null
    const brMap = { '128k': '128', '320k': '320', flac: 'flac', flac24bit: 'flac' }
    const key = md5(`${hash}kgcloudv2`)

    const candidates = []
    // 1) trackercdn v2（酷狗官方 CDN）
    for (const br of [brMap[quality] || '320', '320', '128']) {
      candidates.push(
        `https://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=${br}&appid=1005&pid=2&cmd=25&behavior=play`
      )
    }
    // 2) 移动端 playInfo
    candidates.push(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`)

    for (const url of candidates) {
      try {
        const { json, text } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 0, timeout: 12000 })
        const data = json || null
        const direct = data && (data.url || (data.data && data.data.play_url) || (data.data && data.data.url))
        if (typeof direct === 'string') {
          const first = direct.split(',')[0].trim()
          if (/^https?:\/\//.test(first)) return first
        }
        if (typeof text === 'string' && /^https?:\/\/\S+$/.test(text.trim())) return text.trim()
      } catch { /* 试下一个 */ }
    }
    return null
  },

  /** 一次把酷狗能给出的所有直链都拿出来，交给上层逐个兜底 */
  async getMusicUrlCandidates(song, quality = '320k') {
    const hash = pickHash(song, quality)
    if (!hash) return []
    const brMap = { '128k': '128', '320k': '320', flac: 'flac', flac24bit: 'flac' }
    const key = md5(`${hash}kgcloudv2`)
    const out = []
    for (const br of [brMap[quality] || '320', '320', '128']) {
      const url = `https://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=${br}&appid=1005&pid=2&cmd=25&behavior=play`
      try {
        const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 0, timeout: 12000 })
        const list = json && typeof json.url === 'string' ? json.url.split(',') : []
        for (const u of list) {
          const t = u.trim()
          if (/^https?:\/\//.test(t) && !out.includes(t)) out.push(t)
        }
        if (out.length) break
      } catch { /* 试下一个码率 */ }
    }
    return out
  },

  async getLyric(song) {
    if (!song) return null
    const hash = pickHash(song)
    if (!hash) return null
    const url = `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${hash}`
    try {
      const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 0 })
      const cand = json && json.candidates && json.candidates[0]
      if (!cand) return null
      const dl = await request(
        `https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`,
        { headers: { 'User-Agent': UA_PC }, retry: 0 }
      )
      if (!dl.json || !dl.json.content) return null
      const { base64ToBytes, utf8Decode } = await import('../lib/crypto.js')
      return { lyric: utf8Decode(base64ToBytes(dl.json.content)) }
    } catch { return null }
  },

  async getPic(song) {
    return song && song.img ? String(song.img).replace('{size}', '1000') : null
  },

  /**
   * 专辑曲目。字段结构与歌单曲目一致，直接复用 _playlistSongToSong。
   * 同 searchAlbum：必须走 http。
   */
  async getAlbum(albumId, limit = 200) {
    const id = String(albumId).replace(/[^0-9]/g, '')
    if (!id) throw new Error('无效的酷狗专辑 ID')
    const pageSize = 100
    const songs = []
    let name = ''
    let cover = ''
    let page = 1
    let maxPage = 1

    while (page <= Math.min(maxPage, 10) && songs.length < limit) {
      const url = `http://mobilecdn.kugou.com/api/v3/album/song?albumid=${id}&page=${page}`
        + `&pagesize=${pageSize}&version=8000&plat=0`
      const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1, timeout: 15000 })
      const info = json && json.data && json.data.info
      if (!Array.isArray(info) || !info.length) break
      if (!name) {
        name = decodeName(info[0].album_name || info[0].albumname || '')
        const im = info[0].album_img || info[0].img || ''
        cover = im ? String(im).replace('{size}', '480') : ''
        maxPage = Math.ceil(safeInt(json.data.total) / pageSize) || 1
      }
      for (const raw of info) {
        const s = this._playlistSongToSong(raw)
        if (s) songs.push(s)
        if (songs.length >= limit) break
      }
      page++
    }

    if (!songs.length) throw new Error('该酷狗专辑没有可用曲目')
    return { source: SOURCE, sourceId: id, name: name || `酷狗专辑 ${id}`, cover, songs }
  },

  /** 歌单详情 */
  async getPlaylist(id) {
    const specialId = String(id).replace(/[^0-9]/g, '')
    const first = await this._playlistPage(specialId, 1, 100)
    if (!first) throw new Error('酷狗歌单获取失败')
    const songs = [...first.info]
    const total = first.total
    const pages = Math.ceil(total / 100)
    for (let p = 2; p <= Math.min(pages, 30); p++) {
      const next = await this._playlistPage(specialId, p, 100)
      if (!next) break
      songs.push(...next.info)
    }
    const list = songs.map(s => this._playlistSongToSong(s)).filter(Boolean)
    return {
      source: SOURCE,
      sourceId: specialId,
      name: first.specialname || `酷狗歌单 ${specialId}`,
      cover: null,
      songs: list,
    }
  },

  async _playlistPage(specialId, page, pagesize) {
    const url = `https://mobiles.kugou.com/api/v5/special/song?specialid=${specialId}&page=${page}&pagesize=${pagesize}&version=8000&plat=0&with_res_tag=0`
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1 })
    if (!json || !json.data || !Array.isArray(json.data.info)) return null
    return {
      info: json.data.info,
      total: safeInt(json.data.total),
      specialname: json.data.specialname || (json.data.info[0] && json.data.info[0].specialname) || null,
    }
  },

  _playlistSongToSong(raw) {
    if (!raw || !raw.hash) return null
    const sizeMap = { '128k': [raw.filesize, 128], '320k': [raw['320filesize'] || raw.hqfilesize, 320], flac: [raw.sqfilesize, 740], flac24bit: [raw.resfilesize, 1948] }
    const types = []
    const _types = {}
    const hashMap = { '128k': raw.hash, '320k': raw['320hash'] || raw.hqhash, flac: raw.sqhash, flac24bit: raw.resolve_hash || raw.reshash }
    for (const [type, [size, bitrate]] of Object.entries(sizeMap)) {
      const h = hashMap[type]
      if (!h || !size) continue
      types.push({ type, size, hash: h })
      _types[type] = { size, hash: h, bitrate }
    }
    return {
      source: SOURCE,
      name: decodeName(raw.songname || raw.filename),
      singer: decodeName(formatSingerName(splitSingers(raw.singername), 'x') || raw.singername || ''),
      albumName: decodeName(raw.album_name || ''),
      albumId: String(raw.album_id || ''),
      songmid: String(raw.audio_id || ''),
      hash: raw.hash,
      interval: Math.floor(safeInt(raw.duration)),
      img: raw.trans_param && raw.trans_param.cover ? String(raw.trans_param.cover).replace('{size}', '1000') : null,
      types,
      _types,
      albumAudioId: raw.album_audio_id || raw.audio_id,
    }
  },
}
