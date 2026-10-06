-- 音乐聚合服务 D1 Schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  password     TEXT NOT NULL,          -- 原密码（Subsonic token 鉴权需要原文才能算 md5(pw+salt)）
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  cover        TEXT,
  source       TEXT,
  source_id    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id  TEXT NOT NULL,
  position     INTEGER NOT NULL,
  song_id      TEXT NOT NULL,
  song_json    TEXT NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_plsongs_playlist ON playlist_songs(playlist_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id      TEXT NOT NULL,
  song_id      TEXT NOT NULL,
  song_json    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, song_id)
);

CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL DEFAULT 'public',
  name         TEXT NOT NULL,
  version      TEXT,
  author       TEXT,
  description  TEXT,
  homepage     TEXT,
  url          TEXT,
  script       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  k            TEXT PRIMARY KEY,
  v            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_history (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_user ON search_history(user_id, created_at DESC);

-- 播放进度 / 播放历史
--
-- 刻意**只用一张表**：每「用户 × 歌」一行。这样两个需求共用一份数据 ——
--   · 续播  = 读这一行的 position
--   · 历史  = 按 last_played_at 倒序取
-- 拆成两张表（事件流水 + 进度快照）会立刻带来「两边对不上」的问题，而收益为零。
--
-- play_count 的口径是「真正听过」的次数，不是「点开过」的次数：
-- 客户端只在累计播放超过阈值（或播完）时才 +1，来回拖进度条不会刷高它。
CREATE TABLE IF NOT EXISTS play_progress (
  user_id         TEXT NOT NULL,
  song_id         TEXT NOT NULL,
  song_json       TEXT NOT NULL,
  position        REAL NOT NULL DEFAULT 0,
  duration        REAL NOT NULL DEFAULT 0,
  play_count      INTEGER NOT NULL DEFAULT 0,
  first_played_at INTEGER NOT NULL,
  last_played_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_user ON play_progress(user_id, last_played_at DESC);

-- ---------------------------------------------------------------------------
-- 每日推荐（2026-10-02）
-- 按「北京时间日期」一行，全局一份（不按用户分）：
-- cron 每天 06:00 生成，手动刷新（POST /api/daily/refresh）覆盖当天。
-- songs 是 songForWeb 结构的 JSON 数组 —— 落库前已经过在线搜索解析，
-- 全部是真实可播放的歌，前端拿到直接放，不用再解析一次。
CREATE TABLE IF NOT EXISTS daily_recommend (
  date          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  songs         TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  generator     TEXT NOT NULL DEFAULT 'ai'
);
