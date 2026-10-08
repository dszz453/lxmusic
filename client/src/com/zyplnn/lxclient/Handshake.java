package com.zyplnn.lxclient;

import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;

/**
 * 握手：连上一台服务器，问清楚「你是谁、哪一版、哪条线」。
 *
 * ── 判据为什么是 /api/version ───────────────────────────────────
 * 这个客户端要同时伺候 CF 与 Docker 两条线，两条线的品牌名、版本号都不同，
 * 而客户端**不该靠猜**。服务端在 /api/version 里自报三件事（见 src/server/api.js）：
 *
 *   host     —— 'cf' / 'docker'，由服务端的入口自己写死（src/index.js / server/index.mjs）
 *   version  —— 服务端产品版本，形如 V1.3（src/version.js）
 *   build    —— 构建标识（CI 传的 commit sha 前 12 位）
 *
 * 为什么不用响应头 / CDN 特征 / 页面标题：这些统统会被一层反向代理抹掉，
 * 而 host 是服务端**应用层**自己说的，反代改不了。
 *
 * ── 两个必须遵守的判据纪律（本项目踩过坑）──────────────────────
 * 1) **不能只看 HTTP 状态码**。镜像挂了、反代配错时经常回一个 200 的 HTML
 *    错误页；只看 200 就会把错误页当成「连上了」。所以必须**看正文**：
 *    要么能解析成带 version 字段的 JSON，要么明确报错。
 * 2) **超时预算要够**。域名解析 + TLS 握手在弱网下很容易超过 3 秒，
 *    超时给太紧会把「慢」误判成「不通」。
 *
 * 本类全部是**阻塞**调用，必须在工作线程里跑（调用点见 ServerActivity / BridgeHub）。
 */
public final class Handshake {

    private static final String TAG = "LXC/Handshake";

    /** 连接与读取超时。弱网下 TLS 握手本身就可能 2~3 秒，给 8 秒留足余量 */
    private static final int TIMEOUT_MS = 8000;

    /**
     * UA 用标准 Chrome 移动端，不用 HttpURLConnection 的默认值（"Java/1.x"）。
     * 理由与壳里一致：一部分音乐 CDN / 反代看到非浏览器 UA 会直接拒绝，
     * 而这个握手请求还会被用来判断「服务器活着」，UA 太怪会制造假阴性。
     */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    private Handshake() {
    }

    public static final class Result {
        /** 网络层是否顺利拿到了一份「像本项目的服务端」的应答 */
        public boolean ok;
        /** 归一化之后的基址（点「保存」时存的是它，不是用户手打的原文） */
        public String base = "";
        /** ok=false 时的原因，直接给用户看 */
        public String error = "";
        public int status = 0;
        public long ms = 0;

        /** 服务端自报：产品名 / 版本 / 品牌线 / 构建标识 / 一行式串 */
        public String app = "";
        public String version = "";
        public String host = "";
        public String build = "";
        public String full = "";
        public int versionCode = 0;

        /** 这台服务器还没建管理员（/api/setup-status 说的），连上后要引导创建 */
        public boolean needsSetup = false;
        /** 服务端版本与客户端期望的版本是否有差异（只提示，不阻断） */
        public boolean versionMismatch = false;

        /** 品牌键：由服务端自报的 host 得出，取不到时为空串（调用方退到档案类型兜底） */
        public String brandKey() {
            return ClientBrand.brandKeyOf(host);
        }

        public String brandName(String fallbackKey) {
            String k = brandKey();
            return ClientBrand.nameOf(k.isEmpty() ? fallbackKey : k);
        }
    }

    /**
     * 把用户随手写的东西归一成基址。
     *
     *   `192.168.1.9:8080`    → `http://192.168.1.9:8080`
     *   `music.abc.com`       → `https://music.abc.com`
     *   `https://a.com/api/`  → `https://a.com`
     *
     * 没写协议时的判据（与网页端 public/js/native.js 的 normalizeServer 同一套口径，
     * 两边必须一致，否则「网页里能填进去的地址、客户端里填了连不上」）：
     *   · IPv4 / IPv6 / localhost / 不带点的单段名 → http
     *     （这些基本都是内网地址，内网极少配证书；硬试 https 只会连不上）
     *   · 其余（含点的域名）→ https
     *   · 带端口**不参与判断**，否则 `a.com:8443` 会被误判成 http
     *
     * @return 归一化后的基址；输入为空时返回空串（调用方按「没填」处理）
     */
    public static String normalize(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return "";
        // 去掉末尾的斜杠与 /api（用户很容易连路径一起复制过来）
        s = s.replaceAll("/+$", "");
        s = s.replaceAll("(?i)/api$", "").replaceAll("/+$", "");

        if (s.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
            return s;
        }
        String hostPart = s;
        int slash = hostPart.indexOf('/');
        if (slash >= 0) hostPart = hostPart.substring(0, slash);
        int colon = hostPart.lastIndexOf(':');
        if (colon > 0 && hostPart.indexOf(']') < 0) hostPart = hostPart.substring(0, colon);
        // IPv6 字面量（[::1]）按内网处理
        boolean ipv6 = hostPart.startsWith("[");
        boolean localish = ipv6
                || hostPart.equalsIgnoreCase("localhost")
                || hostPart.matches("\\d{1,3}(\\.\\d{1,3}){3}")
                || (hostPart.indexOf('.') < 0 && !hostPart.isEmpty())
                || hostPart.startsWith("10.")
                || hostPart.startsWith("192.168.")
                || hostPart.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
        return (localish ? "http://" : "https://") + s;
    }

    /** 走一遍握手。**阻塞**：调用方负责放到工作线程 */
    public static Result probe(String input) {
        Result r = new Result();
        String base = normalize(input);
        r.base = base;
        if (base.isEmpty()) {
            r.error = "请先填写服务器地址";
            return r;
        }
        long t0 = System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            URL u = new URL(base + "/api/version");
            conn = (HttpURLConnection) u.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Cache-Control", "no-cache");
            int status = conn.getResponseCode();
            r.status = status;
            String body = status >= 400 ? readStream(conn.getErrorStream()) : readStream(conn.getInputStream());
            r.ms = System.currentTimeMillis() - t0;

            if (status != 200) {
                r.error = "服务器返回 HTTP " + status
                        + (status == 404 ? "（地址可能不对，或那台不是本项目的服务端）" : "");
                return r;
            }
            r.error = "";

            // ⚠ 到这里**还不能**说连上了：200 也可能是反代/镜像的错误页。
            // 必须看正文像不像本项目的服务端 —— 见类注释第 1 条判据纪律。
            String trimmed = body == null ? "" : body.trim();
            if (trimmed.isEmpty()) {
                r.error = "响应是空的，不像本项目的服务端";
                return r;
            }
            if (trimmed.startsWith("<")) {
                r.error = "拿回来的是一个网页而不是接口数据 —— 这个地址多半是反代或网关的错误页";
                return r;
            }
            JSONObject o;
            try {
                o = new JSONObject(trimmed);
            } catch (Throwable t) {
                r.error = "响应不是 JSON，不像本项目的服务端";
                return r;
            }
            r.app = o.optString("app", "");
            r.version = o.optString("version", "");
            r.versionCode = o.optInt("versionCode", 0);
            r.build = o.optString("build", "");
            r.full = o.optString("full", "");
            // host 可能是 null（服务端是尚未升级的老版本），optString 会给 "null" 字符串，
            // 这里统一收成空串 —— 否则品牌判定会拿到一个字面量 "null"。
            String h = o.isNull("host") ? "" : o.optString("host", "");
            r.host = "null".equals(h) ? "" : h;

            if (r.version.isEmpty() && r.full.isEmpty()) {
                r.error = "接口应答里没有 version 字段 —— 这个地址上的服务不是本项目的";
                return r;
            }
            if (r.version.isEmpty() && !r.full.isEmpty()) {
                // 老版本服务端可能只给 full，从 "lxmusic V1.3 (sha)" 里抠出 V1.3
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("(V?\\d+(?:\\.\\d+)+)").matcher(r.full);
                if (m.find()) r.version = m.group(1);
            }
            r.versionMismatch = !r.version.isEmpty()
                    && ClientBrand.compareVersion(r.version, ClientBrand.SERVICE_EXPECT) != 0;
            r.ok = true;
            Log.i(TAG, "握手成功 " + r.base + " → " + r.version + " host=" + r.host + " " + r.ms + "ms");
            return r;
        } catch (Throwable t) {
            r.ms = System.currentTimeMillis() - t0;
            r.error = describe(t);
            return r;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /**
     * 顺带问一句「这台服务器建过管理员没有」，连上之后要据此决定是引导创建还是跳登录。
     *
     * 单独一个方法、单独一次请求：它失败**不影响**握手结论（服务器可能是老版本、
     * 或者只读），所以异常一律吞掉，返回 false 让界面按「已建过」处理。
     */
    public static boolean needsSetup(String base) {
        if (base == null || base.isEmpty()) return false;
        HttpURLConnection conn = null;
        try {
            URL u = new URL(base + "/api/setup-status");
            conn = (HttpURLConnection) u.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return false;
            String body = readStream(conn.getInputStream());
            JSONObject o = new JSONObject(body == null ? "{}" : body.trim());
            return o.optBoolean("needsSetup", false);
        } catch (Throwable t) {
            return false;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /** 把异常翻译成用户能看懂的一句话。原始的 "Connection refused" 对普通用户等于没说 */
    private static String describe(Throwable t) {
        String msg = t.getMessage() == null ? String.valueOf(t) : t.getMessage();
        String low = msg.toLowerCase();
        if (t instanceof java.net.SocketTimeoutException) {
            return "连接超时（" + (TIMEOUT_MS / 1000) + " 秒）—— 地址不通，或被网络挡了";
        }
        if (t instanceof java.net.UnknownHostException) {
            return "域名解析不了：检查地址有没有打错";
        }
        if (t instanceof javax.net.ssl.SSLException) {
            return "TLS 握手失败：这台可能只有 http，或证书不被信任（内网自签证书常见）";
        }
        if (low.contains("failed to connect") || low.contains("econnrefused")) {
            return "端口拒绝连接：服务没起来，或端口不对";
        }
        return msg;
    }

    private static String readStream(InputStream in) {
        if (in == null) return "";
        BufferedReader rd = null;
        try {
            rd = new BufferedReader(new InputStreamReader(in, Charset.forName("UTF-8")));
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            // 上限 256KB：够放下 /api/version 与任何错误页，又不至于被一个超大页面拖住
            while ((n = rd.read(buf)) > 0 && sb.length() < 262144) sb.append(buf, 0, n);
            return sb.toString();
        } catch (Throwable t) {
            return "";
        } finally {
            try {
                if (rd != null) rd.close();
            } catch (Throwable ignore) {
            }
        }
    }
}
