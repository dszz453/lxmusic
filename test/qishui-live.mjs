/**
 * 歌单导入的**联网**验收：网易 / 汽水分享链接走完整条链路。
 *
 * 与 test/import-ref.test.mjs 的分工：
 *   import-ref.test.mjs —— 纯离线，只验「认得出 / 解得开字符串」。
 *   本文件            —— 真发请求，验「链接真的能解析成歌单、失效链接真的被认出来」。
 * 两边都要留着：离线那条保证解析逻辑可复现，这条保证上游没把结构改了。
 *
 * ⚠️ 这个文件依赖**外部链接仍然有效**：
 *   汽水短链是公开分享码，实测（2026-10-05）可用；失效时这一组会红，
 *   请去汽水 App 里换一条新的歌单分享链接，把 QISHUI_LIVE 换掉即可。
 *   网易那个短链是老板给的失效样例，**故意**留着验「失效能被认出来」，别删。
 *
 * 用法：node test/qishui-live.mjs
 *   LX_BASE=http://127.0.0.1:8787   加上这段就跑接口级验收（需要 dev server + 已建管理员）
 */
import { resolvePlaylistRef, importPlaylist, parsePlaylistRef } from '../src/providers/index.js'

const BASE = process.env.LX_BASE || ''
const USER = process.env.LX_USER || 'admin'
const PASS = process.env.LX_PASS || 'LxMusic@2026'

// 实测有效的汽水歌单分享短链（musicdl 文档里给的样例，歌单名 "test"）
const QISHUI_LIVE = process.env.QS_LIVE || 'https://qishui.douyin.com/s/ix9JA2oW'
// 老板给的两条**已失效**链接，留作「失效识别」的对照
const QISHUI_DEAD = 'https://qishui.douyin.com/s/iFwvEYVA/'
const NETEASE_DEAD = 'https://163cn.tv/KYUDUJAZ'
// 汽水单曲分享（合法链接，但不是歌单）
const QISHUI_TRACK = 'https://qishui.douyin.com/s/iXxJcC99/'
// 网易云经典歌单链接（长期有效：热歌榜）
const NETEASE_LIVE = 'https://music.163.com/#/playlist?id=3778678'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✅ ' + name + (extra ? '  → ' + extra : '')) }
  else { fail++; console.log('❌ ' + name + (extra ? '  → ' + extra : '')) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

console.log('\n--- 1. 网易云：经典链接直接导入（可播）')
try {
  const ref = await resolvePlaylistRef(NETEASE_LIVE)
  ok('解析出 wy:3778678', !!ref && ref.source === 'wy' && ref.id === '3778678', JSON.stringify(ref))
  const data = await importPlaylist(ref)
  ok('拿到歌单名与曲目', !!data.name && data.songs.length > 10, data.name + ' · ' + data.songs.length + ' 首')
  ok('曲目带可播的 wy id', data.songs.slice(0, 3).every(s => s.source === 'wy' && /^\d+$/.test(String(s.sourceId || s.id || ''))),
    JSON.stringify(data.songs[0]).slice(0, 160))
} catch (e) {
  ok('网易云经典链接导入', false, String(e && e.message || e))
}

console.log('\n--- 2. 汽水音乐：分享短链 → 歌单 → 曲目清单')
let qsPage = null
try {
  const ref = await resolvePlaylistRef(QISHUI_LIVE)
  ok('短链展开成 playlist_id（不再是短码）',
    !!ref && ref.source === 'qs' && /^\d{10,}$/.test(ref.id) && ref.kind === 'playlist',
    JSON.stringify(ref))
  if (ref && /^\d+$/.test(ref.id)) {
    qsPage = await importPlaylist(ref)
    ok('读到歌单名', !!qsPage.name, qsPage.name)
    ok('读到曲目', qsPage.songs.length > 0, qsPage.songs.length + ' 首')
    ok('每首都有歌名 + 歌手', qsPage.songs.every(s => s.name && s.singer),
      qsPage.songs.map(s => s.name + ' - ' + s.singer).join(' | '))
    ok('标了 matchNeeded（需逐首去现有音源匹配）', qsPage.matchNeeded === true)
    ok('歌单封面可用', /^https:\/\//.test(qsPage.cover), qsPage.cover.slice(0, 90))
  }
} catch (e) {
  ok('汽水短链 → 歌单', false, String(e && e.message || e))
}

console.log('\n--- 3. 失效链接要给出「过期」而不是「解析失败」')
try {
  const dead = await resolvePlaylistRef(QISHUI_DEAD)
  ok('失效汽水短链被标成 expandFailed', !!dead && dead.expandFailed === true, JSON.stringify(dead && { s: dead.source, id: dead.id, failed: dead.expandFailed }))
} catch (e) {
  ok('失效汽水短链处理未抛异常', false, String(e && e.message || e))
}
try {
  const dead2 = await resolvePlaylistRef(NETEASE_DEAD)
  ok('失效网易短链被标成 expandFailed', !!dead2 && dead2.expandFailed === true, JSON.stringify(dead2 && { s: dead2.source, id: dead2.id, failed: dead2.expandFailed }))
} catch (e) {
  ok('失效网易短链处理未抛异常', false, String(e && e.message || e))
}

console.log('\n--- 4. 汽水「单曲」分享要拒绝得清楚（别让人以为导入成功了）')
try {
  const ref = await resolvePlaylistRef(QISHUI_TRACK)
  ok('单曲短链展开后 kind=track', !!ref && ref.kind === 'track', JSON.stringify(ref && { id: ref.id, kind: ref.kind }))
  await importPlaylist(ref)
  ok('单曲链接应当被拒绝', false, '居然没报错')
} catch (e) {
  const msg = String(e && e.message || e)
  ok('单曲链接被拒绝且说明了原因', /不是歌单/.test(msg), msg)
}

console.log('\n--- 5. 未经展开的纯字符串不该被当成歌单（防止回归成「静默成功」）')
{
  const raw = parsePlaylistRef(QISHUI_DEAD)
  ok('同步解析只给短码、标 short（不假装知道 id）',
    !!raw && raw.source === 'qs' && raw.id === 'iFwvEYVA' && raw.short === true, JSON.stringify(raw))
}

if (BASE) {
  console.log('\n--- 6. 接口级：POST /playlist/import（' + BASE + '）')
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  }).then(r => r.json()).catch(() => null)
  const token = login && login.token
  if (!token) {
    ok('登录拿 token（后续接口用例的前置条件）', false, '登录失败，先确认 dev server 与管理员账号')
  } else {
    const api = async (p, opts = {}) => {
      const headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {})
      let body = opts.body
      if (body && typeof body !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(body) }
      const res = await fetch(BASE + '/api' + p, { method: opts.method || 'GET', headers, body })
      return { status: res.status, data: await res.json().catch(() => null) }
    }

    const qsRes = await api('/playlist/import', { method: 'POST', body: { url: QISHUI_LIVE } })
    ok('汽水导入返回 matchNeeded 且**不落库**（避免存进一个放不出声的歌单）',
      qsRes.data && qsRes.data.matchNeeded === true && !qsRes.data.playlist,
      JSON.stringify(qsRes.data && { matchNeeded: qsRes.data.matchNeeded, total: qsRes.data.total, name: qsRes.data.name }))
    ok('返回的曲目只有歌名/歌手（没有假的音源 id）',
      qsRes.data && (qsRes.data.songs || []).every(s => s.name && !s.source && !s.sourceId),
      JSON.stringify((qsRes.data && qsRes.data.songs || []).slice(0, 2)))

    const deadRes = await api('/playlist/import', { method: 'POST', body: { url: NETEASE_DEAD } })
    ok('失效短链返回 400 且提示「过期」', deadRes.status === 400 && /过期/.test(String(deadRes.data && deadRes.data.error)),
      deadRes.status + ' ' + JSON.stringify(deadRes.data))

    // 单曲链接是**输入问题**，必须是 400 而不是 500 —— 500 会让前端和用户都以为服务器坏了
    const trackRes = await api('/playlist/import', { method: 'POST', body: { url: QISHUI_TRACK } })
    ok('汽水单曲链接返回 400（不是 500）且说明原因',
      trackRes.status === 400 && /不是歌单/.test(String(trackRes.data && trackRes.data.error)),
      trackRes.status + ' ' + JSON.stringify(trackRes.data))

    const wyRes = await api('/playlist/import', { method: 'POST', body: { url: NETEASE_LIVE, name: '验收·网易导入' } })
    ok('网易导入直接建出歌单', wyRes.data && wyRes.data.ok === true && wyRes.data.playlist && wyRes.data.total > 10,
      JSON.stringify(wyRes.data && { total: wyRes.data.total, id: wyRes.data.playlist && wyRes.data.playlist.id }))
    if (wyRes.data && wyRes.data.playlist) {
      await sleep(600)
      const del = await api('/playlist?id=' + wyRes.data.playlist.id, { method: 'DELETE' })
      ok('验收歌单已删除', del.data && del.data.ok === true, JSON.stringify(del.data))
    }
  }
} else {
  console.log('\n（跳过接口级验收：没给 LX_BASE）')
}

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
if (fail) console.log('红色项先看清楚是「上游变了」还是「网络抖动」，别直接重跑掩盖。')
process.exit(fail ? 1 : 0)
