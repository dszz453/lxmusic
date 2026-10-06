/**
 * 汽水音乐（抖音）歌单适配。
 *
 * 为什么单独开一个文件而不是塞进 providers/index.js：
 *   这个模块**不是**一个可播放音源。PROVIDERS 里的那些（wy/kg/kw/tx/mg/xm）都能
 *   按自己的 id 解析出音频直链，所以导入后能直接播。汽水不行 —— 我们能拿到歌单曲目，
 *   但拿不到（也不打算去拿）可播直链。所以这里的产出是「歌名 + 歌手」清单，
 *   再由调用方拿去现有音源里逐首匹配。把它混进 PROVIDERS 会让人以为
 *   `qs:xxx` 这种 id 能播，那是个坑。
 *
 * 链路（实测 2026-10-05）：
 *   1. 分享短链 https://qishui.douyin.com/s/<code>/
 *      → 302 → https://music.douyin.com/qishui/share/playlist?playlist_id=...&sec_sharer_id=...
 *      （单曲分享会跳到 /qishui/share/track?track_id=...，视频跳到 /qishui/share/ugc_video?ugc_video_id=...）
 *   2. 落地页是 SSR 的，HTML 里有一段 `_ROUTER_DATA = {...}`，
 *      loaderData.playlist_page 里有 playlistInfo（名称 / 封面 / 曲目数）
 *      和 medias[]（每首的 entity.track：id / name / artists[] / album / duration）。
 *
 * 注意短码**会过期**：失效时第 1 步返回 200 + `{"message":"404 not found"}`（不是 4xx/5xx），
 * 所以判定失效不能只看状态码，得看落地的 URL 里有没有解析出 id。
 */
import { request, UA_MOBILE } from '../lib/http.js'
import { userError } from '../lib/util.js'

const DOUYIN_IMG_HOST = 'https://p3-luna.douyinpic.com/img/'

/** 分享短链：https://qishui.douyin.com/s/<code>/  → code */
export function matchQishuiShort(url) {
  const m = String(url || '').match(/^https?:\/\/qishui\.douyin\.com\/s\/([A-Za-z0-9_-]+)\/?/i)
  return m ? m[1] : null
}

/**
 * 落地页链接 → 实体。
 *   https://music.douyin.com/qishui/share/playlist?playlist_id=123  → { kind:'playlist', id:'123' }
 *   https://music.douyin.com/qishui/share/track?track_id=123        → { kind:'track', id:'123' }
 *   .../share/ugc_video?ugc_video_id=123                            → { kind:'video', id:'123' }
 */
export function matchDouyinShare(url) {
  const raw = String(url || '')
  if (!/^https?:\/\/music\.douyin\.com\/qishui\//i.test(raw)) return null
  let u
  try { u = new URL(raw) } catch { return null }
  const p = u.searchParams
  const playlistId = p.get('playlist_id') || p.get('playlistId')
  if (playlistId) return { kind: 'playlist', id: playlistId }
  const trackId = p.get('track_id') || p.get('trackId')
  if (trackId) return { kind: 'track', id: trackId }
  const videoId = p.get('ugc_video_id') || p.get('video_id')
  if (videoId) return { kind: 'video', id: videoId }
  return null
}

/**
 * 跟随跳转拿到最终的落地页。
 *
 * 用 redirect:'follow' + 读 res.url，比自己逐跳拼 Location 稳：
 * 抖音这边会跳两三跳（短链 → 分享页 → 可能再带一次签名参数），中间任意一跳的
 * Location 相对路径都要自己解析，容易漏。
 *
 * 短码失效时拿到的仍是 200，但落地的不是 music.douyin.com 的分享页 —— 这里如实返回 null，
 * 让上层给出「链接已过期」而不是「解析失败」。
 */
export async function expandQishuiShare(url) {
  const res = await request(url, { raw: true, redirect: 'follow', timeout: 15000, headers: { 'User-Agent': UA_MOBILE }, retry: 1 })
  const finalUrl = (res && res.url) || url
  const entity = matchDouyinShare(finalUrl)
  if (entity) return { ...entity, url: finalUrl }
  // 兜底：有的跳转会把参数留在 body 的刷新链接里，再扫一遍跳转目标
  const loc = res && res.headers && (res.headers.location || res.headers.Location)
  if (loc) {
    const ent2 = matchDouyinShare(loc)
    if (ent2) return { ...ent2, url: loc }
  }
  return null
}

/**
 * 从 SSR 页面里抠出 `_ROUTER_DATA`。
 *
 * 为什么不用正则一把梭：那个 JSON 里嵌着歌词/描述等含 `}` 与 `"` 的字符串，
 * `/\{[\s\S]*?\}/` 这种非贪婪匹配会在一半就收尾。这里老老实实做括号配平，
 * 并且只在字符串外计数 —— 否则歌词里的花括号会把深度算歪。
 */
export function extractRouterData(html) {
  const key = html.indexOf('_ROUTER_DATA')
  if (key < 0) return null
  const start = html.indexOf('{', key)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) return null
  try { return JSON.parse(html.slice(start, end)) } catch { return null }
}

/** 抖音图床模板：urls[0] + uri + '~' + template_prefix + '-crop-center:720:720.jpg'（实测 200） */
export function douyinCover(urlCover) {
  if (!urlCover) return ''
  const base = (urlCover.urls && urlCover.urls[0]) || (urlCover.uri ? DOUYIN_IMG_HOST : '')
  const uri = urlCover.uri || ''
  if (!base || !uri) return ''
  const tpl = urlCover.template_prefix || 'tplv-b829550vbb'
  return base.replace(/\/?$/, '/') + uri + '~' + tpl + '-crop-center:720:720.jpg'
}

/** 一份 SSR 页面 → { name, cover, songs } */
export function parseQishuiPlaylistPage(html) {
  const data = extractRouterData(html)
  const page = data && data.loaderData && data.loaderData.playlist_page
  if (!page) return null
  const info = page.playlistInfo || {}
  const songs = []
  for (const m of page.medias || []) {
    const t = m && m.entity && m.entity.track
    if (!t || !t.name) continue
    const album = t.album || {}
    songs.push({
      name: String(t.name),
      singer: (t.artists || []).map(a => a && a.name).filter(Boolean).join('/'),
      albumName: album.name ? String(album.name) : '',
      // duration 是毫秒，统一成秒 —— 与其它平台 getPlaylist 的口径一致
      interval: t.duration ? Math.round(t.duration / 1000) : 0,
      cover: douyinCover(album.url_cover) || douyinCover(info.url_cover),
      // 只作展示 / 去重用，不要拿它去解析音频（我们没有汽水的取流链路）
      qsId: t.id ? String(t.id) : '',
    })
  }
  return {
    source: 'qs',
    sourceId: String(info.id || ''),
    name: info.title ? String(info.title) : '汽水音乐歌单',
    cover: douyinCover(info.url_cover),
    songs,
    matchNeeded: true,   // 提示调用方：这些歌要逐首去现有音源里找
  }
}

/** 歌单落地页 → { name, cover, songs, matchNeeded } */
export async function getQishuiPlaylist(playlistId) {
  const id = String(playlistId || '').replace(/[^0-9]/g, '')
  if (!id) throw userError('汽水歌单 id 无效，请重新复制分享链接')
  const url = 'https://music.douyin.com/qishui/share/playlist?playlist_id=' + id
  const res = await request(url, { timeout: 20000, headers: { 'User-Agent': UA_MOBILE }, retry: 1 })
  const parsed = parseQishuiPlaylistPage(res.text || '')
  if (!parsed) throw new Error('汽水歌单页解析失败（页面结构可能变了）')
  if (!parsed.songs.length) throw userError('这个汽水歌单是空的，或者没有被公开分享')
  return parsed
}
