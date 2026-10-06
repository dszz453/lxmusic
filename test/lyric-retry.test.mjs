/**
 * retryUntil：按「内容是否合格」重试
 *
 * 背景：酷我歌词接口约一半的请求会返回 HTTP 200 + `{"data":null,"msg":"音乐查询失败"}`。
 * request() 自带的 retry 只在抛异常时重试，抓不住「成功但空手」，
 * 所以抽了 retryUntil 按内容判定。这里用假取数器把它钉死 —— 不能靠
 * 「真实接口多打几次看概率」，那种测试本身就是 50% 抛硬币。
 */
import { retryUntil } from '../src/lib/http.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')) }
}
const noWait = { wait: () => Promise.resolve() }

/* 1. 一次就合格 → 只该调一次，不该有多余往返 */
{
  let calls = 0
  const r = await retryUntil(async () => { calls++; return ['x'] }, (v) => Array.isArray(v) && v.length > 0, noWait)
  ok('一次成功时不重复请求', calls === 1 && r && r[0] === 'x', 'calls=' + calls)
}

/* 2. 前 3 次空、第 4 次拿到 → 必须返回结果 */
{
  let calls = 0
  const r = await retryUntil(async () => {
    calls++
    return calls === 4 ? [{ line: 'a' }] : null
  }, (v) => Array.isArray(v) && v.length > 0, noWait)
  ok('第 4 次拿到内容时返回结果', calls === 4 && r && r[0].line === 'a', 'calls=' + calls)
}

/* 3. 全程空手 → 返回 null，且调用次数正好用完 attempts */
{
  let calls = 0
  const r = await retryUntil(async () => { calls++; return { data: null } }, (v) => Array.isArray(v) && v.length > 0, noWait)
  ok('全程空手返回 null', r === null, 'r=' + JSON.stringify(r))
  ok('默认最多重试 4 次', calls === 4, 'calls=' + calls)
}

/* 4. 抛异常等价于一次失败，异常绝不能漏出去 */
{
  let calls = 0
  let threw = ''
  let r = 'unset'
  try {
    r = await retryUntil(async () => { calls++; throw new Error('boom') }, (v) => v !== null, noWait)
  } catch (e) { threw = String(e.message) }
  ok('取数器抛异常不会外泄', threw === '' && r === null, 'threw=' + threw)
  ok('抛异常也计入重试次数', calls === 4, 'calls=' + calls)
}

/* 5. 「有值但不合格」必须继续重试（这是酷我的真实形态：data 为 null） */
{
  let calls = 0
  const r = await retryUntil(
    async () => { calls++; return calls < 3 ? { data: null } : { data: { lrclist: [1, 2] } } },
    (v) => !!(v && v.data && v.data.lrclist && v.data.lrclist.length),
    noWait
  )
  ok('有值但不合格时继续重试', calls === 3 && r && r.data.lrclist.length === 2, 'calls=' + calls)
}

/* 6. attempts 可调；attempts=1 时就是「只试一次」 */
{
  let calls = 0
  await retryUntil(async () => { calls++; return null }, () => false, { ...noWait, attempts: 1 })
  ok('attempts=1 时只请求一次', calls === 1, 'calls=' + calls)
}

/* 7. 退避是递增的（150 / 270 / 390…），别把上游打得更糟 */
{
  const waits = []
  await retryUntil(async () => null, () => false, { attempts: 4, wait: (ms) => { waits.push(ms); return Promise.resolve() } })
  ok('退避递增且只在失败后发生', waits.length === 3 && waits[0] === 150 && waits[1] === 270 && waits[2] === 390,
    waits.join('/'))
}

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
process.exit(fail ? 1 : 0)
