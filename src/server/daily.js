/**
 * 每日推荐（AI 生成版）
 *
 * 旧版 /api/home 的 hot 是「20 个关键词按天轮换 + 在线搜索」，20 天一圈、当天内固定，
 * 用户看着像永远不变。这里改成：
 *   1. 收集信号 —— 歌单名字、播放记录（歌名/歌手/次数）、最近搜索词；
 *   2. 拼成一句 prompt 交给 AI（src/lib/ai.js 的 generatePlaylist），得到 24 首「歌名+歌手」；
 *   3. 逐首在线搜索解析成真实可播放的歌（AI 编的 ID 不可信，播放链路靠搜索兜底）；
 *   4. 落 D1 daily_recommend（按北京时间日期一行），当天内不再重复生成；
 *   5. 兜底：AI 未配置 / 生成失败 / 有效歌不足时，退回旧的关键词轮换搜索，
 *      保证「每日推荐」任何时候都有歌可放 —— 坏了也只是退回旧行为，不能白屏。
 *
 * 触发入口三个（都在 CF 端）：
 *   · cron   —— wrangler.toml [triggers]，UTC 22:00 = 北京 06:00，见 index.js 的 scheduled
 *   · lazy   —— /api/home 发现当天还没有记录时，waitUntil 后台生成（明天就有了）
 *   · manual —— POST /api/daily/refresh，前端「换一批」按钮，强制重生成
 */

import { generatePlaylist } from '../lib/ai.js'
import { searchOnline, parseQuery } from '../providers/index.js'
import { listPlayHistory, listSearchHistory, getSetting, setSetting } from '../db.js'
// searchSources 的第二个参数要的是**这个 db 模块**（它带 getSetting），不是 D1 句柄 ——
// 本文件里 `db` 这个名字到处都是句柄，所以显式再 import 一次模块，避免看错。
import * as dbmod from '../db.js'
import { HOME_KEYWORDS } from './keywords.js'
// 「用哪些音源」读的是**和搜索同一份**设置（见 sources.js）。
// 早先这里写死了 ['kg','wy','kw']，于是「默认搜索源」改成只用网易云之后，
// 每日推荐照样推酷狗 —— 两处口径不一致是 2026-10-09 老板报障的根因。
import { searchSources } from './sources.js'

/**
 * 生成当日推荐时用的是哪份音源（逗号分隔的签名）。
 *
 * 为什么要把签名存下来：daily_recommend 是按「北京时间日期」一行缓存的，
 * 当天生成过就不再重算。可音源设置是随时能改的 —— 不记签名的话，
 * 用户改完设置要**等到第二天**才生效，表现还是「设置不起作用」。
 * 存了签名就能在设置变化时把当天那份重算一次（代价是几十秒的后台请求，一天最多一次）。
 */
const DAILY_SOURCES_SETTING = 'daily.sources'

/** 一天生成多少首（AI 生成数）。搜索后可能少几首，所以目标比展示略多。 */
const TARGET_COUNT = 24
/** 搜索解析后少于这个数视为「生成质量不行」，走兜底。 */
const MIN_USABLE = 8
/** 并发搜索上限 —— 每首一次多源聚合搜索，串行 24 次太慢，全并发又容易触发上游限流。 */
const SEARCH_CONCURRENCY = 6

/** 北京时间的 YYYY-MM-DD。CF Workers 的 Date 默认 UTC，偏移 +8 写死即可。 */
export function todayBJ(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 从 D1 收集用户口味信号。全部「尽力而为」：
 * 任何一张表读失败都返回空数组，不让推荐功能因为某张表缺席而整体挂掉。
 */
export async function collectSignals(db, userId) {
  // 三张表各自「尽力而为」：某张表缺席（老库 / 壳内替身）只少一路信号，不整体挂掉。
  const safe = async (fn, fallback = []) => {
    try { return (await fn()) || fallback } catch { return fallback }
  }
  const [history, searches, playlistNames] = await Promise.all([
    safe(() => listPlayHistory(db, userId, 40)),
    safe(() => listSearchHistory(db, userId, 10)),
    safe(async () => {
      const { results } = await db.prepare('SELECT name FROM playlists ORDER BY updated_at DESC LIMIT 20').all()
      return (results || []).map(r => r.name).filter(Boolean)
    }),
  ])
  return { playlistNames, history, searches }
}

/**
 * 把信号拼成 prompt。要点：
 *  - 歌单名字是用户自己起的，最能代表口味，放在最前；
 *  - 播放记录按 play_count 排出高频歌手，避免把 40 条历史全塞进去（token 浪费且重点糊）；
 *  - 搜索词次之；都没有时退回「随便推荐」，AI 自己发挥。
 */
export function buildPrompt(signals) {
  const parts = []
  const names = (signals.playlistNames || []).slice(0, 10).map(s => String(s).slice(0, 30))
  if (names.length) parts.push('用户建过这些歌单：' + names.join('、'))

  const plays = (signals.history || [])
    .map(h => ({ name: (h.song && h.song.name) || '', singer: (h.song && h.song.singer) || '', n: h.playCount || 0 }))
    .filter(x => x.name)
  if (plays.length) {
    const singerCount = {}
    for (const p of plays) {
      const s = String(p.singer || '').trim()
      if (s) singerCount[s] = (singerCount[s] || 0) + (p.n || 1)
    }
    const topSingers = Object.entries(singerCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0])
    if (topSingers.length) parts.push('最近常听这些歌手：' + topSingers.join('、'))
    const recent = plays.slice(0, 10).map(p => p.name + (p.singer ? '（' + p.singer + '）' : ''))
    parts.push('最近听过：' + recent.join('、'))
  }

  const kws = (signals.searches || []).map(s => s.keyword || s).filter(Boolean).slice(0, 6)
  if (kws.length) parts.push('最近搜索过：' + kws.join('、'))

  return parts.join('；') || '根据大众口味推荐一些好听、传唱度高的歌曲'
}

/** 兜底：AI 不可用时退回旧的关键词轮换搜索，保证一定有结果。 */
async function fallbackSongs(env, db, searchFn = searchOnline) {
  const day = Math.floor(Date.now() / 86400000)
  // 随机起点 + 每次手动刷新 +1，让兜底路径的「换一批」也有变化
  const idx = (day + Math.floor(Math.random() * HOME_KEYWORDS.length)) % HOME_KEYWORDS.length
  const keyword = HOME_KEYWORDS[idx]
  // 音源走全站设置（与「搜索」同一份），不再写死
  const sources = await searchSources(env, dbmod)
  const parsed = parseQuery(keyword, sources)
  const res = await searchFn(parsed.keyword, { sources: parsed.sources, limit: TARGET_COUNT, pluginPool: env.PLUGIN_POOL })
  return { title: '今日精选 · ' + keyword, songs: res.list, generator: 'fallback', keyword }
}

/**
 * 解析 AI 给的「歌名+歌手」列表 → 真实可播放歌曲。
 * 每首做一次多源聚合搜索取第一条（与「猜你喜欢」同口径）；
 * 搜不到（AI 编造 / 太冷门）的直接跳过，宁缺毋滥。
 * searchFn 可注入（单测用），默认真搜索。
 */
export async function resolveAiSongs(env, db, aiSongs, searchFn = searchOnline) {
  // 同上：音源跟「搜索」共用一份设置，别在这里另立一套
  const parsed = parseQuery('', await searchSources(env, dbmod))
  const out = []
  let cursor = 0
  async function worker() {
    while (cursor < aiSongs.length) {
      const item = aiSongs[cursor++]
      const q = (item.name + ' ' + (item.singer || '')).trim()
      if (!q) continue
      try {
        const res = await searchFn(q, { sources: parsed.sources, limit: 3, pluginPool: env.PLUGIN_POOL })
        if (res && Array.isArray(res.list) && res.list.length) out.push(res.list[0])
      } catch { /* 单首失败不影响整体 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, aiSongs.length) }, worker))
  return out
}

/**
 * 生成当天的每日推荐并落库。force=true 时无视当天已有记录。
 * toWeb：歌曲 → 前端结构的转换函数（api.js 的 songForWeb），落库前统一转换，
 * 这样 /home 与 /daily 的所有出口拿到的都是可直接播放的结构，不用各自再转一遍。
 * 返回 { date, title, songs, generator }；AI 链路整体失败时退回兜底搜索，
 * 兜底也失败才向上抛错（调用方决定怎么提示）。
 */
export async function generateDaily(env, db, { userId = null, force = false, toWeb = null, aiFn = generatePlaylist, searchFn = searchOnline } = {}) {
  const date = todayBJ()
  // 这一轮该用哪些音源 —— 与「搜索」读同一份设置（见 sources.js）
  const sig = (await searchSources(env, dbmod)).join(',')
  if (!force) {
    const existing = await getDaily(db, date)
    const prev = await lastSourcesSig(db)
    // prev === null 表示「读不到签名」（替身/异常），那种情况按老行为直接用当天那份；
    // prev 是空串则说明是**老库**、从没记过签名 —— 当作变了，重算一次，
    // 这正是「升级后才第一次生效」的那一次（否则老板今天还得继续听酷狗）。
    if (existing && (prev === null || prev === sig)) return existing
  }

  const web = (s) => (toWeb ? toWeb(s) : s)
  const record = { date, title: '', songs: [], generator: 'fallback', generatedAt: Date.now() }
  try {
    const signals = await collectSignals(db, userId)
    const prompt = buildPrompt(signals)
    const ai = await aiFn(env, db, { prompt, count: TARGET_COUNT })
    if (ai.songs.length) {
      const resolved = await resolveAiSongs(env, db, ai.songs, searchFn)
      if (resolved.length >= MIN_USABLE) {
        record.title = ai.title || '每日推荐'
        record.songs = resolved.map(web)
        record.generator = 'ai'
      }
    }
  } catch { /* AI 链路任何一步失败都走兜底 */ }

  if (!record.songs.length) {
    const fb = await fallbackSongs(env, db, searchFn)
    record.title = fb.title
    record.songs = fb.songs.map(web)
    record.generator = fb.generator
  }
  if (!record.songs.length) throw new Error('每日推荐生成失败：搜索源无返回')

  await saveDaily(db, record)
  // 记下这次用的音源：下次改了设置才知道该不该重算
  await rememberSourcesSig(db, sig)
  return record
}

/**
 * 上次生成时用的音源签名。
 * 返回 null = **读不出来**（没有 settings 表 / 查询失败），调用方据此退化成老行为；
 * 返回空串 = 读得到但没记过（老库、本次升级后的第一轮）。
 */
async function lastSourcesSig(db) {
  try {
    const v = await getSetting(db, DAILY_SOURCES_SETTING, null)
    return v == null ? '' : String(v)
  } catch { return null }
}

/** 记下音源签名。记不上不影响推荐本身 —— 只是下次会多重算一次。 */
async function rememberSourcesSig(db, sig) {
  try { await setSetting(db, DAILY_SOURCES_SETTING, sig) } catch { /* 下次再记 */ }
}

/** 读某天的推荐。没有返回 null。 */
export async function getDaily(db, date = todayBJ()) {
  try {
    const row = await db.prepare('SELECT date, title, songs, generated_at, generator FROM daily_recommend WHERE date = ?')
      .bind(date).first()
    if (!row) return null
    let songs = []
    try { songs = JSON.parse(row.songs) } catch { /* 脏数据当没有 */ }
    return {
      date: row.date, title: row.title, songs, generator: row.generator,
      generatedAt: row.generated_at,
    }
  } catch { return null }
}

async function saveDaily(db, rec) {
  await db.prepare(
    'INSERT INTO daily_recommend (date, title, songs, generated_at, generator) VALUES (?, ?, ?, ?, ?)'
    + ' ON CONFLICT(date) DO UPDATE SET title = excluded.title, songs = excluded.songs,'
    + ' generated_at = excluded.generated_at, generator = excluded.generator'
  ).bind(rec.date, rec.title, JSON.stringify(rec.songs), rec.generatedAt || Date.now(), rec.generator).run()
}

/** cron / 后台任务用：挑一个「最有数据」的用户当口味来源（播放记录最多的那个）。 */
export async function pickPrimaryUser(db) {
  try {
    const row = await db.prepare(
      'SELECT user_id, COUNT(*) AS n FROM play_progress GROUP BY user_id ORDER BY n DESC LIMIT 1'
    ).first()
    return row ? row.user_id : null
  } catch { return null }
}
