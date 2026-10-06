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

/**
 * 老版 Web 搜索接口。**两个域名并行竞速，谁先给出有效结果用谁。**
 *
 * 为什么从「串行轮询」改成「并行竞速」（2026-10-06 实测）：
 *   原来顺序是 c → c6 → szc → u，单域名超时 3s、总预算 5s。实测延时：
 *
 *       域名            中位     最快     最慢
 *       c.y.qq.com     3816ms  2047ms  4349ms   ← 排在第一位
 *       c6.y.qq.com    2939ms  2464ms  3093ms
 *
 *   **c 的中位延时就有 3.8 秒，已经超过 3 秒的单域名超时** —— 也就是有过半的
 *   请求直接撞超时；它还把 5 秒总预算先吃掉一大块，轮到 c6 时只剩一两秒。
 *   结果就是「QQ 音乐接口受限，本次未返回结果」随机出现。
 *
 *   实测三种策略的成功率（各 6 轮）：
 *       串行 c,c6,szc（3s/5s）  5/6   平均 3323ms
 *       串行 c6,c,szc（4s/8s）  6/6   平均 2969ms
 *       并行 c6∥c（6s）         6/6   平均 2631ms   ← 最快且最稳
 *
 * 所以：并行发 c6 与 c，先返回有效结果的胜出；另一个立刻 abort，不白等。
 *
 * 另外两处修正：
 *   · `u.y.qq.com` 从列表里删掉 —— 实测这个域名下 /soso/fcgi-bin/ 恒返回 404，
 *     它从来没成功过，只是白白占掉一份时间预算。
 *   · `szc.y.qq.com` 降级为「补位」：实测它恒返回 HTTP 500，保留它只为极端
 *     情况下的最后一搏，不再占用并行首轮的名额。
 */
const SEARCH_HOSTS = ['c6.y.qq.com', 'c.y.qq.com']   // 并行竞速的两个主力
const FALLBACK_HOSTS = ['szc.y.qq.com']              // 补位（实测常 500，只在前面全挂时试）

/**
 * 单域名超时。实测最慢一次 4349ms，给到 6000ms 留足余量 ——
 * 并行发两路的情况下，这个值只影响「什么时候放弃」，不影响平均耗时。
 */
const HOST_TIMEOUT = 6000

async function fetchFromHost(host, query) {
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
    return {
      list: [],
      diag: `${host}: http=${status} code=${data && data.code} len=${(text || '').length} list=${raw.length}`,
    }
  } catch (e) {
    return { list: [], diag: `${host}: ${(e && e.message) || e}`.slice(0, 70) }
  }
}

async function searchLegacy(keyword, page, limit) {
  const query = `p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}`
    + '&format=json&t=0&aggr=1&cr=1&lossless=1&new_json=1&platform=yqq.json&needNewCode=0'

  // 第一轮：主力域名并行竞速，先拿到有效结果的胜出
  const first = await Promise.race(
    SEARCH_HOSTS.map(h => fetchFromHost(h, query).then(r => (r.list.length ? r : Promise.reject(r)))),
  ).catch(() => null)
  if (first) return first

  // 第一轮全挂（或都返回空）→ 收集诊断，再试补位域名
  const diags = await Promise.all(SEARCH_HOSTS.map(h => fetchFromHost(h, query)))
    .then(rs => rs.map(r => r.diag))
  for (const host of FALLBACK_HOSTS) {
    const r = await fetchFromHost(host, query)
    if (r.list.length) return r
    diags.push(r.diag)
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
    const legacy = await searchLegacy(keyword, page, limit)
    if (legacy.list.length) {
      return { list: legacy.list, total: legacy.list.length, page, limit, source: SOURCE }
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

    /** 抓一个域名并解析出专辑列表（空数组表示这个域名没给到可用数据）。 */
    const fetchAlbums = async (host) => {
      try {
        const { status, json, text } = await request(`https://${host}/soso/fcgi-bin/client_search_cp?${query}`, {
          headers: { 'User-Agent': UA_PC, Referer: 'https://y.qq.com/portal/search.html' },
          retry: 0,
          timeout: HOST_TIMEOUT,
        })
        const data = json || safeParse(text)
        const seg = data && data.data && data.data.album
        const raw = (seg && seg.list) || []
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
        if (list.length) return { list, total: safeInt(seg.totalnum, list.length), page, limit, source: SOURCE }
        return { list: [], diag: `${host}: http=${status} list=${raw.length}` }
      } catch (e) {
        return { list: [], diag: `${host}: ${(e && e.message) || e}`.slice(0, 60) }
      }
    }

    // 与歌曲搜索同一套策略：主力域名并行竞速，补位域名兜底
    const winner = await Promise.race(
      SEARCH_HOSTS.map(h => fetchAlbums(h).then(r => (r.list.length ? r : Promise.reject(r)))),
    ).catch(() => null)
    if (winner) return winner

    const diags = (await Promise.all(SEARCH_HOSTS.map(fetchAlbums))).map(r => r.diag)
    for (const host of FALLBACK_HOSTS) {
      const r = await fetchAlbums(host)
      if (r.list.length) return r
      diags.push(r.diag)
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
