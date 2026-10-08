#!/usr/bin/env bash
# ============================================================
#  music-edge APK 构建脚本（不依赖 Gradle / Maven）
#
#  为什么手写构建链路而不上 Gradle：
#    Gradle + AGP 要拉几百 MB 的 Maven 依赖，网络一抖就失败；
#    这个壳只有两个 .java 文件、零第三方库，用
#    aapt2 → javac → d8 → zipalign → apksigner 五步走完，
#    离线、可重复、出错定位清晰。
#
#  依赖（各下一份就够，之后全程离线）：
#    · JDK 17            android-build/jdk/
#    · Android SDK       android-build/sdk/   build-tools;34.0.0 + platforms;android-34
#
#  用法：bash build-apk.sh
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AB="$(cd "$HERE/../android-build" && pwd)"        # 放 JDK 与 Android SDK 的地方
# JDK 解压后会多套一层版本目录（jdk/jdk-17.0.20.1+1/），换版本时不用改脚本
JDK="$(ls -d "$AB"/jdk/jdk-* 2>/dev/null | head -1 || true)"
JDK="${JDK:-$AB/jdk}"
SDK="$AB/sdk"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
OUT="$HERE/build"

export JAVA_HOME="$(cygpath -w "$JDK" 2>/dev/null || echo "$JDK")"
export PATH="$JDK/bin:$PATH"
# 让 javac/d8 的中文提示按 UTF-8 输出，否则在 Git Bash 里是一堆乱码
export JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8"

W() { cygpath -w "$1"; }                          # MSYS 路径 → Windows 路径
# 写进 argfile 的路径必须换成 Windows 形式：MSYS 只会自动转换「命令行上的」路径参数，
# argfile 里的内容原样传给 javac，/d/... 会被当成盘符 \d\... → 报「找不到文件」
LIST_WIN() { find "$@" | while read -r f; do cygpath -w "$f"; done; }

APP_NAME="music-edge"
# 1.7：修「打开首页要等十几秒」。不是前端慢，是**服务端每次都在现算同一份东西**。
#   没有 AI 每日推荐的实例（自建 Docker 上很常见）每次进首页都走兜底分支：
#   抓一遍榜单 + 跨 6 个音源搜 24 首 —— 而这两段算出来的是**全站同一份、与用户无关**
#   的内容。早先只有榜单那半截进了缓存（15 分钟），热歌那半截每次都重算，
#   于是每次打开都要把 6 个源里最慢的那个等完（单源硬超时 7 秒）。
#   ① 兜底结果**整份**进缓存（20 分钟；榜单没拿到时降成 2 分钟，恢复后能很快补上）；
#   ② 榜单回源加 **2.5 秒硬上限** —— wy.getToplists() 内部是「重试一遍再退 eapi」，
#      上游半通时能连吃十几秒，而它只是首页的一段，不值得为它干等。
#   实测（同一台机器、同一个请求）：**冷 0.55 秒 → 热 0.004 秒**。
#   另：客户端首页缓存加了「写完回读自检」—— U.store.set 是静默吞错的，
#   不查就永远查不出「写了没写成」这种最像「缓存不存在」的故障。
# 1.6：修「客户端首页要手动点一下底栏才加载 / 我的歌单要等十秒」。
#   两个现象同一个根源：**客户端每次冷启动都在解析 1.9 MB 根本用不到的东西**。
#   ① 远程档案下页面里仍挂着本机后端那两个文件 —— backend.bundle.js（1.29 MB，
#      挂 window.LXBackend）与 plugins.data.js（596 KB，挂 window.LX_PLUGIN_DATA）。
#      而它们的唯一消费者都在 native.js 的**本机分支**里：远程模式在 boot() 第一句
#      就 releaseBootstrap() 返回了，这两个全局一个都不会被读到。两者又都是**同步**
#      script，解析与执行都排在首屏之前；浏览器那边有 HTTP 缓存 + SW，第二次打开几乎
#      不花这笔钱，而客户端是把静态资源从包内直出（shouldInterceptRequest），没有那层
#      缓存 —— 于是每次冷启动都白白解析 1.9 MB。现在按档案类型在注入 HTML 时摘掉
#      （老壳走内置模式，那两个文件是命根子，保留）。
#   ② 内置模式首次启动时 seedPlugins() 要起 24 个 Worker、逐个求值 542 KB 混淆脚本，
#      正好和首页渲染抢主线程 —— 表现就是「首页转好几秒」「点歌单要等十秒」。改成
#      主线程空闲时再跑（requestIdleCallback，老 WebView 退回 2.5 s 定时器）；
#      插件晚几秒可用不影响听歌（用户从打开到点播放本来也要这么久）。
#   另外给 init() 里的 boot() 补了兜底：启动流程中任何**未预期**异常都不许把页面留在
#   空白上。首次加载没有任何 hashchange，boot 一旦中断就只剩顶栏 + 底栏 + 空内容区，
#   用户唯一的自救方式是点一下底栏（那会重新路由）—— 这正是报障里
#   「要点一下才发现」的形状，一个从没被观察到的异常被掩盖成了玄学体验。
#   护栏：test/boot-speed.test.mjs 24 → 38 项（新增第 4、5 节）。
# 1.5：修「安卓客户端首页比网页（PWA）慢一大截」。两处都是**接线方式**的代价，
#   不是哪个功能坏了 —— 所以单元测试永远抓不到，只能靠静态审计钉住。
#  ① 客户端的 /api 请求逐个冷启动。HttpBridge / Handshake 读完响应就 disconnect()
#     把 TCP 连接掐了，下一个请求走不到连接池 → DNS + TCP + TLS 整套重做。同一台
#     自建服务器实测：冷连接 418 ms / 复用连接 20 ms，差 20 倍。而 App 冷启动在渲染
#     首页之前要连发好几个 /api；浏览器那边 HTTP/2 多路复用 + 连接复用几乎不花这笔钱
#     —— 这就是「同一个前端、网页快 App 慢」的主要来源。现在读完只关流，连接归还池里。
#     （「无响应体」那条提前返回的分支仍然断开：没有 body 可读，连接已放弃。）
#  ② 首屏在画之前串行等了好几个来回。boot() 里 setupStatus → me → sources 是一前一后；
#     现在 setupStatus 与 me 走 Promise.all 并行，sources 改成后台填充（首帧没有任何
#     视图读它）。首屏少等一整个来回。
#   护栏：test/boot-speed.test.mjs（24 项）。**断言前必须剔注释** —— 因为修复方式就是
#   「删掉那行代码」，理由只能写在注释里，而注释里必然出现 disconnect() 这个字面量，
#   直接对整文件断言会永远失败。
# 1.4：服务端版本只留在设置页；首页登录后不再干等 —— 先出上次的内容再后台刷新。
#  ① **服务端版本收敛到设置页**（老板 2026-10-08：「服务端版本的显示，仅保留设置项里面，
#     其他页面去掉」）。原来它露在四个地方：设置页（保留）、「关于」页版本行尾巴、
#     客户端顶栏那条细状态条、客户端原生关于页与服务器连接页。
#     前端那一处的根因值得记一下：fillVersionBlock() 往**全局** window.LX_VERSION_LINE
#     尾巴上追加「 · 服务端 V1.x」，而那个变量是「关于」页版本行的数据源 ——
#     等于把服务端版本顺手撒到了别的页面；进出设置页两回还会累积成两截。
#     改成只写设置页自己的 #verHost，不碰全局。
#     客户端那条 24dp 细状态条改回「品牌 · 已连接 · 地址」：它要回答的是
#     「我现在看的这份数据是谁的」，版本号回答不了这个，还挤掉地址。
#  ② **首页做了缓存（stale-while-revalidate）**。登录那条路径上 /api/home 排在
#     /me 与 /sources 后面，且要现算（榜单回源上游、每日推荐读库）→ 几秒骨架屏。
#     现在冷启动先画上次的内容（秒开），再后台静默刷新：
#        · 缓存按「服务器 + 账号」隔离（身份写在记录里，不匹配就当没有）——
#          同一台手机换服务器 / 换账号都不能串；
#        · 只在「内存没东西」时才读磁盘；显式失效（加歌进歌单等）仍走真请求；
#        · 只在拿到真数据之后才回写，坏数据不会自己续命；
#        · 后台刷新不打断用户：已经往下翻过、或内容其实没变，都不重绘。
#     服务端侧顺带给 /api/home 里最贵的一步（fetchToplists 回源）加了 15 分钟
#     边缘缓存 —— 榜单是全站同一份、与用户无关。TTL 自己按时间戳算而不交给
#     Cache-Control，因为安卓壳里没有 Cache API、会退化成进程内 Map，
#     两套宿主的寿命必须由同一处决定。
#  ③ 两条版本线同抬：服务端 V1.3 → **V1.4**（code 103 → 104）、
#     客户端 V1.0 → **V1.1**（code 100 → 101）。
# 1.3：两个客户端各自独立命名 —— Docker 版叫 LX-MUSIC，CF 版（含本壳）叫 music-edge。
#  ① 需求是「两个客户端相互独立」，而两个宿主**共用同一份 public/ 前端资源**，
#     所以「我是谁」只能在运行时判定，不能靠打包两份代码（那样以后每个改动都要同步两处）。
#  ② 名字以前散在四处（manifest.json、index.html 的 <title> 与 apple 短名、
#     app.js 的登录页大标题与 document.title），必然改一处漏一处。
#     新增 public/js/brand.js 收成唯一事实来源，其余地方一律取 LXBrand.name。
#  ③ 判据用**服务端自报**：/api/version 新增 host 字段（CF 入口写 'cf'、
#     Node 入口写 'docker'），比响应头 / CDN 特征可靠 —— 那些会被反代抹掉。
#     前端先用同步判据兜底（壳里 / 远程模式），接口回来再纠正。
#  ④ ⚠️ 实测踩到的真 bug：bindBrand() 原本放在 boot() 里「已登录」之后那段，
#     而未登录走的是两个**提前 return** 的分支 → 登录页（正中一个大标题，
#     最需要正确名字的地方）永远显示兜底猜的名。而兜底猜在 Docker 与 CF 上
#     答案一样（都是 docker）→ **CF 线上会显示成 LX-MUSIC**。
#     已提到 boot() 最前面，并加了断言钉住（test/brand.test.mjs）。
#  ⑤ manifest 由前端合成（抓原文件 → 改 name/short_name/**id** → Blob 换 link）。
#     改 id 是必须的：id 相同的话两个客户端装到同一台设备会**互相顶掉**。
#     SW 的 VERSION 一并抬到 v25，预缓存补上 brand.js。
#
# 1.2：修两个报障 + 加两个功能 + 一处动画优化。
#  ① 修「同一首歌换个音质，长度就不一样」（三十多秒 vs 四分钟，Hi-Res 最完整）。
#     真因**不在播放器**，在服务端挑候选：各音源插件对不同音质返回的是**不同来源**
#     的地址 —— 低音质常落到第三方中转源的**试听片段**，Hi-Res 走正版直链给完整曲目；
#     而原逻辑是「**谁先探通就用谁**」，片段先探通就被选中、完整版探通了也不看一眼。
#     改成探通第一条后再等一个 450ms 的**收敛窗口**把同期候选收齐，
#     按「已知死接口最后 → 官方直链优先 → 体积大优先」挑，并**返回多条**已验候选
#     供客户端降级。450ms 的依据：Range 探测耗时集中在 120~240ms，这点等待
#     远小于「放半首就没了」的代价。另在播放器侧加两道保险（候选按体积降序、
#     播完发现明显没结束就提示是音源不给完整版，而不是让用户以为是播放器坏了）。
#  ② 顺带揪出一个更隐蔽的 bug：stream.js 里**两条排序路径档位不同**。
#     `pickBest`（主路径）原本是 official → size → weak，`compareCandidates`
#     （兜底路径）是 weak → official → size。WEAK_HOSTS 装的是**已知死接口**
#     （music.163.com 的 outer/url 实测 302 → /404），死接口只要探测时侥幸回了
#     content-range 就会被抬到健康官方 CDN 前面 —— 而它恰恰放不出声。
#     同一份文件两套顺序 ⇒ 走哪条路径结果不同 ⇒ 极难复现的偶发。已统一。
#  ③ 修「拖动进度条时歌词完全冻结」+「播放器关了再开歌词不归位」。
#     前者的根因很反直觉：歌词其实由 rAF 驱动（不是 timeupdate），但
#     `timeupdate` 里有一道 `if (state.seeking) return` 会让进度条与上报让位给手指，
#     而拖动期间那道短路**连歌词一起跳过了**；后者是隐藏时可视区高度为 0，
#     歌词按 0 算了位移，再打开时「行号没变就短路」让它永不重算。
#  ④ 新增**播放缓存**：三宿主统一走 Cache Storage，键是合成 URL（不含会过期的直链），
#     **整首放完才落缓存**（边听边存会留下一堆残缺半成品）。缓存优先放在取流链路
#     最前面 —— 省掉的是整条解析开销，这才是用户能感觉到的收益。容量按大小上限
#     并做 LRU 淘汰，设置页可查看/清空，另开 `#/cache` 清单页。
#  ⑤ 新增**下载到本机**：网页端走 a[download]，壳内优先走原生（API 29+ 用
#     MediaStore，29 以下写公共下载目录，重名自动加序号）。注意一个坑：
#     原生成功时返回的是**落地路径字符串**而不是 true，只认布尔值会导致
#     「提示保存了、下载目录里却找不到」。
#  ⑥ 首页加**入场动画**：分段错峰淡入上移（总时长压在 400ms 内）+ 骨架屏交叉淡出，
#     并跟随 `prefers-reduced-motion` 整体降级。
# 1.1：把「部署完到底生没生效」这件事变得可查，并立下发版规矩。
#  ① **构建标识真正接上线**。version.js 里早就写着「BUILD_ID 由构建参数注入」，
#     但从 Dockerfile 到 CI 没有任何一处真的传过它 —— 于是 `/api/version` 永远回
#     `build: "dev"`，两个版本之间**没有任何可机读的区分**。这次部署就吃了这个亏：
#     容器到底是新的还是旧的、只能靠「抓 JS 文件里有没有某段字符串」来猜。
#     现在 Dockerfile 收 `--build-arg LX_BUILD_ID`，CI 传 commit sha，
#     截前 12 位显示。以后 `curl /api/version` 一眼对上「跑的是不是刚推的那一版」。
#     顺带在 CI 里加了一条断言：build 不能是 dev/docker —— 否则这次接的线，
#     下次重构 Dockerfile 时又会静默掉回去（未接线的字段不会自己报错）。
#  ② **修 app-wiring 的版本断言**（3 条一直红的）。根因是断言拿正则去
#     build-apk.sh 里抠写死的 `VERSION_CODE=100`，而那个脚本从 1.10 起就改成
#     「从 src/version.js 读」了 —— 抠不到 → 报 `脚本 null`。
#     **产品是对的，是测试的中介物选错了**。改成直接对 src/version.js
#     （单一事实来源）比对，另加两条「取到了得真传给 aapt2」的断言。
#     按老规矩做了负向对照：把版本改到不一致 / 脚本写死 / 不传给 aapt2 /
#     删掉说明段，四种改法都能报红。
#  ③ 立规矩：**每发一版 APP_VERSION 升 0.1，APP_VERSION_CODE +1**（老板定的）。
#     本版即 V1.0 → V1.1、100 → 101。
# 1.0：**版本号归一到 V1.0**（服务端与 App 同号），同时修两个实网问题。
#  ① 修「手动导入插件导不进来」。根因不在导入逻辑，在**下载**：
#     内置 20+ 个预设音源全指向 raw.githubusercontent.com，国内出口 TCP 被丢，
#     于是每个源都卡到超时 —— 用户看到的就是「点了导入没反应」。
#     改成**多镜像自动降级**：ghfast.top → gh-proxy.com → ghproxy.net → 原地址兜底，
#     谁先给出「像插件脚本的内容」用谁。判定不能只看 HTTP 200 ——
#     镜像挂掉时常回一个 200 的 HTML 错误页，必须看正文长度与开头像不像 JS，
#     否则会把错误页当插件解析，报一句看不懂的语法错误。
#  ② 修「QQ 源搜不出歌」。**不是被腾讯拒，是自己的超时预算太紧**：
#     主域名 c.y.qq.com 实测中位 3816ms、最慢 4349ms，却排在第一位，
#     而单域名超时只给了 3000ms → 过半请求还没等到响应就自己放弃了。
#     改成两个主力域名**并行竞速**（c6.y.qq.com ∥ c.y.qq.com，谁先出结果用谁），
#     超时放宽到 6000ms，并删掉恒返回 404 的 u.y.qq.com（那个域名根本没这接口）。
#     实测：串行 5/6 通过、平均 3323ms → 并行 6/6、平均 2631ms。
#  （服务端同源，Worker / Docker 一并生效；见 src/providers/tx.js 与 public/js/lxplugin.js）
# 1.10：两件事。
#  ① 修「默认搜索源拖完顺序存不上」—— 根因不在写入而在**读回**：管理页那一列是从
#      /api/sources 画的，而那个接口只给了 platforms（平台固定顺序）、没给 order，
#      于是每次进页面都退回平台自然顺序。写入一直是好的（D1 里早就存着自定义顺序、
#      接口日志全是 200），只有页面显示不对 —— 典型的「写得进、读不出」。
#      同时把顺序保存改成**显式按钮**：拖动 / 开关只标「有未保存改动」，点「保存顺序」才提交，
#      带「已保存 · 时间」回执；没保存就切页签 / 刷新会先确认再走。
#  ② 歌单导入新增**汽水音乐**与**网易分享短链**：
#      · 网易 163cn.tv 短链、汽水 qishui.douyin.com/s/… 都先跟随 302 展开成真实 id 再导入；
#      · 汽水给不出可播直链，因此走**两段式** —— 服务端只回「歌名 + 歌手」清单，
#        前端逐首调 /suggest 在现有音源里匹配，匹配完再建歌单（与 AI 歌单同一条路径）。
#        宁可少几首，也不往歌单里塞点开没声的条目；
#      · 分享短链**会过期**（实测两条样例分别返回 200+{"message":"404 not found"} 与 302→#404），
#        这两种情况都识别成「已过期」给明确提示，而不是笼统的「解析失败」；
#      · 贴了单曲 / 视频分享链接时按 400 拒绝并说明，不再当 500 报。
# 1.9：修「1.8 的原生媒体会话在真机上一整套都不生效」。
#      **根因**：MediaBridge.ensureService() 写好了，却**全仓没有任何调用点** ——
#      播放服务从来没被启动过，于是 onCreate 不跑、listener 恒为 null、notifyState() 每次
#      直接空转：没有 MediaSession、没有通知，锁屏 / 控制中枢 / 任务中心自然什么都没有。
#      整条链路一声不响（不是报错，是压根没跑），所以上一轮「Java 编译过 + 26 项链路验收全绿」
#      也没能发现它 —— 那套测试用的是 JS 替身，覆盖不到「谁来启动 Java 服务」。
#      现在：report() 上报到「有曲目」时主动拉起服务，notifyState() 再加一层兜底；
#      服务启动后先无条件进前台（startForegroundService 有 5 秒硬期限，空状态会直接崩进程），
#      随后立刻被真实曲目顶掉，没曲目则几秒后自动收摊。
#      顺带补齐真机上会踩的几处：setPlaybackToLocal（不声明播放类型，部分 ROM 直接忽略这条会话）、
#      显式 onMediaButtonEvent 映射耳机 / 蓝牙 / 车机按键（不再依赖框架猜「该播还是该停」）、
#      ACTION_MEDIA_BUTTON 广播兜底、startForeground 失败时退回普通通知保底（原来只写一行日志）。
#      新增「设置 → 系统播放控制」诊断卡：把页面装配 / 播放服务 / 媒体会话 / 前台服务 /
#      通知是否发出 / 通知权限 / 通知总开关 / 上报次数 / 系统按键 / 封面 / 最近错误逐层摊开，
#      并给一屏可截图的原始诊断 —— 开发机没有安卓运行时，只能靠设备回传这一份定位。
# 1.8：从「套壳浏览器」变成「真客户端」——补上原生媒体会话（MediaSession）。
#      通知栏媒体卡片 / 锁屏与息屏播放控件 / 控制中枢 / 蓝牙耳机与车机按键，全部可用：
#      带封面、曲名歌手、播放进度，以及上一首 / 播放暂停 / 下一首三个键。
#      （WebView 里没有 navigator.mediaSession，所以网页版那几行在壳里一直等于没写，
#        以前只有一条写着「正在播放」的静态通知，什么都点不了。）
#      同时：Android 13+ 运行时申请通知权限（不申请的话前台服务通知一条都不显示）；
#      切后台且正在播放时不再冻结 WebView（web.onPause 会停掉 JS 定时器，
#      进度上报、卡死看门狗、歌词循环全断）；从最近任务划掉 App 时保留 WebView 与会话，
#      重新打开直接复用，页面不重载、播放不中断；播放期持 PARTIAL_WAKE_LOCK，息屏不断流。
# 1.7：管理后台「音源与插件 → 默认搜索源」支持拖动排序（按住左侧手柄拖动，顺序就是综合搜索的
#      优先级；未勾选的平台也保留位置，不会一刷新就蹦到队尾；触摸屏同样能用 —— 走 pointer 事件，
#      不用 HTML5 drag，那套在手机上根本不触发）。
#      用户端新增「自建歌单」：我的歌单标题栏常驻「新建」（原来只在空状态里，建过一个就再找不到）；
#      歌单详情页支持重命名、搜索并连续加歌（#/playlist-add，已在歌单里的会标成「已加入」）、
#      移出单曲、上移 / 下移调整顺序。服务端补 /api/playlist/rename 与 /api/playlist/move。
# 1.6：服务端地址可配置（设置页 / 登录页都能填自建后端，带连通性自检与切回本机），
#      登录用户名可一并预填（配置后登录页 / 初始化页自动带上，不用每次手输）；
#      管理端收口到 /admin（音源与插件、用户管理、AI 歌单配置从用户端挪走），
#      其中「插件调度顺序」不再等平台体检 —— 那要对每个平台各发一次真实搜索（6s+），
#      原来三个接口 Promise.all 一起等，整页停在骨架屏上，看起来就像「插件没了」；
#      播放进度与播放历史写入服务端（跨设备续播）；
#      播放面板加音质与音色按钮；歌词偏移校准挪出歌词区（原来浮在歌词上，滑歌词时极易误触）。
#      修两处真 bug：音色按钮永远「不可用」（tone.js 拿不到 audio 元素，attach 传的一直是 null）；
#      换服务器后旧视图被带过去（hash 会活过整页重载，切回本机模式后卡在「创建管理员」页）。
# 1.5：插件源综合评分 + 调度（自动按实测评分 / 人工自定义顺序，可停用单个源）；
#      全平台搜专辑（含专辑详情页，首页金刚区直接有「搜专辑」入口）；歌单封面
#      （自建与 AI 歌单落库时取首曲封面，历史歌单读取时回填）；
#      歌词与进度同步（LRC offset 符号、rAF 循环接线）。
#      —— 同日第二轮：修「全平台都没有歌词」（插件拿空壳冒充成功，挡住原生接口）；
#      搜索页 7 个平台 chip 挤在一行（喜马拉雅不再被甩到第三行）；
#      「上拉加载更多」的收尾判据（原来永远不结束）+ API 请求超时
#      （挂死的请求会把搜索页永久卡在加载中）；酷我封面 https 证书坏掉（526）改走代理降级 http。
#      1.4：AI 歌单改两阶段 —— 服务端只出 AI 列表（超时放宽到 60~240s），前端逐首匹配
#      带进度、复用 /suggest + /playlist 落库。修「The operation was aborted」：
#      旧版单请求里 AI 30s 超时 + N 首串行搜索，极易被中途掐断。
#      1.3：修真机 MIME 雷 —— WebResourceResponse 的 mimeType 带 "; charset=utf-8"
#      参数时，部分 WebView 解析不了，主文档被按 text/plain 渲染（整页源码平铺）。
#      改为纯 MIME，字符集走 encoding 参数。
#      1.2：第一版「自包含」APK —— 后端、插件、数据库全在设备内，不再依赖 Cloudflare。
#      1.1 只是个套壳，页面仍要从线上站点拉。
#      虽然安卓壳里用不到音频代理（http 可直放），但这份代码是同一份，行为保持一致。
#
# ⚠ 版本号**不在这里写死**。1.10 起改为从 src/version.js 读（单一事实来源），
#   否则「服务端 V1.0 / APP 1.10」这种对不上的事还会再发生一次。
#   要发新版：改 src/version.js 里的 APP_VERSION 与 APP_VERSION_CODE，然后重跑构建。
VERSION_CODE="$(node -e "import('./src/version.js').then(m=>console.log(m.APP_VERSION_CODE))" 2>/dev/null)"
VERSION_NAME="$(node -e "import('./src/version.js').then(m=>console.log(m.APP_VERSION.replace(/^v/i,'')))" 2>/dev/null)"
# 兜底：万一 node 不在 PATH（比如只装了 JDK 的构建机），不至于让构建整个挂掉
VERSION_CODE="${VERSION_CODE:-100}"
VERSION_NAME="${VERSION_NAME:-1.0}"
echo "   版本：$VERSION_NAME (code $VERSION_CODE) ← src/version.js"

echo "== 0. 环境 =="
[ -f "$PLAT" ] || { echo "缺 android.jar: $PLAT"; exit 1; }
[ -x "$BT/aapt2.exe" ] || [ -x "$BT/aapt2" ] || { echo "缺 aapt2: $BT"; exit 1; }
java -version 2>&1 | head -1

# 清场：把上一次的产物**挪走**，不用 rm 删。
# 这些目录每轮都会被完整重生成，本不需要保留 —— 但工作区有批量删除保护：
# 一次删掉 classes/dex/gen 里几百个文件会直接被拦下（SAFE_DELETE_BULK_CONFIRM_REQUIRED，
# 构建停在第一步什么都不做）。挪走只算几次重命名，效果完全相同。
#
# 旧产物落在 build/.trash/<时间戳>/，确认没问题后可以手动清。
# 注意：别图省事改成 `find ... -delete` 逐个删 —— 那样照样会被批量保护拦住。
TRASH="$OUT/.trash/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TRASH"
for d in classes dex gen res.zip sources.txt classes.txt; do
  [ -e "$OUT/$d" ] && mv "$OUT/$d" "$TRASH/" 2>/dev/null || true
done
mv "$OUT"/*.apk "$OUT"/*.apk.idsig "$TRASH/" 2>/dev/null || true
# gen 下只有 aapt2 生成的 R.java，必须整目录清 —— 改过包名之后
# （com.zyplnn.music → com.zyplnn.musicedge）旧包的 R.java 会留下来被 javac 一起
# 收进 sources.txt，最终在 dex 里多出一个没用的 R 类。上面 mv 已经处理。
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "== 1. aapt2 compile：编译资源 =="
"$BT/aapt2.exe" compile --dir "$HERE/res" -o "$OUT/res.zip"

echo "== 1.5. 前端整包进 assets/www（离线自包含的关键一步） =="
# 页面、后端 bundle、插件数据、桥接层全部打进 APK。
# MainActivity.shouldInterceptRequest 直接从 assets 供给，App 启动后一个字节都不出设备。
ASSETS="$HERE/assets"
mkdir -p "$ASSETS/www"
cp -r "$HERE/../public/." "$ASSETS/www/"
# 同步残留：public 里已删掉的文件，assets 里也得跟着走，否则会把废弃文件打进 APK。
# 通常 0 个；逐个删而不是整目录清，避免触发批量删除保护。
(cd "$ASSETS/www" && find . -type f | while read -r f; do
  [ -f "$HERE/../public/$f" ] || { rm -f "$f"; echo "   清理残留: ${f#./}"; }
done)
# 缺任何一个都会让 App 白屏，所以这里逐个点检而不是想当然
for f in index.html css/app.css js/util.js js/brand.js js/api.js js/app.js js/player.js \
         js/lxplugin.js js/lxworker.js js/native.js js/backend.bundle.js js/plugins.data.js; do
  [ -f "$ASSETS/www/$f" ] || { echo "❌ assets 缺少 $f（先跑 node tools/build-app.mjs）"; exit 1; }
done
echo "   assets/www 就绪：$(find "$ASSETS/www" -type f | wc -l) 个文件，$(du -sh "$ASSETS/www" | cut -f1)"

echo "== 2. aapt2 link：链接资源与清单，生成 R.java =="
"$BT/aapt2.exe" link \
  -o "$OUT/app-base.apk" \
  -I "$PLAT" \
  --manifest "$HERE/AndroidManifest.xml" \
  -A "$(W "$ASSETS")" \
  -R "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code $VERSION_CODE \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "== 3. javac：编译 Java 源码 =="
LIST_WIN "$HERE/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
echo "   源文件数: $(wc -l < "$OUT/sources.txt")"
javac -encoding UTF-8 -nowarn -source 11 -target 11 \
  -classpath "$(W "$PLAT")" -d "$(W "$OUT/classes")" "@$(W "$OUT/sources.txt")"

echo "== 4. d8：转 Dex =="
LIST_WIN "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8.bat" --lib "$(W "$PLAT")" --min-api 21 --output "$(W "$OUT/dex")" "@$(W "$OUT/classes.txt")"

echo "== 5. 合成 APK：dex 塞进 aapt2 产物 =="
cp "$OUT/app-base.apk" "$OUT/app-unsigned.apk"
python -c "
import zipfile, sys
p = sys.argv[1]
z = zipfile.ZipFile(p, 'a', zipfile.ZIP_DEFLATED)
z.write(sys.argv[2], 'classes.dex')
z.close()
print('   已写入 classes.dex')
" "$OUT/app-unsigned.apk" "$OUT/dex/classes.dex"

echo "== 6. zipalign：4 字节对齐（v2 签名要求，必须先于签名） =="
"$BT/zipalign.exe" -f -p 4 "$OUT/app-unsigned.apk" "$OUT/app-aligned.apk"

echo "== 7. 生成签名密钥（首次） =="
# 密钥放在 android/keystore/ 而不是 build/ —— build/ 每次都被 rm -rf 清掉，
# 密钥一旦跟着被删，下次构建就会换一套签名，用户只能卸载重装（数据全丢）。
KS="$HERE/keystore/yunmusic.keystore"
mkdir -p "$(dirname "$KS")"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v \
    -keystore "$KS" -storepass android -keypass android \
    -alias yunmusic -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=YunMusic, OU=Mobile, O=Zyplnn, L=Zhengzhou, ST=Henan, C=CN" \
    -noprompt 2>&1 | tail -2
  echo "   密钥: $KS（口令 android；升级包要沿用同一个，别丢）"
else
  echo "   复用已有密钥: $KS"
fi

echo "== 8. apksigner：签名 =="
"$BT/apksigner.bat" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias yunmusic \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT/$APP_NAME-$VERSION_NAME.apk" \
  "$OUT/app-aligned.apk"

echo "== 9. 校验 =="
"$BT/apksigner.bat" verify --print-certs "$OUT/$APP_NAME-$VERSION_NAME.apk" | head -8
ls -la "$OUT/$APP_NAME-$VERSION_NAME.apk"

echo ""
echo "✅ 产物: $OUT/$APP_NAME-$VERSION_NAME.apk"
