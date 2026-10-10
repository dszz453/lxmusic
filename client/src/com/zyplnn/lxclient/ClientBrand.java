package com.zyplnn.lxclient;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.util.Log;

/**
 * 客户端的「自我认知」：我叫什么名字、我是哪一版、我期望跟哪一版服务端说话。
 *
 * ── 为什么名字不写死 ────────────────────────────────────────────
 * 这个客户端是**通用**的：同一份 APK 既能连 Cloudflare 那条线、也能连 Docker
 * 自托管那条线。而这两条线在这份代码里各自有自己的品牌名（见 public/js/brand.js
 * 的 NAMES）：
 *
 *   · Docker 自托管 → LX-MUSIC
 *   · Cloudflare Worker（含 CF 上的网页端）→ music-edge
 *
 * 判据**不是**本地配置猜出来的，而是**服务端自报**：握手时读 /api/version 的
 * host 字段（服务端入口自己写的 'cf' / 'docker'）。这比看响应头、看 CDN 特征
 * 可靠得多 —— 那些经过一层反向代理就没了。
 *
 * 客户端自己的名字（桌面图标上那个）是另一件事，固定为 LX-MUSIC：
 * 它是「这个 App 叫什么」，不该因为连了哪台服务器而变 —— 否则用户的桌面图标
 * 会自己改名，那才是真的怪。
 *
 * ── 版本为什么从 PackageManager 读 ──────────────────────────────
 * 不在这里写常量。build-client.sh 在 aapt2 link 时把 client/version.mjs 里的
 * 版本号写进清单，运行时再读回来 —— 这样「APK 属性里看到的版本」与
 * 「界面上显示的版本」永远不可能不一致（写两份常量迟早会漂移，本项目吃过这亏）。
 */
public final class ClientBrand {

    private static final String TAG = "LXC/Brand";

    private ClientBrand() {
    }

    /* ---------------- 名字 ---------------- */

    /** 客户端自身的产品名。装到桌面上、关于页抬头都用它 */
    public static final String CLIENT_NAME = "LX-MUSIC";

    /** Docker / 本机 node 那条线的品牌名。必须与 public/js/brand.js 的 NAMES.docker 一致 */
    public static final String NAME_DOCKER = "LX-MUSIC";

    /** Cloudflare Worker 那条线的品牌名。必须与 public/js/brand.js 的 NAMES.cf 一致 */
    public static final String NAME_CF = "music-edge";

    /**
     * 服务端自报的 host 字段 → 品牌键（'cf' | 'docker'）。
     *
     * 取值表与 public/js/brand.js 的 HOST_MAP 保持同一份口径 —— 多认几个别名
     * （worker / cloudflare / node）是为了容忍服务端以后改叫法，
     * 而不是让客户端去猜。认不出来返回空串，调用方退到「按用户选的档位」判断。
     *
     * @param rawHost /api/version 的 host 字段，可为 null
     * @return 'cf' / 'docker' / ''（未知）
     */
    public static String brandKeyOf(String rawHost) {
        String h = rawHost == null ? "" : rawHost.trim().toLowerCase();
        if (h.isEmpty()) return "";
        if (h.equals("cf") || h.equals("worker") || h.equals("cloudflare")) return "cf";
        if (h.equals("docker") || h.equals("node")) return "docker";
        return "";
    }

    /** 品牌键 → 展示名。未知键按 docker 那条线（与 brand.js 的兜底一致） */
    public static String nameOf(String brandKey) {
        return "cf".equals(brandKey) ? NAME_CF : NAME_DOCKER;
    }

    /**
     * 这条线是「内置离线」时显示什么名字。
     *
     * 内置模式跑的是从 CF 那条线打包下来的同一份前端与后端 bundle（见 build-client.sh
     * 的 assets 同步），所以沿用 CF 的名字 —— 显示成别的名字反而与它实际跑的东西不符。
     */
    public static String builtinName() {
        return NAME_CF;
    }

    /* ---------------- 版本 ---------------- */

    /**
     * 客户端期望对接的服务端版本。
     *
     * ⚠️ 这个值必须与 src/version.js 的 APP_VERSION 一致 —— 由
     * test/client-wiring.test.mjs 钉住（两边抠出来比对），改了服务端版本忘了改这里会报红。
     *
     * 它的用途只有一个：握手后如果服务端回了个**不同的**版本，在服务器页给一句提示。
     * 只提示、不阻断 —— 差一格版本通常仍然可用，硬拦会把用户锁在门外。
     */
    public static final String SERVICE_EXPECT = "V2.5";

    /** 客户端自己的版本名（形如 "1.0"）。读不到时给兜底，不让界面显示 null */
    public static String versionName(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            String n = pi.versionName;
            return n == null || n.isEmpty() ? "0.0" : n;
        } catch (Throwable t) {
            Log.w(TAG, "读客户端版本号失败: " + t.getMessage());
            return "0.0";
        }
    }

    /** 客户端构建号（versionCode） */
    public static long versionCode(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 带 V 前缀的展示名（形如 "V1.0"），与 src/version.js 的 APP_VERSION 写法对齐 */
    public static String versionLine(Context ctx) {
        return "V" + versionName(ctx).replaceFirst("^[Vv]", "");
    }

    /**
     * 构建标识（CI 传的 commit sha 前 12 位；本地构建是 dev）。
     *
     * 为什么读 assets 里的小文件、而不是生成一个 Java 常量类：
     *   · 生成 Java 意味着「没跑构建脚本就编译不过」（一个找不到的类），
     *     而这份工程是希望**能被 Android Studio 直接打开**的（见 AndroidManifest 说明）；
     *   · 生成 res 里的 string 也不行：同一个 string 名在主 res 与生成 res 里各有一份，
     *     aapt2 会报重复资源（靠 --auto-add-overlay 抢顺序太脆）。
     * 放 assets 则是纯运行时读取、读不到就退化成 dev，编译期零依赖。
     *
     * 这个值要和「服务端 /api/version 的 build」对得上，排查「是不是同一个提交」时
     * 不用来回猜 —— 本地构建两边都是 dev，CI 构建两边都是同一个 sha。
     */
    public static String buildId(Context ctx) {
        java.io.InputStream in = null;
        try {
            in = ctx.getAssets().open("www/client-build.txt");
            byte[] buf = new byte[64];
            int n = in.read(buf);
            if (n <= 0) return "dev";
            String s = new String(buf, 0, n, "UTF-8").trim();
            return s.isEmpty() ? "dev" : s;
        } catch (Throwable t) {
            return "dev";
        } finally {
            try {
                if (in != null) in.close();
            } catch (Throwable ignore) {
            }
        }
    }

    /**
     * 版本比较：把 "V1.3" / "1.3.1" 这种切成数字段比大小。
     *
     * @return 负数 = a 比 b 旧；0 = 同级；正数 = a 比 b 新。
     *         解析不出数字时按 0 处理（宁可当成同级，也不要因为格式怪就报「不兼容」）。
     */
    public static int compareVersion(String a, String b) {
        int[] x = parse(a);
        int[] y = parse(b);
        int n = Math.max(x.length, y.length);
        for (int i = 0; i < n; i++) {
            int xi = i < x.length ? x[i] : 0;
            int yi = i < y.length ? y[i] : 0;
            if (xi != yi) return xi < yi ? -1 : 1;
        }
        return 0;
    }

    private static int[] parse(String v) {
        if (v == null) return new int[0];
        String[] parts = v.trim().replaceFirst("^[Vv]", "").split("[^0-9]+");
        int n = 0;
        for (String p : parts) if (!p.isEmpty()) n++;
        int[] out = new int[n];
        int i = 0;
        for (String p : parts) {
            if (p.isEmpty()) continue;
            try {
                out[i++] = Integer.parseInt(p);
            } catch (Throwable t) {
                out[i++] = 0;
            }
        }
        return out;
    }
}
