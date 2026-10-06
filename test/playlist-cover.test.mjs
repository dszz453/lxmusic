/**
 * 歌单封面回填的回归测试（纯本地 SQLite，不联网）。
 *
 * 背景：「我的歌单」里自建 / AI 生成的歌单原本没有封面（POST /playlist 不写 cover），
 * 和导入来的歌单并排看就是一块空灰格子。修法有两条：
 *   ① 新歌单：POST /playlist 落库时用第一首歌的专辑封面兜底（这条在 api.js 里，见下）
 *   ② 老歌单：listPlaylists 读的时候从第一首歌的 json 里回填，不跑数据迁移
 * 这里测的是 ②（它藏在 SQL 子查询里，最容易在改动中悄悄失效）。
 *
 * 跑：node --experimental-sqlite --test test/playlist-cover.test.mjs
 */
import { listPlaylists } from '../src/db.js'

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      got=${a}\n      exp=${e}`)
}

let DatabaseSync
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (e) {
  console.error('需要 node:sqlite（用 --experimental-sqlite 运行）:', e.message)
  process.exit(2)
}

/** 把 node:sqlite 包成 D1 的 prepare/bind/all 形状，让 src/db.js 能原样跑 */
function d1Like(raw) {
  return {
    prepare(sql) {
      const st = raw.prepare(sql)
      let args = []
      const stmt = {
        bind(...a) { args = a; return stmt },
        async all() { return { results: st.all(...args) } },
        async first() { const r = st.all(...args); return r.length ? r[0] : null },
        async run() { st.run(...args); return { success: true } },
      }
      return stmt
    },
  }
}

const raw = new DatabaseSync(':memory:')
raw.exec(`
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, cover TEXT,
    source TEXT, source_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE playlist_songs (
    playlist_id TEXT NOT NULL, position INTEGER NOT NULL,
    song_id TEXT NOT NULL, song_json TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
  );
`)
const db = d1Like(raw)

const IMG_A = 'https://p1.music.126.net/aaa.jpg'
const IMG_B = 'https://p2.music.126.net/bbb.jpg'
const insertPl = raw.prepare('INSERT INTO playlists (id,user_id,name,cover,source,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
const insertSong = raw.prepare('INSERT INTO playlist_songs (playlist_id,position,song_id,song_json) VALUES (?,?,?,?)')

// ① 老歌单：cover 空 → 应回填第一首歌的 img
insertPl.run('pl_old', 'u1', '老歌单', '', 'wy', '', 1, 10)
insertSong.run('pl_old', 0, 's0', JSON.stringify({ name: '第一首', img: IMG_A }))
insertSong.run('pl_old', 1, 's1', JSON.stringify({ name: '第二首', img: IMG_B }))

// ② 已有封面的歌单：不能被第一首歌覆盖（平台给的歌单设计图才是正主）
insertPl.run('pl_cover', 'u1', '有封面的歌单', 'https://x/cover.jpg', 'kg', '123', 1, 20)
insertSong.run('pl_cover', 0, 's0', JSON.stringify({ name: '第一首', img: IMG_A }))

// ③ 第一首没图、第二首有图 → 按 position 顺序，第一首无图就退回空（不跳着找）
insertPl.run('pl_nofirst', 'u1', '首曲无图', '', '', '', 1, 15)
insertSong.run('pl_nofirst', 0, 's0', JSON.stringify({ name: '无图', img: '' }))
insertSong.run('pl_nofirst', 1, 's1', JSON.stringify({ name: '有图', img: IMG_B }))

// ④ 空歌单：没歌可退，保持空（前端会画占位图标）
insertPl.run('pl_empty', 'u1', '空歌单', '', '', '', 1, 5)

// ⑤ 脏数据：song_json 不是合法 JSON，不能把整个列表搞崩
insertPl.run('pl_bad', 'u1', '脏数据', '', '', '', 1, 6)
insertSong.run('pl_bad', 0, 's0', '{坏掉的 json')

// ⑥ 别人的歌单不该出现
insertPl.run('pl_other', 'u2', '别人的', 'https://x/y.jpg', '', '', 1, 99)

const rows = await listPlaylists(db, 'u1')
const byId = Object.fromEntries(rows.map(r => [r.id, r]))

check('只返回当前用户的歌单', rows.length, 5)
check('按 updated_at 倒序', rows.map(r => r.id), ['pl_cover', 'pl_nofirst', 'pl_old', 'pl_bad', 'pl_empty'])
check('老歌单用第一首歌的封面回填', byId.pl_old.cover, IMG_A)
check('已有封面不被覆盖', byId.pl_cover.cover, 'https://x/cover.jpg')
check('第一首没图时不跳到第二首', byId.pl_nofirst.cover, '')
check('空歌单保持无封面', byId.pl_empty.cover, '')
check('脏 song_json 不影响列表', byId.pl_bad.cover, '')
check('内部字段 first_song 不外泄', 'first_song' in byId.pl_old, false)
check('song_count 仍然正确', [byId.pl_old.song_count, byId.pl_empty.song_count], [2, 0])
check('空封面统一成空串而不是 null', [byId.pl_empty.cover === '', byId.pl_nofirst.cover === ''], [true, true])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
