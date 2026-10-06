/**
 * 歌单链接解析与汽水页解析的纯单测（不发网络请求）。
 *
 * 覆盖两处本轮新增的能力：
 *   1. parsePlaylistRef —— 认得出网易分享短链（163cn.tv）与汽水（短链 / 落地页），
 *      以及从整段分享文案里抠链接（手机上复制出来的就是带文案的一整段）。
 *   2. qishui.js 的 SSR 解析 —— 括号配平取 _ROUTER_DATA、字段映射、封面模板。
 *
 * 真联网的那部分在 test/qishui-live.mjs，分开跑：
 * 这里的每一条都必须离线可复现，否则「解析坏了」和「今天网络不好」分不开。
 *
 * 用法：node test/import-ref.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlaylistRef } from '../src/providers/index.js'
import { matchQishuiShort, matchDouyinShare, extractRouterData, parseQishuiPlaylistPage, douyinCover } from '../src/providers/qishui.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✅ ' + name + (extra ? '  → ' + extra : '')) }
  else { fail++; console.log('❌ ' + name + (extra ? '  → ' + extra : '')) }
}

/* ==================== 1. 各平台链接的识别 ==================== */
console.log('\n--- 1. 链接识别（parsePlaylistRef，离线）')

const cases = [
  // [输入, 期望 source, 期望 id, 期望 short]
  ['https://music.163.com/#/playlist?id=3778678', 'wy', '3778678', false],
  ['https://music.163.com/playlist?id=3778678&userid=1', 'wy', '3778678', false],
  ['https://163cn.tv/KYUDUJAZ', 'wy', 'KYUDUJAZ', true],
  ['https://163cn.tv/AbCdEf?from=wx', 'wy', 'AbCdEf', true],
  ['https://qishui.douyin.com/s/ix9JA2oW/', 'qs', 'ix9JA2oW', true],
  ['https://qishui.douyin.com/s/ix9JA2oW', 'qs', 'ix9JA2oW', true],
  ['https://music.douyin.com/qishui/share/playlist?playlist_id=7629573360581656610&sec_sharer_id=x', 'qs', '7629573360581656610', false],
  ['https://www.kugou.com/yy/special/single/519669.html', 'kg', '519669', false],
  ['https://www.kuwo.cn/playlist_detail/2787295395', 'kw', '2787295395', false],
  ['https://y.qq.com/n/ryqq/playlist/7011264340', 'tx', '7011264340', false],
  ['kg:519669', 'kg', '519669', false],
  ['3778678', 'wy', '3778678', false],
]
for (const [input, source, id, short] of cases) {
  const r = parsePlaylistRef(input)
  ok('识别 ' + input.slice(0, 62),
    !!r && r.source === source && r.id === id && !!r.short === short,
    r ? `${r.source}:${r.id}${r.short ? ' (short)' : ''}` : 'null')
}

/* ==================== 2. 分享文案里抠链接 ==================== */
console.log('\n--- 2. 整段分享文案（手机上复制出来的形态）')

const clipQishui = '分享一首歌给你:屋顶 - 宿涵/周杰伦/张神儿 https://qishui.douyin.com/s/ix9JA2oW/ 复制此链接打开汽水音乐'
const rq = parsePlaylistRef(clipQishui)
ok('从汽水分享文案里认出链接', !!rq && rq.source === 'qs' && rq.id === 'ix9JA2oW',
  rq ? `${rq.source}:${rq.id}` : 'null')

const clipWy = '分享歌单「我喜欢的音乐」 https://163cn.tv/KYUDUJAZ （来自网易云音乐）'
const rw = parsePlaylistRef(clipWy)
ok('从网易分享文案里认出短链', !!rw && rw.source === 'wy' && rw.id === 'KYUDUJAZ' && rw.short === true,
  rw ? `${rw.source}:${rw.id}` : 'null')

/* ==================== 3. 单曲 / 视频分享要认出来但不当歌单 ==================== */
console.log('\n--- 3. 汽水单曲 / 视频链接（是合法链接，但不是歌单）')

const rt = parsePlaylistRef('https://qishui.douyin.com/s/iXxJcC99/')
ok('汽水单曲短链被识别为 qs（不报「无法识别」）', !!rt && rt.source === 'qs', rt ? rt.id : 'null')

const rtrack = parsePlaylistRef('https://music.douyin.com/qishui/share/track?track_id=7681510072551770139')
ok('汽水单曲落地页标了 kind=track', !!rtrack && rtrack.source === 'qs' && rtrack.kind === 'track' && rtrack.id === '7681510072551770139',
  JSON.stringify(rtrack))

const rvideo = parsePlaylistRef('https://music.douyin.com/qishui/share/ugc_video?ugc_video_id=7573178830975479451')
ok('汽水视频落地页标了 kind=video', !!rvideo && rvideo.source === 'qs' && rvideo.kind === 'video', JSON.stringify(rvideo))

/* ==================== 4. 边界 ==================== */
console.log('\n--- 4. 边界情况')

ok('空串返回 null', parsePlaylistRef('') === null)
ok('没有 id 的陌生链接返回 null', parsePlaylistRef('https://example.com/hello') === null)
ok('只有两位数字不算 id', parsePlaylistRef('42') === null)
const rdef = parsePlaylistRef('123456', 'kg')
ok('纯数字走 defaultSource', !!rdef && rdef.source === 'kg' && rdef.id === '123456', JSON.stringify(rdef))

/* ==================== 5. 汽水 SSR 页解析 ==================== */
console.log('\n--- 5. 汽水歌单页解析（真实响应裁出的夹具）')

const html = fs.readFileSync(path.join(HERE, 'fixtures/qishui-playlist.html'), 'utf8')
const page = parseQishuiPlaylistPage(html)
ok('能从页面里解析出歌单', !!page, page ? page.name : 'null')
ok('歌单名正确', page && page.name === 'test', page && page.name)
ok('sourceId 取到了 playlistInfo.id', page && page.sourceId === '7629573360581656610', page && page.sourceId)
ok('曲目数正确', page && page.songs.length === 2, page && page.songs.length + ' 首')
ok('第一首：歌名 / 歌手 / 专辑 / 时长(秒)',
  page && page.songs[0].name === '相见恨晚' && page.songs[0].singer === '彭佳慧'
  && page.songs[0].albumName === '敲敲我的头' && page.songs[0].interval === 253,
  page && JSON.stringify(page.songs[0]))
ok('多歌手用 / 连接', page && page.songs[1].singer === '宿涵/周杰伦/张神儿', page && page.songs[1].singer)
ok('标了 matchNeeded（要交给前端逐首匹配）', page && page.matchNeeded === true)
ok('封面用抖音图床模板拼出可用链接',
  page && /^https:\/\/p3-luna\.douyinpic\.com\/img\/tos-cn-v-2774c002\/[0-9a-f]+~tplv-b829550vbb-crop-center:720:720\.jpg$/.test(page.cover),
  page && page.cover)
ok('每首都带了封面（退回歌单封面也算）', page && page.songs.every(s => /^https:\/\//.test(s.cover)))

/* ==================== 6. 括号配平提取器 ==================== */
console.log('\n--- 6. _ROUTER_DATA 提取器（字符串里的花括号不能算深度）')

const tricky = '<script>_ROUTER_DATA = {"a":{"lyric":"前面 { 后面 }","quote":"他说\\"好\\"","n":{"deep":1}}} ;</script>'
const tr = extractRouterData(tricky)
ok('歌词里的 { } 与转义引号不会提前截断', !!tr && tr.a && tr.a.n && tr.a.n.deep === 1, JSON.stringify(tr))
ok('没有 _ROUTER_DATA 时返回 null', extractRouterData('<html><body>hi</body></html>') === null)
ok('JSON 残缺时返回 null 而不是抛异常', extractRouterData('_ROUTER_DATA = {"a":{') === null)
ok('拿到的是对象而不是字符串', tr && typeof tr === 'object')

/* ==================== 7. 小工具 ==================== */
console.log('\n--- 7. 汽水链接匹配工具')

ok('matchQishuiShort 认路径 /s/<code>/', matchQishuiShort('https://qishui.douyin.com/s/abc123/') === 'abc123')
ok('matchQishuiShort 不认落地页', matchQishuiShort('https://music.douyin.com/qishui/share/playlist?playlist_id=1') === null)
ok('matchDouyinShare 认歌单页', (matchDouyinShare('https://music.douyin.com/qishui/share/playlist?playlist_id=99') || {}).kind === 'playlist')
ok('matchDouyinShare 认单曲页', (matchDouyinShare('https://music.douyin.com/qishui/share/track?track_id=99') || {}).id === '99')
ok('matchDouyinShare 不认无关域名', matchDouyinShare('https://example.com/qishui/share/playlist?playlist_id=1') === null)
ok('douyinCover 缺字段时返回空串', douyinCover(null) === '' && douyinCover({ uri: '' }) === '')

console.log('\n===== ' + pass + ' 通过 / ' + fail + ' 失败 =====')
if (fail) console.log('有失败项，别急着往下走。')
process.exit(fail ? 1 : 0)
