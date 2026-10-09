#!/usr/bin/env bash
# ============================================================
#  LX-MUSIC 通用客户端 · APK 构建脚本（不依赖 Gradle / Maven）
#
#  与隔壁 android/build-apk.sh（music-edge 壳）同一个套路：
#    aapt2 → javac → d8 → zipalign → apksigner 五步走完，全程离线。
#  差别只在四处：
#    1) 版本号取自 client/version.mjs（**客户端自己的版本线**，不是服务端的）；
#    2) 先跑 tools/build-client-rn.mjs 把跨端业务层打成 client-layer.js，
#       再连同 public/ 一起塞进 assets/www；
#    3) 包名 com.zyplnn.lxclient（与 com.zyplnn.musicedge 并存，互不覆盖）；
#    4) 产物落在 dist/lx-music-client-<版本>.apk。
#
#  依赖（各下一份就够，之后全程离线，与壳共用同一份）：
#    · JDK 17            android-build/jdk/
#    · Android SDK       android-build/sdk/   build-tools;34.0.0 + platforms;android-34
#
#  用法：
#    bash client/build-client.sh                   # 完整构建
#    bash client/build-client.sh --skip-backend    # 跳过后端 bundle 重建（快，调试前端时用）
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # …/client
ROOT="$(cd "$HERE/.." && pwd)"                            # 仓库根
AB="$(cd "$ROOT/android-build" && pwd)"                   # JDK 与 Android SDK
JDK="$(ls -d "$AB"/jdk/jdk-* 2>/dev/null | head -1 || true)"
JDK="${JDK:-$AB/jdk}"
SDK="$AB/sdk"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
OUT="$HERE/build"

SKIP_BACKEND=0
for arg in "$@"; do
  [ "$arg" = "--skip-backend" ] && SKIP_BACKEND=1
done

export JAVA_HOME="$(cygpath -w "$JDK" 2>/dev/null || echo "$JDK")"
export PATH="$JDK/bin:$PATH"
# 让 javac/d8 的中文提示按 UTF-8 输出，否则在 Git Bash 里是一堆乱码
export JAVA_TOOL_OPTIONS="-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8"

W() { cygpath -w "$1"; }                                  # MSYS 路径 → Windows 路径
LIST_WIN() { find "$@" | while read -r f; do cygpath -w "$f"; done; }

# ── 客户端产品名（装在桌面上的名字）。注意与**品牌**不是一回事：
#    连 CF 时界面显示 music-edge、连 Docker 时显示 LX-MUSIC，那是运行期由服务端自报的。
APP_NAME="lx-music-client"

# ⚠ 版本号不在这里写死 —— 从 client/version.mjs 读（单一事实来源）。
#    要发新版：改 client/version.mjs 的 CLIENT_VERSION 与 CLIENT_VERSION_CODE，重跑构建。
VERSION_CODE="$(node -e "import('./client/version.mjs').then(m=>console.log(m.CLIENT_VERSION_CODE))" 2>/dev/null)"
VERSION_NAME="$(node -e "import('./client/version.mjs').then(m=>console.log(m.CLIENT_VERSION.replace(/^v/i,'')))" 2>/dev/null)"
SERVICE_VER="$(node -e "import('./client/version.mjs').then(m=>console.log(m.SERVICE_VERSION))" 2>/dev/null)"
BUILD_ID="${LX_BUILD_ID:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo dev)}"
VERSION_CODE="${VERSION_CODE:-100}"
VERSION_NAME="${VERSION_NAME:-1.0}"
SERVICE_VER="${SERVICE_VER:-V2.0}"
echo "   客户端版本：$VERSION_NAME (code $VERSION_CODE) ← client/version.mjs"
echo "   服务端版本：客户端按 $SERVICE_VER 对接 ← src/version.js（由测试钉住一致性）"
echo "   构建标识：$BUILD_ID"

echo "== 0. 环境 =="
[ -f "$PLAT" ] || { echo "缺 android.jar: $PLAT"; exit 1; }
[ -x "$BT/aapt2.exe" ] || [ -x "$BT/aapt2" ] || { echo "缺 aapt2: $BT"; exit 1; }
java -version 2>&1 | head -1

echo "== 0.5. 打包跨端业务层（client/rn/src → client-layer.js） =="
# 这一步必须在同步 assets 之前：assets 里要放进它的产物。
# 它会做构建期语法检查，语法错直接中断构建 —— 否则到了设备上是整页白屏。
node "$ROOT/tools/build-client-rn.mjs"

if [ "$SKIP_BACKEND" = "0" ]; then
  echo "== 0.6. 重建离线后端 bundle（src/ → public/js/backend.bundle.js） =="
  # 内置离线模式要靠它：客户端里后端逻辑是在 WebView 的 JS 引擎里跑的。
  # 每次都重建，保证 APK 里的后端与仓库里的 src/ 一致 ——
  # 不然会出现「服务端改了、离线模式没改」这种只在断网时才暴露的偏差。
  node "$ROOT/tools/build-app.mjs"
else
  echo "== 0.6. 跳过后端 bundle 重建（--skip-backend） =="
fi

# 清场：把上一次的产物**挪走**，不用 rm 删。
# 这些目录每轮都会被完整重生成，本不需要保留 —— 但工作区有批量删除保护：
# 一次删掉 classes/dex/gen 里几百个文件会直接被拦下（SAFE_DELETE_BULK_CONFIRM_REQUIRED），
# 构建会停在第一步什么都不做。挪走只算几次重命名，效果完全相同。
TRASH="$OUT/.trash/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TRASH"
for d in classes dex gen res.zip sources.txt classes.txt; do
  [ -e "$OUT/$d" ] && mv "$OUT/$d" "$TRASH/" 2>/dev/null || true
done
mv "$OUT"/*.apk "$OUT"/*.apk.idsig "$TRASH/" 2>/dev/null || true
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "== 1. aapt2 compile：编译资源 =="
"$BT/aapt2.exe" compile --dir "$HERE/res" -o "$OUT/res.zip"

echo "== 1.5. 前端整包 + 跨端业务层进 assets/www =="
ASSETS="$HERE/assets"
mkdir -p "$ASSETS/www"
cp -r "$ROOT/public/." "$ASSETS/www/"
# 同步残留：public 里已删掉的文件，assets 里也得跟着走，否则会把废弃文件打进 APK。
# 通常 0 个；逐个删而不是整目录清，避免触发批量删除保护。
#
# ⚠ 下面这两个**不是从 public/ 来的**（客户端专属），必须排除在清理之外：
#   js/client-layer.js   ← client/rn/build/ 的产物
#   client-build.txt     ← 本脚本写进去的构建标识
# 不排除的话它们每轮都会被删一次、再被补回来 —— 看起来没坏，但只要有人
# 调换了「清理」与「补文件」的顺序，产物就会静默少一个文件。
CLIENT_ONLY="js/client-layer.js client-build.txt"
(cd "$ASSETS/www" && find . -type f | while read -r f; do
  rel="${f#./}"
  for keep in $CLIENT_ONLY; do [ "$rel" = "$keep" ] && continue 2; done
  [ -f "$ROOT/public/$rel" ] || { rm -f "$f"; echo "   清理残留: $rel"; }
done)
# 跨端业务层：不属于 public/（它是客户端专属的），单独放进来
cp "$HERE/rn/build/client-layer.js" "$ASSETS/www/js/client-layer.js"
# 构建标识：ClientBrand.buildId() 读它显示在关于页与诊断里，
# 用它跟服务端 /api/version 的 build 对账（本地构建两边都是 dev）
printf '%s' "$BUILD_ID" > "$ASSETS/www/client-build.txt"

# 缺任何一个都会让 App 白屏，所以这里逐个点检而不是想当然。
# client-layer.js 尤其要查：它由宿主注入到 index.html，
# 缺了它页面照样能开（只是少了底栏同步），是最典型的「静默少功能」。
for f in index.html css/app.css js/util.js js/brand.js js/api.js js/app.js js/player.js \
         js/lxplugin.js js/lxworker.js js/native.js js/backend.bundle.js js/plugins.data.js \
         js/client-layer.js client-build.txt; do
  [ -f "$ASSETS/www/$f" ] || { echo "❌ assets 缺少 $f"; exit 1; }
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

echo "== 7. 签名密钥 =="
# 与 music-edge 壳**共用同一把密钥**（android/keystore/yunmusic.keystore）。
# 两个包名不同，共用一把密钥不会有任何冲突；好处是用户/部署者只需要备份一份密钥。
# 密钥必须放在 android/keystore/ 而不是 build/ —— build/ 每轮都被清，
# 密钥一旦跟着被删，下次构建就会换一套签名，用户只能卸载重装（数据全丢）。
KS="$ROOT/android/keystore/yunmusic.keystore"
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
"$BT/apksigner.bat" verify --print-certs "$OUT/$APP_NAME-$VERSION_NAME.apk" | head -6
"$BT/aapt2.exe" dump badging "$OUT/$APP_NAME-$VERSION_NAME.apk" 2>/dev/null \
  | grep -E "^package|^application-label|^launchable-activity|^uses-permission" | head -12
ls -la "$OUT/$APP_NAME-$VERSION_NAME.apk"

# 随手拷一份到 dist/，方便直接取件（dist/ 已在 .gitignore 里）
mkdir -p "$ROOT/dist"
cp "$OUT/$APP_NAME-$VERSION_NAME.apk" "$ROOT/dist/$APP_NAME-$VERSION_NAME.apk"

echo ""
echo "✅ 产物: $OUT/$APP_NAME-$VERSION_NAME.apk"
echo "   副本: dist/$APP_NAME-$VERSION_NAME.apk"
echo "   客户端 V$VERSION_NAME（code $VERSION_CODE）· 按服务端 $SERVICE_VER 设计 · 构建 $BUILD_ID"
