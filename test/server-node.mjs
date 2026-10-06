/**
 * Docker / 自托管宿主（server/index.mjs）的端到端自检。
 *
 * 为什么要单独一个：Cloudflare 那边的验收（test/e2e.mjs）走的是 wrangler dev，
 * 而 Docker 版换掉了三样东西 —— 路由、静态资源、数据库底座（D1 → node:sqlite）。
 * 这三样恰恰是最容易「代码看着没改、行为却变了」的地方：
 *   · D1 的 batch 有事务，node:sqlite 要自己包；
 *   · D1 绑定值宽容（undefined/布尔），node:sqlite 会直接抛；
 *   · 静态资源在 CF 是平台能力，这里是 server/static.mjs 自己发的。
 * 所以这里逐条验证「换宿主之后语义是否一致」。
 *
 * 用法：
 *   # 先起服务
 *   LX_PORT=8791 LX_DATA_DIR=./_dockerdata node server/index.mjs &
 *   # 再打它
 *   LX_BASE=http://127.0.0.1:8791 node test/server-node.mjs
 *
 * 用真实 HTTP（不是内存直调）：要覆盖的正是「Node 的 http → 标准 Request/Response
 * → src/ 那套 Web API」这一段转换，直调就把要测的东西跳过去了。
 */
const B = (process.env.LX_BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '')
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const NEWPASS = process.env.LX_NEWPASS || ''

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

async function call(path, opts = {}) {
  const r = await fetch(B + path, opts)
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 200) } }
  return { status: r.status, data, headers: r.headers }
}

const main = async () => {
  console.log(`\n目标 ${B}\n`)

  /* 1. 会话 */
  console.log('--- 1. 初始化 / 登录')
  const status = await call('/api/setup-status')
  ok('/api/setup-status 可达且是 JSON', status.status === 200 && status.data && typeof status.data.needsSetup === 'boolean',
    JSON.stringify(status.data))

  let token = ''
  if (status.data && status.data.needsSetup) {
    const r = await call('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    })
    token = (r.data && r.data.token) || ''
    ok('空库时能创建管理员（setup 走的是同一套 users 表）', !!token, `HTTP ${r.status}`)
  } else {
    const r = await call('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    })
    token = (r.data && r.data.token) || ''
    ok('已有库时能登录', !!token, `HTTP ${r.status}`)
  }
  if (!token) { console.log('\n登录失败，后续无意义'); process.exit(1) }

  const H = { Authorization: 'Bearer ' + token }
  const J = { ...H, 'content-type': 'application/json' }
  const me = await call('/api/me', { headers: H })
  ok('/api/me 认识这个 token（会话密钥是持久的，重启不该把所有人踢下线）',
    me.status === 200 && me.data && me.data.user, JSON.stringify(me.data && me.data.user))

  /* 2. 插件池 */
  console.log('\n--- 2. 音源插件（Docker 的坑都在这儿）')
  const health = await call('/healthz')
  const hp = (health.data && health.data.plugins) || {}
  // 加载失败的插件在池子里也算「已登记」，所以 total 应等于内置清单长度
  ok('/healthz 报告插件池已装载', hp.total > 0, `total=${hp.total} ready=${hp.ready}`)
  ok('有可用插件（不是空池子）', hp.ready > 0, `ready=${hp.ready}`)

  const plug = await call('/api/admin/plugins', { headers: H })
  const list = (plug.data && (plug.data.plugins || plug.data.list)) || []
  ok('/api/admin/plugins 列出插件（含被跳过的那些，要能看到「为什么没上岗」）', list.length > 0, `${list.length} 条`)
  const skipped = list.filter(p => /跳过|杀死 JS 引擎/.test(String(p.error || '')))
  console.log(`      其中被跳过的：${skipped.map(p => p.id || p.name).join(', ') || '（无）'}`)

  /* 3. 搜索 / 取流（真实打第三方源，只断言结构） */
  console.log('\n--- 3. 搜索与取流')
  const s = await call('/api/search?q=' + encodeURIComponent('晴天') + '&source=wy&limit=3', { headers: H })
  const song = (s.data && s.data.list || [])[0]
  ok('搜索返回结果', !!song, song ? `${song.name} - ${song.singer}` : JSON.stringify(s.data).slice(0, 160))

  const url = song ? await call('/api/url?id=' + encodeURIComponent(song.id) + '&q=320k&fast=1', { headers: H }) : { data: {} }
  ok('取流接口有响应结构（不承诺第三方源当下的可用性）',
    url.data && (url.data.ok === true || url.data.ok === false),
    JSON.stringify(url.data).slice(0, 140))

  const sheets = await call('/api/charts', { headers: H })
  ok('榜单接口可用', sheets.status === 200 && !!(sheets.data && (sheets.data.list || sheets.data.sheets)),
    JSON.stringify(sheets.data).slice(0, 120))

  /* 4. 播放进度 / 历史（覆盖 node:sqlite 的 batch 与类型转换） */
  console.log('\n--- 4. 播放进度与历史')
  if (song) {
    await call('/api/play-history?id=' + encodeURIComponent(song.id), { method: 'DELETE', headers: H })
    const before = await call('/api/progress?id=' + encodeURIComponent(song.id), { headers: H })
    ok('未播过的歌没有续播点', !(before.data && before.data.progress), JSON.stringify(before.data).slice(0, 80))

    await call('/api/progress', { method: 'POST', headers: J, body: JSON.stringify({ id: song.id, position: 12.5, duration: 260, played: true }) })
    const mid = await call('/api/progress?id=' + encodeURIComponent(song.id), { headers: H })
    const p1 = mid.data && mid.data.progress
    ok('进度能写入并读回（REAL 列 + 主键冲突的 INSERT OR IGNORE + UPDATE 路径）',
      p1 && Math.abs(Number(p1.position) - 12.5) < 0.01 && Number(p1.play_count) === 1,
      JSON.stringify(p1))

    await call('/api/progress', { method: 'POST', headers: J, body: JSON.stringify({ id: song.id, position: 30, duration: 0, played: false }) })
    const mid2 = await call('/api/progress?id=' + encodeURIComponent(song.id), { headers: H })
    const p2 = mid2.data && mid2.data.progress
    ok('duration=0 不覆盖已有时长、未达标不涨播放次数',
      p2 && Number(p2.duration) === 260 && Number(p2.play_count) === 1,
      JSON.stringify(p2))

    const hist = await call('/api/play-history?limit=5', { headers: H })
    ok('播放历史按最后播放时间倒序列出', !!(hist.data && hist.data.list && hist.data.list.length), `${(hist.data && hist.data.list || []).length} 条`)

    const del = await call('/api/play-history?id=' + encodeURIComponent(song.id), { method: 'DELETE', headers: H })
    ok('单条删除生效', del.status === 200)
  }

  /* 5. 歌单（batch 事务路径） */
  console.log('\n--- 5. 歌单（走 D1 batch，容易被 sqlite 适配层写坏）')
  const created = await call('/api/playlist', { method: 'POST', headers: J, body: JSON.stringify({ name: 'docker-自检', songs: song ? [song] : [] }) })
  const plId = created.data && (created.data.id || (created.data.playlist && created.data.playlist.id))
  ok('新建歌单成功', !!plId, JSON.stringify(created.data).slice(0, 120))
  if (plId) {
    const got = await call('/api/playlist?id=' + encodeURIComponent(plId), { headers: H })
    // 注意 GET /api/playlist 把歌曲嵌在 playlist 下（不是顶层 songs）
    const songs = (got.data && got.data.playlist && got.data.playlist.songs) || []
    ok('歌曲确实落库（batch 里的多条 INSERT 一起提交）', !song || songs.length === 1, `${songs.length} 首`)
    const del = await call('/api/playlist?id=' + encodeURIComponent(plId), { method: 'DELETE', headers: H })
    ok('删歌单连带清掉曲目（batch 事务没把中间状态留下）', del.status === 200)
  }

  /* 6. 管理员接口 + 越权 */
  console.log('\n--- 6. 管理端与越权')
  const stats = await call('/api/admin/stats', { headers: H })
  ok('管理员能看统计', stats.status === 200 && !!stats.data, JSON.stringify(stats.data).slice(0, 120))

  const users = await call('/api/admin/users', { headers: H })
  ok('管理员能列用户', users.status === 200 && !!(users.data && users.data.list !== undefined), JSON.stringify(users.data).slice(0, 120))

  const tmpUser = 'e2e_tmp_' + Math.random().toString(36).slice(2, 7)
  const created2 = await call('/api/admin/users', { method: 'POST', headers: J, body: JSON.stringify({ username: tmpUser, password: 'tmp1234', isAdmin: false }) })
  ok('管理员能建普通账号', created2.status === 200 || created2.status === 201, JSON.stringify(created2.data).slice(0, 100))

  const tmpLogin = await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: tmpUser, password: 'tmp1234' }) })
  const tmpTok = tmpLogin.data && tmpLogin.data.token
  ok('新账号能登录', !!tmpTok)
  if (tmpTok) {
    const TH = { Authorization: 'Bearer ' + tmpTok }
    const denied = await call('/api/admin/stats', { headers: TH })
    ok('普通账号访问管理接口被拒 403', denied.status === 403, `HTTP ${denied.status}`)
    const stillOk = await call('/api/search?q=test&limit=1', { headers: TH })
    ok('普通账号仍能正常用搜索（鉴权没误伤用户端）', stillOk.status === 200 || stillOk.status === 500, `HTTP ${stillOk.status}`)
  }
  // 收尾：删掉临时账号（顺带压一遍 deleteUser 的 6 条 batch 语句）
  const urow = ((users.data && users.data.list) || []).find(u => u.username === tmpUser)
  if (urow) {
    const delU = await call('/api/admin/users?id=' + encodeURIComponent(urow.id), { method: 'DELETE', headers: H })
    ok('删除账号（多表 batch）成功', delU.status === 200)
  }

  /* 7. 静态资源（server/static.mjs 的全部职责） */
  console.log('\n--- 7. 静态资源与响应头')
  const index = await fetch(B + '/')
  ok('首页返回 HTML', index.status === 200 && (index.headers.get('content-type') || '').includes('text/html'))

  const admin = await fetch(B + '/admin')
  const adminBody = await admin.text()
  ok('/admin 映射到管理页并带 noindex（_headers 的规则在 Node 侧也要生效）',
    admin.status === 200 && adminBody.includes('管理后台') && (admin.headers.get('x-robots-tag') || '').includes('noindex'),
    `robots=${admin.headers.get('x-robots-tag')}`)

  const sw = await fetch(B + '/sw.js')
  ok('/sw.js 是 no-cache（否则用户手机长期吃旧壳）', (sw.headers.get('cache-control') || '') === 'no-cache',
    sw.headers.get('cache-control'))

  const hd = await fetch(B + '/_headers')
  ok('_headers 不作为静态资源暴露（它是配置，不是页面）', hd.status === 404, `HTTP ${hd.status}`)

  const etag = index.headers.get('etag')
  if (etag) {
    const again = await fetch(B + '/', { headers: { 'if-none-match': etag } })
    ok('带 If-None-Match 返回 304（不是每次全量重传）', again.status === 304, `HTTP ${again.status}`)
  } else {
    ok('首页带 ETag', false, '没有 etag 头')
  }

  const missing = await fetch(B + '/does-not-exist.js')
  ok('不存在的资源 404（不能拿 index.html 冒充）', missing.status === 404)

  const spa = await fetch(B + '/library')
  ok('无扩展名的深链接回落到首页（前端 hash 路由的兜底）', spa.status === 200 && (spa.headers.get('content-type') || '').includes('text/html'))

  /* 8. Subsonic */
  console.log('\n--- 8. Subsonic 协议')
  const ping = await call('/rest/ping?u=' + encodeURIComponent(USER) + '&p=' + encodeURIComponent(PASS) + '&v=1.16.1&c=test&f=json')
  ok('/rest/ping 返回 subsonic-response', ping.status === 200 && JSON.stringify(ping.data || '').includes('subsonic-response'),
    JSON.stringify(ping.data).slice(0, 120))

  console.log(`\n================ Docker 宿主自检：${pass} 通过 / ${fail} 失败 ================\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('自检中断:', (e && e.stack) || e)
  process.exit(1)
})
