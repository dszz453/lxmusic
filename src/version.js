/**
 * 版本号的唯一事实来源（Single Source of Truth）。
 *
 * 为什么要有这个文件：这个项目有**三个宿主**（Cloudflare Workers / 安卓壳 /
 * Docker 自托管），而版本号以前散落在四处、各不相同：
 *
 *   package.json                  1.0.0
 *   android/AndroidManifest.xml   versionName 1.10 / versionCode 11
 *   public/sw.js                  VERSION = 'v20'（那是**静态缓存版本**，不是产品版本）
 *   线上 Worker                   没写版本
 *
 * 「服务端和 APP 都要有版本号 V1.0」就是要这三处**说同一个数字**。
 * 所以统一读这里，谁也别再各写各的。
 *
 * ── 两条版本线，别混 ──────────────────────────────────────────
 *   APP_VERSION      产品版本，人看的。改功能才动它。当前 V2.6
 *   APP_VERSION_CODE 整数构建号，Android 靠它判断「能不能覆盖安装」。
 *                    每次要发新版就 +1，**不能倒退、不能重复**，
 *                    否则手机上会报「应用未安装」（签名相同也装不上）。
 *
 * ── 发版规矩（老板 2026-10-06 定，2026-10-08 收紧）──────────────
 *   **每发一个版本，APP_VERSION 升 0.1**（V1.0 → V1.1 → V1.2 …），
 *   同时 APP_VERSION_CODE +1。两件事一次做完，别只改一个 ——
 *   只改名字不改 code，手机上装不上新版；只改 code 不改名字，用户看不出换了。
 *   一次发版=一次对外可见的变化，别把好几个改动攒着当一版发。
 *
 *   2026-10-08 收紧：**不许再把新改动「同号原地覆盖」**。早先为了省事定过
 *   「纯前端 UI 改动不抬版本号、两个 APK 用同一个号覆盖 dist/」的例外 ——
 *   **那条作废**。凡用户能感知到的改动（界面、接口、行为）都算一版，必须 +0.1；
 *   抬了要连带同步 client/version.mjs 的 SERVICE_VERSION、重部署 CF、重建镜像，
 *   这份代价照付：版本号对不上的代价更大（用户报障时报的号谁也对不上）。
 *   唯一不算发版的是「只改注释/文档、不产生任何新包」的提交。
 *
 * sw.js 里那个 `VERSION='vNN'` 是另一回事：它只管浏览器静态缓存该不该失效，
 * 每次改前端资源都要 +1，跟产品版本解耦。**这里不写它的当前值** ——
 * 写了就会过期（早先这里写着 v20，而实际已经 v22 了，纯属误导），
 * 要看得去 public/sw.js 里读。
 * 别把两者合并 —— 合并的后果是「只想刷新一下缓存，却被迫宣布发了个新版本」。
 */

/** 产品版本（对外展示用）。每发一版升 0.1。 */
export const APP_VERSION = 'V2.6'

/** Android versionCode：整数、单调递增、跨次发布不可重复。每发一版 +1。 */
export const APP_VERSION_CODE = 116

/** 人类可读的完整标识，日志/关于页用。 */
export const APP_ID = 'lxmusic'

/**
 * 构建标识。用来回答「这台机器上跑的是哪一次构建」。
 *
 * 由构建参数注入：Dockerfile 收 `--build-arg LX_BUILD_ID=…`（CI 传 commit sha），
 * 本地直接跑源码就是 'dev'。
 *
 * 为什么非要它不可：**光看产品版本号分辨不出代码新旧** —— V1.0 会挂很久，
 * 部署完到底有没有生效，之前只能靠「去抓某个文件里有没有某段字符串」这种土办法。
 * 有了它，`curl /api/version` 一眼就能对上：接口里那个 sha 是不是你刚推的那一次。
 */
export const BUILD_ID = String(
  (typeof process !== 'undefined' && process.env && process.env.LX_BUILD_ID) || 'dev',
)
  .trim()
  // 完整的 40 位 sha 太长，日志和页面里都挤。取前 12 位已经足够区分，
  // 又能在 git 里直接搜到那一次提交。
  .slice(0, 12) || 'dev'

/** 一行式版本串，形如 `lxmusic V1.1 (3a41e22a1b2c)` */
export function versionLine() {
  return `${APP_ID} ${APP_VERSION} (${BUILD_ID})`
}

/** 给接口/健康检查用的结构化版本信息。 */
export function versionInfo() {
  return {
    app: APP_ID,
    version: APP_VERSION,
    versionCode: APP_VERSION_CODE,
    build: BUILD_ID,
    full: versionLine(),
  }
}
