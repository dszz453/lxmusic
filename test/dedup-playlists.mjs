// 清理线上 D1 里重复的测试歌单：同名歌单只保留创建时间最新的一个
// 用法：node test/dedup-playlists.mjs [--dry]
const BASE = 'https://music.zyplnn.dpdns.org'
const AUTH = 'v=1.16.1&c=lx&u=admin&p=' + encodeURIComponent(process.env.LX_PASS || '')
const DRY = process.argv.includes('--dry')

const get = async (path) => {
  const r = await fetch(`${BASE}/rest/${path}${path.includes('?') ? '&' : '?'}${AUTH}&f=json`)
  return r.json()
}

const j = await get('getPlaylists.view')
const list = j['subsonic-response']?.playlists?.playlist || []
console.log(`线上共 ${list.length} 个歌单`)

// 按名字分组，组内按 created 降序，保留第一个
const groups = new Map()
for (const p of list) {
  if (!groups.has(p.name)) groups.set(p.name, [])
  groups.get(p.name).push(p)
}

const doomed = []
for (const [name, arr] of groups) {
  arr.sort((a, b) => String(b.created).localeCompare(String(a.created)))
  const keep = arr[0]
  console.log(`\n【${name}】共 ${arr.length} 个 → 保留 ${keep.id} (${keep.created})`)
  for (const p of arr.slice(1)) {
    console.log(`   删除 ${p.id} (${p.created})`)
    doomed.push(p)
  }
}

if (!doomed.length) {
  console.log('\n没有重复歌单，无需清理')
  process.exit(0)
}
if (DRY) {
  console.log(`\n[--dry] 待删除 ${doomed.length} 个，未实际执行`)
  process.exit(0)
}

let ok = 0, fail = 0
for (const p of doomed) {
  const r = await fetch(`${BASE}/rest/deletePlaylist.view?${AUTH}&id=${encodeURIComponent(p.id)}&f=json`)
  const t = await r.text()
  let status = ''
  try { status = JSON.parse(t)['subsonic-response']?.status } catch { status = t.slice(0, 120) }
  if (status === 'ok') { ok++; console.log(`OK   删除 ${p.id}  ${p.name}`) }
  else { fail++; console.log(`FAIL ${p.id}  ${p.name} -> ${status}`) }
}

console.log(`\n完成：成功 ${ok} / 失败 ${fail}`)
const after = await get('getPlaylists.view')
const rest = after['subsonic-response']?.playlists?.playlist || []
console.log(`清理后剩余 ${rest.length} 个歌单：`)
for (const p of rest) console.log(`  ${p.id}  ${p.name}  ${p.songCount} 首  ${p.created}`)
