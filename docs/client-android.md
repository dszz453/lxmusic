# 安卓客户端（云音乐 Docker 版 / CF 版）

同一个仓库里保留两套安卓宿主：UI 与后端路径不同，分别构建、分别维护：

| | `android/`（CF 版） | `client/`（Docker 版） |
|---|---|---|
| 包名 | `com.yunmusic.cf` | `com.yunmusic.docker` |
| 桌面名称 | **云音乐(CF版)** | **云音乐(Docker版)** |
| 宿主架构 | 单 Activity + WebView，嵌入本地 `backend.bundle.js` 自包含壳 | 原生多页面 + WebView 跨端层，保留服务器配置、本地音乐库与设置 |
| 代码来源 | `android/` 独立 Java 壳 + `public/` + 本地 bundle | `client/` Docker 客户端 + 共用 `public/` |
| 应用版本来源 | `android/version.mjs`（CF APK） | `client/version.mjs`（Docker APK） |
| 产物 | `outputs/云音乐(CF版)-V2.22.apk` | `outputs/云音乐(Docker版)-V2.22.apk` |

包名不同，所以两个 App **可以同时安装在同一台手机上**，各自的数据与设置隔离。
签名密钥也分别保存在 `android/keystore/yunmusic.keystore` 与
`client/keystore/yunmusic-app.keystore`。Docker 版 V2.20 使用新包名 `com.yunmusic.docker`；
旧版 `com.yunmusic.app` 不会自动迁移，若手机里仍装有旧版，它会作为另一个 App 留在设备上。

> ⚠ 2026-10-14：原本还有**第三个**安卓工程 `yunmusic-client/`（包名同样是 `com.yunmusic.app`，
> 但前端是**手写单文件** `assets/web/index.html`，4727 行）。老板要求「客户端参照 web 端重新开发」
> → 它已被 `client/` 取代并**整体删除**：包名与签名沿用，前端换成 `public/` 整包。
> 从此**只有一份前端**，不再出现「改一处漏一处」的分叉。
> 一并删掉的还有 `tools/build-client-lxcore.mjs` —— 它只为那个手写前端生成
> `lxcore.js` / `plugins.data.js` 到 `yunmusic-client/assets/web/`，
> 手写前端一没，它就零引用了（`plugins.data.js` 现在由 `tools/build-app.mjs`
> 统一产出到 `public/js/`，网页端与客户端共用）。

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
│     业务页面本体是 `public/`（首页/搜索/歌单/播放器，两个安卓宿主共用）  │
├──────────────────────────────────────────────────────────┤
│  ④ 底层能力层（Java + JNI 预留）                           │
│     core/AudioEngine    本地音频发现 / 解码接口 / 引擎信息      │
└──────────────────────────────────────────────────────────┘
```

### 逐层对照网易云，以及「我们为什么这么选」

| 网易云的做法 | 本工程的做法 | 原因 |
|---|---|---|
| 外壳/页面都可能是 Kotlin（新代码优先 Kotlin） | **全部 Java** | 构建链路是 `aapt2 → javac → d8`（没有 Gradle），也就没有 `kotlinc` 与 `kotlin-stdlib`。为一个几千行的宿主引入 80MB 编译器 + 运行时，换来的只是语法糖；而 Java 侧的分层结构**一模一样**，以后要上 Kotlin 是加编译步骤，不是重写架构 |
| 业务页面用 React Native（JS/TS + Hermes） | **业务页面仍是 JS/TS，但渲染载体是系统 WebView** | 真上 RN 需要 Gradle + npm 依赖 + Hermes + native module 编译，与本工程「免 Gradle、离线可构建」的链路直接冲突。更关键的是：这个项目的业务页面**已经用 JS 写完了**，而且是**两个安卓宿主共用同一份** —— 换 RN 等于把它们重写一遍并复制成第二份源码，正是这个项目一直在避免的事（「改一处漏一处」） |
| 音频解码/音效/重采样是 C/C++（JNI） | **JNI 接口预留 + 平台 API 兜底** | 没有 NDK（同上，无 LLVM/NDK 工具链）。所以：能做的用平台 API 做到位（`MediaStore` 找本地音频、`MediaMetadataRetriever` 取时长/比特率/采样率），native 那部分**如实标注不可用**（`AudioEngine.nativeAvailable()`），绝不写「假装成功」的桩 |
| 纯原生页面：设置、本地播放底层、权限、推送 | **照搬** | 这四类都握在系统手里（权限、Activity 跳转、媒体库、进程退出），放跨端层只会做不了或者做不稳。见下面「原生与跨端怎么分工」 |
| React Native 页面：动态、社区、直播、歌单详情 | **照搬**：首页/搜索/歌单/播放器放跨端层 | 这些是**频繁迭代的业务 UI**，改一次要两个安卓宿主同时生效；放进跨端层才能做到「一处改两端同效」 |

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
   两档固定槽位（内置离线 / 服务器地址）+ 任意多条自建。槽位不随用户改名或删除 ——
   品牌判定要靠它，用户不该有办法把「我连的是哪条线」这件事搞乱。
   > 2026-10-15（V2.21）：老板要求「docker 版本不要写两个线路了，一个就行」，
   > 于是去掉「主线路 / 备用线路」的二分，只留**一个服务器地址槽位** + 内置离线。
   > 老配置里的 `cf` 备用槽位在 `ensureDefaults()` 里被收编：地址搬进唯一槽位后移除，
   > 用户升级后不会丢地址。

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

5. **单服务器地址直配与 Token 隔离**
   - **交互极简**：服务器地址（自建 Docker / CF 均可）直接在卡片上展开输入框，
     用户进页面即可直接打字修改，无需再点开多层抽屉；内置离线作为另一档并列可选。
   - **切换即落盘**：点击「保存并启用」时，自动保存输入框内未提交的新地址，
     避免握手失败导致的配置丢失。
   - **多服务器 Token 隔离**：前端鉴权令牌按 `lx.token@<serverBase>` 区分存储，
     解决换服务器后因令牌混用导致的 401 掉登录问题。

---

## 四、版本号分线

| 版本线 | 现在 | 改哪儿 | 对应 APK |
|---|---|---|---|
| CF 客户端 | **V2.22**（`versionCode 420`） | `android/version.mjs` | `云音乐(CF版)-V2.22.apk` |
| Docker 客户端 | **V2.22**（`versionCode 420`） | `client/version.mjs` | `云音乐(Docker版)-V2.22.apk` |
| CF Worker / Docker 服务端 | **V2.14**（`versionCode 133`） | `src/version.js` | 服务端，不等同 APK 版本 |

三个版本值分别维护；服务端发布不要求 App 重装，某个 App 宿主有改动也不要求另一份跟着发版。
CF 与 Docker APK 的 versionCode 当前相同，但 Android 用不同包名识别应用，因此两者可共存。
各自发版时都只在对应版本文件里递增，不要拿服务端版本号覆盖 APK 版本号。

客户端必须知道**自己该跟哪一版服务端说话** —— Docker 客户端的
`client/version.mjs` `SERVICE_VERSION`（= 服务端 `APP_VERSION`，由
`test/client-wiring.test.mjs` 钉住）与 Java 侧的 `ClientBrand.SERVICE_EXPECT`。
握手回来版本不一致时**只提示、不阻断**。CF 壳是本地自包含实现，其 APK 版本独立由 `android/version.mjs` 管理。

顺带修掉一个会立刻出现的假告警：共用前端原本拿**客户端版本**去比**服务端版本**，
在通用客户端上必然不等（2.22 vs V2.14）→ 一条永远亮着的「⚠ 与服务端版本不一致」。
现在比的是 `window.LX_CLIENT_SERVICE`（客户端期望的服务端版本），
拿不到时退回老行为（老壳不受影响）。

---

## 五、构建与验证

```bash
# Docker 版：原生多页面客户端，自动打包跨端层与离线后端 bundle
bash client/build-client.sh
bash client/build-client.sh --skip-backend   # 仅改 UI/跨端层时使用

# CF 版：android/ 自己的 WebView + 本地 backend.bundle.js 构建链
bash android/build-apk.sh

# 产物都会复制到 outputs/ 供安装
outputs/云音乐(Docker版)-V2.22.apk
outputs/云音乐(CF版)-V2.22.apk
```

> ⚠ **CI 上必须用环境变量给脚本指路**（本机走 `android-build/` 便携工具链，CI 上没有）：
> `JDK_DIR` / `BUILD_TOOLS` / `PLATFORM` / `OUT_DIR` 四个。
> 其中 `PLATFORM` 的契约是 **`android.jar` 的完整路径**，不是 `platforms/android-34`
> 这个目录 —— 传目录时脚本会打印 `缺 android.jar: …/platforms/android-34` 然后退出 1，
> 而 `sdkmanager` 那步明明装成功了，很容易误判成「SDK 没装好」。
> `test/app-wiring.test.mjs` 第 9 节把这条钉住了（传目录会精确报红）。
>
> ⚠ `client/build-client.sh` 是**跨平台**的（本机 Windows + Git Bash / CI ubuntu）。
> 平台差异只集中在脚本开头那一节：`W()`（cygpath 路径转换，无 cygpath 时原样）、
> `EXE`（`.exe` 后缀）、`LIST_Q()`（@argfile 列表）、`PY`（python 定位）。
> **正文里不要再出现 `aapt2.exe` 或本机绝对路径** —— 那正是 CI 第一次真跑时
> `aapt2.exe: No such file or directory`（exit 127）的原因：本机全绿、CI 直接挂。
> 这两条也在第 9 节里钉住了。

```bash
# 静态接线审计
node test/client-wiring.test.mjs
node test/app-wiring.test.mjs
node test/client-layer.mjs
```

改完必须跑的（与项目原有口径一致）：

```bash
node test/brand.test.mjs              # 38 项：品牌判定（客户端的同步判据在这里被钉住）
node test/app-wiring.test.mjs         # 60 项：CF APK 版本落点 / 媒体会话接线 / CI 出包环境契约
node test/client-wiring.test.mjs      # 113 项：客户端四条链路（静态接线审计）
node test/client-layer.mjs            # 34 项：跨端层行为（守卫 / 路由归属 / 入口接管 / 桥崩容错）
node test/boot-speed.test.mjs         # 52 项：启动路径（首屏不等网络 / 档案读取顺序）
node test/stream-pick.mjs             # 78 项：取流候选排序 + /url 与 /stream 共享候选缓存
node test/edge-cache.mjs              # 46 项：边缘缓存（榜单/专辑/歌词/播放直链）行为 + 接线
```

> ⚠ `edge-cache.mjs` 读的是 `src/server/api.js` 与 `src/lib/stream.js`（服务端源码）。
> 它进的是**客户端** CI，靠的是「改 `src/` 必然跟着重打入库的
> `public/js/backend.bundle.js`」这条链 —— 所以 `backend.bundle.js` **不能**从仓库里拿掉。

> ⚠ **跨端层产物（`client/rn/build/client-layer.js`）不进仓库** —— 它被 `.gitignore` 里
> 那条无路径限定的 `build/` 规则挡住（见 `.gitignore` 第 28 行）。所以
> `client-wiring` / `client-layer` 都会在**产物缺失或比源码旧时现打包一遍**，
> 全新检出（CI runner、别人刚 clone）也能直接跑。别把这条改回「直接断言产物存在」：
> 本机有产物所以全绿，CI 上必挂 —— 2026-10-15 就这么挂过一次。

> ⚠ 构建脚本第 1.5 步是 `cp -r "$ROOT/public/." "$ASSETS/www/"` ——
> **APK 里的前端就是仓库里的 `public/`，逐字节同一份**，不是副本、不是「同步过来的」。
> 改前端 = 改 `public/`，两端同时生效；构建时还会把 `public/` 里已删的文件
> 从 `assets/www/` 清掉（`client-layer.js` 与 `client-build.txt` 两个客户端专属文件除外）。

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
