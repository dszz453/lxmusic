/**
 * Subsonic API 兼容层（面向 音流 / Feishin / DSub / substreamer 等客户端）
 *
 * 设计要点：
 * 1. 本站是「在线聚合」型音乐库，没有本地曲库；search3 直接返回各平台实时搜索结果。
 * 2. 可浏览内容（专辑列表/歌单）映射为用户歌单 + 收藏。
 * 3. stream 一定由服务端解析地址并代理，保证「解析与拉流同一出口」，规避 CDN 的 IP 绑定限制。
 */
import { md5 } from '../lib/crypto.js'
import { encodeSongId, decodeSongId, encodeAlbumId, decodeAlbumId } from '../lib/songid.js'
import { searchOnline, resolveLyric, resolvePic, parseQuery, SOURCE_META, ALL_SOURCES, getProvider } from '../providers/index.js'
import { pluginSearchSourceKeys } from './sources.js'
import { audioMime, guessAudioFormat, safeInt, decodeName } from '../lib/util.js'
import { openAudioStream } from '../lib/stream.js'
import { outboundFetch } from '../lib/http.js'
import * as db from '../db.js'

export const API_VERSION = '1.16.1'
export const SUBSONIC_NS = 'http://subsonic.org/restapi'

/* =========================================================
 *  响应序列化
 * ========================================================= */

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 去掉 XML 非法控制字符，否则客户端解析直接崩
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

function toXml(name, value, indent = '') {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) {
    return value.map(v => toXml(name, v, indent)).join('')
  }
  if (typeof value === 'object') {
    let attrs = ''
    let children = ''
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue
      if (k.startsWith('@')) attrs += ` ${k.slice(1)}="${xmlEscape(v)}"`
      else children += toXml(k, v, indent + '  ')
    }
    if (!children) return `${indent}<${name}${attrs}/>`
    return `${indent}<${name}${attrs}>${children.startsWith('\n') ? '' : ''}${children}</${name}>`
  }
  return `${indent}<${name}>${xmlEscape(value)}</${name}>`
}

function subsonicEnvelope(payload, version) {
  return { 'subsonic-response': { '@xmlns': SUBSONIC_NS, '@status': payload.status || 'ok', '@version': version || API_VERSION, ...payload } }
}

/**
 * XML 里用 `@attr` 区分属性与子元素，但 Subsonic 的 JSON 格式（f=json）
 * 是**扁平**的：属性和子元素一律是普通键。
 * 例如 `{"subsonic-response":{"status":"ok","version":"1.16.1","xmlns":"..."}}`。
 * 如果直接把带 @ 前缀的对象 stringify 出去，客户端（音流 / Feishin）会解析不到字段。
 */
function toSubsonicJson(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(toSubsonicJson)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k.startsWith('@') ? k.slice(1) : k] = toSubsonicJson(v)
    }
    return out
  }
  return value
}

function respond(payload, ctx) {
  const version = ctx.version || API_VERSION
  const envelope = subsonicEnvelope(payload, version)
  if (ctx.format === 'json') {
    return new Response(JSON.stringify({ 'subsonic-response': toSubsonicJson(envelope['subsonic-response']) }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    })
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n${toXml('subsonic-response', envelope['subsonic-response'], '')}`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'access-control-allow-origin': '*' },
  })
}

function fail(code, message, ctx) {
  return respond({ status: 'failed', error: { '@code': code, '@message': message } }, ctx)
}

/* =========================================================
 *  鉴权
 * ========================================================= */

/**
 * 支持三种 Subsonic 鉴权：
 *  - u + t + s ：token = md5(password + salt)（推荐）
 *  - u + p     ：明文密码，或 p=enc:xxxx 的十六进制密码
 *  - u + p 且 p 以 "token:" 开头：直接传 md5 密码
 */
export async function authenticate(env, params) {
  const username = params.get('u')
  if (!username) return { error: [10, '缺少参数 u（用户名）'] }
  const user = await db.findUserByName(env.DB, username)
  if (!user) return { error: [40, '用户名或密码错误'] }

  const token = params.get('t')
  const salt = params.get('s')
  if (token && salt !== null && salt !== undefined) {
    const expect = md5(user.password + salt)
    if (expect.toLowerCase() !== String(token).toLowerCase()) return { error: [40, '用户名或密码错误'] }
    return { user }
  }

  const p = params.get('p')
  if (p) {
    let password = p
    if (p.startsWith('enc:')) {
      try {
        password = hexToStr(p.slice(4))
      } catch { return { error: [40, '密码解码失败'] } }
    }
    if (password === user.password) return { user }
    return { error: [40, '用户名或密码错误'] }
  }

  return { error: [10, '缺少鉴权参数（需要 t+s 或 p）'] }
}

function hexToStr(hex) {
  let out = ''
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  return out
}

/* =========================================================
 *  对象转换
 * ========================================================= */

function songToSubsonic(song, favoriteIds = null) {
  const id = encodeSongId(song)
  const albumId = encodeAlbumId(song.source, song.albumId || '', song.albumName || '', song.singer || '', song.img || '')
  const artistId = song.singer ? encodeArtistIdSafe(song.singer) : undefined
  // 用插件声明的音质推断最佳后缀；没有则用 mp3
  const types = song.types || []
  const best = types.includes('flac24bit') ? 'flac' : types.includes('flac') ? 'flac' : 'mp3'
  return {
    '@id': id,
    '@parent': albumId,
    '@isDir': false,
    '@title': song.name || '未知歌曲',
    '@album': song.albumName || '未知专辑',
    '@artist': song.singer || '未知歌手',
    '@track': 0,
    '@year': 0,
    '@genre': (SOURCE_META[song.source] && SOURCE_META[song.source].short) || song.source,
    '@coverArt': id,
    '@size': 0,
    '@contentType': audioMime(null, best),
    '@suffix': best,
    '@duration': safeInt(song.interval),
    '@bitRate': best === 'flac' ? 900 : 320,
    '@path': `${song.singer || ''} - ${song.name || ''}`.trim(),
    '@albumId': albumId,
    ...(artistId ? { '@artistId': artistId } : {}),
    '@type': 'music',
    ...(favoriteIds && favoriteIds.has(id) ? { '@starred': new Date().toISOString() } : {}),
  }
}

function artistIdFor(name) {
  return encodeArtistIdSafe(name)
}

function encodeArtistIdSafe(name) {
  // 避免循环依赖，内联一个最简实现
  const json = JSON.stringify({ n: name })
  let b64 = ''
  try {
    b64 = btoa(unescape(encodeURIComponent(json)))
  } catch {
    b64 = json
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function albumToSubsonic({ id, name, artist, cover, songCount = 0, created = null }) {
  return {
    '@id': id,
    '@name': name || '未命名专辑',
    '@artist': artist || '未知歌手',
    '@artistId': artistIdFor(artist || '未知歌手'),
    '@coverArt': id,
    '@songCount': songCount,
    '@duration': 0,
    '@playCount': 0,
    '@created': created || new Date().toISOString(),
  }
}

/* =========================================================
 *  路由
 * ========================================================= */

export async function handleSubsonic(request, env, url) {
  const params = url.searchParams
  const ctx = {
    format: (params.get('f') || 'xml').toLowerCase() === 'json' ? 'json' : 'xml',
    version: params.get('v') || API_VERSION,
    client: params.get('c') || 'unknown',
  }

  // /rest/ping 也要鉴权（客户端据此校验账号）
  const method = url.pathname.replace(/^.*\/rest\//, '').replace(/\.view$/, '')
  const auth = await authenticate(env, params)
  if (auth.error) return fail(auth.error[0], auth.error[1], ctx)
  const user = auth.user

  try {
    switch (method) {
      case 'ping': return respond({}, ctx)
      case 'getLicense': return respond({ license: { '@valid': true, '@email': user.username + '@local', '@licenseExpires': '2099-12-31T23:59:59.000Z' } }, ctx)
      case 'getUser': return respond({ user: buildUser(user) }, ctx)
      case 'getMusicFolders': return respond({ musicFolders: { musicFolder: [{ '@id': 0, '@name': '在线音乐' }] } }, ctx)
      case 'getScanStatus': return respond({ scanStatus: { '@scanning': false, '@count': 0 } }, ctx)
      case 'getGenres': return respond({ genres: { genre: Object.values(SOURCE_META).map(m => ({ '@songCount': 0, '@albumCount': 0, '#text': m.name })) } }, ctx)
      case 'getIndexes': return getIndexes(env, user, ctx)
      case 'getArtists': return getArtists(env, user, ctx)
      case 'getArtist': return getArtist(env, user, params, ctx)
      case 'getAlbumList':
      case 'getAlbumList2': return getAlbumList(env, user, params, ctx)
      case 'getAlbum': return getAlbum(env, user, params, ctx)
      case 'getSong': return getSong(env, user, params, ctx)
      case 'getRandomSongs': return getRandomSongs(env, params, ctx)
      case 'getTopSongs': return getTopSongs(env, params, ctx)
      case 'getSimilarSongs':
      case 'getSimilarSongs2': return getSimilarSongs(env, params, ctx)
      case 'search':
      case 'search2':
      case 'search3': return search(env, user, params, ctx, method)
      case 'stream':
      case 'download': return stream(env, params, ctx, method)
      case 'getCoverArt': return getCoverArt(env, params, ctx)
      case 'getLyrics': return getLyrics(env, params, ctx)
      case 'getLyricsBySongId': return getLyricsBySongId(env, params, ctx)
      case 'getPlaylists': return getPlaylists(env, user, ctx)
      case 'getPlaylist': return getPlaylist(env, user, params, ctx)
      case 'createPlaylist': return createPlaylist(env, user, params, ctx)
      case 'updatePlaylist': return updatePlaylist(env, user, params, ctx)
      case 'deletePlaylist': return deletePlaylist(env, user, params, ctx)
      case 'star': return star(env, user, params, ctx)
      case 'unstar': return unstar(env, user, params, ctx)
      case 'getStarred':
      case 'getStarred2': return getStarred(env, user, params, ctx)
      case 'scrobble': return respond({}, ctx)
      case 'setRating': return respond({}, ctx)
      case 'getPlayQueue': return respond({}, ctx)
      case 'savePlayQueue': return respond({}, ctx)
      case 'getArtistInfo':
      case 'getArtistInfo2': return respond({}, ctx)
      case 'getAlbumInfo':
      case 'getAlbumInfo2': return respond({}, ctx)
      case 'getSongsByGenre': return respond({ songsByGenre: {} }, ctx)
      case 'getBookmarks': return respond({ bookmarks: {} }, ctx)
      case 'getShares': return respond({ shares: {} }, ctx)
      case 'getInternetRadioStations': return respond({ internetRadioStations: {} }, ctx)
      case 'getChatMessages': return respond({ chatMessages: {} }, ctx)
      case 'getNowPlaying': return respond({ nowPlaying: {} }, ctx)
      case 'getAvatar': return placeholderCover(ctx)
      default:
        return fail(0, `不支持的接口: ${method}`, ctx)
    }
  } catch (e) {
    console.error(`[subsonic] ${method} 处理失败:`, e && e.stack || e)
    return fail(0, String((e && e.message) || e), ctx)
  }
}

function buildUser(user) {
  return {
    '@username': user.username,
    '@email': '',
    '@scrobblingEnabled': false,
    '@adminRole': !!user.is_admin,
    '@settingsRole': true,
    '@downloadRole': true,
    '@uploadRole': false,
    '@playlistRole': true,
    '@coverArtRole': true,
    '@commentRole': false,
    '@podcastRole': false,
    '@streamRole': true,
    '@jukeboxRole': false,
    '@shareRole': false,
    '@videoConversionRole': false,
  }
}

/* ---------------- 浏览 ---------------- */

async function getIndexes(env, user, ctx) {
  const artists = await collectArtists(env, user)
  return respond({
    indexes: {
      '@lastModified': Date.now(),
      '@ignoredArticles': 'The El La Los Las Le Les',
      index: artists.length ? [{ '@name': '★', artist: artists.map(a => ({ '@id': a.id, '@name': a.name, '@albumCount': a.albumCount })) }] : [],
    },
  }, ctx)
}

async function getArtists(env, user, ctx) {
  const artists = await collectArtists(env, user)
  return respond({
    artists: {
      '@ignoredArticles': 'The El La Los Las Le Les',
      index: artists.length ? [{ '@name': '★', artist: artists.map(a => ({ '@id': a.id, '@name': a.name, '@albumCount': a.albumCount, '@coverArt': a.id })) }] : [],
    },
  }, ctx)
}

async function collectArtists(env, user) {
  const playlists = await db.listPlaylists(env.DB, user.id)
  const favorites = await db.listFavorites(env.DB, user.id)
  const names = new Set(playlists.map(p => p.name))
  for (const f of favorites) {
    for (const n of String(f.singer || '').split('、')) if (n.trim()) names.add(n.trim())
  }
  return Array.from(names).slice(0, 200).map(n => ({ id: artistIdFor(n), name: n, albumCount: 1 }))
}

async function getArtist(env, user, params, ctx) {
  const id = params.get('id') || ''
  let name = ''
  try {
    const decoded = JSON.parse(decodeURIComponent(escape(atob(id.replace(/-/g, '+').replace(/_/g, '/')))))
    name = decoded.n || ''
  } catch { /* ignore */ }
  if (!name) return respond({ artist: { '@id': id, '@name': '未知歌手', album: [] } }, ctx)

  const albums = []
  const playlists = await db.listPlaylists(env.DB, user.id)
  for (const p of playlists) albums.push(albumToSubsonic({ id: p.id, name: p.name, artist: name, cover: p.cover, songCount: p.song_count }))
  return respond({ artist: { '@id': id, '@name': name, '@albumCount': albums.length, album: albums } }, ctx)
}

/**
 * 专辑列表映射为「用户歌单 + 收藏」，让客户端有可浏览的目录结构。
 */
async function getAlbumList(env, user, params, ctx) {
  const size = Math.min(safeInt(params.get('size'), 50) || 50, 500)
  const offset = safeInt(params.get('offset'), 0)
  const playlists = await db.listPlaylists(env.DB, user.id)
  const favorites = await db.listFavorites(env.DB, user.id)

  const albums = playlists.map(p => albumToSubsonic({
    id: p.id,
    name: p.name,
    artist: p.source ? ((SOURCE_META[p.source] && SOURCE_META[p.source].name) || p.source) : '我的歌单',
    cover: p.cover,
    songCount: p.song_count,
    created: new Date(p.created_at).toISOString(),
  }))
  if (favorites.length) {
    albums.unshift(albumToSubsonic({
      id: 'favorites', name: '我的收藏', artist: '收藏',
      cover: favorites[0].img || '', songCount: favorites.length,
    }))
  }
  return respond({ albumList2: { album: albums.slice(offset, offset + size) } }, ctx)
}

async function getAlbum(env, user, params, ctx) {
  const id = params.get('id') || ''
  if (id === 'favorites') {
    const favorites = await db.listFavorites(env.DB, user.id)
    return respond({
      album: {
        ...albumToSubsonic({ id, name: '我的收藏', artist: '收藏', songCount: favorites.length }),
        song: favorites.map(s => songToSubsonic(s)),
      },
    }, ctx)
  }
  if (id.startsWith('pl_')) {
    const pl = await db.getPlaylist(env.DB, id, user.id)
    if (!pl) return fail(70, '专辑不存在', ctx)
    return respond({
      album: {
        ...albumToSubsonic({
          id: pl.id, name: pl.name,
          artist: pl.source ? ((SOURCE_META[pl.source] && SOURCE_META[pl.source].name) || pl.source) : '我的歌单',
          cover: pl.cover, songCount: pl.songs.length, created: new Date(pl.created_at).toISOString(),
        }),
        song: pl.songs.map(s => songToSubsonic(s)),
      },
    }, ctx)
  }

  // 平台专辑：用专辑名+歌手去搜索，再按 albumId 过滤
  const decoded = decodeAlbumId(id)
  if (!decoded) return fail(70, '专辑不存在', ctx)
  const provider = getProvider(decoded.source)
  if (!provider) return fail(70, '不支持的平台', ctx)
  const keyword = `${decoded.name} ${decoded.artist}`.trim()
  try {
    const res = await provider.search(keyword, 1, 30)
    let songs = res.list.filter(s => s.albumId && s.albumId === decoded.albumId)
    if (!songs.length) songs = res.list
    return respond({
      album: {
        ...albumToSubsonic({ id, name: decoded.name, artist: decoded.artist, cover: decoded.cover, songCount: songs.length }),
        song: songs.map(s => songToSubsonic(s)),
      },
    }, ctx)
  } catch (e) {
    return fail(0, `专辑获取失败: ${(e && e.message) || e}`, ctx)
  }
}

async function getSong(env, user, params, ctx) {
  const song = decodeSongId(params.get('id'))
  if (!song) return fail(70, '歌曲不存在', ctx)
  const full = await hydrateSong(song)
  const favorites = await db.listFavorites(env.DB, user.id)
  const favIds = new Set(favorites.map(f => encodeSongId(f)))
  return respond({ song: songToSubsonic(full, favIds) }, ctx)
}

/** 从 ID 还原的歌曲信息不完整时，回平台补全 */
async function hydrateSong(song) {
  if (song.name && song.singer) return song
  const provider = getProvider(song.source)
  if (!provider) return song
  try {
    const keyword = song.name || song.songmid || song.hash || ''
    if (!keyword) return song
    const res = await provider.search(keyword, 1, 20)
    const found = res.list.find(s => String(s.songmid) === String(song.songmid) || (s.hash && s.hash === song.hash))
    if (found) return { ...found, ...stripEmpty(song) }
  } catch { /* ignore */ }
  return song
}

function stripEmpty(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) out[k] = v
  return out
}

async function getRandomSongs(env, params, ctx) {
  const size = Math.min(safeInt(params.get('size'), 20) || 20, 100)
  const keywords = ['热门', '经典', '新歌', '流行', '华语']
  const kw = keywords[Math.floor(Math.random() * keywords.length)]
  const { list } = await searchOnline(kw, { limit: size })
  return respond({ randomSongs: { song: list.map(s => songToSubsonic(s)) } }, ctx)
}

async function getTopSongs(env, params, ctx) {
  const artist = params.get('artist') || ''
  const count = Math.min(safeInt(params.get('count'), 20) || 20, 100)
  if (!artist) return respond({ topSongs: {} }, ctx)
  const { list } = await searchOnline(artist, { limit: count })
  return respond({ topSongs: { song: list.map(s => songToSubsonic(s)) } }, ctx)
}

async function getSimilarSongs(env, params, ctx) {
  const song = decodeSongId(params.get('id'))
  const count = Math.min(safeInt(params.get('count'), 20) || 20, 100)
  if (!song) return respond({ similarSongs2: {} }, ctx)
  const keyword = song.singer || song.name || ''
  const { list } = await searchOnline(keyword, { limit: count })
  return respond({ similarSongs2: { song: list.map(s => songToSubsonic(s)) } }, ctx)
}

/* ---------------- 搜索 ---------------- */

async function search(env, user, params, ctx, method) {
  const rawQuery = params.get('query') || params.get('any') || params.get('title') || ''
  const songCount = Math.min(safeInt(params.get('songCount'), 20) || 20, 100)
  const albumCount = Math.min(safeInt(params.get('albumCount'), 20) || 0, 100)
  const songOffset = safeInt(params.get('songOffset'), 0)

  // 第三参是插件专有源（如 qsvip），Subsonic 客户端同样可以 `qsvip:关键词` 指定
  const { sources, keyword } = parseQuery(rawQuery, ALL_SOURCES, pluginSearchSourceKeys(env))
  if (!keyword) {
    return respond({ [method === 'search3' ? 'searchResult3' : 'searchResult2']: { song: [] } }, ctx)
  }

  const { list, errors } = await searchOnline(keyword, { sources, page: 1, limit: songCount + songOffset, pluginPool: env.PLUGIN_POOL })
  const slice = list.slice(songOffset, songOffset + songCount)
  const favorites = await db.listFavorites(env.DB, user.id)
  const favIds = new Set(favorites.map(f => encodeSongId(f)))

  const songs = slice.map(s => songToSubsonic(s, favIds))

  // 专辑去重（按 albumId）
  const albumMap = new Map()
  for (const s of list) {
    if (!s.albumId) continue
    const aid = encodeAlbumId(s.source, s.albumId, s.albumName, s.singer, s.img)
    if (albumMap.has(aid)) continue
    albumMap.set(aid, albumToSubsonic({ id: aid, name: s.albumName, artist: s.singer, cover: s.img, songCount: 1 }))
  }
  const albums = Array.from(albumMap.values()).slice(0, albumCount || 0)

  const artistMap = new Map()
  for (const s of list) {
    for (const n of String(s.singer || '').split('、')) {
      const name = n.trim()
      if (!name) continue
      const aid = artistIdFor(name)
      if (artistMap.has(aid)) continue
      artistMap.set(aid, { '@id': aid, '@name': name, '@albumCount': 1, '@coverArt': aid })
    }
  }

  const payload = {
    song: songs,
    ...(albums.length ? { album: albums } : {}),
    ...(artistMap.size ? { artist: Array.from(artistMap.values()).slice(0, 20) } : {}),
  }
  const key = method === 'search3' ? 'searchResult3' : 'searchResult2'
  if (errors && errors.length) console.warn('[subsonic] 搜索部分平台失败:', errors.join(' | '))
  return respond({ [key]: payload }, ctx)
}

/* ---------------- 播放 ---------------- */

async function stream(env, params, ctx, method) {
  const song = decodeSongId(params.get('id'))
  if (!song) return fail(70, '歌曲不存在', ctx)

  const quality = mapMaxBitRateToQuality(params.get('maxBitRate'))
  // 逐个候选源尝试，直到真正拿到音频字节（见 lib/stream.js 的设计说明）
  const r = await openAudioStream(song, quality, env.PLUGIN_POOL, {
    rangeHeader: params.get('_range') || '',
  })
  if (!r.ok) {
    console.error('[subsonic] 取流失败:', (r.errors || []).join(' | '))
    return fail(0, r.error || '所有音源均无可用链接', ctx)
  }
  return r.response
}

function mapMaxBitRateToQuality(maxBitRate) {
  const br = safeInt(maxBitRate, 0)
  if (!br) return '320k'
  if (br <= 128) return '128k'
  if (br <= 320) return '320k'
  if (br <= 1000) return 'flac'
  return 'flac24bit'
}

/* ---------------- 封面 / 歌词 ---------------- */

async function getCoverArt(env, params, ctx) {
  const id = params.get('id') || ''
  let url = null
  if (/^https?:\/\//.test(id)) url = id
  else {
    const song = decodeSongId(id)
    if (song) url = await resolvePic(song, env.PLUGIN_POOL)
  }
  if (!url) return placeholderCover(ctx)
  try {
    const upstream = await outboundFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: new URL(url).origin + '/' } })
    if (!upstream.ok) return placeholderCover(ctx)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return placeholderCover(ctx)
  }
}

let placeholderCache = null
function placeholderCover(ctx) {
  if (!placeholderCache) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="#1f2937"/><g fill="#4b5563"><circle cx="150" cy="120" r="34"/><path d="M150 162c-40 0-72 22-72 50v10h144v-10c0-28-32-50-72-50z"/></g></svg>`
    placeholderCache = new TextEncoder().encode(svg)
  }
  return new Response(placeholderCache, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' },
  })
}

async function getLyrics(env, params, ctx) {
  const artist = params.get('artist') || ''
  const title = params.get('title') || ''
  if (!title) return respond({ lyrics: { '@artist': artist, '@title': title } }, ctx)
  const { list } = await searchOnline(`${title} ${artist}`.trim(), { limit: 5, pluginPool: env.PLUGIN_POOL })
  const target = list.find(s => s.name && s.name.includes(title)) || list[0]
  if (!target) return respond({ lyrics: { '@artist': artist, '@title': title } }, ctx)
  const lyric = await resolveLyric(target, env.PLUGIN_POOL)
  return respond({ lyrics: { '@artist': target.singer || artist, '@title': target.name || title, '#text': (lyric && lyric.lyric) || '' } }, ctx)
}

async function getLyricsBySongId(env, params, ctx) {
  const song = decodeSongId(params.get('id'))
  if (!song) return respond({ lyricsList: {} }, ctx)
  const lyric = await resolveLyric(song, env.PLUGIN_POOL)
  if (!lyric) return respond({ lyricsList: {} }, ctx)
  return respond({
    lyricsList: {
      structuredLyrics: {
        '@displayArtist': song.singer || '',
        '@displayTitle': song.name || '',
        '@lang': 'und',
        '@synced': true,
        line: String(lyric.lyric || '').split('\n').filter(Boolean).map(line => {
          const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
          if (!m) return { '@value': line, '@start': 0 }
          const start = (parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000
          return { '@start': Math.round(start), '@value': m[3] || '' }
        }),
      },
    },
  }, ctx)
}

/* ---------------- 歌单 ---------------- */

async function getPlaylists(env, user, ctx) {
  const list = await db.listPlaylists(env.DB, user.id)
  return respond({
    playlists: {
      playlist: list.map(p => ({
        '@id': p.id,
        '@name': p.name,
        '@comment': p.source ? `来自 ${(SOURCE_META[p.source] && SOURCE_META[p.source].name) || p.source}` : '',
        '@owner': user.username,
        '@public': false,
        '@songCount': p.song_count,
        '@duration': 0,
        '@created': new Date(p.created_at).toISOString(),
        '@changed': new Date(p.updated_at).toISOString(),
        '@coverArt': p.id,
      })),
    },
  }, ctx)
}

async function getPlaylist(env, user, params, ctx) {
  const pl = await db.getPlaylist(env.DB, params.get('id'), user.id)
  if (!pl) return fail(70, '歌单不存在', ctx)
  const favorites = await db.listFavorites(env.DB, user.id)
  const favIds = new Set(favorites.map(f => encodeSongId(f)))
  return respond({
    playlist: {
      '@id': pl.id,
      '@name': pl.name,
      '@owner': user.username,
      '@public': false,
      '@songCount': pl.songs.length,
      '@duration': pl.songs.reduce((a, s) => a + safeInt(s.interval), 0),
      '@created': new Date(pl.created_at).toISOString(),
      '@changed': new Date(pl.updated_at).toISOString(),
      entry: pl.songs.map(s => songToSubsonic(s, favIds)),
    },
  }, ctx)
}

async function createPlaylist(env, user, params, ctx) {
  const name = params.get('name') || '新建歌单'
  const songIds = params.getAll('songId')
  let songs = []
  if (songIds.length) {
    songs = songIds.map(id => decodeSongId(id)).filter(Boolean)
  }
  const playlistId = params.get('playlistId')
  if (playlistId) {
    const existing = await db.getPlaylist(env.DB, playlistId, user.id)
    if (!existing) return fail(70, '歌单不存在', ctx)
    if (songs.length) await db.appendSongs(env.DB, playlistId, songs)
    if (name) await db.renamePlaylist(env.DB, playlistId, user.id, name)
    return respond({}, ctx)
  }
  await db.createPlaylist(env.DB, { userId: user.id, name, songs })
  return respond({}, ctx)
}

async function updatePlaylist(env, user, params, ctx) {
  const id = params.get('playlistId')
  const pl = await db.getPlaylist(env.DB, id, user.id)
  if (!pl) return fail(70, '歌单不存在', ctx)
  const name = params.get('name')
  if (name) await db.renamePlaylist(env.DB, id, user.id, name)
  const toRemove = params.getAll('songIndexToRemove').map(n => safeInt(n, -1)).filter(n => n >= 0).sort((a, b) => b - a)
  for (const idx of toRemove) await db.removePlaylistSong(env.DB, id, idx)
  const addIds = params.getAll('songIdToAdd').map(i => decodeSongId(i)).filter(Boolean)
  if (addIds.length) await db.appendSongs(env.DB, id, addIds)
  return respond({}, ctx)
}

async function deletePlaylist(env, user, params, ctx) {
  await db.deletePlaylist(env.DB, params.get('id'), user.id)
  return respond({}, ctx)
}

/* ---------------- 收藏 ---------------- */

async function star(env, user, params, ctx) {
  for (const id of params.getAll('id')) {
    const song = decodeSongId(id)
    if (!song) continue
    const full = await hydrateSong(song)
    await db.addFavorite(env.DB, user.id, id, full)
    await db.setSetting(env.DB, `star_${user.id}_${id}`, Date.now())
  }
  return respond({}, ctx)
}

async function unstar(env, user, params, ctx) {
  for (const id of params.getAll('id')) {
    await db.removeFavorite(env.DB, user.id, id)
  }
  return respond({}, ctx)
}

async function getStarred(env, user, params, ctx) {
  const favorites = await db.listFavorites(env.DB, user.id)
  return respond({
    starred2: {
      song: favorites.map(s => songToSubsonic(s, new Set(favorites.map(f => encodeSongId(f))))),
      album: [],
      artist: [],
    },
  }, ctx)
}

export { songToSubsonic, albumToSubsonic }
