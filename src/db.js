/**
 * D1 数据访问层
 */
import { stableHash } from './lib/util.js'

export function now() {
  return Date.now()
}

export function newId(prefix = '') {
  return prefix + stableHash(String(Date.now()) + Math.random()) + Math.random().toString(36).slice(2, 8)
}

/* ---------------- 建表（幂等自愈） ---------------- */

/**
 * 建表语句。
 *
 * 为什么要在代码里也存一份，而不是只在 schema.sql 里：
 * 这份后端要跑在**三个宿主**上 —— Cloudflare D1、Docker 里的 node:sqlite、
 * APK 内的设备 SQLite。三者的建表时机完全不同（D1 要靠 `wrangler d1 execute`
 * 手动跑，壳内是首启自动开户）。把建表做成「第一次请求时幂等自愈」，
 * 三个宿主就都不需要各自的迁移步骤了。
 *
 * ⚠️ 改 schema.sql 时这里要同步 —— test/schema-sync.test.mjs 会比对两边的表名集合，
 * 漂了就会挂。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cover TEXT,
    source TEXT,
    source_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id)',
  `CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    song_id TEXT NOT NULL,
    song_json TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_plsongs_playlist ON playlist_songs(playlist_id)',
  `CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    song_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  )`,
  `CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT 'public',
    name TEXT NOT NULL,
    version TEXT,
    author TEXT,
    description TEXT,
    homepage TEXT,
    url TEXT,
    script TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_search_user ON search_history(user_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS play_progress (
    user_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    song_json TEXT NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    play_count INTEGER NOT NULL DEFAULT 0,
    first_played_at INTEGER NOT NULL,
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, song_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_progress_user ON play_progress(user_id, last_played_at DESC)',
  // 每日推荐：按北京时间日期一行，songs 是 songForWeb 结构的 JSON 数组。
  // 只有一份（全局），不按用户分 —— 单用户产品，cron 用「播放记录最多的用户」当口味来源。
  `CREATE TABLE IF NOT EXISTS daily_recommend (
    date TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    songs TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    generator TEXT NOT NULL DEFAULT 'ai'
  )`,
]

/**
 * 幂等建表。已在本 isolate / 进程里跑过就直接返回，不再打数据库。
 *
 * 失败不抛：老库缺张表只该让**用那张表的功能**不可用，
 * 不该把整个服务的每个请求都变成 500（比如搜索是完全不碰 play_progress 的）。
 */
const schemaDone = new WeakSet()
export async function ensureSchema(db) {
  if (!db || schemaDone.has(db)) return
  const failed = []
  for (const sql of SCHEMA) {
    try {
      await db.prepare(sql).run()
    } catch (e) {
      failed.push(String((e && e.message) || e))
    }
  }
  schemaDone.add(db)
  if (failed.length) console.warn('[db] 建表有失败项:', failed.join(' | '))
}

/** 供测试比对 schema.sql 与代码内 SCHEMA 是否漂移 */
export function schemaStatements() {
  return SCHEMA.slice()
}


/* ---------------- 用户 ---------------- */

export async function findUserByName(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first()
}

export async function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
}

export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM users').first()
  return (row && row.c) || 0
}

export async function createUser(db, { username, password, isAdmin = 0 }) {
  const id = newId('u_')
  await db.prepare('INSERT INTO users (id, username, password, is_admin, created_at) VALUES (?,?,?,?,?)')
    .bind(id, username, password, isAdmin ? 1 : 0, now()).run()
  return { id, username, password, is_admin: isAdmin ? 1 : 0 }
}

export async function updateUserPassword(db, id, password) {
  await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(password, id).run()
}

export async function listUsers(db) {
  const { results } = await db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at').all()
  return results || []
}

export async function deleteUser(db, id) {
  await db.batch([
    db.prepare('DELETE FROM users WHERE id = ?').bind(id),
    db.prepare('DELETE FROM playlists WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)').bind(id),
    db.prepare('DELETE FROM favorites WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM search_history WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM play_progress WHERE user_id = ?').bind(id),
  ])
}

/* ---------------- 歌单 ---------------- */

export async function listPlaylists(db, userId) {
  // 顺带把「第一首歌」的 json 捞出来：早先自建 / AI 生成的歌单没写 cover，
  // 库里那一列是空的，这里用第一首歌的专辑封面兜底，省掉一次全表数据迁移。
  const { results } = await db.prepare(
    'SELECT p.*,'
    + ' (SELECT COUNT(*) FROM playlist_songs s WHERE s.playlist_id = p.id) AS song_count,'
    + ' (SELECT s.song_json FROM playlist_songs s WHERE s.playlist_id = p.id ORDER BY s.position LIMIT 1) AS first_song'
    + ' FROM playlists p WHERE p.user_id = ? ORDER BY p.updated_at DESC'
  ).bind(userId).all()
  return (results || []).map(r => {
    let cover = r.cover
    if (!cover && r.first_song) {
      try {
        const s = JSON.parse(r.first_song)
        cover = (s && (s.img || s.pic)) || ''
      } catch { /* 脏数据就当没有封面 */ }
    }
    const { first_song, ...rest } = r
    return { ...rest, cover }
  })
}

export async function getPlaylist(db, id, userId) {
  const pl = await db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').bind(id, userId).first()
  if (!pl) return null
  const { results } = await db.prepare('SELECT song_id, song_json FROM playlist_songs WHERE playlist_id = ? ORDER BY position').bind(id).all()
  pl.songs = (results || []).map(r => {
    try { return JSON.parse(r.song_json) } catch { return null }
  }).filter(Boolean)
  return pl
}

export async function createPlaylist(db, { userId, name, cover = '', source = '', sourceId = '', songs = [] }) {
  const id = newId('pl_')
  const ts = now()
  const stmt = db.prepare('INSERT INTO playlists (id, user_id, name, cover, source, source_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  await stmt.bind(id, userId, name, cover, source, sourceId, ts, ts).run()
  if (songs.length) await appendSongs(db, id, songs)
  return { id, name, cover, source, sourceId, songs, song_count: songs.length }
}

export async function appendSongs(db, playlistId, songs) {
  const row = await db.prepare('SELECT COALESCE(MAX(position), -1) AS mx FROM playlist_songs WHERE playlist_id = ?').bind(playlistId).first()
  let pos = ((row && row.mx) != null ? row.mx : -1) + 1
  const stmts = songs.map(s => db.prepare('INSERT OR REPLACE INTO playlist_songs (playlist_id, position, song_id, song_json) VALUES (?,?,?,?)')
    .bind(playlistId, pos++, s.songId || s.id || '', JSON.stringify(s)))
  if (stmts.length) await db.batch(stmts)
  await db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').bind(now(), playlistId).run()
}

export async function replacePlaylistSongs(db, playlistId, songs) {
  await db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').bind(playlistId).run()
  await appendSongs(db, playlistId, songs)
}

export async function renamePlaylist(db, id, userId, name) {
  await db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(name, now(), id, userId).run()
}

export async function deletePlaylist(db, id, userId) {
  await db.batch([
    db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').bind(id, userId),
    db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ?').bind(id),
  ])
}

export async function removePlaylistSong(db, playlistId, index) {
  const { results } = await db.prepare('SELECT position, song_id, song_json FROM playlist_songs WHERE playlist_id = ? ORDER BY position').bind(playlistId).all()
  const kept = (results || []).filter((_, i) => i !== Number(index))
  await replacePlaylistSongs(db, playlistId, kept.map(r => {
    try { return JSON.parse(r.song_json) } catch { return null }
  }).filter(Boolean))
}

/* ---------------- 收藏 ---------------- */

export async function listFavorites(db, userId) {
  const { results } = await db.prepare('SELECT song_id, song_json, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return (results || []).map(r => {
    let song = null
    try { song = JSON.parse(r.song_json) } catch { /* ignore */ }
    return song ? { ...song, starred: r.created_at } : null
  }).filter(Boolean)
}

export async function addFavorite(db, userId, songId, song) {
  await db.prepare('INSERT OR REPLACE INTO favorites (user_id, song_id, song_json, created_at) VALUES (?,?,?,?)')
    .bind(userId, songId, JSON.stringify(song), now()).run()
}

export async function removeFavorite(db, userId, songId) {
  await db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ?').bind(userId, songId).run()
}

export async function isFavorite(db, userId, songId) {
  const row = await db.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND song_id = ?').bind(userId, songId).first()
  return !!row
}

/* ---------------- 设置 ---------------- */

export async function getSetting(db, key, def = null) {
  const row = await db.prepare('SELECT v FROM settings WHERE k = ?').bind(key).first()
  return row ? row.v : def
}

export async function setSetting(db, key, value) {
  await db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').bind(key, String(value)).run()
}

/* ---------------- 搜索历史 ---------------- */

export async function addSearchHistory(db, userId, keyword) {
  const k = String(keyword || '').trim()
  if (!k) return
  await db.prepare('INSERT INTO search_history (id, user_id, keyword, created_at) VALUES (?,?,?,?)')
    .bind(newId('sh_'), userId, k, now()).run()
}

export async function listSearchHistory(db, userId, limit = 20) {
  const { results } = await db.prepare('SELECT keyword, created_at FROM search_history WHERE user_id = ? GROUP BY keyword ORDER BY MAX(created_at) DESC LIMIT ?')
    .bind(userId, limit).all()
  return results || []
}

export async function clearSearchHistory(db, userId) {
  await db.prepare('DELETE FROM search_history WHERE user_id = ?').bind(userId).run()
}

/* ---------------- 播放进度 / 播放历史 ---------------- */

/**
 * 写一次播放进度。
 *
 * 刻意**不用 SQLite 的 upsert 语法**（`ON CONFLICT ... DO UPDATE`）：
 * 那是 SQLite 3.24（2018）才有的，而 APK 要兼容 Android 5.0，
 * 系统自带 SQLite 是 3.8.x，会直接报语法错。
 * 换成「INSERT OR IGNORE + UPDATE」两步，语义等价、老版本也能跑。
 *
 * play_count 只在 `played` 为真时递增 —— 客户端判「真正听过」才置位，
 * 否则拖进度条来回蹭会把计数刷上天。
 */
export async function upsertPlayProgress(db, userId, songId, song, { position = 0, duration = 0, played = false } = {}) {
  const ts = now()
  const pos = Math.max(0, Number(position) || 0)
  const dur = Math.max(0, Number(duration) || 0)
  const inc = played ? 1 : 0
  const json = JSON.stringify(song || {})

  await db.prepare(
    'INSERT OR IGNORE INTO play_progress (user_id, song_id, song_json, position, duration, play_count, first_played_at, last_played_at)'
    + ' VALUES (?,?,?,?,?,0,?,?)'
  ).bind(userId, songId, json, pos, dur, ts, ts).run()

  await db.prepare(
    // duration 只在新值更可信（>0）时覆盖：暂停上报时可能还没读到时长，
    // 这时若把 0 写进去，续播进度条的总长就丢了
    'UPDATE play_progress SET song_json = ?, position = ?,'
    + ' duration = CASE WHEN ? > 0 THEN ? ELSE duration END,'
    + ' play_count = play_count + ?, last_played_at = ?'
    + ' WHERE user_id = ? AND song_id = ?'
  ).bind(json, pos, dur, dur, inc, ts, userId, songId).run()
}

/** 取单首的续播位置。没有记录返回 null（调用方据此从 0 开始） */
export async function getPlayProgress(db, userId, songId) {
  return db.prepare('SELECT position, duration, play_count, last_played_at FROM play_progress WHERE user_id = ? AND song_id = ?')
    .bind(userId, songId).first()
}

export async function listPlayHistory(db, userId, limit = 200) {
  const { results } = await db.prepare(
    'SELECT song_id, song_json, position, duration, play_count, last_played_at FROM play_progress'
    + ' WHERE user_id = ? ORDER BY last_played_at DESC LIMIT ?'
  ).bind(userId, Math.max(1, Math.min(1000, Number(limit) || 200))).all()
  return (results || []).map(r => {
    let song = null
    try { song = JSON.parse(r.song_json) } catch { /* 脏数据跳过解析 */ }
    return {
      songId: r.song_id, song: song || null,
      position: r.position, duration: r.duration,
      playCount: r.play_count, lastPlayedAt: r.last_played_at,
    }
  }).filter(x => x.song)
}

/** 清空播放历史；给了 songId 就只删那一条 */
export async function clearPlayHistory(db, userId, songId = null) {
  if (songId) {
    await db.prepare('DELETE FROM play_progress WHERE user_id = ? AND song_id = ?').bind(userId, songId).run()
  } else {
    await db.prepare('DELETE FROM play_progress WHERE user_id = ?').bind(userId).run()
  }
}

/* ---------------- 管理端统计 ---------------- */

/** 管理端总览：各表的行数，一个页面看全站规模 */
export async function adminCounts(db) {
  const one = async (sql) => {
    const r = await db.prepare(sql).first()
    return (r && r.c) || 0
  }
  return {
    users: await one('SELECT COUNT(*) AS c FROM users'),
    playlists: await one('SELECT COUNT(*) AS c FROM playlists'),
    favorites: await one('SELECT COUNT(*) AS c FROM favorites'),
    searches: await one('SELECT COUNT(*) AS c FROM search_history'),
    progressRows: await one('SELECT COUNT(*) AS c FROM play_progress'),
    plays: await one('SELECT COALESCE(SUM(play_count), 0) AS c FROM play_progress'),
  }
}

/** 全部用户的播放记录（带用户名），供管理端查看 */
export async function listAllPlayHistory(db, limit = 200) {
  const { results } = await db.prepare(
    'SELECT p.user_id, p.song_id, p.song_json, p.position, p.duration, p.play_count, p.last_played_at,'
    + ' u.username FROM play_progress p LEFT JOIN users u ON u.id = p.user_id'
    + ' ORDER BY p.last_played_at DESC LIMIT ?'
  ).bind(Math.max(1, Math.min(1000, Number(limit) || 200))).all()
  return (results || []).map(r => {
    let song = null
    try { song = JSON.parse(r.song_json) } catch { /* ignore */ }
    return {
      userId: r.user_id, username: r.username || '(已删除)',
      songId: r.song_id, song: song || null,
      position: r.position, duration: r.duration,
      playCount: r.play_count, lastPlayedAt: r.last_played_at,
    }
  }).filter(x => x.song)
}
