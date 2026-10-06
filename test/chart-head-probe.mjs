/**
 * 对比探针：榜单卡片图到底用「榜首专辑封面」还是「榜首歌手头像」更好。
 * 网易云的专辑封面有相当一部分是自动生成的文字图（新歌还没出正式封面时），
 * 那种图铺在卡片上并不比原来的官方榜单设计图好看；歌手头像则一定是一张真照片。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const H = { 'User-Agent': UA, Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' }

const get = async (u) => {
  const r = await fetch(u, { headers: H })
  const j = await r.json().catch(() => null)
  return { http: r.status, j }
}

const topIds = [3778678, 19723756, 3779629, 2884035, 60198, 71384707, 1978921795, 991319590]

for (const id of topIds) {
  try {
    const { j } = await get(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=3&s=0`)
    const pl = j && j.playlist
    const t = (pl.tracks || []).find(x => x && x.al && x.al.picUrl)
    if (!t) { console.log(`【${pl && pl.name}】无曲目`); continue }
    const artist = (t.ar || [])[0] || {}
    console.log(`\n【${pl.name}】榜首 ${artist.name} · ${t.name}`)
    console.log(`  专辑封面 ${String(t.al.picUrl).slice(0, 78)}`)
    // 歌手详情：拿头像
    if (artist.id) {
      const { j: aj } = await get(`https://music.163.com/api/artist/${artist.id}`)
      const a = aj && aj.artist
      console.log(`  歌手头像 ${a && a.picUrl ? String(a.picUrl).slice(0, 78) : '(无)'}`)
      console.log(`  图库张数 ${a && a.albumSize !== undefined ? a.albumSize : '?'}`)
    }
  } catch (e) {
    console.log(`\n【${id}】失败 ${e.message}`)
  }
}
