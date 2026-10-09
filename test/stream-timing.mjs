/** 代理取流分段计时：定位 19~38 秒起播到底耗在哪 */
const BASE = 'https://music.zyplnn.dpdns.org'
const PASS = process.env.LX_PASS || ''
if (!PASS) console.warn('[warn] 未设置 LX_PASS，需要登录的接口会 401')

const tok = (await (await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASS }),
})).json()).token

const auth = { Authorization: 'Bearer ' + tok }

async function timed(label, path, extraHeaders = {}) {
  const t0 = Date.now()
  const r = await fetch(BASE + path, { headers: { ...auth, ...extraHeaders } })
  const ms = Date.now() - t0
  const from = r.headers.get('x-resolved-from') || '-'
  let note = ''
  if (!r.headers.get('content-type')?.startsWith('audio')) {
    note = (await r.text()).slice(0, 200)
  } else {
    try { await r.body.cancel() } catch {}
  }
  console.log(`${String(ms).padStart(6)}ms  ${label}  st=${r.status} from=${from}  ${note}`)
  return ms
}

const KEY = process.argv[2] || '告白气球'
const s = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent(KEY) + '&limit=12', { headers: auth })).json()

for (const src of ['kg', 'wy', 'kw', 'tx']) {
  const song = (s.list || []).find(x => x.source === src)
  if (!song) { console.log(`\n### ${src}: 无搜索结果`); continue }
  console.log(`\n### ${src}  ${song.name}/${song.singer}`)
  // 1) 直连候选解析+探测
  const t0 = Date.now()
  const u = await (await fetch(BASE + '/api/url?id=' + encodeURIComponent(song.id) + '&q=320k&fast=1', { headers: auth })).json()
  console.log(`  /api/url?fast=1  ${Date.now() - t0}ms  verified=${u.verified} 候选=${(u.urls || []).length}`)
  // 2) 代理首帧
  await timed('  /api/stream (首次)', '/api/stream?id=' + encodeURIComponent(song.id) + '&q=320k', { Range: 'bytes=0-' })
  // 3) 代理二次（带 Range 跳过预筛）
  await timed('  /api/stream (Range)', '/api/stream?id=' + encodeURIComponent(song.id) + '&q=320k', { Range: 'bytes=100000-' })
}
