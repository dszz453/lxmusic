/**
 * 歌曲 / 专辑 / 歌手 ID 编解码
 * Subsonic 客户端只认字符串 ID，且会把它当不透明 token 来回传，
 * 所以把「平台 + 取流必需字段」一起塞进 ID 里，服务端无需额外存储即可还原。
 */
import { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode } from './crypto.js'

function b64urlEncode(str) {
  return bytesToBase64(utf8Encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return utf8Decode(base64ToBytes(s))
}

/** 歌曲 ID：只保留取流所需的键，避免 URL 过长 */
export function encodeSongId(song) {
  const payload = {
    s: song.source,
    i: song.songmid || song.id || '',
    h: song.hash || '',
    a: song.albumId || '',
    m: song.mediaMid || '',
    n: song.name || '',
    g: song.singer || '',
    t: song.interval || 0,
    p: song.img || '',
  }
  const keep = {}
  for (const [k, v] of Object.entries(payload)) {
    if (v !== '' && v !== 0 && v != null) keep[k] = v
  }
  return b64urlEncode(JSON.stringify(keep))
}

export function decodeSongId(id) {
  if (!id) return null
  // 兼容极简写法 kg:HASH 形式
  const plain = String(id).match(/^(kg|wy|kw|tx)[:：](.+)$/i)
  if (plain) {
    const source = plain[1].toLowerCase()
    const value = plain[2]
    return {
      source,
      songmid: value,
      id: value,
      hash: source === 'kg' ? value : '',
      name: '',
      singer: '',
      interval: 0,
      img: '',
      albumId: '',
      mediaMid: '',
      _types: null,
      types: [],
    }
  }
  try {
    const obj = JSON.parse(b64urlDecode(id))
    if (!obj || !obj.s) return null
    return {
      source: obj.s,
      songmid: obj.i || '',
      id: obj.i || '',
      hash: obj.h || '',
      albumId: obj.a || '',
      mediaMid: obj.m || '',
      name: obj.n || '',
      singer: obj.g || '',
      interval: obj.t || 0,
      img: obj.p || '',
      types: [],
      _types: null,
      fromId: true,
    }
  } catch {
    return null
  }
}

export function encodeAlbumId(source, albumId, name = '', artist = '', cover = '') {
  const keep = { s: source, a: albumId }
  if (name) keep.n = name
  if (artist) keep.g = artist
  if (cover) keep.p = cover
  return b64urlEncode(JSON.stringify(keep))
}

export function decodeAlbumId(id) {
  try {
    const obj = JSON.parse(b64urlDecode(id))
    if (!obj || !obj.s) return null
    return { source: obj.s, albumId: obj.a || '', name: obj.n || '', artist: obj.g || '', cover: obj.p || '' }
  } catch {
    return null
  }
}

export function encodeArtistId(source, name, cover = '') {
  const keep = { s: source, n: name }
  if (cover) keep.p = cover
  return b64urlEncode(JSON.stringify(keep))
}

export function decodeArtistId(id) {
  try {
    const obj = JSON.parse(b64urlDecode(id))
    if (!obj || !obj.n) return null
    return { source: obj.s || 'all', name: obj.n, cover: obj.p || '' }
  } catch {
    return null
  }
}

/** 给歌曲补一个稳定的 id 字段（Subsonic 用） */
export function withSongId(song) {
  return { ...song, id: encodeSongId(song) }
}
