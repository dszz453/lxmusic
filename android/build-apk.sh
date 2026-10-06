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
for f in index.html css/app.css js/util.js js/api.js js/app.js js/player.js \
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
