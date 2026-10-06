# 自托管（Docker / iStoreOS）

同一个 `src/`，三种宿主。这份文档只讲第三种：

| | Cloudflare Workers | 安卓 APP（自包含） | **Docker / 自托管** |
|---|---|---|---|
| 后端跑在哪 | CF 边缘 | 手机里 | 你自己的机器 |
| 数据库 | D1 | 手机 SQLite | `node:sqlite`（一个文件） |
| 数据在哪 | CF 账号里 | 那台手机上 | `/data`（你挂的目录） |
| 音源插件 | CF 出口跑 | 手机 WebView 跑 | 你的宽带出口跑 |
| 换手机/重装 | 不受影响 | 清空 | 不受影响 |
| 对外 | CF 给你的域名 | 不需要 | 你的公网 IP + Lucky / Nginx |

---

## 一、为什么自托管可能更好（以及代价）

用户问过「docker 是不是搜索速度会更好」。实测口径下的答案是：**在取流成功率上会明显更好，速度上互有胜负。**

- **出口 IP 不一样，这才是关键。** CF 的边缘出口在国内音源眼里是「境外机房」，实测：QQ 音乐直接在 CF 出口被拒（`c.y.qq.com` 500），部分插件初始化要拉的配置域名在 CF 出口也到不了。家里的宽带出口在国内、是「正常用户 IP」，同一批插件能连上的更多。本机实测 Docker 版 **25 个内置插件里 18 个可用**，而线上是 14 个里 5 个可用。
- **没有隔离区限制。** CF 只允许在启动阶段 `new Function`，且一个插件把隔离区搞死就永远不就绪；Node 里没这层限制。
- **没有冷启动。** CF 边缘实例会被回收，第一个请求要重新初始化插件池；常驻容器不用。
- **代价一：你的上传带宽。** 网页端「服务端代理」那一级（`/api/stream`）是从你的宽带上行的。手机端 APP 直连播放不走代理，但浏览器里遇到 http-only 音源就会走。
- **代价二：家里的 IP 有风险。** 某些音源对高频请求的风控是按 IP 的，你的家宽 IP 被限速/封了，影响的是全家上网。
- **代价三：维护在你手上。** 备份、升级、证书续期都得自己管（Lucky 能省掉大半）。

---

## 二、iStoreOS 上装起来

iStoreOS 自带 Docker。三种入口，任选一种。

> **⚠️ 先做这一步（国内网络）**：拉 `ghcr.io` 大概率超时。配个镜像加速源，
> 一劳永逸，后面所有 `docker pull` 都受益：
>
> ```sh
> mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
> {
>   "registry-mirrors": ["https://docker.1ms.run", "https://docker.1panel.live"],
>   "log-driver": "json-file",
>   "log-opts": { "max-size": "10m", "max-file": "3" }
> }
> EOF
> /etc/init.d/docker restart     # iStoreOS；普通 Debian/Ubuntu 用 systemctl restart docker
> ```
>
> 两个源是**主备**关系（`docker` 依次尝试）。实测 `docker.1ms.run` 响应更快，
> 所以排前面。`log-opts` 那两行也别省 —— 容器日志默认无限增长，
> 跑久了能把数据盘写满。

### 方式 A：LuCI 界面（推荐给不想敲命令的）

`Docker` → `容器` → `新增`，按下面填：

| 项 | 值 |
|---|---|
| 名称 | `lxmusic` |
| 镜像 | `ghcr.io/dszz453/lxmusic:latest`（拉不动就用下面的方式 C 自己构建） |
| 重启策略 | `unless-stopped` |
| 端口映射 | `8787` → `8787`（协议 TCP） |
| 卷挂载 | `/mnt/xxx/lxmusic-data` → `/data`（**必须**，用你数据盘上的真实路径） |
| **运行用户** | `1000:1000`（LuCI 里可能叫「User」/「用户」，**别留空**） |
| 环境变量 | `LX_SESSION_SECRET=`（留空即可，会自动生成并存库） |

启动后浏览器打开 `http://路由器IP:8787/admin`，第一次会让你建管理员账号。

### 方式 B：SSH 里一行命令

```sh
mkdir -p /mnt/sata/lxmusic-data
chown -R 1000:1000 /mnt/sata/lxmusic-data      # ← 别跳过，否则容器无限重启
docker run -d --name lxmusic --restart unless-stopped \
  -p 8787:8787 \
  -v /mnt/sata/lxmusic-data:/data \
  --user 1000:1000 \
  ghcr.io/dszz453/lxmusic:latest
```

> `--user 1000:1000` 与那句 `chown` 的缘由，见下面「出问题了怎么查 → 容器一直重启」。

### 方式 C：docker compose（想改配置方便）

```sh
mkdir -p /mnt/sata/lxmusic && cd /mnt/sata/lxmusic
# 把仓库里的 docker-compose.yml 放到这里（或者直接手写一份，见仓库内那份的注释）
mkdir -p data && chown -R 1000:1000 data
docker compose up -d
docker compose logs -f          # 看启动日志
```

### 目录与端口约定

- 容器内固定监听 `8787`，`/data` 是唯一需要持久化的目录（里面就一个 `lxmusic.db` + WAL）。
- 备份 = 把 `/data` 拷走。恢复 = 拷回来重建容器。
- 升级 = `docker compose pull && docker compose up -d`（或 LuCI 里点重建），数据不受影响。

### 版本号怎么确认

```sh
curl -s http://127.0.0.1:8787/api/version
# {"ok":true,"app":"lxmusic","version":"V1.1","versionCode":101,"build":"3a41e22a1b2c","full":"lxmusic V1.1 (3a41e22a1b2c)"}
curl -s http://127.0.0.1:8787/healthz | grep -o '"version":{[^}]*}'
docker logs lxmusic | head -3          # 启动第一行就带版本
```

`build` 是构建标识（CI 传的 commit sha 前 12 位），**用来确认部署真的生效了**：
它应该等于你刚推的那次提交的 sha 前缀。若显示 `dev`，说明这个镜像不是 CI 构建的
（比如本地 `docker build` 没带 `--build-arg LX_BUILD_ID=…`）。

或者直接看应用里：**设置页底部「版本」**会同时显示客户端版本与服务端版本；
两者不一致时会高亮 —— 这正是「APP 装了新版、连的却是旧服务器」的典型症状。

### 插件自动评分（可选，默认每天一次）

音源插件会失效，内置的排序表是**构建时**在这台构建机上实测出来的。
自托管版可以**在你这台机器的网络环境下重新实测**，结果比构建机的更贴合你的实际出口。

跑起来有两件事，都在管理后台「音源与插件」页顶部：

- **自动**：容器启动后按间隔自动跑一轮，结果写进数据库并立即对所有搜索生效。
  间隔用环境变量控制（`docker-compose.yml` 里加一行）：

  ```yaml
  environment:
    LX_SCORE_INTERVAL: "1d"      # 默认 1d。可用 off / 30m / 12h / 1d / 2w
  ```

  写 `off` 就只保留手动。**下限 5 分钟**（避免把音源站打挂），写错的值会回落到默认 `1d`。

- **手动**：点页面上的「立即重评」即可，不需要重启容器。按钮会变成「正在评分…」，
  界面按间隔自动轮询，跑完自动刷新排序表。

评分是在**独立子进程**里跑的（`--ephemeral`，不写 `src/generated/`），
所以即使某个插件把 JS 引擎搞崩，容器本身也不受影响；一轮的超时上限是 20 分钟。

> 线上（Cloudflare Workers）不支持运行时评分 —— 那里不能在请求阶段动态求值插件。
> 那个宿主的管理页会明确显示「自动评分不可用」，请在本地跑
> `node tools/plugin-score.mjs` 实测后重新部署。

---

## 三、Lucky 做域名 + HTTPS（对外的门）

> 家宽的 80 / 443 对入站基本是封的，所以「让外网访问」这一步不要指望端口映射。Lucky 的价值在于它跑在本机、**出站**连 Cloudflare / 阿里云拿证书，再把请求收回来 —— 不需要你家宽开任何入站端口。

Lucky 里配置两步：

**1) 先加一个 Web 服务规则（反代）**

| 项 | 值 |
|---|---|
| 类型 | 反向代理 / Web 服务 |
| 前端地址 | `0.0.0.0:443`（要用域名 HTTPS 就选 443） |
| 后端地址 | `http://127.0.0.1:8787` |
| 证书 | 用 Lucky 的 ACME 给域名签一张（DNS 方式，无需 80 端口） |

**2) 三个必须调的反代参数**（不调会出现「能打开但很难用」）

| 参数 | 设成 | 为什么 |
|---|---|---|
| **响应缓冲 / Buffer** | **关** | 不关的话 `/api/stream` 的音频会被反代整体缓冲，拖动进度条像在重新加载 |
| 读取超时 | `600s` 以上 | 一首歌从头播到尾都是同一个连接 |
| 传递客户端真实 IP | 开（`X-Forwarded-For`） | 否则日志里全是 127.0.0.1，排查不了 |

> 小技巧：不想让 8787 暴露在局域网上，就把端口映射改成 `127.0.0.1:8787:8787`，只留本机反代能访问。

---

## 四、把手机 APP 指到它

APP 设置 → **服务端** → 填 `https://你的域名` → 点「测试连接」→ 通过后「保存并重启」。

- 填了之后 APP 就从「单机版」变成「纯客户端」：账号、播放记录、音源插件全在服务器那一侧，换手机不丢。
- 想改回单机版：同一个位置点「恢复本机模式」。地址填错、连不上、进不去设置页时，**登录页底部也有同一个入口**，所以不会把自己锁在外面。
- 不写协议时的判定：`192.168.1.9:8787` 按 `http://`，`music.example.com` 按 `https://`。带端口不参与判断。
- APP 请求走的是原生桥而不是网页 fetch，所以服务器**不需要**配 CORS。

---

## 五、出问题了怎么查

```sh
docker logs lxmusic | tail -40            # 启动日志里有插件加载结果
curl -s http://127.0.0.1:8787/healthz     # {"ok":true,"plugins":{"total":25,"ready":18}}
```

### 容器一直重启

**先看日志最后一行**，它通常直接告诉你是哪一类：

#### 情况一：`数据目录不可写` / `unable to open database file`

这是**自托管最常见的第一个坑**，而且原生产物给的信息完全指不到方向。

根因：镜像里的进程以 `node`（uid 1000）运行，不是 root。
如果宿主机上的挂载目录**还不存在**，Docker 会以 root 身份把它建出来（755）——
容器里就写不进去。

> SQLite 对「目录不存在」「文件只读」「父目录不可写」**报的是同一句话**
> （`unable to open database file`），不区分。所以别靠它猜，照下面做。

现在 `openDatabase` 会自己分开探目录与权限，报出是哪种，并直接把该执行的命令打出来：

```sh
# 照日志里那句做（路径换成本机实际的数据目录）
sudo mkdir -p /你的路径/lxdata && sudo chown -R 1000:1000 /你的路径/lxdata
docker restart lxmusic
```

或者更省事：`docker run` 时带 `--user 1000:1000`，`docker compose` 用仓库里那份
（已经写了 `user: "1000:1000"`）。

⚠️ **`chown` 之后别再拿 root 去覆盖这个目录**（比如用 root 跑 `docker cp`、
或再用 root 起一次容器），否则属主会被改回去、问题复现。

#### 情况二：日志停在某一行没有下文

启动时会逐个求值每个插件，某些重度混淆的脚本求值时**不抛异常、直接杀死 JS 引擎**
（`try/catch` 拦不住）。所以**日志的最后一行就是把它搞崩的那个插件**。
确认后跳过它（写进环境变量即可，不用改代码）：

```sh
docker run -d ... -e LX_PLUGIN_SKIP="pdone-lx,另一个插件id" ghcr.io/dszz453/lxmusic:latest
```

更进一步可以重新摸底，产出一份新名单：

```sh
docker exec -it lxmusic node tools/plugin-prescreen.mjs    # 只摸底，不改文件
docker exec -it lxmusic node tools/plugin-prescreen.mjs --check
```

> 说明：`src/generated/plugin-skip.js` 里已经预置了实测会崩的插件（本机 Node 22 上只有 `pdone-lx`）。
> 换 Node 大版本或插件更新后可能变，所以容器里也留了上面这条自救路径。
>
> 另外容器里还有一道**自愈**：求值每个插件前先把它写进 `/data/.plugin-eval-pending`，
> 求值完再清掉。万一名单漏了导致进程被杀，重启后能从标记里读出「上次死在谁手上」并跳过它，
> 而不是无休止地崩-重启。

### `/healthz` 里 `outbound` 说「找不到 undici」

这**不影响使用**，只是「出站连接复用」这一项提速没生效，功能照旧。健康检查长这样：

```json
"outbound": "已启用 keep-alive 连接池（空闲保持 30s）"     ← 正常
"outbound": "已跳过（找不到 undici 包…）"                  ← 提速没生效
```

正常镜像里 `vendor/undici/` 会在构建时被 `COPY` 进 `/app/node_modules/undici`
（详见 Dockerfile 里的说明，以及 `tools/vendor-undici.mjs`）。
如果你自己改了 Dockerfile 把那一行删了，就会出现第二种情况 —— 重新加回去即可。

### 搜索没结果 / 某个平台老是失败

```sh
# 直接看这个平台的接口在当前这台机器上通不通
curl -s "http://127.0.0.1:8787/api/search?q=晴天&source=wy&limit=1" -H "Authorization: Bearer <token>"
```

单个平台挂掉不影响其它平台 —— 综合搜索是并发跑的，某一家失败只是它那一栏少东西。
默认搜索源可以在管理后台「音源与插件 → 默认搜索源」里改。

### 网页能开但播放没声音

多半是反代的响应缓冲没关（见上面第三节）。其次看 `docker logs` 里有没有 `/api/stream` 的报错。

### 日志里一堆「未处理的 Promise 拒绝」

那是插件的异步初始化在拉自己的配置域名，拉不到就抛了。**不影响使用**，
服务端已经兜住（不兜的话进程会直接退出）。真正要关注的是「某个平台取不到流」。
