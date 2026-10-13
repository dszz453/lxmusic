/**
 * 回归：专辑详情（打开专辑）必须真的能列出曲目、且带对专辑名。
 *
 * 背景（2026-10-13 老板报障）：「李哪吒上学记」搜专辑能搜到，点进去却打不开 /
 * 集数对不上。查下来是两个 provider 的**响应形状不匹配**，跟搜索链路无关：
 *
 *   1) tx 专辑接口 fcg_v8_album_info_cp 返回的是**扁平字段**
 *      （songmid / songname / size128 / strMediaMid），而 filterSong 是按
 *      **搜索接口**的嵌套形状写的（item.mid / item.name / item.file.size_128mp3）
 *      → 每一条都被 filter(s => s.songmid) 丢掉 → 永远报「没有可用曲目」。
 *   2) kg 专辑曲目接口 album/song 的每条记录里**没有** album_name / album_img
 *      → 原先从 info[0] 取名字，永远取到空串 → 专辑详情顶着「酷狗专辑 <id>」。
 *
 * 这里用 __lxFetch 桩把两家的响应按**实测真实形状**喂进去（并各带一条形状守卫，
 * 防止有人把 fixture 改成「照着客户端代码看着像什么」的样子 —— 那样会把 bug
 * 固化成预期行为）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import tx from '../src/providers/tx.js'
import kg from '../src/providers/kg.js'

/** 只按 URL 片段分发的桩；返回体就是各平台实测响应的关键片段 */
function stubFetch(routes) {
  globalThis.__lxFetch = async (url) => {
    for (const [frag, body] of routes) {
      if (String(url).includes(frag)) {
        return new Response(JSON.stringify(body), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
}

// —— 实测（2026-10-13）tx 专辑接口 data.list[0] 的真实字段，原样保留 ——
const TX_ALBUM_ITEM = {
  albumid: 63067444,
  albummid: '003bX9Z14RPfX4',
  albumname: '李哪吒上学记|稀里糊涂一年级&神神气气二年级',
  cdIdx: 0,
  interval: 197,
  singer: [{ id: 19934107, mid: '001l28vt1rlmwK', name: '奇妙故事广播站' }],
  size128: 3161275,
  size320: 0,
  size5_1: 0,
  sizeape: 0,
  sizeflac: 0,
  sizeogg: 0,
  songid: 562880387,
  songmid: '002RQ0Xo4PFero',
  songname: '00 我叫李哪吒',
  songorig: '00 我叫李哪吒',
  strMediaMid: '002RQ0Xo4PFero',
  vid: '',
}

test('形状守卫：tx 专辑 fixture 必须是「扁平字段」，不能带 file / mid / name', () => {
  // 真接口就是扁平形状；一旦有人把 fixture 改成嵌套形状，这条会红，
  // 提醒他「那不是在复现真接口，是在复现 bug」。
  assert.equal(TX_ALBUM_ITEM.file, undefined)
  assert.equal(TX_ALBUM_ITEM.mid, undefined)
  assert.equal(TX_ALBUM_ITEM.name, undefined)
  assert.equal(typeof TX_ALBUM_ITEM.songmid, 'string')
  assert.equal(typeof TX_ALBUM_ITEM.songname, 'string')
  assert.equal(typeof TX_ALBUM_ITEM.size128, 'number')
})

test('tx：专辑接口的扁平条目能被解析成曲目（不再整批丢弃）', async () => {
  stubFetch([
    ['fcg_v8_album_info_cp', { code: 0, data: { name: '李哪吒上学记|稀里糊涂一年级&神神气气二年级', mid: '003bX9Z14RPfX4', list: [TX_ALBUM_ITEM] } }],
  ])
  const r = await tx.getAlbum('003bX9Z14RPfX4')
  assert.equal(r.songs.length, 1, '应解析出 1 首')
  const s = r.songs[0]
  assert.equal(s.songmid, '002RQ0Xo4PFero', 'songmid 必须来自 songmid 字段')
  assert.equal(s.mediaMid, '002RQ0Xo4PFero', 'mediaMid 必须来自 strMediaMid')
  assert.equal(s.name, '00 我叫李哪吒', 'name 必须来自 songname')
  assert.equal(s.albumName, '李哪吒上学记|稀里糊涂一年级&神神气气二年级')
  assert.equal(s.albumId, '003bX9Z14RPfX4')
  assert.equal(s.interval, 197)
  assert.ok(r.name.includes('李哪吒上学记'), '专辑名应来自 data.name')
  // 128k 音质要按扁平字段映射出来（size_128mp3 ← size128）
  assert.ok(s.types.some(t => t.type === '128k' && t.size === 3161275), '128k 音质应被映射')
  // 专辑接口没有 size_hires，绝不能凭空造出 24bit
  assert.ok(!s.types.some(t => t.type === 'flac24bit'), '不得凭空虚报 flac24bit')
})

test('tx：专辑名优先取 data.name（新字段），回退 data.albumName（旧字段）', async () => {
  stubFetch([
    ['fcg_v8_album_info_cp', { code: 0, data: { albumName: '旧字段专辑名', list: [TX_ALBUM_ITEM] } }],
  ])
  const r = await tx.getAlbum('003bX9Z14RPfX4')
  assert.equal(r.name, '旧字段专辑名')
})

// —— 实测（2026-10-13）kg album/song 的真实记录：有 hash / album_id，**没有** album_name ——
const KG_ALBUM_SONG_ITEM = {
  hash: '52B4130EC3F7E831AB548753949739B3',
  audio_id: 438280127,
  album_id: '138402904',
  album_audio_id: 722617422,
  songname: '00 我叫李哪吒',
  singername: '奇妙故事广播站',
  duration: 197,
  filesize: 3161275,
}

test('形状守卫：kg album/song 的记录里没有 album_name / album_img', () => {
  assert.equal(KG_ALBUM_SONG_ITEM.album_name, undefined)
  assert.equal(KG_ALBUM_SONG_ITEM.album_img, undefined)
  assert.equal(KG_ALBUM_SONG_ITEM.album_id, '138402904')
})

test('kg：专辑名与封面取自 album/info（album/song 里根本没有这些字段）', async () => {
  stubFetch([
    ['/api/v3/album/info', {
      data: {
        albumid: 138402904,
        albumname: '李哪吒上学记|稀里糊涂一年级&神神气气二年级',
        imgurl: 'http://imge.kugou.com/stdmusic/{size}/20250217/x.jpg',
      },
    }],
    ['/api/v3/album/song', { data: { total: 2, info: [KG_ALBUM_SONG_ITEM, Object.assign({}, KG_ALBUM_SONG_ITEM, { hash: 'AAAA', audio_id: 2 })] } }],
  ])
  const r = await kg.getAlbum('138402904')
  assert.equal(r.songs.length, 2)
  assert.ok(r.name.includes('李哪吒上学记'), `专辑名应来自 album/info，实际=${r.name}`)
  assert.ok(!/酷狗专辑 \d+/.test(r.name), '不应再落到「酷狗专辑 <id>」兜底名')
  assert.ok(r.cover.includes('imge.kugou.com'), '封面应来自 album/info 的 imgurl')
  assert.ok(!r.cover.includes('{size}'), '封面里的 {size} 占位符必须被替换')
})

test('kg：album/info 挂了也不影响列曲目（名字退回兜底）', async () => {
  stubFetch([
    ['/api/v3/album/song', { data: { total: 1, info: [KG_ALBUM_SONG_ITEM] } }],
  ])
  const r = await kg.getAlbum('138402904')
  assert.equal(r.songs.length, 1)
  assert.ok(r.name.includes('138402904'), '拿不到名字时退回含 id 的兜底名')
})

test.after(() => { delete globalThis.__lxFetch })
