/**
 * QQ 音乐（tx）
 * 搜索：u.y.qq.com/cgi-bin/musicu.fcg（GET + data=URL 编码 JSON，参考实现已验证必须用 GET）
 * 取流：vkey.GetVkeyServer / CgiGetVkey
 */
import { request, UA_PC } from '../lib/http.js'
import { decodeName, formatSingerName, safeInt } from '../lib/util.js'

const SOURCE = 'tx'
const QQ_UA = 'QQMusic 14090508(android 12)'
const GUID = '10000'

function buildSearchPayload(keyword, page, limit) {
  return {
    comm: {
      ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic', phonetype: 'EBG-AN10',
      os_ver: '12', OpenUDID: '0', chid: '0', aid: '0', oaid: '0', taid: '0', tid: '0',
      wid: '0', uid: '0', sid: '0', modeSwitch: '6', teenMode: '0', ui_mode: '2', nettype: '1020',
    },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicMobile',
      param: {
        search_type: 0, query: keyword, page_num: page, num_per_page: limit,
        highlight: 0, nqc_flag: 0, multi_zhida: 0, cat: 2, grp: 1, sin: 0, sem: 0,
      },
    },
  }
}

const QUALITY_KEYS = [
  ['128k', 'size_128mp3', 128],
  ['320k', 'size_320mp3', 320],
  ['flac', 'size_flac', 740],
  ['flac24bit', 'size_hires', 1948],
]

/** 老版 Web 搜索接口（主用），多个同类域名轮询以规避单点超时 */
const SEARCH_HOSTS = ['c.y.qq.com', 'c6.y.qq.com', 'szc.y.qq.com', 'u.y.qq.com']

/**
 * QQ 音乐搜索的总时间预算。实测在 Cloudflare 出口被拒时，
 * 4 个域名 + musicu 兜底串行要跑 12~17 秒；这里硬性封顶，
 * 超预算立刻放弃（调用方还有 4.5 秒的平台级超时兜底）。
 */
const SEARCH_DEADLINE = 5000     // 整个 search() 的总预算
const HOST_TIMEOUT = 3000        // 单个域名的超时

async function searchLegacy(keyword, page, limit, deadline) {
  const diags = []
  const query = `p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}`
    + '&format=json&t=0&aggr=1&cr=1&lossless=1&new_json=1&platform=yqq.json&needNewCode=0'
  for (const host of SEARCH_HOSTS) {
    if (Date.now() > deadline) { diags.push('已超出搜索时间预算'); break }
    try {
      const { status, json, text } = await request(`https://${host}/soso/fcgi-bin/client_search_cp?${query}`, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/portal/search.html' },
        retry: 0,
        timeout: HOST_TIMEOUT,
      })
      const data = json || safeParse(text)
      const song = data && data.data && data.data.song
      const raw = (song && song.list) || []
      const list = raw.filter(s => s && s.file && s.file.media_mid).map(filterSong)
      if (list.length) return { list, diag: `${host} ok ${list.length}` }
      diags.push(`${host}: http=${status} code=${data && data.code} len=${(text || '').length} list=${raw.length}`)
    } catch (e) {
      diags.push(`${host}: ${(e && e.message) || e}`.slice(0, 70))
    }
  }
  return { list: [], diag: diags.join(' | ') }
}

/** 移动端 musicu 搜索（兜底；当前常返回空列表） */
async function searchMusicu(keyword, page, limit) {
  try {
    const payload = buildSearchPayload(keyword, page, limit)
    const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`
    const { json } = await request(url, { headers: { 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/' }, retry: 0, timeout: 4000 })
    if (!json || json.code !== 0 || !json.req || json.req.code !== 0) {
      return { list: [], diag: `code=${json && json.code}/${json && json.req && json.req.code}` }
    }
    const data = json.req.data || {}
    const body = data.body || data
    const songs = body.item_song || []
    return { list: songs.filter(s => s && s.file && s.file.media_mid).map(filterSong), diag: `item_song=${songs.length}` }
  } catch (e) {
    return { list: [], diag: (e && e.message) || String(e) }
  }
}

function filterSong(item) {
  const file = item.file || {}
  const types = []
  const _types = {}
  for (const [type, sizeKey, bitrate] of QUALITY_KEYS) {
    const size = file[sizeKey]
    if (!size) continue
    types.push({ type, size })
    _types[type] = { size, bitrate }
  }
  const album = item.album || {}
  const albumId = album.mid || ''
  const singers = item.singer || []
  let img = ''
  if (albumId) img = `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumId}.jpg`
  else if (singers[0] && singers[0].mid) img = `https://y.gtimg.cn/music/photo_new/T001R800x800M000${singers[0].mid}.jpg`
  return {
    source: SOURCE,
    name: decodeName(item.name || '') + decodeName(item.title_extra || ''),
    singer: decodeName(formatSingerName(singers, 'name')),
    albumName: decodeName(album.name || ''),
    albumId,
    songmid: item.mid,
    mediaMid: file.media_mid || '',
    songId: item.id,
    id: item.mid,
    interval: safeInt(item.interval),
    img: img || null,
    types,
    _types,
  }
}

/**
 * 搜索：老版 Web 接口 client_search_cp 目前最稳（实测 2026-09）
 * 说明：`u.y.qq.com` 的 musicu.fcg 移动端搜索接口虽然返回 code:0，
 *      但 item_song 恒为空（需要额外签名），因此改为以 Web 接口为主、musicu 兜底。
 * 另外 c.y.qq.com 在 Cloudflare 出口偶发超时，所以准备了多个同类域名轮询。
 */
export default {
  id: SOURCE,
  name: 'QQ音乐',

  async search(keyword, page = 1, limit = 30) {
    const deadline = Date.now() + SEARCH_DEADLINE
    const legacy = await searchLegacy(keyword, page, limit, deadline)
    if (legacy.list.length) {
      return { list: legacy.list, total: legacy.list.length, page, limit, source: SOURCE }
    }
    if (Date.now() > deadline) {
      throw new Error(`QQ音乐搜索失败（已超出 ${SEARCH_DEADLINE}ms 时间预算；web: ${legacy.diag}）`)
    }
    const musicu = await searchMusicu(keyword, page, limit)
    if (musicu.list.length) {
      return { list: musicu.list, total: musicu.list.length, page, limit, source: SOURCE }
    }
    throw new Error(`QQ音乐搜索失败（web: ${legacy.diag}｜musicu: ${musicu.diag}）`)
  },

  /**
   * 搜专辑。老版 web 接口换 `t=8`（专辑），跟歌曲搜索共用多域名轮询 ——
   * c.y.qq.com 在 CF 出口不稳，多域名是必须的冗余。
   *
   * 说明：u.y.qq.com 的 musicu 也有专辑接口（DoSearchForQQMusicDesktop，
   * search_type=2，实测 330ms 很快），但它对同一出口 IP 有频率限制，
   * 连续请求几次后 list 直接变空。所以不把它当主力，只保留 web 这条稳定路径。
   */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const query = `p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}`
      + '&t=8&format=json&new_json=1&platform=yqq.json&needNewCode=0'
    const deadline = Date.now() + SEARCH_DEADLINE
    const diags = []
    for (const host of SEARCH_HOSTS) {
      if (Date.now() > deadline) { diags.push('已超出时间预算'); break }
      try {
        const { status, json, text } = await request(`https://${host}/soso/fcgi-bin/client_search_cp?${query}`, {
          headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/portal/search.html' },
          retry: 0,
          timeout: HOST_TIMEOUT,
        })
        const data = json || safeParse(text)
        const seg = data && data.data && data.data.album
        const raw = (seg && seg.list) || []
        if (raw.length) {
          const list = raw.map(a => {
            const mid = a.albumMID || ''
            return {
              source: SOURCE,
              // 只保留带 albummid 的条目 —— 数字 albumID 换不到曲目，留着就是打不开的死条目
              id: mid,
              name: decodeName(String(a.albumName || '').replace(/<[^>]+>/g, '')),
              singer: decodeName(a.singerName || ''),
              img: String(a.albumPic || (mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : ''))
                .replace(/^http:\/\//, 'https://'),
              trackCount: safeInt(a.song_count || a.songCount),
              publishDate: String(a.publicTime || a.publish_date || '').slice(0, 10),
            }
          }).filter(a => a.id && a.name)
          if (list.length) {
            return { list, total: safeInt(seg.totalnum, list.length), page, limit, source: SOURCE }
          }
        }
        diags.push(`${host}: http=${status} list=${raw.length}`)
      } catch (e) {
        diags.push(`${host}: ${(e && e.message) || e}`.slice(0, 60))
      }
    }
    throw new Error(`QQ音乐专辑搜索失败（${diags.join(' | ')}）`)
  },

  /** 原生取流：vkey 接口 */
  async getMusicUrl(song, quality = '320k') {
    if (!song || !song.songmid) return null
    const prefixMap = { '128k': 'M500', '320k': 'M800', flac: 'F000', flac24bit: 'RS01' }
    const extMap = { '128k': 'mp3', '320k': 'mp3', flac: 'flac', flac24bit: 'flac' }
    const prefix = prefixMap[quality] || 'M800'
    const ext = extMap[quality] || 'mp3'
    const mediaMid = song.mediaMid || song.songmid
    const filename = `${prefix}${mediaMid}${song.songmid}.${ext}`

    const payload = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: GUID,
          songmid: [song.songmid],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20',
        },
      },
      comm: { uin: '0', format: 'json', ct: 24, cv: 0 },
    }
    try {
      const { json } = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        body: payload,
        headers: { 'User-Agent': QQ_UA, Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' },
        retry: 0, timeout: 12000,
      })
      const req0 = json && json.req_0
      const midurlinfo = req0 && req0.data && req0.data.midurlinfo
      const sip = (req0 && req0.data && req0.data.sip) || []
      if (Array.isArray(midurlinfo) && midurlinfo[0] && midurlinfo[0].purl) {
        const base = sip.find(s => s && s.startsWith('https://')) || sip[0] || 'https://dl.stream.qqmusic.qq.com/'
        return base + midurlinfo[0].purl
      }
    } catch { /* ignore */ }

    // 兜底：试各音质前缀的直链（无 vkey 时通常 403，但部分公开曲可用）
    const candidates = [filename, `M500${mediaMid}${song.songmid}.mp3`, `C400${mediaMid}${song.songmid}.m4a`]
    for (const f of candidates) {
      const testUrl = `https://dl.stream.qqmusic.qq.com/${f}`
      try {
        const res = await request(testUrl, { method: 'HEAD', headers: { 'User-Agent': QQ_UA }, retry: 0, timeout: 8000, raw: true })
        if (res.ok) return testUrl
      } catch { /* 试下一个 */ }
    }
    return null
  },

  async getLyric(song) {
    if (!song || !song.songmid) return null
    try {
      const { json, text } = await request(
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${song.songmid}&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`,
        { headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/portal/player.html' }, retry: 0 }
      )
      const data = json || safeParse(text)
      if (data && data.lyric) {
        return { lyric: decodeName(data.lyric), tlyric: data.trans ? decodeName(data.trans) : null }
      }
    } catch { /* ignore */ }
    return null
  },

  async getPic(song) {
    return (song && song.img) || null
  },

  /**
   * 专辑曲目。注意专辑主键是 **albummid**（字符串）而不是数字 albumID ——
   * 所以 searchAlbum 只保留带 mid 的条目，拿到数字 ID 是打不开的。
   */
  async getAlbum(albumId, limit = 200) {
    const mid = String(albumId).replace(/[^0-9A-Za-z]/g, '')
    if (!mid) throw new Error('无效的 QQ 音乐专辑 ID')
    const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${mid}`
      + '&format=json&platform=yqq.json&needNewCode=0'
    const { json, text } = await request(url, {
      headers: { 'User-Agent': UA_PC, Referer: `https://y.qq.com/n/ryqq/albumDetail/${mid}` },
      retry: 1,
      timeout: 15000,
    })
    const data = json || safeParse(text)
    const raw = data && data.data && data.data.list
    if (!Array.isArray(raw) || !raw.length) throw new Error('QQ音乐专辑曲目获取失败')
    const songs = raw.slice(0, limit).map(filterSong).filter(s => s && s.songmid)
    if (!songs.length) throw new Error('该 QQ 音乐专辑没有可用曲目')
    return {
      source: SOURCE,
      sourceId: mid,
      name: decodeName(data.data.albumName || ''),
      cover: String(data.data.albumPic || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg`)
        .replace(/^http:\/\//, 'https://'),
      songs,
    }
  },

  /** 歌单：QQ 音乐老版 disstid 接口 */
  async getPlaylist(id) {
    const disstid = String(id).replace(/[^0-9]/g, '')
    const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${disstid}&format=json&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
    const { json, text } = await request(url, {
      headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/n/yqq/playlist/' }, retry: 1,
    })
    const data = json || safeParse(text)
    const cd = data && data.cdlist && data.cdlist[0]
    if (!cd) throw new Error('QQ音乐歌单获取失败')
    const songs = (cd.songlist || []).filter(s => s && s.file && s.file.media_mid).map(filterSong)
    return {
      source: SOURCE,
      sourceId: disstid,
      name: cd.dissname || `QQ歌单 ${disstid}`,
      cover: cd.logo || null,
      songs,
    }
  },
}

function safeParse(text) {
  if (!text) return null
  const s = String(text).trim()
  const m = s.match(/^[^(]*\((.*)\)[;\s]*$/s)
  const body = m ? m[1] : s
  try { return JSON.parse(body) } catch { return null }
}
