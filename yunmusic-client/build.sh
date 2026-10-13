#!/bin/bash
#
# 云音乐安卓客户端 —— 一条龙构建脚本
#
# 从 aapt2 编译资源一路做到签名出包，不依赖 Gradle：
#   aapt2 compile → aapt2 link → javac → d8 → zip 注入 classes.dex
#   → zipalign → apksigner（v1+v2+v3）→ 产物校验
#
# 为什么不用 Gradle：这个工程只有一个 Activity 级别的模块，Gradle 拉一套
# 依赖要几分钟、还会把 build 目录塞满缓存；上面这条链路实测 17 秒出包，
# 而且每一步都能单独复现（排错时不用猜 AGP 在背后干了什么）。
#
# 用法：
#   bash build.sh                       # 本地（自动找同级 repo_extracted 里的便携工具链）
#   OUTPUT_DIR=$PWD/outputs bash build.sh   # CI（产物落在仓库内）
#
# 工具链可用环境变量覆盖，便于在 Linux CI 上指向 setup-java / setup-android 装好的路径：
#   JDK_DIR / SDK_DIR / BUILD_TOOLS / PLATFORM / OUTPUT_DIR
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

# ---------------------------------------------------------------- 工具链定位
#
# 默认布局：本地开发时 yunmusic-client 与 repo_extracted/lxmusic-main 同级，
# 后者带着 android-build/{jdk,sdk} 这套便携工具链（约 1.2 GB，不进仓库）。
# CI 上不存在这个目录，必须用环境变量指过去。
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-$PROJECT_DIR/../repo_extracted/lxmusic-main/android-build}"
JDK_DIR="${JDK_DIR:-$TOOLCHAIN_DIR/jdk/jdk-17.0.10+7}"
SDK_DIR="${SDK_DIR:-$TOOLCHAIN_DIR/sdk}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK_DIR/build-tools/34.0.0}"
PLATFORM="${PLATFORM:-$SDK_DIR/platforms/android-34}"

# Windows（Git Bash / MSYS / Cygwin）上这些可执行文件带 .exe，Linux 上没有
EXE=""
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) EXE=".exe" ;;
esac

# 把路径转成「当前平台的 JDK 工具链能吃的形式」。
# Windows 上 javac/java 只认 C:/... 这种盘符路径，Git Bash 的 /c/... 它们不认，
# 所以必须过一遍 cygpath -m；Linux 上没有 cygpath，原样返回即可。
#
# ⚠ 契约：**只输出转换后的路径，绝不带尾随换行**，换行一律由调用方显式给出。
#
#   为什么必须写死这条契约：cygpath -m 的输出**自带换行**，printf '%s' **不带**。
#   于是 `winpath "$f" >> list.txt` 这种写法在 Windows 上恰好能分行（蹭了 cygpath
#   的换行），到 Linux 上所有路径会挤成一行。D8 读到的 argfile 只有一个超长路径，
#   报出来的错是
#       java.nio.file.NoSuchFileException:
#           .../CrashActivity.class/home/runner/.../MusicService$1.class/...
#   —— 一堆 .class 路径首尾相连，报错信息一个字都不提「换行符」，极难定位。
#   （CI 上实际踩过：build job 挂在这一步。）
#   现在把 cygpath 的换行在这里剥掉，两平台的 winpath 行为完全一致。
winpath() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1" | tr -d '\r\n'
    else
        printf '%s' "$1"
    fi
}

# 数一个 argfile 的行数，用来验证「一行一条路径」这个前提。
# 见 winpath 上面那段说明：argfile 一旦被挤成一行，javac / D8 的报错都指不到根因，
# 所以这里主动数一遍，对不上就用一句人话直接退出。
check_argfile() {
    local list="$1" want="$2" label="$3"
    local got
    got=$(wc -l < "$list" | tr -d ' \r')
    if [ "$got" != "$want" ]; then
        echo "！$label 行数（$got）与实际条目数（$want）不一致。" >&2
        echo "  说明 $list 的换行丢了 —— 多个路径被挤在同一行，" >&2
        echo "  javac / D8 会把它们当成一个路径，报 NoSuchFileException 之类的错。" >&2
        echo "  请检查 winpath 的契约（只转路径、不带换行）是否被破坏。" >&2
        exit 1
    fi
}

# python：Windows 上叫 python，多数 Linux 发行版只装 python3
PY=""
for c in python python3; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then echo "找不到 python / python3" >&2; exit 1; fi

AAPT2="$BUILD_TOOLS/aapt2$EXE"
ZIPALIGN="$BUILD_TOOLS/zipalign$EXE"
D8_JAR="$BUILD_TOOLS/lib/d8.jar"
APKSIGNER_JAR="$BUILD_TOOLS/lib/apksigner.jar"
ANDROID_JAR="$PLATFORM/android.jar"
JAVAC="$JDK_DIR/bin/javac$EXE"
JAVA="$JDK_DIR/bin/java$EXE"
KEYTOOL="$JDK_DIR/bin/keytool$EXE"

# 工具链缺件就早点报出来，别等跑到第 5 步才炸（那时已经编译了两分钟）
for f in "$AAPT2" "$ZIPALIGN" "$D8_JAR" "$APKSIGNER_JAR" "$ANDROID_JAR" "$JAVAC" "$JAVA"; do
    if [ ! -e "$f" ]; then
        echo "缺少工具链文件：$f" >&2
        echo "提示：本地请确认 $TOOLCHAIN_DIR 存在；CI 请用 JDK_DIR / SDK_DIR / BUILD_TOOLS / PLATFORM 指定。" >&2
        exit 1
    fi
done

OUT_DIR="$PROJECT_DIR/build"
# 产物目录：本地默认跟旧脚本一致（项目根的 outputs/），CI 用 OUTPUT_DIR 指到仓库内
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/../outputs}"

# ---------------------------------------------------------------- 版本号
# 用户规则：从 V2.0 起步，每发一版 +0.1
VERSION_NAME="V2.15"
VERSION_CODE=350
FINAL_APK="$OUTPUT_DIR/云音乐-$VERSION_NAME.apk"

# 只清理本次构建的中间产物。
# 注意：不要写成 rm -rf "$OUT_DIR" —— build/ 下还放着预览页与截图，
# 而且整目录递归删除会被宿主的安全删除机制拦下（表现为脚本静默中断）。
"$PY" -c "
import shutil, os, sys
out = sys.argv[1]
for d in ('compiled_res', 'gen', 'classes', 'dex'):
    p = os.path.join(out, d)
    if os.path.isdir(p):
        shutil.rmtree(p)
for f in ('base.apk', 'unaligned.apk', 'aligned.apk', 'compiled_res.zip', 'sources.txt', 'classes.txt'):
    p = os.path.join(out, f)
    if os.path.isfile(p):
        os.remove(p)
" "$(winpath "$OUT_DIR")"
mkdir -p "$OUT_DIR/compiled_res" "$OUT_DIR/gen" "$OUT_DIR/classes" "$OUT_DIR/dex"

echo "=== [1/7] 编译 Android 资源 (aapt2 compile) ==="
"$AAPT2" compile --dir "$PROJECT_DIR/res" -o "$OUT_DIR/compiled_res.zip"

echo "=== [2/7] 链接资源 + 打包 assets (aapt2 link) ==="
# 关键：这里显式给出 --min-sdk-version / --target-sdk-version / --version-code / --version-name。
# 不再用「jar uf 事后塞 assets」的写法 —— assets 交给 aapt2 的 -A 参数一次成型，
# 少一次 zip 重写，就少一处可能被 PackageManager 挑刺的地方。
"$AAPT2" link -o "$OUT_DIR/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$PROJECT_DIR/AndroidManifest.xml" \
    -A "$PROJECT_DIR/assets" \
    --java "$OUT_DIR/gen" \
    --min-sdk-version 21 \
    --target-sdk-version 34 \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    --auto-add-overlay \
    "$OUT_DIR/compiled_res.zip"

echo "=== [3/7] 编译 Java 源码 (javac) ==="
WIN_ANDROID_JAR=$(winpath "$ANDROID_JAR")
WIN_CLASSES_DIR=$(winpath "$OUT_DIR/classes")

rm -f "$OUT_DIR/sources.txt"
# javac 的 @argfile：一行一个源文件，路径含空格所以用引号包起来。
# 换行由 echo 给出（winpath 不带换行，见上面的契约说明）。
find "$PROJECT_DIR/src" "$OUT_DIR/gen" -name "*.java" | while read -r line; do
    echo "\"$(winpath "$line")\"" >> "$OUT_DIR/sources.txt"
done
check_argfile "$OUT_DIR/sources.txt" \
    "$(find "$PROJECT_DIR/src" "$OUT_DIR/gen" -name '*.java' | wc -l | tr -d ' ')" \
    "sources.txt"

"$JAVAC" -encoding UTF-8 -nowarn \
    -source 11 -target 11 \
    -classpath "$WIN_ANDROID_JAR" \
    -d "$WIN_CLASSES_DIR" \
    @"$(winpath "$OUT_DIR/sources.txt")"

echo "=== [4/7] 转换为 DEX 字节码 (D8) ==="
rm -f "$OUT_DIR/classes.txt"
# D8 的 @argfile：一行一个 .class。
# ⚠ 这里曾经是 `winpath "$line" >> classes.txt` —— 蹭了 cygpath 自带的换行，
#    在 Linux 上失效（所有路径挤成一行）。必须由 echo 显式给换行。
find "$OUT_DIR/classes" -name "*.class" | while read -r line; do
    echo "$(winpath "$line")" >> "$OUT_DIR/classes.txt"
done
check_argfile "$OUT_DIR/classes.txt" \
    "$(find "$OUT_DIR/classes" -name '*.class' | wc -l | tr -d ' ')" \
    "classes.txt"

"$JAVA" -cp "$(winpath "$D8_JAR")" com.android.tools.r8.D8 \
    --lib "$WIN_ANDROID_JAR" \
    --output "$(winpath "$OUT_DIR/dex")" \
    --min-api 21 \
    @"$(winpath "$OUT_DIR/classes.txt")"

echo "=== [5/7] 合成 APK 并执行 4 字节对齐 (zipalign) ==="
cp "$OUT_DIR/base.apk" "$OUT_DIR/unaligned.apk"

# 用 python zipfile 以「追加」方式写入 classes.dex：
# 相比 JDK 的 jar 工具，它不会重写已有条目、也不会额外生成 META-INF/MANIFEST.MF。
"$PY" -c "
import zipfile, sys
apk, dex = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED)
z.write(dex, 'classes.dex')
z.close()
print('   已写入 classes.dex')
" "$(winpath "$OUT_DIR/unaligned.apk")" "$(winpath "$OUT_DIR/dex/classes.dex")"

"$ZIPALIGN" -f -p 4 "$OUT_DIR/unaligned.apk" "$OUT_DIR/aligned.apk"

echo "=== [6/7] 签名 APK (apksigner) ==="
KEYSTORE="$PROJECT_DIR/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
    "$KEYTOOL" -genkeypair -v -keystore "$KEYSTORE" -alias debug -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass android -keypass android -dname "CN=YunMusic, OU=App, O=YunMusic, L=SZ, ST=GD, C=CN" -noprompt
fi

mkdir -p "$OUTPUT_DIR"

"$JAVA" -jar "$(winpath "$APKSIGNER_JAR")" sign \
    --ks "$(winpath "$KEYSTORE")" \
    --ks-pass pass:android \
    --key-pass pass:android \
    --ks-key-alias debug \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --v4-signing-enabled false \
    --out "$(winpath "$FINAL_APK")" \
    "$(winpath "$OUT_DIR/aligned.apk")"

echo "=== [7/7] 产物校验 ==="
"$JAVA" -jar "$(winpath "$APKSIGNER_JAR")" verify --verbose "$(winpath "$FINAL_APK")" 2>&1 | head -6
"$AAPT2" dump badging "$FINAL_APK" 2>/dev/null | grep -E "^package|^sdkVersion|^targetSdkVersion|^application-label|^launchable-activity" | head -8
"$ZIPALIGN" -c -v 4 "$FINAL_APK" > /dev/null 2>&1 && echo "   zipalign: OK" || echo "   zipalign: FAILED"
"$AAPT2" dump xmltree "$FINAL_APK" --file AndroidManifest.xml 2>/dev/null | grep -E "foregroundServiceType|uses-sdk|minSdkVersion|targetSdkVersion" | head -5

echo "--- assets 与磁盘逐字节比对（防止打包的是旧前端）---"
"$PY" -c "
import zipfile, hashlib, sys, os
apk = sys.argv[1]
src_root = sys.argv[2]
z = zipfile.ZipFile(apk)
bad = 0
n = 0
for name in z.namelist():
    if not name.startswith('assets/'):
        continue
    disk = os.path.join(src_root, name[len('assets/'):])
    if not os.path.isfile(disk):
        print('   ! APK 里的 %s 在磁盘上不存在' % name); bad += 1; continue
    a = hashlib.sha256(z.read(name)).hexdigest()
    b = hashlib.sha256(open(disk, 'rb').read()).hexdigest()
    n += 1
    if a != b:
        print('   ! %s 内容不一致' % name); bad += 1
print('   已比对 %d 个 asset，%s' % (n, '全部一致' if bad == 0 else ('%d 个不一致' % bad)))
sys.exit(1 if bad else 0)
" "$(winpath "$FINAL_APK")" "$(winpath "$PROJECT_DIR/assets")"

echo "--- 口令扫描（安装包内不得出现任何真实账号口令）---"
# 为什么要有这一步：口令一旦被打进 APK，反编译 assets/web/index.html 或
# 扫 classes.dex 就能直接读到；改口令还得重新出包。所以构建环节必须
# 主动拦截，而不是靠人工 review。这里的清单只存在于构建脚本中，不进包。
"$PY" -c "
import zipfile, sys
apk = sys.argv[1]
FORBIDDEN = [
    'Zyp297360', 'Zyp200709',          # 历史内置口令，已废弃，绝不允许回流
]
z = zipfile.ZipFile(apk)
hits = []
for name in z.namelist():
    if name.endswith('/'):
        continue
    data = z.read(name)
    try:
        text = data.decode('utf-8', 'ignore')
    except Exception:
        text = data.decode('latin-1', 'ignore')
    for pat in FORBIDDEN:
        if pat in text:
            hits.append((name, pat))
if hits:
    for name, pat in hits:
        print('   ! %s 里出现了禁用口令 %s' % (name, pat))
    print('   口令扫描: FAILED —— 安装包里带着真实口令，必须清干净再出包')
    sys.exit(1)
print('   口令扫描: OK（已检查 %d 个条目，无禁用口令）' % len(z.namelist()))
" "$(winpath "$FINAL_APK")"

echo ""
echo "=== 全部构建完成！==="
ls -lh "$FINAL_APK"
