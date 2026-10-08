# 安卓客户端（LX-MUSIC · 通用客户端）

同一个仓库里有**两个安卓工程**，做的是两件不同的事，别混：

| | `android/` | **`client/`（本文档）** |
|---|---|---|
| 包名 | `com.zyplnn.musicedge` | `com.zyplnn.lxclient` |
| 定位 | CF 那条线上的**离线自包含壳** | **通用客户端**：连 CF / Docker / 自建 / 内置都行 |
| 后端 | 永远在设备内（`backend.bundle.js` + 手机 SQLite） | 跟着「服务器档案」走：远程就放服务器上，内置就在设备内 |
| 名字 | 固定 `music-edge` | 由所连服务端自报（`music-edge` 或 `LX-MUSIC`） |
| 版本线 | 与服务端同号（V1.3） | **客户端自己的版本线（V1.0 起算）** |
| 产物 | `dist/music-edge-<版本>.apk` | `dist/lx-music-client-<版本>.apk` |

两者包名不同 → **可以同时装在一台设备上互不覆盖**，方便对照。
签名共用 `android/keystore/yunmusic.keystore`（包名不同不冲突，部署者只备份一份密钥）。

---

## 一、分层：照搬「原生 + 跨端」混合架构

网易云的安卓客户端是**原生宿主 + React Native 混合**：

> 外壳、播放器、底层音频能力用 Java/Kotlin + C/C++；
> 首页、社区、直播、动态这些大量业务页面用 React Native（JS/TS）写，
> 搭配 Hermes 引擎，一套代码跑双端；原生 Activity 里嵌 RN 页面。

本客户端**分层与职责划分完全照搬，只换了渲染载体**：

```
┌──────────────────────────────────────────────────────────┐
│  ① 原生宿主层（Java）                                     │
│     ClientActivity      顶栏 / 原生底部导航 / 内容容器         │
│     ServerActivity      服务器连接（首启向导 + 切换）          │
│     SettingsActivity    设置（系统能力那一半）                │
│     LocalMusicActivity  本地音乐（系统媒体库）                │
│     AboutActivity       关于（两条版本线）                    │
│     PlaybackService     播放前台服务 + MediaSession           │
├──────────────────────────────────────────────────────────┤
│  ② 跨端桥接层（Java）                                     │
│     AndroidHost  ← 共用前端的老协议（http / db / 媒体会话）    │
│     BridgeHub    ← 客户端专属（档案 / 原生页 / 路由 / 剪贴板）  │
├──────────────────────────────────────────────────────────┤
│  ③ 跨端业务层（JS，`client/rn/`）                          │
│     00-guard / 10-bridge / 20-brand / 30-nav / 40-pages / 50-shell │
│     承载：底栏与路由同步、品牌与双版本、原生页入口接管          │
│     业务页面本体是 `public/`（首页/搜索/歌单/播放器，三宿主共用）  │
├──────────────────────────────────────────────────────────┤
│  ④ 底层能力层（Java + JNI 预留）                           │
│     core/AudioEngine    本地音频发现 / 解码接口 / 引擎信息      │
└──────────────────────────────────────────────────────────┘
```

### 逐层对照网易云，以及「我们为什么这么选」

| 网易云的做法 | 本工程的做法 | 原因 |
|---|---|---|
| 外壳/页面都可能是 Kotlin（新代码优先 Kotlin） | **全部 Java** | 构建链路是 `aapt2 → javac → d8`（没有 Gradle），也就没有 `kotlinc` 与 `kotlin-stdlib`。为一个几千行的宿主引入 80MB 编译器 + 运行时，换来的只是语法糖；而 Java 侧的分层结构**一模一样**，以后要上 Kotlin 是加编译步骤，不是重写架构 |
| 业务页面用 React Native（JS/TS + Hermes） | **业务页面仍是 JS/TS，但渲染载体是系统 WebView** | 真上 RN 需要 Gradle + npm 依赖 + Hermes + native module 编译，与本工程「免 Gradle、离线可构建」的链路直接冲突。更关键的是：这个项目的业务页面**已经用 JS 写完了**，而且是**三宿主共用同一份** —— 换 RN 等于把它们重写一遍并复制成第二份源码，正是这个项目一直在避免的事（「改一处漏一处」） |
| 音频解码/音效/重采样是 C/C++（JNI） | **JNI 接口预留 + 平台 API 兜底** | 没有 NDK（同上，无 LLVM/NDK 工具链）。所以：能做的用平台 API 做到位（`MediaStore` 找本地音频、`MediaMetadataRetriever` 取时长/比特率/采样率），native 那部分**如实标注不可用**（`AudioEngine.nativeAvailable()`），绝不写「假装成功」的桩 |
| 纯原生页面：设置、本地播放底层、权限、推送 | **照搬** | 这四类都握在系统手里（权限、Activity 跳转、媒体库、进程退出），放跨端层只会做不了或者做不稳。见下面「原生与跨端怎么分工」 |
| React Native 页面：动态、社区、直播、歌单详情 | **照搬**：首页/搜索/歌单/播放器放跨端层 | 这些是**频繁迭代的业务 UI**，改一次要三端同时生效；放进跨端层才能做到「改一处三端同效」 |

> 一句话：**分层照搬，渲染载体按可构建性换**。换掉的是 RN 这一层的运行时，不是它的架构位置。

---

## 二、原生与跨端怎么分工（这条界线是经验，不是洁癖）

判据只有一条：**这件事是「系统能力」还是「业务规则」**。

| 归原生（本工程的 `*Activity`） | 归跨端（`public/` + `client/rn/`） |
|---|---|
| 连哪台服务器（地址填错时跨端层自己都起不来，必须有一块独立地面） | 音质、音色均衡、播放缓存策略、歌词偏移 |
| 通知权限、系统设置直达 | 音源插件的启停与顺序、综合搜索排序 |
| 本地音乐扫描与播放（媒体库 / 解码器） | 歌单、收藏、每日推荐、播放队列 |
| 底部导航、顶栏、Activity 生命周期、退出 | 页面内容与路由（`#/xxx`） |
| 播放前台服务、通知栏/锁屏/耳机按键 | 播放器面板的 UI 与交互 |

「设置」页因此被**劈成两半**：`SettingsActivity`（原生那半，只有入口与系统项）+ 网页 `#/settings`（业务那半）。这不是偷懒，是为了让业务规则**只有一份实现**。

---

## 三、CF / Docker 通用是怎么做到的

四件事拼起来，缺一件就会出现「界面显示 A、实际连的是 B」：

1. **服务器档案**（`ServerStore`，SharedPreferences）
   三档固定槽位（内置离线 / Cloudflare / Docker）+ 任意多条自建。槽位不随用户改名或删除 ——
   品牌判定要靠它，用户不该有办法把「我连的是哪条线」这件事搞乱。

2. **握手**（`Handshake`，`GET /api/version`）
   服务端自报 `host`（`cf` / `docker`）、`version`、`build`。
   ⚠ 两条判据纪律（本项目踩过的坑）：**不能只看状态码**（反代挂了常回 200 的错误页），
   必须看正文像不像本项目的接口；**超时预算要够**（弱网下 TLS 握手本身就要 2~3 秒）。

3. **品牌与版本由服务端决定，不靠本地配置猜**
   品牌判据是服务端自报的 `host` 字段（`cf → music-edge`、`docker → LX-MUSIC`），
   不用响应头/CDN 特征 —— 那些过一层反向代理就没了。
   `brand.js` 的同步判据本来只能猜出「壳一定是 cf」，客户端里通过注入
   `window.LX_CLIENT_HOST_HINT` 把它变成**准确答案**，于是不会闪名，
   也不会把 Docker 那条线装成 `music-edge` 的 PWA 身份。

4. **注入**（`ClientActivity.injectClientShell`，改的是**内存里的** index.html）
   `<head>` 最前面注入一段脚本，做三件必须在页面脚本之前完成的事：
   - 把 active 档案的地址写进 `localStorage`（`native.js` 加载时就读它决定连本机还是远程）；
   - 写下品牌同步判据与客户端期望的服务端版本；
   - 注入一段 CSS 隐藏网页自带的顶栏/底栏（原生接管），并把排版里为它们预留的空间收回来。
   改内存而不改 `public/index.html`：共用前端**一行都不动**，网页端与老壳行为零变化。

---

## 四、两条版本线

| | 谁 | 现在 | 改哪儿 |
|---|---|---|---|
| 客户端版本 | 这个 APK | **V1.0**（`versionCode 100`） | `client/version.mjs` |
| 服务端版本 | CF Worker / Docker | **V1.3** | `src/version.js` |

**两者不必同号，也不该强求同号**：服务端升到 V1.4 时，只要接口兼容，App 不用重装；
客户端修个原生层的 bug 时，服务端一行都不用动。强行同号的后果是
「服务端发个版，全量用户就得重装 App」。

但客户端必须知道**自己该跟哪一版服务端说话** —— 那就是
`client/version.mjs` 的 `SERVICE_VERSION`（= 服务端 `APP_VERSION`，由
`test/client-wiring.test.mjs` 钉住）与 Java 侧的 `ClientBrand.SERVICE_EXPECT`。
握手回来版本不一致时**只提示、不阻断**：差一格通常仍然可用，硬拦会把用户锁在门外。

顺带修掉一个会立刻出现的假告警：共用前端原本拿**客户端版本**去比**服务端版本**，
在通用客户端上必然不等（1.0 vs V1.3）→ 一条永远亮着的「⚠ 与服务端版本不一致」。
现在比的是 `window.LX_CLIENT_SERVICE`（客户端期望的服务端版本），
拿不到时退回老行为（老壳不受影响）。

---

## 五、构建与验证

```bash
# 构建（会自动先打包跨端业务层，再重建离线后端 bundle）
bash client/build-client.sh
bash client/build-client.sh --skip-backend   # 只改前端/跨端层时更快

# 产物
client/build/lx-music-client-1.0.apk         # 主产物
dist/lx-music-client-1.0.apk                 # 副本，方便取件

# 静态接线审计（78 项，秒级，不需要安卓运行时）
node test/client-wiring.test.mjs

# 跨端层行为（25 项，秒级，不需要浏览器/安卓 —— 自带一个极小 DOM 替身）
# 产物缺失或落后于 client/rn/src/ 时会先自动重打一遍，不会静默测旧产物
node test/client-layer.mjs
```

改完必须跑的（与项目原有口径一致）：

```bash
node test/brand.test.mjs              # 38 项：品牌判定（客户端的同步判据在这里被钉住）
node test/app-wiring.test.mjs         # 46 项：版本落点 / 媒体会话接线
node test/client-wiring.test.mjs      # 78 项：客户端四条链路（静态接线审计）
node test/client-layer.mjs            # 25 项：跨端层行为（守卫 / 路由归属 / 入口接管 / 桥崩容错）
```

> `client-wiring` 与 `client-layer` 是**互补**的，别只跑一个：
> 前者审「源码里有没有写对」（静态、不执行），后者审「跑起来是不是那个行为」。
> 单靠静态审计过不了「守卫判据写太松导致网页端也被接管」这类错 ——
> 那是行为问题，只能跑出来。
>
> 构建脚本里的 `aapt2 dump badging` 会打印包名/版本/权限/标签，
> 用来核对「包内清单到底声明了什么」——**不要只看源码**，
> 源码改了但没传给 aapt2 的情况是存在的（本项目吃过一次）。

---

## 六、已知限制与「以后怎么接上」

| 限制 | 症状 | 以后接上的做法 |
|---|---|---|
| 没有 Kotlin | 新增原生代码只能写 Java | 加 `kotlinc` 编译步骤（`kotlin-stdlib.jar` 一起打进 dex）。分层不用动 |
| 没有 React Native | 跨端层是 WebView 承载 JS | 真要上 RN：`client/rn/` 那一层换成 RN bundle，桥接层（`BridgeHub`）换个协议实现即可 —— 原生宿主与底层能力层不动 |
| 没有 NDK | 没有 native 解码器 / 音效 | 加 `jni/` 与 CMake，实现 `AudioEngine` 里已预留的 4 个 native 方法；**调用点已经写好了**，上层页面一行不用改 |
| 本地音乐只做「发现 + 交给系统播放器」 | 本地歌不进客户端的播放器面板 | 面板那套是**为在线取流设计的**（队列/候选/歌词/缓存），硬塞本地文件两边都别扭。要合并得先在跨端层加一个「本地音源」类型 |
| WebView 内核差异 | 极老内核上 `HashChangeEvent` 可能不存在 | 已经做了兜底（`new Event('hashchange')`）；`MutationObserver` 缺失时退化成 CSS 那一层 |

---

## 七、排障：常见症状 → 先查哪里

| 症状 | 先查 |
|---|---|
| 底栏不高亮 / 高亮错 | `client-layer.js` 加载了吗（`assets/www/js/client-layer.js` 在不在包里）；`LXNative.setRoute` 有没有被调用（原生 Logcat 里搜 `LXC/`） |
| 网页顶栏和原生顶栏一起出现 | 注入的那段 `<style id="lxClientChrome">` 有没有生效（选择器是否与网页类名一致） |
| 名字显示成另一条线的 | `window.LX_CLIENT_HOST_HINT` 注入值 vs 服务端 `/api/version` 的 `host`；档案的 `kind` 填错了会让同步判据先猜错 |
| 连不上某台服务器 | 服务器页点「测试连接」看具体是哪一类失败（超时 / 域名解析 / TLS / 端口拒绝，`Handshake.describe` 会翻译）；**注意「反代回了 200 的错误页」会被识别成「不像本项目的服务端」而不是「连上了」** |
| 设置页版本行一直提示不一致 | 服务端 `APP_VERSION` 与 `client/version.mjs` 的 `SERVICE_VERSION` 是否同步（`node test/client-wiring.test.mjs` 会报红） |
| 某个功能静默失效 | 先确认那个模块在不在 `tools/build-client-rn.mjs` 的 `MODULES` 清单里 —— 没进清单的模块**永远不会执行**且**不会报错** |
