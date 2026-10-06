/**
 * 咪咕音乐（mg）
 *
 * 搜索 / 专辑 / 歌词 / 封面都走 MIGUM2.0 这一套：
 *   https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do
 *   搜索歌曲：searchSwitch={"song":1}
 *   搜索专辑：searchSwitch={"album":1}
 * 实测 CF 出口 200（搜索 ~0.9s，专辑 ~1.2s）。
 *
 * ⚠️ 取流例外：listenSong.do 对免费/付费曲目一律返回
 *    `{"code":"200000","info":"暂不提供试听地址"}` —— 换 toneFlag（LQ/PQ/HQ/SQ）、
 *    换 resourceType、加 deviceId、换 MIGUM3.0 路由都试过，全是同一句。
 *    所以这里**不实现原生取流**，交给落雪插件兜底：本地插件池里
 *    liuyun-lxmusic / liuyun-nya / pdone-huanyin / pdone-huibq / pdone-qdy
 *    这 5 个都声明了 mg 的 musicUrl，musicUrlCandidateList() 会自动走它们。
 *
 * 歌词很省事：搜索结果的 lyricUrl 直接就是 LRC 文本（实测 1.5KB 完整歌词），
 * 不需要再调歌词接口。trcUrl 是翻译，多数为空。
 */
import { request, UA_PC } from '../lib/http.js'
import { decodeName, safeInt } from '../lib/util.js'

const SOURCE = 'mg'
const SEARCH_API = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do'
const REFERER = 'https://m.music.migu.cn/'

/** 音质档位映射。咪咕给的是 rateFormats[].formatType，只取我们认识的三档 */
const QUALITY_MAP = {
  PQ: ['128k', 128],
  HQ: ['320k', 320],
  SQ: ['flac', 740],
  ZQ: ['flac24bit', 1948],
}

function pickImg(raw) {
  const items = (raw && raw.imgItems) || []
  if (!items.length) return ''
  // imgSizeType 01 < 02 < 03，取最大那张；拿不到就退回最后一个
  const sorted = [...items].sort((a, b) => String(b.imgSizeType || '').localeCompare(String(a.imgSizeType || '')))
  return String((sorted[0] && sorted[0].img) || '').replace(/^http:/, 'https:')
}

function filterSong(raw) {
  const types = []
  const _types = {}
  for (const f of raw.rateFormats || []) {
    const entry = QUALITY_MAP[f.formatType]
    if (!entry) continue
    const [type, bitrate] = entry
    if (_types[type]) continue
    types.push({ type, size: safeInt(f.size), format: f.fileType || f.androidFileType || 'mp3' })
    _types[type] = { size: safeInt(f.size), bitrate, format: f.fileType || f.androidFileType || 'mp3' }
  }
  types.reverse()   // 由低到高，跟其它平台一致

  return {
    source: SOURCE,
    // contentId 才是取流/歌词要的东西，copyrightId 也一并带上（插件会用到）
    id: String(raw.contentId || raw.id || ''),
    songmid: String(raw.contentId || raw.id || ''),
    contentId: String(raw.contentId || ''),
    copyrightId: String(raw.copyrightId || ''),
    name: decodeName(raw.name || ''),
    singer: decodeName((raw.singers || []).map(s => s.name).filter(Boolean).join('、')),
    albumName: decodeName(((raw.albums || [])[0] || {}).name || ''),
    albumId: String(((raw.albums || [])[0] || {}).id || ''),
    interval: safeInt(raw.length || raw.duration),
    img: pickImg(raw),
    // 搜索结果里直接带歌词地址，播放时不用再查一遍
    lyricUrl: String(raw.lyricUrl || ''),
    types,
    _types,
    _rawTags: raw.tags || [],
  }
}

export default {
  id: SOURCE,
  name: '咪咕音乐',

  async search(keyword, page = 1, limit = 30) {
    const url = `${SEARCH_API}?` + new URLSearchParams({
      text: keyword,
      pageNo: String(page),
      pageSize: String(limit),
      searchSwitch: JSON.stringify({ song: 1 }),
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC, Referer: REFERER }, retry: 1, timeout: 15000 })
    if (!json || json.code !== '000000' || !json.songResultData) throw new Error('咪咕搜索失败')
    const list = (json.songResultData.result || []).map(filterSong).filter(s => s.id && s.name)
    return { list, total: safeInt(json.songResultData.totalCount), page, limit, source: SOURCE }
  },

  /** 搜专辑 */
  async searchAlbum(keyword, page = 1, limit = 20) {
    const url = `${SEARCH_API}?` + new URLSearchParams({
      text: keyword,
      pageNo: String(page),
      pageSize: String(limit),
      searchSwitch: JSON.stringify({ album: 1 }),
    })
    const { json } = await request(url, { headers: { 'User-Agent': UA_PC, Referer: REFERER }, retry: 1, timeout: 15000 })
    if (!json || json.code !== '000000' || !json.albumResultData) throw new Error('咪咕专辑搜索失败')
    const list = (json.albumResultData.result || []).map(a => ({
      source: SOURCE,
      id: String(a.id || ''),
      name: decodeName(a.name || ''),
      singer: decodeName(a.singer || ''),
      img: String(a.imgItems && a.imgItems.length
        ? (a.imgItems.find(i => String(i.imgSizeType) === '03') || a.imgItems[0]).img
        : (a.img || '')).replace(/^http:/, 'https:'),
      trackCount: safeInt(a.songCount || a.totalCount),
      publishDate: String(a.publishDate || ''),
      intro: String(a.intro || '').slice(0, 120),
    })).filter(a => a.id && a.name)
    return { list, total: safeInt(json.albumResultData.totalCount), page, limit, source: SOURCE }
  },

  /**
   * 原生取流：咪咕所有路由都拒绝提供试听地址（见文件头说明）。
   * 返回空数组而不是抛错 —— 让 musicUrlCandidateList() 自然落到插件兜底那一段。
   */
  async getMusicUrlCandidates() {
    return []
  },

  async getLyric(song) {
    if (!song) return null
    const url = song.lyricUrl
    if (!url) return null
    try {
      const { text } = await request(url, { headers: { 'User-Agent': UA_PC, Referer: REFERER }, retry: 0, timeout: 12000 })
      const body = String(text || '').trim()
      if (!body || !/\[\d{1,3}:\d{1,2}/.test(body)) return null
      return { lyric: body }
    } catch { return null }
  },

  async getPic(song) {
    if (song && song.img) return song.img
    return null
  },
}
