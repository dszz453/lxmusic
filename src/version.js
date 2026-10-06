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
 *   APP_VERSION      产品版本，人看的。改功能才动它。当前 V1.0
 *   APP_VERSION_CODE 整数构建号，Android 靠它判断「能不能覆盖安装」。
 *                    每次要发新版就 +1，**不能倒退、不能重复**，
 *                    否则手机上会报「应用未安装」（签名相同也装不上）。
 *
 * sw.js 里那个 `VERSION='v20'` 是另一回事：它只管浏览器静态缓存该不该失效，
 * 每次改前端资源都要 +1，跟产品版本解耦。别把两者合并 —— 合并的后果是
 * 「只想刷新一下缓存，却被迫宣布发了个新版本」。
 */

/** 产品版本（对外展示用）。V1.0 起。 */
export const APP_VERSION = 'V1.0'

/** Android versionCode：整数、单调递增、跨次发布不可重复。 */
export const APP_VERSION_CODE = 100

/** 人类可读的完整标识，日志/关于页用。 */
export const APP_ID = 'lxmusic'

/**
 * 构建标识。Docker 里由构建参数注入（镜像 tag / git sha），
 * 本地跑就是 'dev'。用来回答「这台机器上跑的是哪一次构建」。
 */
export const BUILD_ID = (typeof process !== 'undefined' && process.env && process.env.LX_BUILD_ID) || 'dev'

/** 一行式版本串：`lxmusic V1.0 (dev)` */
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
