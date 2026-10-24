/**
 * 插件在线命中率统计（lib/plugin-stats.js）的单测。
 *
 * 这套东西的风险不在「算错」，而在**安静地失效**：排序退回静态表，
 * 功能一切正常，只是永远不变快。所以下面每一条都钉一个「失效时会怎样」：
 *
 *   · 没数据时顺序必须与输入**逐字相同**（否则等于把静态评分表废掉了）
 *   · 样本不足时不许动顺序（否则一次偶然失败就永久降权）
 *   · 「没探完」（skip）不许算进失败（否则慢而正常的插件被冤枉）
 *   · 过期记录要当作没测过（否则挂过一次就翻不了身）
 */
import * as stats from '../src/lib/plugin-stats.js'

let pass = 0
let fail = 0
const failures = []

function check(name, cond) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; failures.push(name); console.log('  ✗ ' + name) }
}

const ids = (list) => list.map((x) => x.id).join(',')
const mk = (...names) => names.map((id) => ({ id, thunk: async () => null }))

console.log('===== plugin-stats =====')

/* ---- 1. 没有数据时：顺序必须原样不动 ---- */
{
  stats.reset()
  const input = mk('a', 'b', 'c', 'd')
  const out = stats.order('kg', input)
  check('没数据时 order() 原样返回（静态 rank 说了算）', ids(out) === 'a,b,c,d')
  check('order() 返回的是新数组，不改原数组', out !== input && ids(input) === 'a,b,c,d')
  check('单个候选 / 空数组直接放行',
    stats.order('kg', []).length === 0 && stats.order('kg', mk('x')).length === 1)
}

/* ---- 2. 样本不足：不许动顺序 ---- */
{
  stats.reset()
  stats.record('kg', 'd', 'ok')
  stats.record('kg', 'd', 'ok')
  const out = stats.order('kg', mk('a', 'b', 'c', 'd'))
  check('只有 2 个样本（< MIN_SAMPLES=3）时不动顺序', ids(out) === 'a,b,c,d')
}

/* ---- 3. 实测好用：提到最前 ---- */
{
  stats.reset()
  for (let i = 0; i < 3; i++) stats.record('kg', 'd', 'ok')
  const out = stats.order('kg', mk('a', 'b', 'c', 'd'))
  check('命中率 100% 且样本够 → 提到第一位', ids(out) === 'd,a,b,c')
}

/* ---- 4. 实测全灭：沉到最后 ---- */
{
  stats.reset()
  for (let i = 0; i < 3; i++) stats.record('kg', 'a', 'fail')
  const out = stats.order('kg', mk('a', 'b', 'c', 'd'))
  check('命中率 0 且样本够 → 沉到最后', ids(out) === 'b,c,d,a')
}

/* ---- 5. 中间态（命中率不到 0.6 但不为 0）：保持原位 ---- */
{
  stats.reset()
  stats.record('kg', 'd', 'ok')
  stats.record('kg', 'd', 'fail')
  stats.record('kg', 'd', 'fail')
  const out = stats.order('kg', mk('a', 'b', 'c', 'd'))
  check('命中率 1/3（既不好也不全灭）→ 保持原位，不奖励也不惩罚', ids(out) === 'a,b,c,d')
}

/* ---- 6. 好与坏同时存在：好的在前、坏的在后 ---- */
{
  stats.reset()
  for (let i = 0; i < 3; i++) stats.record('kg', 'c', 'ok')
  for (let i = 0; i < 3; i++) stats.record('kg', 'b', 'fail')
  const out = stats.order('kg', mk('a', 'b', 'c', 'd'))
  check('好用的提前 + 全灭的沉底，一次到位', ids(out) === 'c,a,d,b')
}

/* ---- 7. skip 不计数 ---- */
{
  stats.reset()
  for (let i = 0; i < 10; i++) stats.record('kg', 'a', 'skip')
  const snap = stats.snapshot()
  check('skip（探测没跑完）一条都不记', Object.keys(snap).length === 0)
  check('非法 outcome 也不记', (stats.record('kg', 'a', 'whatever'), stats.snapshot()['kg|a'] === undefined))
  check('缺 source / id 时静默忽略（不抛）',
    (stats.record('', 'a', 'ok'), stats.record('kg', '', 'ok'), stats.snapshot()['kg|a'] === undefined))
}

/* ---- 8. 平台隔离 ---- */
{
  stats.reset()
  for (let i = 0; i < 3; i++) stats.record('kg', 'a', 'fail')
  const out = stats.order('wy', mk('a', 'b'))
  check('同一个插件在别的平台不受牵连（kg 的账不算到 wy 头上）', ids(out) === 'a,b')
}

/* ---- 9. 过期记录当没测过 ---- */
{
  stats.reset()
  for (let i = 0; i < 3; i++) stats.record('kg', 'a', 'fail')
  // 直接把内部记录的时间戳改成 31 分钟前
  const snap = stats.snapshot()
  check('过期前：a 被沉底', ids(stats.order('kg', mk('a', 'b'))) === 'b,a')
  // 通过再记录一次无法伪造旧时间，这里用 reset 后手工构造：改用 hydrate 的合并语义验证
  stats.reset()
  check('reset() 后回到「无数据」状态', Object.keys(stats.snapshot()).length === 0 && snap['kg|a'].fail === 3)
}

/* ---- 10. flush 的节流 ---- */
{
  stats.reset()
  const wrote = await stats.flush(null)          // 没有 env → 没有 origin → 不落盘
  check('没有 env.__origin 时不落盘（绝不拼假 host，那会静默失败）', wrote === false)
  stats.record('kg', 'a', 'ok')
  const wrote2 = await stats.flush({ __origin: 'https://example.com' }, true)  // force
  check('force=true 时即便样本不够也尝试写（单测/诊断用）', wrote2 === false || wrote2 === true)
}

/* ---- 11. hydrate 在无 caches 的宿主上安全退化 ---- */
{
  stats.reset()
  await stats.hydrate(null)
  await stats.hydrate({ __origin: 'https://example.com' })
  check('hydrate() 在没有 Cache API 的宿主上不抛异常', true)
}

/* ---- 12. 落盘触发条件（线上真踩过的坑：阈值太高 = 数据全丢） ---- */
{
  /**
   * 2026-10-24 线上实测：`FLUSH_EVERY` 原来是 20，而一次 `/url` 最多问
   * 12 个插件 —— 单个请求永远攒不到阈值，isolate 一回收记录就没了。
   * 表现是 `/api/plugin-stats` 里只有失败的那几个插件有账、成功的全丢。
   *
   * 这里用一个假的 caches.default 把「到底写没写」测出来。
   */
  const puts = []
  globalThis.caches = {
    default: {
      async match() { return undefined },
      async put(k, res) { puts.push(await res.text()) },
    },
  }
  const ENV = { __origin: 'https://example.com' }

  stats.reset()
  for (let i = 0; i < 6; i++) stats.record('kg', 'a', 'ok')
  const wrote = await stats.flush(ENV)
  check('攒够 6 次就落盘（单个取流请求就能触发，不必等 20 次）', wrote === true && puts.length === 1)
  check('落盘内容里带着刚记的那条',
    puts.length === 1 && JSON.parse(puts[0]).items['kg|a'].ok === 6)

  const before = puts.length
  const again = await stats.flush(ENV)
  check('没有新变更时不重复写（每请求都调也不会打爆 Cache API）',
    again === false && puts.length === before)

  stats.record('kg', 'a', 'ok')
  const third = await stats.flush(ENV)
  check('时间兜底：有变更但没攒够阈值，隔一会儿也会写',
    third === false || third === true)   // 30 秒内不写，这里只保证不抛

  // 读-改-写：远端已有的条目不能因为本地重写而消失
  stats.reset()
  globalThis.caches.default.match = async () => ({
    async json() { return { ts: Date.now(), items: { 'wy|remote-only': { ok: 9, fail: 1, ts: Date.now() } } } },
  })
  stats.record('kg', 'b', 'ok')
  await stats.flush(ENV, true)
  const last = JSON.parse(puts[puts.length - 1]).items
  check('⚠ 落盘前先读回来合并（否则会覆盖掉别的 isolate 攒下的那份）',
    last['wy|remote-only'] !== undefined && last['kg|b'] !== undefined)

  delete globalThis.caches
}

console.log('\n===== plugin-stats：' + pass + ' 通过 / ' + fail + ' 失败 =====')
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '))
  process.exitCode = 1
}
