/**
 * 插件调度顺序的回归测试（纯逻辑，不联网）。
 *
 * 覆盖 tools/plugin-score.mjs 生成排序表之后，「先试哪个插件」这套决策：
 *   自动模式  —— 按实测评分降序，未上榜的按注册顺序垫后
 *   人工模式  —— 用户排过的按用户顺序，**没排到的按实测评分垫后**（不是注册顺序）
 *   停用      —— 两种模式下都生效
 *
 * 中间那条是踩过坑的：一开始人工模式未排到的插件落回注册顺序，于是用户一切到
 * 人工模式，他没动过的那十几个插件顺序整体重排一遍，看起来像设置被重置了。
 * 跑：node --test test/plugin-rank.test.mjs
 */
import { PluginPool } from '../src/lib/lxruntime.js'

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      got=${a}\n      exp=${e}`)
}

/** 造一个池子：注册顺序 a,b,c,d,e；实测排名 c,a,e（b/d 未上榜） */
function mkPool() {
  const pool = new PluginPool()
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    pool.add({ ok: true, id, meta: { name: id }, sources: { wy: { actions: ['musicUrl'] } } })
  }
  pool.setRank({ wy: ['c', 'a', 'e'] })
  return pool
}
const ids = (pool) => pool.musicUrlPlugins('wy').map(p => p.id)

/* ---- 自动模式 ---- */
{
  const pool = mkPool()
  check('未装载偏好时按实测评分，未上榜的按注册顺序垫后',
    ids(pool), ['c', 'a', 'e', 'b', 'd'])
  check('显式 auto 模式同上',
    (pool.setUserPrefs({ mode: 'auto' }), ids(pool)), ['c', 'a', 'e', 'b', 'd'])
}

/* ---- 人工模式 ---- */
{
  const pool = mkPool()
  pool.setUserPrefs({ mode: 'manual', order: { wy: ['d'] } })
  check('人工模式：d 排第一，其余按实测评分垫后（不是注册顺序）',
    ids(pool), ['d', 'c', 'a', 'e', 'b'])

  pool.setUserPrefs({ mode: 'manual', order: { wy: ['e', 'b', 'd'] } })
  check('人工模式：按用户给的完整顺序，剩下的按评分垫后',
    ids(pool), ['e', 'b', 'd', 'c', 'a'])

  pool.setUserPrefs({ mode: 'auto', order: { wy: ['d'] } })
  check('切回自动模式后，之前排的顺序不再生效',
    ids(pool), ['c', 'a', 'e', 'b', 'd'])

  pool.setUserPrefs({ mode: 'manual', order: { kg: ['d'] } })
  check('人工顺序是按平台各存各的，排了 kg 不影响 wy',
    ids(pool), ['c', 'a', 'e', 'b', 'd'])
}

/* ---- 停用 ---- */
{
  const pool = mkPool()
  check('停用 c 后它从候选里消失，其余顺序不变',
    (pool.setUserPrefs({ mode: 'auto', disabled: ['c'] }), ids(pool)), ['a', 'e', 'b', 'd'])

  pool.setUserPrefs({ mode: 'manual', order: { wy: ['d'] }, disabled: ['c'] })
  check('人工模式 + 停用同时生效',
    ids(pool), ['d', 'a', 'e', 'b'])

  pool.setUserPrefs({ mode: 'manual', order: { wy: ['d'] }, disabled: ['d'] })
  check('停用的插件即使被排过也不出现',
    (pool.setUserPrefs({ mode: 'manual', order: { wy: ['d'] } }), ids(pool)), ['d', 'c', 'a', 'e', 'b'])
}

/* ---- 脏数据 ---- */
{
  const pool = mkPool()
  pool.setUserPrefs({ mode: 'manual', order: { wy: ['不存在的插件', 'd'] } })
  check('人工顺序里的未知 id 不影响其余插件（该平台无 rank 命中时按评分垫后）',
    ids(pool), ['d', 'c', 'a', 'e', 'b'])

  pool.setUserPrefs(null)
  check('偏好被清空后退回纯实测排序',
    ids(pool), ['c', 'a', 'e', 'b', 'd'])

  const empty = new PluginPool()
  check('空池子不报错', (empty.setUserPrefs({ mode: 'manual', order: { wy: ['x'] } }), ids(empty)), [])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
