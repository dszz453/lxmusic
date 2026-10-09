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
 * 触发入口四个（都在 CF 端）：
 *   · cron   —— wrangler.toml [triggers]，UTC 22:00 = 北京 06:00，见 index.js 的 scheduled
 *   · lazy   —— /api/home 发现当天还没有记录时，waitUntil 后台生成（明天就有了）
 *   · manual —— POST /api/daily/refresh，前端「换一批」按钮，强制重生成
 *   · requery—— 改了「默认搜索源」时，把当天那份**只换源**重算（见 requeryDailySources）。
 *               与上面三个不同：它不重新选曲、不跑 AI，因此能在请求生命周期内跑完。
 *               少了这条，「设置改了当天不生效」会一直是老板的报障常客。
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

/**
 * 当天那份推荐是不是「用另一份音源生成的」。
 *
 * 为什么需要它：`daily_recommend` 是按日期一行缓存的，而 `/api/home` 与 `/daily`
 * 一看到当天有记录就**直接返回**（首页要秒开，这是对的）—— 于是「改了默认搜索源」
 * 这件事在**当天**永远不生效，用户只能等第二天早上 6 点的 cron 重算，
 * 表现依旧是「设置不起作用」（老板 2026-10-09 报的就是这个）。
 *
 * 所以这两处读接口顺手问一句「这份是不是旧音源生成的」；是的话由调用方重算。
 *
 * 返回 false 的两种情况：没有记录；或**读不到**签名（替身 / 没有 settings 表），
 * 那种情况按老行为办，别拿一个猜出来的结论去触发重算。
 * 注意空串（老库从没记过签名）**算变了** —— 那正是升级后该立刻生效的第一次。
 *
 * ══════════════ ⚠ 这里踩过一个「静默失效」的坑，别再犯 ══════════════
 * 这个函数原先的签名是 `dailySourcesStale(env, db, record)`，api.js 照直传了自己作用域里
 * 的 `db` —— 可那个 `db` 是 `import * as db from '../db.js'` 的**模块**，不是 D1 句柄！
 * 于是 `lastSourcesSig` → `getSetting` → `db.prepare(...)` 抛 `TypeError: db.prepare
 * is not a function`，又被 `lastSourcesSig` 的 `catch { return null }` 吞成 null，
 * 这一层再 `if (prev === null) return false` —— **整条链路安静地永远返回 false**。
 *
 * 后果：2026-10-09 老板报「CF 端今日推荐还是酷狗」，而线上数据完全对得上这个 bug ——
 * `settings` 里始终没有 `daily.sources`（重算从没跑过）、`daily_recommend` 的
 * `generated_at` 停在当天 06:00 的 cron、13 首全是 kg。修完当天换上真正的句柄后
 * 立刻变成按设置的 wy 优先。
 *
 * 教训不是「调用点写错了」，而是**这个参数本来就不该存在**：同一个名字 `db`
 * 在 api.js 里是模块、在 daily.js 里是句柄，两处含义相反（`getSetting(db, …)` 要句柄，
 * `searchSources(env, settingsDb)` 要模块）—— 只要它还接受外部传进来的「db」，
 * 就迟早有人传错，而且错了不报错、只静默失效。所以现在**只收 env**，句柄自己从
 * `env.DB` 取，签名上就没有可传错的地方。
 */
export async function dailySourcesStale(env, record) {
  if (!record || !record.songs || !record.songs.length) return false
  // ⚠ 必须是 D1 句柄：从 env 自己取，绝不由调用方传（见上面的坑）
  const prev = await lastSourcesSig(env && env.DB)
  if (prev === null) return false
  const now = (await searchSources(env, dbmod)).join(',')
  return prev !== now
}

/**
 * 总预算与并发（「只换源」用）。
 *
 * 为什么单独一套而不是复用 `SEARCH_CONCURRENCY`：那条是 AI 解析用的（6）。
 * 换源是「24 首都要过一遍」的批处理，且必须在**请求生命周期内**跑完，
 * 并发给足才有机会收敛；而 AI 解析不急于一次跑完，并发低一点少惹上游限流。
 */
const REQUERY_CONCURRENCY = 8
const REQUERY_BUDGET_MS = 12000

/**
 * 「只换源」的重算：保留当天已经选好的曲目，按**当前的音源设置**把每一首重新解析一遍。
 *
 * ══════════════ 为什么不直接重跑 generateDaily ══════════════
 * 上一版就是那么做的（在 `env.waitUntil` 里跑完整生成），但它注定不生效：
 * 完整生成 = AI 出题 + 24 首逐首跨源搜索，daily.js 自己的注释都写着「30~90s」——
 * 而 CF Worker 在响应返回后给 `waitUntil` 的预算只有约 30 秒，任务跑到一半就被
 * 回收，`saveDaily` 和 `rememberSourcesSig` 都没执行。表现就是「怎么修都不生效」。
 *
 * 关键认识：**AI 只决定「推哪 24 首」，跟音源没关系**。改了音源设置，歌单本身不用变，
 * 只需要把每首换到新源上取一次 —— 省掉 AI 那 10~30 秒，才有可能跑完。
 *
 * ══════════════ 预算与部分成功 ══════════════
 * `budgetMs` 用尽就停止发起新的搜索，**已经换好的照常写回**：宁可只换一部分，
 * 也不要整份丢弃 —— 用户至少能立刻看到一部分新源的结果。
 * 记签名的判据是「**这一轮真的跑过**」（`ran`），不是「全部换完」——
 * 理由见下面那段 ⚠ 注释，那是这个函数第二次踩同一个坑。
 *
 * 返回 `{ replaced, total, completed, ran, saved }`，方便调试与断言。
 */
export async function requeryDailySources(env, record, { toWeb = null, budgetMs = REQUERY_BUDGET_MS, searchFn = searchOnline } = {}) {
  const songs = (record && record.songs) || []
  if (!songs.length) return { replaced: 0, total: 0, completed: true, saved: false }

  const sources = await searchSources(env, dbmod)
  const sig = sources.join(',')
  const parsed = parseQuery('', sources)
  // 预算由调用方定（首页 9s / 今日推荐页 14s，见 api.js）。不再设下限：
  // 早先写成 Math.max(1000, budgetMs)，看着是防呆，实际把调用方的小预算悄悄抬成 1 秒，
  // 于是「预算用尽」这条分支在测试里永远进不去 —— 护栏形同虚设。
  const deadline = Date.now() + budgetMs

  const out = songs.slice()
  let cursor = 0
  let replaced = 0

  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= songs.length) return
      if (Date.now() > deadline) return // 预算用尽：剩下的原样保留，交给下一次
      const s = songs[i] || {}
      const q = ((s.name || '') + ' ' + (s.singer || '')).trim()
      if (!q) continue
      try {
        const res = await searchFn(q, { sources: parsed.sources, limit: 3, pluginPool: env.PLUGIN_POOL })
        const hit = res && Array.isArray(res.list) ? res.list[0] : null
        // 只在**换到了别的源**时才替换：同一源重复搜到的不动，免得把 id/封面抖坏
        if (hit && hit.source && hit.source !== s.source) {
          out[i] = toWeb ? toWeb(hit) : hit
          replaced++
        }
      } catch { /* 单首失败保留原样，不影响整体 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REQUERY_CONCURRENCY, songs.length) }, worker))

  const completed = cursor >= songs.length
  /**
   * ══════════════ ⚠ 「记签名」的判据不能是 completed（2026-10-09 第二次踩） ══════════════
   *
   * 签名（`daily.sources`）回答的问题是「**这份 daily 是按哪套音源生成的**」，
   * 不是「换源有没有全部成功」。原来写成 `if (completed)`，于是：
   *
   *   首页给换源的预算是 9 秒（api.js 的 HOME_REQUERY_BUDGET_MS），而自建 Docker 上
   *   24 首跨源搜一遍常常跑不完 9 秒 → `completed === false` → **签名不记**
   *   → 下一次访问 `dailySourcesStale` 又是 true → 又同步等 9 秒 → 又跑不完 …… **无限循环**。
   *
   * 报障原话正是这个形状：「docker 每次重新打开，登录需要 10s，这个时候我的歌单
   * 加载不出来」「打开 APP 后，app 一直在重新登录后台」—— 那 9 秒是**串在
   * `/api/home` 响应里的**，把 `/api/me` 与 `/api/playlists` 一起压在后面，
   * 界面就停在「未登录」。CF 上不出现，是因为线上那份早就换成功过一次、签名记上了，
   * 此后 `stale` 恒为 false —— 所以这个 bug **只在慢实例上现形**。
   *
   * 正确判据是「**这一轮真的按当前设置跑过**」：只要有歌被处理过（`cursor > 0`），
   * 这份 daily 的源就已经是当前设置了。没跑到的几首还留在老源上，那属于「还有尾巴」，
   * 交给后台慢慢收敛即可，不该让整份被反复判定成 stale。
   */
  const ran = cursor > 0
  if (replaced > 0) {
    try {
      // generatedAt 一并更新：它是「这份内容的时间」，换源后内容确实变了，
      // 前端/缓存只要看它就知道该重渲染（沿用旧值会让「没变化」的假象一直挂着）。
      await saveDaily(env.DB, { ...record, songs: out, generatedAt: Date.now() })
    } catch { /* 写失败只是这次白换，不影响返回 */ }
  }
  if (ran) {
    try { await rememberSourcesSig(env.DB, sig) } catch { /* 记不上就下次多重算一次 */ }
  }
  return { replaced, total: songs.length, completed, ran, saved: replaced > 0 }
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
