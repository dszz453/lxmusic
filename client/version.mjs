/**
 * 客户端版本号的唯一事实来源（Single Source of Truth）。
 *
 * ── 为什么要和 src/version.js 分开 ─────────────────────────────
 * 本项目有**两条版本线**，以前一直混着用一个数字：
 *
 *   · 服务端版本（src/version.js 的 APP_VERSION）—— CF Worker / Docker 那一侧，
 *     描述「接口与后端行为」到了第几版。当前 V2.7。
 *   · 客户端版本（本文件）—— 安卓客户端（原生宿主 + 跨端层）自身，
 *     描述「这个 App 装的是哪一版」。从 V1.0 起算。
 *
 * 两者**不是一回事，也不该强行同号**：
 *   · 服务端升到 V1.4 时，老客户端并不一定需要重新装 —— 只要接口还是兼容的，
 *     客户端可以停在 V1.0 继续用（这正是「客户端通用」的意义）。
 *   · 反过来，客户端修一个原生层的 bug（比如通知栏媒体卡片点不动），
 *     服务端一行代码都不用动。
 * 强行同号会逼出「服务端发个版，全量用户就得重装 App」这种荒唐局面。
 *
 * 但客户端必须**知道自己该跟哪一版服务端说话** —— 这就是 SERVICE_VERSION。
 * 握手时（GET /api/version）拿服务端自报的 version 与它比对，不一致只提示、不阻断：
 * 版本差一格通常仍然可用，硬拦会把用户锁在门外。
 *
 * ── 发版规矩（老板 2026-10-06 定，2026-10-08 收紧）──────────────
 * 每发一版：CLIENT_VERSION 升 0.1、CLIENT_VERSION_CODE +1，两件事一次做完。
 * 与服务端侧同规矩（见 src/version.js 顶部）—— 只改一个的后果一样：
 * 只改 code 装得上但没人看得出换了，只改名字装不上（Android 靠 code 判断覆盖）。
 *
 * 2026-10-08 收紧：**客户端每出一个新包都要 +0.1，不许同号原地覆盖 dist/**。
 * 早先「只改原生 UI 就用同一个号覆盖」的例外作废 —— 后果是用户手里两个
 * 截然不同的包都叫 V1.0，报障时对不上号。改完客户端要重跑
 * `bash client/build-client.sh`（包内 client-build.txt 记录构建时的 HEAD，
 * 所以必须先提交再构建）。
 * 注意分工：改客户端**不动** SERVICE_VERSION（那是「本 App 按哪版服务端设计」
 * 的声明）—— 只有服务端抬了 APP_VERSION，这里才跟着抬。 */

/** 客户端产品版本。从 V1.0 起算，每出一个新包升 0.1 */
export const CLIENT_VERSION = 'V2.4'

/** 安卓 versionCode：整数、单调递增、跨次发布不可重复 */
export const CLIENT_VERSION_CODE = 114

/** 客户端包名（与既有 music-edge 壳 com.zyplnn.musicedge 并存，互不覆盖） */
export const CLIENT_PACKAGE = 'com.zyplnn.lxclient'

/** 客户端对内自称（装在桌面上的名字）。品牌由所连服务端决定，这里是 App 自身的名字 */
export const CLIENT_APP_NAME = 'LX-MUSIC'

/** 该客户端按哪一版服务端设计（对接 src/version.js 的 APP_VERSION） */
export const SERVICE_VERSION = 'V2.7'

/**
 * 构建标识：Dockerfile / CI 传 commit sha，本地直接构建就是 'dev'。
 * 与服务端同一个来源，这样「App 里看到的构建号」能和「服务端 /api/version 的 build」
 * 对上 —— 排查「是不是同一个提交」时不用来回猜。
 */
export const CLIENT_BUILD_ID = String(
  (typeof process !== 'undefined' && process.env && process.env.LX_BUILD_ID) || 'dev',
)
  .trim()
  .slice(0, 12) || 'dev'

/** 一行式版本串，形如 `LX-MUSIC 客户端 V1.0 (3a41e22a1b2c)` */
export function clientVersionLine() {
  return `${CLIENT_APP_NAME} 客户端 ${CLIENT_VERSION} (${CLIENT_BUILD_ID})`
}

/** 结构化版本信息（桥接层回给跨端层用） */
export function clientVersionInfo() {
  return {
    app: CLIENT_APP_NAME,
    version: CLIENT_VERSION,
    versionCode: CLIENT_VERSION_CODE,
    build: CLIENT_BUILD_ID,
    service: SERVICE_VERSION,
    package: CLIENT_PACKAGE,
  }
}
