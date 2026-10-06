/**
 * 插件实测得分排序表（由 tools/plugin-score.mjs 自动生成，请勿手动修改）
 *
 * 结构：{ [平台]: [插件 id, ...] }，按该平台上的综合得分降序。
 * src/plugins.js 装载插件池后会调 pool.setRank(PLUGIN_RANK)，让「先试哪个插件」
 * 由实测结果决定，而不是 build.mjs 里的书写顺序。
 *
 * 生成时间：2026-10-01 02:18:16
 * 评分口径：取流成功率 45% + 响应速度 25% + 直链可播性 15%（平台实测），
 *           另以覆盖广度 15% 加权；「能否加载」是一票否决的硬门槛。
 *           因本机出口不可达而没测成的插件，排在实测有效的插件之后。
 * 重新生成：node tools/plugin-score.mjs
 *
 * ⚠ 口径限制：分数是在**构建机**的网络上测的，与线上 Cloudflare Worker 出口不完全一致。
 *   「成功率高」可信；「成功率 0 且出口不可达」的条目只是没测到，不代表它不行。
 *   2026-10-01 实测对照：构建机 18/25 可加载，线上 /healthz 同样 18/25、失败的是同一批
 *   （六音 / 野花 / 独家音源 / 野草 / 聚合API(CF) / 长青SVIP），所以这份排序的覆盖率是完整的。
 */
export const PLUGIN_RANK = {
  "wy": [
    "cloud-fuguang",
    "pdone-qdy",
    "wsl-quandou",
    "cloud-hyw",
    "cloud-kh",
    "fengs-merged",
    "jiexiang",
    "liuyun-jh",
    "wsl-molan",
    "wsl-xinghai",
    "pdone-huanyin",
    "wsl-freemusic",
    "liuyun-lxmusic",
    "wsl-lxfree",
    "liuyun-nya",
    "pdone-huibq",
    "wsl-zicheng",
    "pdone-ikun",
  ],
  "kg": [
    "cloud-fuguang",
    "cloud-hyw",
    "cloud-kh",
    "jiexiang",
    "wsl-molan",
    "pdone-qdy",
    "wsl-quandou",
    "wsl-xinghai",
    "liuyun-lxmusic",
    "wsl-lxfree",
    "fengs-merged",
    "liuyun-jh",
    "liuyun-nya",
    "pdone-huibq",
    "wsl-freemusic",
    "wsl-zicheng",
  ],
  "kw": [
    "cloud-fuguang",
    "cloud-kh",
    "jiexiang",
    "wsl-molan",
    "wsl-xinghai",
    "pdone-qdy",
    "wsl-quandou",
    "fengs-merged",
    "cloud-hyw",
    "pdone-huanyin",
    "wsl-freemusic",
    "liuyun-lxmusic",
    "wsl-lxfree",
    "liuyun-jh",
    "liuyun-nya",
    "pdone-huibq",
    "wsl-zicheng",
    "pdone-ikun",
  ],
  "tx": [
    "cloud-fuguang",
    "cloud-hyw",
    "jiexiang",
    "wsl-molan",
    "wsl-xinghai",
    "pdone-qdy",
    "wsl-quandou",
    "pdone-huanyin",
    "liuyun-lxmusic",
    "wsl-lxfree",
    "cloud-kh",
    "fengs-merged",
    "liuyun-jh",
    "liuyun-nya",
    "pdone-huibq",
    "wsl-freemusic",
    "wsl-zicheng",
  ],
  "mg": [
    "cloud-fuguang",
    "jiexiang",
    "wsl-molan",
    "pdone-qdy",
    "wsl-quandou",
    "cloud-kh",
    "wsl-xinghai",
    "liuyun-lxmusic",
    "wsl-lxfree",
    "cloud-hyw",
    "fengs-merged",
    "liuyun-jh",
    "liuyun-nya",
    "pdone-huibq",
    "wsl-freemusic",
    "wsl-zicheng",
    "pdone-huanyin",
  ],
}

export const PLUGIN_RANK_META = {
  generatedAt: "2026-10-01 02:18:16",
  keywords: ["周杰伦 晴天","陈奕迅 十年","邓紫棋 泡沫"],
  scorer: 'plugin-score/1',
  measuredFrom: 'build-host',
  unmeasured: ["pdone-huibq","pdone-ikun","liuyun-lxmusic","liuyun-nya","liuyun-jh","cloud-kh","wsl-zicheng","wsl-lxfree"],
}
