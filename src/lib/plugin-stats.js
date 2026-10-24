/**
 * 插件「在线命中率」统计 —— 让取流候选的顺序由**线上真实表现**决定。
 *
 * ── 为什么要这个（而不是继续用 plugin-rank.js）─────────────────────
 * `src/generated/plugin-rank.js` 是 `tools/plugin-score.mjs` 在**构建机**上
 * 离线实测生成的（2026-10-01）。它自己的表头就写着一条限制：
 *
 *   「分数是在构建机的网络上测的，与线上 Cloudflare Worker 出口不完全一致。」
 *
 * 这条限制在实测中是真的会咬人：同一批插件，构建机上通、CF 出口上超时；
 * 反过来也有。而取流只会试候选列表的前 N 个（`resolveMusicUrlFast` 的
 * maxTries），**排序错了就等于把能出声的插件挡在门外**。
 *
 * 所以这里补一层「运行期自己数」：哪个插件在这台机器、这条出口上**真的
 * 交出过能播的音频**，就把它往前提；反复交出假音源 / 4xx 的，往后放。
 *
 * ── 三个刻意的设计 ────────────────────────────────────────────────
 *
 * ① **只统计「确定」的结果，不统计「没测完」**。
 *    `rec.ok === false && !rec.status` 表示探测没跑完（预算到点），
 *    那是我们的问题，不是插件的问题 —— 记成失败会让一个本来健康的插件
 *    因为几次预算不够就被永久降权。判据与 `stream.js` 的 `hardFail` 完全一致。
 *
 * ② **样本不足不参与排序**（MIN_SAMPLES）。一次偶然的失败不该改写顺序，
 *    否则「谁先被抽到谁就背锅」，顺序会在噪声里来回翻。
 *
 * ③ **30 分钟滚动窗口**。插件上游是会变的（今天挂了明天好了），
 *    陈年旧账不该一直压着它。超过窗口的记录视为「未知」，退回静态 rank 的位次。
 *
 * ── 存储 ─────────────────────────────────────────────────────────
 * 内存 Map 是主存储（读写都在同步路径上，不能 await）；
 * 另外每 FLUSH_EVERY 次变更把整份快照写进 edgeCache，跨 isolate 共享。
 * CF 上 isolate 会被频繁回收，只靠内存等于没统计 —— 所以 hydrate/flush
 * 这两步不能省。Docker / 壳里没有 `caches`，自动退化成纯内存，行为不变。
 *
 * ⚠ edgeCache 的 key 必须属于本 zone（见 api.js 里 `CACHE_KEY_HOST` 那一大段
 * 血泪说明）：这里用 `env.__origin` 拼，拿不到 origin 就干脆不落盘，
 * 只留内存 —— 绝不能用一个「看起来像 URL」的假 host，那会 put 静默失败。
 */

/** 统计窗口：超过这个时间的记录视为过期（插件上游是会变的） */
const WINDOW_MS = 30 * 60 * 1000

/** 少于这么多样本不参与排序（防「一次偶然失败就永久降权」） */
const MIN_SAMPLES = 3

/** 命中率达到这个值算「好」，提到前面 */
const GOOD_RATE = 0.6

/** edgeCache 里那份快照的有效期 */
const CACHE_TTL_MS = 10 * 60 * 1000

/** 两次 hydrate 之间的最小间隔（别每个请求都去读缓存） */
const HYDRATE_INTERVAL_MS = 60 * 1000

/**
 * 攒够这么多次变更就落一次盘。
 *
 * ⚠ 原来写的是 20，**线上实测发现太高**：一次 `/url` 最多问 12 个插件，
 * 一个请求根本攒不到 20 次；isolate 一回收，这一整批记录就没了。
 * 2026-10-24 打 `/api/plugin-stats` 看到的正是这个 —— 只有失败的那几个
 * 插件有账，成功的全丢（因为失败记录先攒到阈值触发了 flush，成功的那几条
 * 落在别的 isolate 上、没来得及落盘）。
 *
 * 降到 6 之后，单个取流请求就会触发一次；再配下面那条 30 秒的时间兜底，
 * 免得「请求很稀」的时候数据一直悬在内存里。
 */
const FLUSH_EVERY = 6

/** 时间兜底：有变更、且距上次落盘超过这么久，也落一次 */
const FLUSH_MIN_INTERVAL_MS = 30 * 1000

/** 内部 key 路径（与 api.js 的 `/__edgecache` 前缀保持一致，便于日志辨认） */
const CACHE_PATH = '/__edgecache/plugin-stats'

/** `${source}|${pluginId}` -> { ok, fail, ts } */
const mem = new Map()

let loadedAt = 0
let hydrating = null
let dirty = 0
let lastFlushAt = 0
let lastFlushOk = null
let lastFlushErr = ''

/** 统计键。平台 + 插件 id —— 同一个插件在不同平台上表现可以完全不同。 */
export function statKey(source, pluginId) {
  return `${String(source || '')}|${String(pluginId || '')}`
}

/**
 * 把一条 `{ok, fail, ts}` 折算成排序用的档位。
 *
 *   tier 0 —— 实测好用（命中率 >= GOOD_RATE），提到前面
 *   tier 1 —— 未知 / 样本不足 / 命中率一般，**原样不动**
 *   tier 2 —— 实测全灭（命中率 0），放到最后
 *
 * ⚠ 只有 0 和 2 会改变顺序，tier 1 一律不参与排序 —— 这是「别让统计把静态
 * 先验冲掉」的保险：统计只负责「救」和「埋」，不负责重新洗牌。
 *
 * `rate` 在 tier 1 上**必须返回 0**（而不是真实命中率）。踩过的坑：
 * 一开始返回真实值，于是命中率 1/3 的插件（既不算好也不算坏）会因为
 * 0.333 > 未知项的 -1 而被排到所有未知项前面 —— 等于「稍微差一点」
 * 反而被奖励了。tier 1 里所有项同分，第三键（原下标）才会生效。
 */
function tierOf(rec, now) {
  if (!rec) return { tier: 1, rate: 0 }
  if (now - (rec.ts || 0) > WINDOW_MS) return { tier: 1, rate: 0 }   // 过期 = 未知
  const samples = (rec.ok || 0) + (rec.fail || 0)
  if (samples < MIN_SAMPLES) return { tier: 1, rate: 0 }
  const rate = (rec.ok || 0) / samples
  if (rate <= 0) return { tier: 2, rate: 0 }
  if (rate >= GOOD_RATE) return { tier: 0, rate }
  return { tier: 1, rate: 0 }
}

/**
 * 按在线命中率重排候选。
 *
 * @param {string} source 平台代号（kg/wy/kw/tx/xm）
 * @param {Array<{id:string}>} items 已经按静态 rank 排好的候选
 * @returns {Array} 重排后的新数组（不改原数组）
 *
 * 排序键：tier 升序 → 命中率降序 → 原下标升序。
 * 最后一个键保证**稳定**：同档同率时维持静态 rank 的顺序，
 * 所以「统计完全没数据」时输出与输入一模一样（这一点有单测钉着）。
 */
export function order(source, items) {
  if (!Array.isArray(items) || items.length < 2) return items || []
  const now = Date.now()
  const keyed = items.map((it, i) => ({
    it, i,
    ...tierOf(mem.get(statKey(source, it.id)), now),
  }))
  keyed.sort((a, b) => (a.tier - b.tier) || (b.rate - a.rate) || (a.i - b.i))
  return keyed.map((x) => x.it)
}

/**
 * 记一次结果。
 *
 * @param {string} source
 * @param {string} pluginId
 * @param {'ok'|'fail'|'skip'} outcome
 *   `skip` = 这次没能判断（探测没跑完 / 插件超时前就撞上总预算），
 *   不计入任何一边 —— 见文件头第 ① 条。
 */
export function record(source, pluginId, outcome) {
  if (!source || !pluginId) return
  if (outcome !== 'ok' && outcome !== 'fail') return
  const k = statKey(source, pluginId)
  const now = Date.now()
  let rec = mem.get(k)
  // 过期的记录直接重开一份，别在旧账上继续累加
  if (!rec || now - (rec.ts || 0) > WINDOW_MS) rec = { ok: 0, fail: 0, ts: now }
  if (outcome === 'ok') rec.ok += 1
  else rec.fail += 1
  rec.ts = now
  mem.set(k, rec)
  dirty += 1
}

/** 只读快照，供诊断口 / 单测用 */
export function snapshot() {
  const now = Date.now()
  const out = {}
  for (const [k, v] of mem) {
    if (now - (v.ts || 0) > WINDOW_MS) continue
    out[k] = { ok: v.ok || 0, fail: v.fail || 0, ts: v.ts }
  }
  return out
}

/** 单测用：清空内存态 */
export function reset() {
  mem.clear()
  loadedAt = 0
  hydrating = null
  dirty = 0
  lastFlushAt = 0
}

/**
 * edgeCache 的 key。拿不到 `env.__origin` 就返回 null —— 宁可只留内存，
 * 也不要用一个不属于本 zone 的 host 去 put（那会静默失败，见文件头说明）。
 */
function cacheKeyOf(env) {
  const origin = env && env.__origin
  if (!origin || !/^https?:\/\//.test(String(origin))) return null
  try {
    return new Request(String(origin).replace(/\/+$/, '') + CACHE_PATH, { method: 'GET' })
  } catch {
    return null
  }
}

function defaultCache() {
  return (globalThis.caches && globalThis.caches.default) || null
}

/** 读 edgeCache 里那份快照。无 caches / 无 origin / 过期 / 解析失败一律回 null。 */
async function readRemote(env) {
  const key = cacheKeyOf(env)
  const c = defaultCache()
  if (!key || !c) return null
  try {
    const res = await c.match(key)
    if (!res) return null
    const body = await res.json()
    if (!body || Date.now() - (body.ts || 0) > CACHE_TTL_MS) return null
    return body.items || null
  } catch { return null }
}

/**
 * 把一份远端快照并进内存。
 *
 * 合并规则：**时间戳更新的那份胜出**，不做累加 —— 两个 isolate 各自累加的
 * 结果相加会把同一批请求数两遍，命中率会失真；而「取较新的那份」最多
 * 丢失一点样本量，不会算错比例。
 *
 * @returns {number} 真正被采纳的条数（便于单测）
 */
function mergeInto(items) {
  if (!items || typeof items !== 'object') return 0
  let n = 0
  for (const [k, v] of Object.entries(items)) {
    if (!v || typeof v !== 'object') continue
    const cur = mem.get(k)
    if (!cur || (v.ts || 0) > (cur.ts || 0)) {
      mem.set(k, { ok: Number(v.ok) || 0, fail: Number(v.fail) || 0, ts: Number(v.ts) || 0 })
      n += 1
    }
  }
  return n
}

/**
 * 从 edgeCache 拉一次快照并合并进内存。
 *
 * 失败一律吞掉：统计是**锦上添花**，它自己坏掉绝不能影响取流。
 *
 * @param {object} env Worker 环境（要 `env.__origin`）
 * @param {boolean} [force] 跳过 60 秒节流。**只有诊断口用** ——
 *   否则打 `/api/plugin-stats` 很可能落到一个刚起的 isolate 上、看到空表，
 *   会让人误判「统计根本没在记」。
 */
export async function hydrate(env, force = false) {
  const now = Date.now()
  if (!force && now - loadedAt < HYDRATE_INTERVAL_MS) return
  if (hydrating) return hydrating
  loadedAt = now
  hydrating = readRemote(env)
    .then((items) => { mergeInto(items) })
    .catch(() => {})
    .finally(() => { hydrating = null })
  return hydrating
}

/**
 * 把内存里攒下的统计落进 edgeCache。
 *
 * 三种触发：攒够 `FLUSH_EVERY` 次 / 距上次超过 `FLUSH_MIN_INTERVAL_MS` 且有变更 /
 * `force`（诊断口与单测用）。其余情况是空操作，所以每个请求都调一遍没有成本。
 *
 * ⚠ **先读回来合并、再写**。多个 isolate 各写各的会互相覆盖：A 写完 B 写，
 * A 那批就没了。读-改-写至少能保住别人已经攒下的那份；真正的并发写仍可能
 * 丢一点样本 —— 对「排序参考」这个用途来说完全可以接受，不必上锁。
 *
 * @returns {boolean} 这次是否真的写了
 */
export async function flush(env, force = false) {
  const now = Date.now()
  const due = force
    || dirty >= FLUSH_EVERY
    || (dirty > 0 && now - lastFlushAt >= FLUSH_MIN_INTERVAL_MS)
  if (!due) return false
  const key = cacheKeyOf(env)
  const c = defaultCache()
  if (!key || !c) { dirty = 0; return false }
  lastFlushAt = now
  const remote = await readRemote(env)
  dirty = 0
  mergeInto(remote)
  const items = snapshot()
  try {
    await c.put(key, new Response(JSON.stringify({ ts: Date.now(), items }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=' + Math.floor(CACHE_TTL_MS / 1000),
      },
    }))
    lastFlushOk = true
    lastFlushErr = ''
    return true
  } catch (e) {
    // ⚠ 不能静默吞：put 失败时整套统计等于没接上，而症状是「一切正常，只是
    // 排序永远不变」。把原因留在 lastFlushErr 里，诊断口能直接看到。
    lastFlushOk = false
    lastFlushErr = String((e && e.message) || e)
    return false
  }
}

/**
 * 诊断用的内部状态。**只给 `/api/plugin-stats?debug=1` 用** ——
 * 这套统计失效时一点声响都没有（排序退回静态表，功能全对），
 * 没有这些数字就只能靠猜。
 */
export function debugInfo() {
  return {
    dirty,
    lastFlushAt,
    lastFlushOk,
    lastFlushErr,
    loadedAt,
    memSize: mem.size,
    hydrated: !!loadedAt,
  }
}
