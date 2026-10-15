# 云音乐 · 全平台音乐播放器

> **当前版本：V2.13**（服务端）· 客户端 V2.21
>
> 一个自托管的音乐播放系统，支持 **Cloudflare Workers 线上部署**、**Docker 自建服务器**，并提供可在同一手机共存的 **云音乐(CF版)** 与 **云音乐(Docker版)** 两个独立 APK。
> 两个 APK 保留各自宿主：CF 版基于 `android/` WebView + 本地 bundle；Docker 版基于 `client/` 原生多页面客户端。
>
> 服务端、CF APK 与 Docker APK 的版本号分别维护。服务端改动可部署生效，不必重新装 App；宿主侧改动只重建对应 APK。当前 APK 均为 V2.21，服务端为 V2.13。
>
> **客户端的前端就是网页端本身**：`client/assets/www` 是构建时从 `public/` 整包拷进去的，
> 只多一个客户端专属的 `js/client-layer.js`（跨端层）。改 `public/` 就等于改客户端界面。

---

## 快速开始

### 方式一：Cloudflare Workers（零服务器成本）

适合个人轻量使用，利用 Cloudflare 全球边缘节点，无需维护服务器。

```bash
npm install
node build.mjs                                    # 内联插件数据
export CLOUDFLARE_API_TOKEN=你的令牌
export CLOUDFLARE_ACCOUNT_ID=你的账号ID
npx wrangler deploy
```

部署后访问你的自定义域名，首次使用会引导创建管理员账号。

### 方式二：Docker 自建（推荐）

适合长期使用，数据完全自主，支持双架构（amd64 / arm64）。

```bash
# 国内网络建议先配镜像加速
docker run -d --name lxmusic \
  -p 8787:8787 \
  -v /你的路径/lxdata:/data \
  --user 1000:1000 \
  --restart unless-stopped \
  ghcr.io/dszz453/lxmusic:latest
```

或用 `docker-compose.yml`：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d
```

打开 `http://你的IP:8787` → 创建管理员 → 登录后进 `/admin` 配音源插件。

> ⚠️ `--user 1000:1000` 和 `chown` **不能省**。镜像进程以 `node`（uid 1000）运行，挂载目录属主不对会导致 SQLite 无法写入，服务无限重启。

### 方式三：安卓 APK（云音乐 · CF 版 / Docker 版）

直接安装到手机，**无需自建服务器**。两个 APK 包名不同，**可以装在同一台手机上共存**。

| APK | 包名 | 宿主 | 定位 |
|---|---|---|---|
| **云音乐(CF版)** | `com.yunmusic.cf` | `android/` WebView + 本地 bundle | 离线自包含，后端整个跑在设备内 |
| **云音乐(Docker版)** | `com.yunmusic.docker` | `client/` 原生多页面客户端 | 连自建服务器或内置离线，保留本地音乐库与设置 |

两者共同点：最低 Android 5.0（API 21），目标 API 34，已签名（v1 + v2 + v3）。

```bash
bash client/build-client.sh    # → outputs/云音乐(Docker版)-V2.21.apk
bash android/build-apk.sh      # → outputs/云音乐(CF版)-V2.21.apk
```

Docker 版首启让你选连哪条线，两条可选：

| 连接方式 | 说明 |
|---|---|
| **服务器地址** | 自建 Docker / 局域网服务器，或任意 Cloudflare Workers 地址 |
| **内置离线** | 后端完全跑在设备内，不连任何服务器（数据只在这台手机上） |

下载：[Releases](https://github.com/dszz453/lxmusic/releases) 或直接用 CI 产物。

---

## 功能概览

### 服务端能力

| 功能 | 说明 |
|---|---|
| **多平台音源** | 网易云、酷狗、酷我、QQ音乐、咪咕、喜马拉雅，共 6 大平台 |
| **AI 歌单生成** | 输入关键词，AI 自动生成歌单并逐首匹配真实可播歌曲 |
| **智能取流** | 直连 → 插件解析 → 服务端代理，三级降级，自动选最优音源 |
| **插件评分调度** | 自动实测各插件的取流成功率、响应速度、可播性，按成绩排序；支持人工覆盖 |
| **自建歌单** | 创建、收藏、编辑歌单，支持播放历史跨设备同步 |
| **歌词同步** | 逐行高亮，支持 ±3 秒偏移校准，适配蓝牙耳机延迟 |
| **管理后台** | 音源插件管理、用户管理、AI 接口配置、系统设置 |
| **Subsonic 接入** | 标准 `/rest/*` 协议，任何 Subsonic 客户端都能接入 |

### 客户端能力（云音乐 APK）

| 功能 | 说明 |
|---|---|
| **服务器地址管理** | 保存一个自建服务器地址（CF / Docker 均可），或切到内置离线 |
| **离线播放** | 首次启动自动创建本机账号，无需联网即可搜索、播放 |
| **封面缓存** | 原生级 LRU 缓存 + 磁盘缓存，切页零等待 |
| **锁屏控制** | MediaSession 驱动，支持锁屏卡片、控制中心、蓝牙耳机/车机 AVRCP |
| **歌曲下载** | 一键下载到本机（MediaStore，无需存储权限） |
| **歌词显示** | 黑胶旋转 + 歌词滚动高亮 + 偏移校准 |
| **全屏播放器** | 铺满屏幕，顶部收起按钮 + 音质调节，底部音源与插件信息 |
| **每日推荐** | 基于口味自动生成每日歌单 |
| **排行榜 & 专辑** | 全平台榜单、专辑详情、歌手信息 |
| **深色模式** | 跟随系统自动切换 |

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        用户层                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  网页端 PWA   │  │  云音乐 APK   │  │  Subsonic 客户端  │  │
│  │  (public/)   │  │   (client/)   │  │    (/rest/*)     │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
└─────────┼─────────────────┼───────────────────┼────────────┘
          │                 │                   │
          ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                        服务层                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Cloudflare       │  │ Docker (Node.js)│  │  APK 内置    │ │
│  │ Workers          │  │ + node:sqlite   │  │  SQLite     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│                                                              │
│  同一份 src/ 源码，运行时按宿主能力自动分支：                    │
│  • 数据库：D1 / SQLite / android.database.sqlite              │
│  • 缓存：CF Cache API / 进程内 Map / 内存 Map                 │
│  • 出网：原生 fetch / 原生 HttpURLConnection (桥)             │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计

- **单一事实来源**：`src/version.js` 一处改版本，三端同步生效。
- **同构前端**：`public/` 的 PWA 前端与 APK 内的前端**是同一份文件** ——
  APK 打包时把 `public/` 整包拷进 `assets/www`，由 WebView 从包内直出
  （`shouldInterceptRequest`），Java 侧只做「网络 / 数据库 / 媒体会话」三座桥
  （见 `public/js/native.js`）。网页端与客户端**共享同一套页面与交互**，
  不存在「两边各写一份、改一处漏一处」。
- **零构建依赖**：APK 打包不依赖 Gradle / Maven，纯 aapt2 + javac + d8 + zipalign + apksigner。
- **ES5 兼容**：支持 Android 5.0 的老 WebView，全部手写 polyfill，无现代语法。

---

## 部署细节

### Docker 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LX_PORT` | `8787` | 监听端口 |
| `LX_DATA_DIR` | `/data` | 数据目录（**务必挂载出来**） |
| `LX_SESSION_SECRET` | 自动生成 | 会话签名密钥，留空则首次随机生成 |
| `DEFAULT_SOURCES` | `kg,wy,kw,tx,xm` | 综合搜索默认平台 |
| `LX_SCORE_INTERVAL` | `1d` | 插件自动评分间隔（`off` / `30m` / `12h` / `1d`） |
| `LX_PLUGIN_SKIP` | 空 | 逗号分隔的插件 id，跳过有问题的源 |

### 插件评分

默认每天自动跑一轮实测评分，按「取流成功率 45% + 响应速度 25% + 可播性 15% + 覆盖广度 15%」综合排序。也可以随时在管理后台点「立即重评」。

> Cloudflare 版不支持运行时评分（无子进程、无可写文件系统），评分需在本地跑 `node tools/plugin-score.mjs` 后重新部署。

---

## 客户端线路配置

云音乐 APK 支持同时保存两条服务器线路，随时切换：

| 线路 | 用途 | 示例 |
|---|---|---|
| 地址 1（主线路） | 自建 Docker / 本地服务器 | `https://你的服务器地址:端口` |
| 地址 2（备用线路） | Cloudflare Workers | `https://你的Workers域名` |

切换线路后自动清空 token 并重新登录，避免旧 token 打新服务器导致 401。

---

## 测试

```bash
# 服务端端到端（真 HTTP，31 项）
LX_BASE=http://127.0.0.1:8787 node test/server-node.mjs

# 客户端静态接线审计（112 项，秒级，不需要安卓运行时）
node test/client-wiring.test.mjs

# 客户端跨端层行为（34 项，自带极小 DOM 替身）
node test/client-layer.mjs

# 客户端其它护栏：品牌判定 / 版本落点 / 首屏启动速度
node test/brand.test.mjs && node test/app-wiring.test.mjs && node test/boot-speed.test.mjs

# 浏览器验收（93 项，需本地服务）
LX_BASE=http://127.0.0.1:8787 LX_PASS='密码' node test/ui.mjs
```

> `client-wiring` 与 `client-layer` 是**互补**的，别只跑一个：前者审「源码里有没有写对」
> （静态、不执行），后者审「跑起来是不是那个行为」。CI 里两套都跑。

---

## 版本发布

发版规矩：
- 服务端 `APP_VERSION` 每版 **升 0.1**，同时 `APP_VERSION_CODE` **+1**
- 客户端每版 **升 0.1**，`versionCode` **+10**
- 当前：**服务端 V2.13 (132) / 客户端 V2.21 (410)**
- 客户端版本改 `client/version.mjs`，然后 `bash client/build-client.sh` 出包
  （包内 `client-build.txt` 记录构建时的 HEAD，所以**先提交再构建**）

部署后查 `/api/version` 的 `build` 字段即可确认「跑的是不是刚推的那一版」。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 服务端 | Cloudflare Workers / Node.js 22 + `node:sqlite` |
| 前端 | 原生 JS（ES5），零框架，PWA |
| 安卓壳 | 纯 WebView + Java 桥接，无 RN / Capacitor |
| 构建 | 自研 ESM→IIFE 打包器（`tools/build-app.mjs`），零 npm 依赖 |
| CI | GitHub Actions（docker build + 真容器验收、安卓构建 + smoke 测试） |

---

## 开源协议

MIT
