// 每日推荐单元测试：不真出网 —— AI 与搜索都通过参数注入 fake。
// 覆盖：北京时间跨日、prompt 组装、信号表缺席容错、生成编排（AI 成功 / AI 失败兜底 /
// 解析不足兜底）、当天已有记录不重生成、手动刷新 force 覆盖、落库后 getDaily 读回。
import { todayBJ, buildPrompt, collectSignals, generateDaily, getDaily, resolveAiSongs, dailySourcesStale, requeryDailySources } from '../src/server/daily.js'
import { readFileSync } from 'node:fs'

/**
 * 去掉注释再做「不包含 / 签名」断言。
 * 注释里必然写着那条规则的**反面写法**（本文件就写了 `db.prepare is not a function`），
 * 直接拿整文件匹配会永远红。
 */
function deComment(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

let pass = 0, fail = 0
const results = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push('  ✓ ' + name) }
  else { fail++; results.push('  ✗ ' + name + (extra ? ' —— ' + extra : '')) }
}

/* ---------- fake 基建 ---------- */

// 内存 D1 替身：只实现 daily.js 用到的 prepare().bind().first()/run()/all()
//
// settings 表也要有：每日推荐要读「生效的搜索源」（src/server/sources.js），
// 还要把自己这次用的音源签名记下来（daily.sources）。替身缺这张表时
// lastSourcesSig 会返回 null（= 读不到），于是「音源没变就不重算」这条就测不出来了。
function fakeDb() {
  const daily = new Map()   // date -> row
  const settings = new Map() // k -> v
  const tables = { playlists: [], play_progress: [], search_history: [] }
  return {
    _tables: tables, _daily: daily, _settings: settings,
    prepare(sql) {
      const s = sql.toUpperCase()
      const chain = {
        _args: [],
        bind(...a) { this._args = a; return this },
        async first() {
          if (s.includes('FROM SETTINGS')) {
            return settings.has(this._args[0]) ? { v: settings.get(this._args[0]) } : null
          }
          if (s.includes('FROM DAILY_RECOMMEND')) return daily.get(this._args[0]) || null
          if (s.includes('FROM PLAY_PROGRESS') && s.includes('GROUP BY')) {
            const rows = tables.play_progress
            if (!rows.length) return null
            const cnt = {}
            for (const r of rows) cnt[r.user_id] = (cnt[r.user_id] || 0) + 1
            const [user_id, n] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]
            return { user_id, n }
          }
          return null
        },
        async all() {
          if (s.includes('FROM PLAYLISTS')) return { results: tables.playlists.map(r => ({ name: r.name })) }
          return { results: [] }
        },
        async run() {
          if (s.includes('INTO SETTINGS')) {
            settings.set(this._args[0], this._args[1])
            return { success: true }
          }
          if (s.includes('INSERT INTO DAILY_RECOMMEND')) {
            const [date, title, songs, generatedAt, generator] = this._args
            daily.set(date, { date, title, songs, generated_at: generatedAt, generator })
          }
          return { success: true }
        },
      }
      return chain
    },
    // collectSignals 走 db.js 的 listPlayHistory / listSearchHistory，它们用 prepare().bind().all()
  }
}

// listPlayHistory/listSearchHistory 用固定 SQL 查 play_progress / search_history，
// fakeDb 的 all() 不区分它们 —— 直接给 db 对象挂上这两个函数的替身。
function withHistory(db, history, searches) {
  db.listPlayHistory = async (_userId, limit) => history.slice(0, limit || 200)
  db.listSearchHistory = async (_userId, limit) => searches.slice(0, limit || 20)
  return db
}

const fakeEnv = (over = {}) => ({ PLUGIN_POOL: null, DB: null, ...over })

// AI fake：返回指定歌单
const aiOk = (songs, title = '测试歌单') => async () => ({ title, songs })
// AI fake：直接抛（未配置 / 超时 / 上游 500）
const aiBoom = async () => { throw new Error('AI 未配置') }
// 搜索 fake：每个关键词都命中 1 首（name 里带回关键词便于断言）
const searchOk = async (q) => ({ list: [{ source: 'kg', id: 'x_' + q, name: q, singer: '某人', img: '', types: [{ type: '128k' }] }] })
// 搜索 fake：永远空
const searchEmpty = async () => ({ list: [] })

/* ---------- 1. 北京时间 ---------- */
{
  // UTC 2026-10-01T17:00:00Z = 北京 10-02 01:00 → 日期应算成 10-02
  ok('todayBJ 跨日：UTC 17:00 已是北京次日',
    todayBJ(Date.UTC(2026, 9, 1, 17, 0, 0)) === '2026-10-02')
  // UTC 2026-10-01T15:59:00Z = 北京 10-01 23:59 → 还是当天
  ok('todayBJ 不跨日：UTC 15:59 还是北京当天',
    todayBJ(Date.UTC(2026, 9, 1, 15, 59, 0)) === '2026-10-01')
}

/* ---------- 2. buildPrompt ---------- */
{
  const p1 = buildPrompt({
    playlistNames: ['深夜驾车', '粤语回忆'],
    history: [
      { song: { name: '海阔天空', singer: 'Beyond' }, playCount: 12 },
      { song: { name: '富士山下', singer: '陈奕迅' }, playCount: 8 },
      { song: { name: '海阔天空', singer: 'Beyond' }, playCount: 3 },
    ],
    searches: [{ keyword: '老歌' }],
  })
  ok('prompt 含歌单名', p1.includes('深夜驾车') && p1.includes('粤语回忆'))
  ok('prompt 含高频歌手（Beyond 听了 15 次）', p1.includes('Beyond'))
  ok('prompt 含搜索词', p1.includes('老歌'))

  const p2 = buildPrompt({ playlistNames: [], history: [], searches: [] })
  ok('信号全空时退化为大众口味 prompt', p2.includes('推荐'))

  // play_count 汇总：海阔天空 12+3=15 > 富士山下 8 → Beyond 排前面
  const p3 = buildPrompt({
    playlistNames: [],
    history: [
      { song: { name: '富士山下', singer: '陈奕迅' }, playCount: 8 },
      { song: { name: '海阔天空', singer: 'Beyond' }, playCount: 12 },
      { song: { name: '海阔天空', singer: 'Beyond' }, playCount: 3 },
    ],
    searches: [],
  })
  ok('歌手按播放次数排序（Beyond 在前）', p3.indexOf('Beyond') < p3.indexOf('陈奕迅'))
}

/* ---------- 3. collectSignals 容错 ---------- */
{
  const badDb = {
    prepare() { throw new Error('表不存在') },
    listPlayHistory: async () => { throw new Error('boom') },
    listSearchHistory: async () => { throw new Error('boom') },
  }
  const sig = await collectSignals(badDb, 'u1')
  ok('三张表全炸时返回空信号而不抛',
    Array.isArray(sig.playlistNames) && Array.isArray(sig.history) && Array.isArray(sig.searches)
    && !sig.playlistNames.length && !sig.history.length && !sig.searches.length)
}

/* ---------- 4. generateDaily 编排 ---------- */
{
  // 4a. AI 成功 + 搜索能解析 → generator=ai，走 toWeb 转换
  const db1 = withHistory(fakeDb(), [], [])
  const aiSongs = Array.from({ length: 12 }, (_, i) => ({ name: '歌' + i, singer: '歌手' + i }))
  const rec1 = await generateDaily(fakeEnv(), db1, {
    force: true, toWeb: (s) => ({ ...s, web: true }),
    aiFn: aiOk(aiSongs, '按口味挑的'), searchFn: searchOk,
  })
  ok('AI 链路成功 → generator=ai', rec1.generator === 'ai')
  ok('标题用 AI 起的名', rec1.title === '按口味挑的')
  ok('歌曲经过 toWeb 转换后落库', rec1.songs.length === 12 && rec1.songs[0].web === true)

  // 落库后 getDaily 能读回（同一天）
  const back = await getDaily(db1)
  ok('落库后当天 getDaily 读回同一份', !!back && back.songs.length === 12 && back.generator === 'ai')

  // 4b. force=false 且当天已有 → 直接返回，不再生成（AI 不会被调用）
  let called = 0
  const rec2 = await generateDaily(fakeEnv(), db1, {
    force: false, aiFn: async () => { called++; return { title: 'x', songs: [] } }, searchFn: searchOk,
  })
  ok('当天已有记录时不重生成', called === 0 && rec2.generator === 'ai' && rec2.title === '按口味挑的')

  // 4c. force=true（手动刷新）→ 覆盖当天
  const rec3 = await generateDaily(fakeEnv(), db1, {
    force: true, toWeb: (s) => s,
    aiFn: aiOk(aiSongs, '换一批后的'), searchFn: searchOk,
  })
  ok('手动刷新覆盖当天记录', rec3.title === '换一批后的' && (await getDaily(db1)).title === '换一批后的')

  // 4d. AI 抛错 → 兜底搜索
  const db4 = withHistory(fakeDb(), [], [])
  const rec4 = await generateDaily(fakeEnv(), db4, {
    force: true, aiFn: aiBoom, searchFn: searchOk,
  })
  ok('AI 失败 → 兜底关键词搜索', rec4.generator === 'fallback' && rec4.songs.length > 0)
  ok('兜底标题带关键词', /^今日精选 · /.test(rec4.title))

  // 4e. AI 成功但解析出的歌太少 → 兜底
  // （搜索 fake：AI 歌名「歌N」搜不到，兜底关键词「热歌」这类能搜到 —— 生产上两者走同一个真搜索）
  const db5 = withHistory(fakeDb(), [], [])
  const rec5 = await generateDaily(fakeEnv(), db5, {
    force: true, toWeb: (s) => s, aiFn: aiOk(aiSongs),
    searchFn: async (q) => (/^歌/.test(q) ? { list: [] } : searchOk(q)),
  })
  ok('解析不足 8 首 → 退兜底', rec5.generator === 'fallback' && rec5.songs.length > 0)

  // 4f. AI 与搜索全炸 → 向上抛错
  let threw = false
  try {
    await generateDaily(fakeEnv(), withHistory(fakeDb(), [], []), {
      force: true, aiFn: aiBoom, searchFn: searchEmpty,
    })
  } catch { threw = true }
  ok('兜底也搜不到时向上抛错', threw)

  /* 4g. 音源必须来自「默认搜索源」设置 —— 2026-10-09 报障的根因
   *
   * 原来这里写死 ['kg','wy','kw']（酷狗排第一），于是管理后台把默认搜索源改成
   * 只用网易云之后，搜索听话、每日推荐照样推酷狗。下面两条把「读设置」这件事钉死：
   *   · 传给搜索的 sources 就是设置里那一份（不是写死的清单）；
   *   · 设置变了，当天那份要重算（否则改完设置得等到第二天）。
   */
  const db6 = withHistory(fakeDb(), [], [])
  const env6 = fakeEnv({ DB: db6 })
  const seen = []
  const spy = async (q, opts) => { seen.push((opts && opts.sources || []).join(',')); return searchOk(q) }
  await db6.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').bind('search.sources', 'wy').run()
  const rec6 = await generateDaily(env6, db6, { force: true, toWeb: (s) => s, aiFn: aiOk(aiSongs), searchFn: spy })
  ok('每日推荐传下去的源 = 设置里那一份（这里只勾了网易云）',
    seen.length > 0 && seen.every((s) => s === 'wy'), seen.join(' / '))
  ok('用了设置的源也能正常出结果', rec6.songs.length === 12)

  // 设置没变 → 当天不重算（老行为不能丢）
  let again = 0
  const rec7 = await generateDaily(env6, db6, {
    force: false, aiFn: async () => { again++; return { title: 'x', songs: [] } }, searchFn: spy,
  })
  ok('音源没变 → 当天那份直接复用，不重算', again === 0 && rec7.title === rec6.title)

  // 设置变了 → 重算（不然「改了设置不生效」要一直挂到第二天）
  await db6.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').bind('search.sources', 'kw').run()
  let called6 = 0
  const rec8 = await generateDaily(env6, db6, {
    force: false, toWeb: (s) => s, aiFn: async () => { called6++; return { title: '换源之后', songs: aiSongs } }, searchFn: spy,
  })
  ok('音源设置变了 → 当天那份立刻重算', called6 === 1 && rec8.title === '换源之后')
  ok('重算时用的是新设置（酷我）', seen[seen.length - 1] === 'kw', seen.join(' / '))

  /* 4h. 「当天那份是不是旧音源生成的」判据
   *
   * 为什么单独要它：`/api/home` 与 `/daily` 一看到当天有记录就**直接返回**（首页要秒开），
   * 于是即使 generateDaily 改好了，改了设置之后**当天**仍然看不到效果 ——
   * 用户要等到第二天 06:00 的 cron，表现还是「设置不起作用」。
   * 所以这两个读接口要顺手问一句这里，是旧的就当场换源。
   */
  const recX = { date: '2026-10-09', songs: [{ name: 'x' }] }
  ok('没有记录 → 谈不上「旧」（不该触发换源）',
    (await dailySourcesStale(env6, null)) === false
    && (await dailySourcesStale(env6, { date: 'x', songs: [] })) === false)

  // 当前设置是 kw（上面 4g 最后改的），而签名记的是上一次生成用的 kw → 不算旧
  const sigNow = db6._settings.get('daily.sources')
  ok('签名记下了（否则下面两条是空断言）', typeof sigNow === 'string' && sigNow.length > 0, String(sigNow))
  ok('签名 = 当前设置 → 不算旧', (await dailySourcesStale(env6, recX)) === false, String(sigNow))

  // 老库：从没记过签名（键不存在）→ 算旧。这正是「升级后第一次就该立刻生效」的那次
  db6._settings.delete('daily.sources')
  ok('老库没记过签名 → 算旧（升级后第一次访问就该换源，而不是等到明天）',
    (await dailySourcesStale(env6, recX)) === true)

  // 设置又改了 → 算旧
  db6._settings.set('daily.sources', 'kg,wy,kw')
  ok('设置换了但当天那份还是旧源生成的 → 算旧', (await dailySourcesStale(env6, recX)) === true)

  // 读不到 settings 表（替身 / 老库）→ 退化成老行为，别拿猜出来的结论去换源
  ok('读不到签名表 → 返回 false（退化成老行为，不拿猜的结论换源）',
    (await dailySourcesStale(fakeEnv({ DB: { prepare() { throw new Error('no table') } } }), recX)) === false)

  /* 4h-2. ⚠ 血泪护栏：这个判据**只能收 env**
   *
   * 它原先的签名是 `(env, db, record)`，而 api.js 传的 `db` 是
   * `import * as db from '../db.js'` 那个**模块**，daily.js 却按 D1 句柄用 ——
   * getSetting 拿到模块 → `db.prepare is not a function` → 被 catch 吞成 null →
   * `if (prev === null) return false` → **整条链路安静地永远返回 false**。
   * 于是线上「改了音源设置」在 CF 端怎么修都不生效，`settings` 里始终没有
   * `daily.sources`（2026-10-09 老板报障）。这类 bug 不报错、只静默失效，
   * 所以把「参数形状」本身钉进测试：句柄必须自己从 env.DB 取。
   */
  const dailySrc = deComment(readFileSync(new URL('../src/server/daily.js', import.meta.url), 'utf8'))
  ok('dailySourcesStale 只收 env（句柄自取，从签名上消除「模块 vs 句柄」传错的可能）',
    /export async function dailySourcesStale\(env, record\)/.test(dailySrc))
  ok('dailySourcesStale 里取签名走 env.DB，不是外部塞进来的东西',
    /lastSourcesSig\(env && env\.DB\)/.test(dailySrc))
  ok('⚠ lastSourcesSig 的调用只有两种合法形态：env 自取、或 generateDaily 自己的句柄参数',
    (dailySrc.match(/lastSourcesSig\(/g) || []).length
    === (dailySrc.match(/lastSourcesSig\((?:env && env\.DB|db)\)/g) || []).length)

  /* 4i. api.js 必须真的把这两处接上去（helper 写好了没人调 = 白写），
   *     且必须用「只换源」而不是再跑一遍完整生成 —— 完整生成是 30~90s，
   *     放 CF 的 waitUntil 里跑到一半就被回收，等于没做。 */
  const apiSrc = deComment(readFileSync(new URL('../src/server/api.js', import.meta.url), 'utf8'))
  ok('/api/home 的「当天已有记录」分支会做旧源检查',
    /if \(daily && daily\.songs\.length\)[\s\S]{0,600}?regenDailyIfStale\(/.test(apiSrc))
  ok('/api/daily 也做同一件事（否则从「每日推荐」页进来还是看不到效果）',
    /path === '\/daily' && method === 'GET'[\s\S]{0,400}?regenDailyIfStale\(/.test(apiSrc))
  ok('换源走 requeryDailySources（只换源、不重跑 AI）',
    /function regenDailyIfStale\(env, record, toWeb/.test(apiSrc)
    && /requeryDailySources\(env, record/.test(apiSrc))
  ok('函数默认同步等（真实调用点由下面两条分别钉住）',
    /\{ sync = true, budgetMs \} = \{\}/.test(apiSrc))
  /**
   * ⚠ 首页必须 `sync: false` —— 2026-10-09 第二次报障的根因。
   *
   * 原来首页写的是 `sync: true, budgetMs: 9000`，那 9 秒是**串在 /home 响应里**的。
   * 弱网自建实例上跑不完 → 签名记不上（见 daily.js 的 `ran` 注释）→ 每次访问都等满
   * 9 秒，而同一刻的 /api/me 与 /api/playlists 全被压在这 9 秒后面 ——
   * 界面停在「未登录」，报障原话「docker 每次重新打开，登录需要 10s」。
   * 所以这条断言钉的是「首页绝不再同步等」，别改回去。
   */
  ok('⚠ 首页换源走后台（绝不同步等 —— 9 秒串进 /home 会压住 /api/me 与 /api/playlists）',
    /regenDailyIfStale\(env, daily, songForWeb, \{ sync: false/.test(apiSrc)
    && /sync: true, budgetMs: HOME_REQUERY_BUDGET_MS/.test(apiSrc) === false)
  ok('「今日推荐」页仍同步等（那一页是用户主动进来看推荐的，等得起）',
    /regenDailyIfStale\(env, daily, songForWeb, \{ sync: true, budgetMs: DAILY_REQUERY_BUDGET_MS/.test(apiSrc))
  ok('换完重读一次再返回（本次响应给的就是新内容）',
    /if \(dstale\)[\s\S]{0,220}?getDaily\(env\.DB\)/.test(apiSrc))
  ok('⚠ 调用点不许再传 db（模块当句柄 → TypeError 被 catch 吞掉 → 永远 false）',
    /regenDailyIfStale\(\s*env\s*,\s*db\b/.test(apiSrc) === false
    && /dailySourcesStale\(\s*env\s*,\s*db\b/.test(apiSrc) === false)
  ok('同步路径也有去重（同一 isolate 复用任务 + 冷却），连点首页不会反复等',
    /dailyRegenTask/.test(apiSrc) && /now - dailyRegenAt < 20000/.test(apiSrc))
  /**
   * ⚠ 没有 `waitUntil` 的宿主（Docker / 本机 node）**也必须真跑**后台重算。
   *
   * 原来这里写的是 `if (!env.waitUntil) return true` —— 在 CF 上没问题（它一定有），
   * 但自建实例没有 `env.waitUntil`，那一句在 Docker 上等于**永远不重算**。
   * `waitUntil` 的唯一作用是「保住响应返回后还要跑的任务不被回收」；Node 进程不会
   * 因为回了响应就掐掉在途的 promise，所以把 promise 丢出去它就会跑完。
   * 所以断言要同时钉两件：旧短路不在了 + 新写法里 task 真的被创建。
   */
  ok('⚠ 没有 waitUntil 的宿主也必须真跑（旧的 `if (!env.waitUntil) return true` 在 Docker 上=永不重算）',
    /if \(!env\.waitUntil\) return true/.test(apiSrc) === false
    && /const task = requeryDailySources\(env, record, \{ toWeb, budgetMs \}\)/.test(apiSrc)
    && /if \(env\.waitUntil\) \{/.test(apiSrc))
  ok('generateDaily 的调用点传的是 env.DB（句柄），不是 db 模块',
    /generateDaily\(env, env\.DB,/.test(apiSrc)
    && /generateDaily\(\s*env\s*,\s*db\b/.test(apiSrc) === false)

  /* 4j. requeryDailySources：「改了音源设置」时只换源
   *
   * 关键认识：AI 只决定「推哪 24 首」，跟音源无关。改了音源设置，歌单本身不用变，
   * 只要把每首换到新源上取一次 —— 省掉 AI 的 10~30 秒，才有可能在请求生命周期内跑完。
   */
  {
    const db7 = withHistory(fakeDb(), [], [])
    const env7 = fakeEnv({ DB: db7 })
    await db7.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').bind('search.sources', 'wy,kg').run()
    const hitWy = async (q) => ({ list: [{ source: 'wy', id: 'wy_' + q, name: q, singer: '' }] })

    const recA = {
      date: '2026-10-09', title: '每日推荐', generator: 'ai', generatedAt: 1,
      songs: [
        { name: '同桌的你', singer: '老狼', source: 'kg', id: 'kg_1' },
        { name: '海阔天空', singer: 'Beyond', source: 'kg', id: 'kg_2' },
      ],
    }
    const ra = await requeryDailySources(env7, recA, { toWeb: (s) => s, searchFn: hitWy })
    ok('换源：每首都换到新源', ra.replaced === 2 && ra.total === 2 && ra.completed === true, JSON.stringify(ra))
    ok('换源：换到了就落库', ra.saved === true)
    ok('换源：记下这次用的源签名（下次不再判旧）', db7._settings.get('daily.sources') === 'wy,kg')

    const back = await getDaily(db7, '2026-10-09')
    ok('换源：读回来的歌已经是新源',
      !!back && back.songs.length === 2 && back.songs.every((s) => s.source === 'wy'),
      back ? JSON.stringify(back.songs.map((s) => s.source)) : 'null')

    // 已经在目标源上的歌不再替换：同一源重复搜到的不动，免得把 id / 封面抖坏
    const recB = { date: '2026-10-10', songs: [{ name: 'C', singer: 'c', source: 'wy', id: 'wy_9' }] }
    const rb = await requeryDailySources(env7, recB, { toWeb: (s) => s, searchFn: hitWy })
    ok('已经在目标源上 → 不算替换（避免把 id/封面抖坏）', rb.replaced === 0 && rb.completed === true)

    /**
     * ⚠ 预算用尽（没跑完）**也必须记签名** —— 2026-10-09 第二次踩的坑，别改回去。
     *
     * 签名回答的是「这份 daily 是按哪套音源生成的」，不是「换源全部成功了」。
     * 原先写成 `if (completed)`，于是弱网自建实例上（9 秒跑不完 24 首）：
     *   completed=false → 签名不记 → 下次访问又判 stale → 又同步等 9 秒 → **无限循环**。
     * 报障原话「docker 每次重新打开，登录需要 10s，这个时候我的歌单加载不出来」
     * 就是这个循环：那 9 秒会把同一刻的 `/api/me`、`/api/playlists` 一起压在后面。
     * CF 上不出现，是因为线上那份早就换成功过一次、签名记上了 —— 所以这个 bug
     * **只在慢实例上现形**，是这个项目最难查的一类。
     */
    const db8 = withHistory(fakeDb(), [], [])
    const env8 = fakeEnv({ DB: db8 })
    await db8.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?,?)').bind('search.sources', 'wy').run()
    const slow = async (q) => { await new Promise((r) => setTimeout(r, 40)); return hitWy(q) }
    const many = {
      date: '2026-10-11',
      songs: Array.from({ length: 48 }, (_, i) => ({ name: 'S' + i, singer: '', source: 'kg', id: 'kg_' + i })),
    }
    const rc = await requeryDailySources(env8, many, { toWeb: (s) => s, budgetMs: 100, searchFn: slow })
    ok('预算用尽：没跑完（completed=false，尾巴留给下次）', rc.completed === false, JSON.stringify(rc))
    ok('⚠ 但真的跑过（ran=true）→ 必须记下签名，否则每次访问都要白等一整轮',
      rc.ran === true && db8._settings.get('daily.sources') === 'wy', JSON.stringify(rc))
    ok('结构断言：结尾用 ran 判据（不许再出现 completed 把关的 rememberSourcesSig）',
      /if \(ran\)/.test(dailySrc)
      && /if \(completed\)[\s\S]{0,40}?rememberSourcesSig/.test(dailySrc) === false)
  }
}

/* ---------- 5. resolveAiSongs ---------- */
{
  const got = await resolveAiSongs(fakeEnv(), fakeDb(), [
    { name: '晴天', singer: '周杰伦' },
    { name: '', singer: '' },         // 全空跳过
    { name: '冷门歌', singer: '' },   // 搜索失败跳过
  ], async (q) => { if (q.includes('冷门')) throw new Error('无结果'); return searchOk(q) })
  ok('resolveAiSongs：跳过空名与搜索失败的', got.length === 1 && got[0].name.includes('晴天'))
}

/* ---------- 汇总 ---------- */
console.log('===== daily.test =====')
console.log(results.join('\n'))
console.log(`===== 共 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
