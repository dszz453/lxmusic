/** 线上验收：/api/url?fast=1 的三件事 —— 协议升级、并发探测、体积降序 */
const BASE = 'https://music.zyplnn.dpdns.org'
const PASS = process.env.LX_PASS || 'Zyp200709+'

const j = async (p, opt) => {
  const r = await fetch(BASE + p, opt)
  const t = await r.text()
  try { return { st: r.status, d: JSON.parse(t) } } catch { return { st: r.status, d: t.slice(0, 300) } }
}

// 登录拿 token
let token = ''
{
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  })
  const d = await r.json().catch(() => ({}))
  token = d.token || (d.data && d.data.token) || ''
  console.log('登录:', r.status, token ? 'token ok' : JSON.stringify(d).slice(0, 200))
}

for (const kw of ['告白气球', '晴天', '稻香']) {
  console.log(`\n======== ${kw} ========`)
  const s = await j('/api/search?q=' + encodeURIComponent(kw) + '&limit=12', { headers: { Authorization: 'Bearer ' + token } })
  const list = (s.d && (s.d.list || (s.d.data && s.d.data.list))) || []
  console.log('  搜索结果:', s.st, list.length, '首')
  for (const src of ['wy', 'kw', 'kg']) {
    const song = list.find(x => x.source === src)
    if (!song) { console.log(`  ${src}: 无`); continue }
    const u = await j('/api/url?id=' + encodeURIComponent(song.id) + '&q=320k&fast=1', { headers: { Authorization: 'Bearer ' + token } })
    const d = u.d || {}
    const urls = d.urls || []
    console.log(`  ${src} ${song.name}/${song.singer} → st=${u.st} ok=${d.ok} 候选${urls.length}条 verified=${d.verified}`)
    for (const x of urls) {
      const https = /^https:/i.test(x.url)
      console.log(`     ${https ? 'https' : 'http '} ${(x.size / 1048576).toFixed(2)}MB [${x.from}] ${x.url.slice(0, 95)}`)
    }
    if (d.error) console.log('     err:', d.error)
  }
}
