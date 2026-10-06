# 云音乐（落雪插件兼容）自托管版
#
# ── 为什么形态这么简单 ─────────────────────────────────────────
#  · **运行时几乎零依赖**。src/ 全是纯 Web 标准 API（fetch / Request / Response /
#    crypto.subtle），数据库用 Node 22 内置的 node:sqlite。没有原生模块要编译。
#    唯一的例外见下面「为什么要塞一份 undici」。
#  · **没有构建阶段**。前端是零构建的原生 HTML/JS（public/），后端直接跑源码。
#    改一行代码重建镜像几秒钟（实测整包构建 ~42 秒，其中大半是拉基础镜像）。
#  · 基底选 glibc 的 bookworm-slim 而不是 alpine：node:sqlite 是 Node 官方构建内置的，
#    两边都有，但 glibc 版踩坑最少，代价只是大几十 MB。
#
# ── 为什么要塞一份 undici（约 2.1MB，零依赖、纯 JS）─────────────
# 出站连接复用（server/outbound-pool.mjs）靠给全局 fetch 换一个带 keep-alive 的
# Agent 来提速。而 **node:22-slim 里没有可 import 的 undici** —— 实测三条路全不通：
#     import('undici')                        → ERR_MODULE_NOT_FOUND
#     import('node:undici')                   → ERR_UNKNOWN_BUILTIN_MODULE
#     import('node:internal/deps/undici/...') → ERR_UNKNOWN_BUILTIN_MODULE
# 在开发机上 `import('undici')` 之所以能成，是因为 wrangler 把它作为间接依赖装进了
# node_modules —— 那是个**假象**：一旦进容器（没有 node_modules）就静默退化成原生 fetch，
# 而代码里的 try/catch 会把它伪装成「正常运行、只是没提速」。
# 所以这里显式装一份：npm install 会把它平铺到 /app/node_modules，import('undici') 即可命中。
# 它零 dependencies、无原生模块，装它不会把镜像搞大多少，也不会引入编译步骤。
#
# ── 要求 ───────────────────────────────────────────────────────
#  · Node ≥ 22.13（node:sqlite 免 flag）。这里固定 node:22，满足。
#  · 数据全在 /data（SQLite 文件 + WAL），**必须挂出来**，否则重建容器等于清库。
#
# ── 构建与运行 ─────────────────────────────────────────────────
#   docker build -t lxmusic .
#   docker run -d --name lxmusic -p 8787:8787 -v $PWD/data:/data lxmusic
#
# 官方镜像（GitHub Actions 自动构建）：ghcr.io/dszz453/lxmusic:latest
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    LX_PORT=8787 \
    LX_HOST=0.0.0.0 \
    LX_DATA_DIR=/data

WORKDIR /app

# tools/ 也带上：容器里能跑 node tools/plugin-prescreen.mjs 重新摸底插件，
# 用户网络下某个插件把进程搞崩时，这是唯一的自救手段（见 README「插件白屏/崩溃」）。
COPY package.json ./
COPY src ./src
COPY public ./public
COPY server ./server
COPY tools ./tools

# ── 出站连接池依赖：只拷 undici 一件，不跑 npm ─────────────────────
#
# 为什么不用 `npm install undici`：试过，**两条路都不通** ——
#   ① 容器里跑 npm install —— 构建期在 CI 上是通的，但在没有外网/镜像受限的
#      自建环境里会挂；而且 package.json 里带着 win32 专用的 devDependency
#      （@cloudflare/workerd-windows-64），npm 解析整棵树时会报
#      `EBADPLATFORM Unsupported platform ... win32`，连 `npm install undici` 都装不成。
#   ② 把它写进 dependencies 再 npm ci —— 会破坏「镜像里没有 node_modules」这个前提，
#      还得引入一个构建阶段，代价大得多。
#
# 所以选最笨也最稳的：`vendor/undici/` 由 `tools/vendor-undici.mjs` 从本地
# node_modules 拷进仓库（零依赖、纯 JS、2.1MB），这里直接 COPY 进镜像。
# 好处：构建完全离线、不依赖任何仓库可达性、逐字节可复现。
# 没拷到也不会让构建失败 —— outbound-pool.mjs 会退回原生 fetch，功能照旧。
COPY vendor/undici ./node_modules/undici

# 非 root 运行。数据目录先建好并交给 node 用户，避免首次挂载时权限不对。
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8787

# 镜像里没有 curl，用 Node 自己探。
#
# start-period 给 20 秒，**不是**因为启动慢，而是给慢盘留余量：
#   · 插件求值是同步的 new Function(script)，24 个加起来的纯开销实测只有 ~113ms，
#     插件内部的异步 fetch 只影响「插件就绪」事件，不在启动路径上。
#   · 从进程启动到 /healthz 返回 200：开发机实测 ~1.1 秒；
#     在 Debian 13 / 4 核的测试机上**容器冷启动实测 2.87~3.12 秒**（四轮）。
#     20 秒已经是实测值的 6 倍余量，够覆盖树莓派这类慢盘了。
#   · 早先这里写 90 秒（注释还说「启动要 ~25 秒」），那是**管道打时间戳测出来的假象** ——
#     `node server/index.mjs | while read` 会被下游缓冲卡住，看起来像启动慢。别再用管道测启动。
#   · start-period 只影响「启动阶段失败不算失败」，给大了的代价是容器真挂时晚 1 分钟才被发现。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LX_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
