/**
 * 酷我音乐（kw）
 * 搜索：search.kuwo.cn/r.s（实测 CF 出口 200）
 * 取流：antiserver 转换接口 → 新域名 www.kuwo.cn playUrl
 */
import { request, UA_PC, retryUntil, sleep } from '../lib/http.js'
import { decodeName, formatSingerName, safeInt } from '../lib/util.js'

const SOURCE = 'kw'

const MINFO_RE = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/

const LEVEL_MAP = {
  4000: ['flac24bit', 1948],
  2000: ['flac', 740],
  320: ['320k', 320],
  128: ['128k', 128],
}

function filterSong(raw) {
  const types = []
  const _types = {}
  if (raw.N_MINFO) {
    for (const seg of String(raw.N_MINFO).split(';')) {
      const m = seg.match(MINFO_RE)
      if (!m) continue
      const entry = LEVEL_MAP[m[2]]
      if (!entry) continue
      const [type, bitrate] = entry
      const size = m[4]
      if (_types[type]) continue
      types.push({ type, size })
      _types[type] = { size, bitrate }
    }
    types.reverse()
  }
  const rid = String(raw.MUSICRID || '').replace('MUSIC_', '')
  let pic = raw.prob_albumpic || null
  if (!pic && raw.web_albumpic_short) pic = `https://img4.kuwo.cn/star/albumcover/1000${raw.web_albumpic_short}`
  if (pic && pic.startsWith('//')) pic = 'https:' + pic
  return {
    source: SOURCE,
    name: decodeName(raw.SONGNAME),
    singer: decodeName(formatSingerName(String(raw.ARTIST || '').split('&'), 'x') || raw.ARTIST),
    albumName: decodeName(raw.ALBUM || ''),
    albumId: decodeName(raw.ALBUMID || ''),
    songmid: rid,
    id: rid,
    interval: safeInt(raw.DURATION),
    img: pic,
    types,
    _types,
  }
}

export default {
  id: SOURCE,
  name: '酷我音乐',

  async search(keyword, page = 1, limit = 30) {
    const url = 'http://search.kuwo.cn/r.s?' + new URLSearchParams({
      client: 'kt',
      all: keyword,
      pn: String(page - 1),
      rn: String(limit),
      uid: '794762570',
      ver: 'kwplayer_ar_9.2.2.1',
      vipver: '1',
      show_copyright_off: '1',
      newver: '1',
      ft: 'music',
      cluster: '0',
      strategy: '2012',
      encoding: 'utf8',
      rformat: 'json',
      vermerge: '1',
      mobi: '1',
      issubtitle: '1',
    })
    const { json, text } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 2 })
    const data = json || tryParseKuwo(text)
    if (!data || !Array.isArray(data.abslist)) throw new Error('酷我搜索失败')
    return {
      list: data.abslist.map(filterSong),
      total: safeInt(data.TOTAL, data.abslist.length),
      page,
      limit,
      source: SOURCE,
    }
  },

  /**
   * 搜专辑。同一个 r.s 接口换 `ft=album` 即可（实测 CF 出口 576ms）。
   * 封面有两个字段：`img` 是完整 URL，`pic` 是相对路径（要配 BASEPICPATH），优先 img。
   */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const url = 'http://search.kuwo.cn/r.s?' + new URLSearchParams({
      all: keyword,
      ft: 'album',
      rn: String(limit),
      pn: String(page - 1),
      encoding: 'utf8',
      rformat: 'json',
      mobi: '1',
      vipver: '1',
    })
    const { json, text } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1, timeout: 15000 })
    const data = json || tryParseKuwo(text)
    if (!data || !Array.isArray(data.albumlist)) throw new Error('酷我专辑搜索失败')
    const base = data.BASEPICPATH || ''
    const list = data.albumlist.map(a => {
      let img = a.img || ''
      if (!img && a.pic && base) img = base + a.pic
      return {
        source: SOURCE,
        id: String(a.albumid || a.id || ''),
        name: decodeName(a.name || a.album || ''),
        singer: decodeName(a.artist || ''),
        img: img ? String(img).replace(/^http:/, 'https:') : '',
        trackCount: safeInt(a.musiccnt),
        publishDate: String(a.pub || a.showtime || '').slice(0, 10),
        intro: String(a.info || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 120),
      }
    }).filter(a => a.id && a.name)
    return { list, total: list.length, page, limit, source: SOURCE }
  },

  /** 原生取流：antiserver 返回纯文本 URL；失败退回网页接口 */
  async getMusicUrl(song, quality = '320k') {
    const rid = song && (song.songmid || song.id)
    if (!rid) return null
    const fmt = quality.startsWith('flac') ? 'flac' : 'mp3'
    const candidates = [
      `https://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_${rid}&format=${fmt}&response=url`,
      `https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=MUSIC_${rid}&format=${fmt}&response=url`,
    ]
    for (const url of candidates) {
      try {
        const { text } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 0, timeout: 10000 })
        const trimmed = String(text || '').trim()
        if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed
      } catch { /* 试下一个 */ }
    }
    try {
      const { json } = await request(`https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${rid}&type=music&httpsStatus=1`, {
        headers: { 'User-Agent': UA_PC, Referer: 'https://www.kuwo.cn/', Cookie: 'kw_token=ABCDEFG' },
        retry: 0, timeout: 10000,
      })
      if (json && json.data && json.data.url) return json.data.url
    } catch { /* ignore */ }
    return null
  },

  /**
   * 歌词。
   *
   * 上游 `m.kuwo.cn/newh5/singles/songinfoandlrc` 会**随机**返回
   * `{"data":null,"msg":"音乐查询失败"}`，HTTP 仍是 200。
   *
   * 实测（同一 musicId 连打）：单次成功率只有约 25%，
   *   无间隔 ×12 → 3/12；间隔 1200ms ×8 → 2/8。
   * 也就是说这不是限流 —— 加间隔没用，是上游自己在若干后端之间随机挑一个，
   * 其中大部分取不到数据。
   *
   * 顺带把能试的都试了，只有这一个接口有救：`www.kuwo.cn/api/www/music/lyric`、
   * `mobi.kuwo.cn/mobi.s`（convert_lrc / convert_lrc_batch）、
   * `nplserver.kuwo.cn/pl.svc?op=getlrc`、`newlyric.kuwo.cn/newlyric.lrc`
   * （?id= / ?lyricid= / ?MUSIC_ / 裸 rid 四种参数）**全部 0/8**。
   *
   * 所以唯一的解法是按内容多试几次：p≈0.25 时 8 次全败约 10%，
   * 再叠上前端那一次重试（见 fetchLyric）落到 1% 量级。
   * 退避封顶 400ms，避免「整首歌都没歌词」时白等太久（最坏约 3s）。
   */
  async getLyric(song) {
    const rid = song && (song.songmid || song.id)
    if (!rid) return null
    const url = `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}`
    const list = await retryUntil(
      async () => {
        const { json } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 0 })
        return (json && json.data && json.data.lrclist) || null
      },
      (l) => Array.isArray(l) && l.length > 0,
      { attempts: 8, wait: (ms) => sleep(Math.min(ms, 400)) }
    )
    if (!list) return null
    return {
      lyric: list
        .map(l => {
          const t = Number(l.time) || 0
          const mm = String(Math.floor(t / 60)).padStart(2, '0')
          const ss = (t % 60).toFixed(2).padStart(5, '0')
          return `[${mm}:${ss}]${l.lineLyric || ''}`
        })
        .join('\n'),
    }
  },

  async getPic(song) {
    return (song && song.img) || null
  },

  /** 歌单：新版 nplserver 接口 */
  async getPlaylist(id) {
    const pid = String(id).replace(/[^0-9]/g, '')
    const url = 'http://nplserver.kuwo.cn/pl.svc?' + new URLSearchParams({
      op: 'getlistinfo', pid, pn: '0', rn: '1000', encode: 'utf8', keyset: 'pl2012',
      identity: 'kuwo', pcmp4: '1', vipver: 'MUSIC_9.1.1.2_W2', newver: '1',
    })
    const { json, text } = await request(url, { headers: { 'User-Agent': UA_PC }, retry: 1 })
    const data = json || tryParseKuwo(text)
    if (!data || !Array.isArray(data.musiclist)) throw new Error('酷我歌单获取失败')
    const songs = data.musiclist.map(m => filterSong({
      SONGNAME: m.name,
      ARTIST: m.artist,
      ALBUM: m.album,
      ALBUMID: m.albumid,
      MUSICRID: `MUSIC_${m.rid}`,
      DURATION: m.duration,
      N_MINFO: m.n_minfo,
      web_albumpic_short: m.web_albumpic_short,
      prob_albumpic: m.albumpic,
    }))
    return { source: SOURCE, sourceId: pid, name: data.title || `酷我歌单 ${pid}`, cover: data.pic || null, songs }
  },
}

/** 酷我部分接口返回带单引号的伪 JSON */
function tryParseKuwo(text) {
  if (!text) return null
  const s = String(text).trim()
  const cleaned = s.replace(/^[\s\S]*?=\s*/, '')
  try { return JSON.parse(cleaned) } catch { /* ignore */ }
  try {
    return JSON.parse(cleaned.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"'))
  } catch { return null }
}
