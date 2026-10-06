/**
 * 插件评分真机验收：自动排期 + 手动触发，在真实容器里跑一整轮。
 *
 * 为什么单独有这么一个（而不是并进 server-node.mjs）：
 * server-node.mjs 是**秒级**的接口自检，而这里要**真跑一轮评分**——
 * 子进程会挨个打各音乐平台，实测 170~210 秒。两件事的耗时差三个数量级，
 * 混在一起会让日常自检慢到没人愿意跑，最后等于没有。
 *
 * 用法（在容器里跑，因为要直接读 /data/lxmusic.db 拿管理员口令）：
 *   docker exec -e PW=你的管理密码 lxmusic node --experimental-sqlite /tmp/rescore-docker.mjs
 * 不传 PW 时会自己从库里读一个管理员密码 —— 仅因为这是**测试**，
 * 生产脚本绝不该这么干。
 *
 * 验收要点（顺序即真实契约）：
 *   1. 自动排期生效（intervalMs > 0，来自 LX_SCORE_INTERVAL，compose 默认 1d）
 *   2. POST 立即返回 202（受理即返回，不是同步等完 —— 一轮要几分钟）
 *   3. 轮询能看到 running 翻转、rounds 递增
 *   4. 跑完后 lastOk / lastTrigger / lastElapsedMs 都对
 *   5. 结果落库并**改变取流顺序**：meta.source 从 build 变 runtime
 *   6. 状态跨请求可见（healthz.last、管理接口 rescore.last）
 *
 * ⚠️ 断言只落在「不变量」和「相对变化」上。
 * 第一版假设了「开始时 rounds=0、来源还是 build」，真机上直接红了两条 ——
 * 因为容器启动后自动排期可能已经跑过一轮，前置状态不由测试说了算。
 */
import { DatabaseSync } from 'node:sqlite'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const PW = process.env.PW || ''

const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts)
  const t = await r.text()
  let v = null
  try { v = JSON.parse(t) } catch { v = { __raw: t.slice(0, 200) } }
  return { status: r.status, v }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const main = async () => {
  // 0. 从库里读一个管理员口令才能登录（容器里没别的办法；生产上这是你自己的密码）
  let user = 'admin', pw = PW
  if (!pw) {
    try {
      const db = new DatabaseSync('/data/lxmusic.db')
      const row = db.prepare('SELECT username, password FROM users WHERE is_admin = 1').get()
      if (row) { user = row.username; pw = row.password }
    } catch (e) { console.log('读库失败：', e.message) }
  }
  if (!pw) { console.log('!! 没有管理员口令，无法继续'); process.exit(2) }

  const login = await j('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pw }),
  })
  check('管理员能登录', login.status === 200 && !!login.v.token, 'status=' + login.status)
  const H = { authorization: 'Bearer ' + login.v.token }

  // 1. 触发前：应处于「已排期、未在跑」
  //
  // ⚠️ 这里**不假设 rounds 从 0 开始、也不假设评分来源还是构建期**。
  // 第一版就是那么断言的，结果在真机上红了两条 —— 因为容器启动后
  // 自动排期可能已经跑过一轮（本次实测就是这样），前置状态根本不由测试说了算。
  // 断言要落在「不变量」上：能读到状态、当前没在跑；以及关键的**相对变化**
  // （rounds 会涨、来源会变成 runtime），那才是真正要验证的行为。
  const before = await j('/healthz')
  const rb = before.v.rescore || {}
  check('自动排期已生效（intervalMs > 0）', rb.intervalMs > 0, 'intervalText=' + rb.intervalText)
  check('触发前没有在跑', rb.running === false, 'running=' + rb.running)
  const roundsBefore = rb.rounds || 0
  console.log(`   （本轮开始时 rounds=${roundsBefore}，来源=${
    ((await j('/api/admin/plugin-scores', { headers: H })).v.meta || {}).source
  }）`)

  // 2. 手动触发：契约是 202 受理（不是 200 同步完成）
  const t0 = Date.now()
  const kick = await j('/api/admin/plugin-rescore', { method: 'POST', headers: H })
  check('手动触发被受理（202）', kick.status === 202,
    'status=' + kick.status + ' accepted=' + kick.v.accepted)

  // 3. 轮询到结束 —— 上限放宽到 8 分钟（真实一轮要几分钟）
  let rounds = 0, snap = null
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(5000)
    const r = await j('/api/admin/plugin-rescore', { headers: H })
    snap = r.v.status || {}
    const live = snap.live || {}
    if (rounds !== live.rounds) {
      rounds = live.rounds
      console.log(`   … 轮次 ${rounds}，running=${live.running}，已过 ${Math.round((Date.now() - t0) / 1000)}s`)
    }
    // rounds 从 0 涨到 1 且不在跑了 = 这一轮结束
    if (live.rounds >= 1 && !live.running) break
  }

  const live = (snap && snap.live) || {}
  check('手动触发真的跑完了一轮', live.rounds > roundsBefore,
    `${roundsBefore} → ${live.rounds}`)
  check('这轮标记为 manual 触发', live.lastTrigger === 'manual', 'lastTrigger=' + live.lastTrigger)
  check('这轮成功了', live.lastOk === true,
    'lastOk=' + live.lastOk + (live.lastError ? ' err=' + live.lastError : ''))
  check('记录了耗时', typeof live.lastElapsedMs === 'number' && live.lastElapsedMs > 0,
    Math.round((live.lastElapsedMs || 0) / 1000) + 's')

  // 4. 结果落库并生效：meta.source 应是 runtime
  const after = await j('/api/admin/plugin-scores', { headers: H })
  const metaAfter = after.v.meta || {}
  check('评分来源是运行时实测', metaAfter.source === 'runtime', 'source=' + metaAfter.source)
  check('有了新的评分时间', !!metaAfter.generatedAt, 'generatedAt=' + metaAfter.generatedAt)
  check('按平台给出了新排序', Object.keys(after.v.byPlatform || {}).length > 0,
    '平台=' + Object.keys(after.v.byPlatform || {}).join('/'))

  // 5. 状态可见且跨重启 —— 这一条抓的就是「live 有值但 last 空」那个 bug。
  //    注意 last 走的是 2 秒 TTL 缓存（见 server/index.mjs），所以这里等一会儿再读，
  //    否则读到的是缓存里那份 null，会在修好之后继续假红。
  await sleep(2500)
  const h2 = await j('/healthz')
  const last = (h2.v.rescore || {}).last
  check('状态跨请求可见（healthz.last 有值）', !!last,
    last ? 'trigger=' + last.lastTrigger + ' ok=' + last.lastOk + ' rounds=' + last.rounds : '(空)')

  const sc = await j('/api/admin/plugin-scores', { headers: H })
  const last2 = (sc.v.rescore || {}).last
  check('状态跨请求可见（管理接口 rescore.last 有值）', !!last2,
    last2 ? 'trigger=' + last2.lastTrigger : '(空)')

  const ok = results.filter(r => r.ok).length
  console.log(`\n=== ${ok}/${results.length} 通过 ===`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
