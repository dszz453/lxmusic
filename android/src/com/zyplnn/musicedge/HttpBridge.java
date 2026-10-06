package com.zyplnn.musicedge;

import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * 出站 HTTP 桥。
 *
 * 为什么需要它：
 *   网页发跨域请求会被同源策略拦下 —— 各家音乐源站基本不会回
 *   Access-Control-Allow-Origin，所以搜索、取流解析这类调用在浏览器里根本发不出去。
 *   原生侧发请求没有这层限制，于是把整条出站链路搬到这里：
 *   页面调 httpRequest(id, reqJson)，本类在后台线程发请求，
 *   完成后用 evaluateJavascript 把结果回投给 window.__LXB_HTTP(id, payloadJson)。
 *
 * 为什么是异步的：
 *   @JavascriptInterface 的同步方法跑在 WebView 的 JS 线程上，会串行化所有请求。
 *   一次搜索要并发打 4~5 个平台，串行会把耗时从 1 秒拖到 4 秒以上。
 *   所以这里用线程池 + 异步回投，页面侧用 Promise 等待，语义上仍是并发。
 *
 * 为什么要自己跟重定向：
 *   各家音源的直链跳转经常跨协议（https → http），HttpURLConnection 的
 *   自动跟随在这种场景下并不总是生效，直接表现为「明明有地址却下载失败」。
 *   手动跟 5 跳更可控，也能把每一跳记进日志。
 */
public class HttpBridge {

    private static final String TAG = "LXB/Http";

    /** 与 MainActivity 里的 UA 保持一致：WebView 默认 UA 带 "; wv"，部分 CDN 会据此拒绝 */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /** 文本类响应上限 4MB，二进制 8MB —— 超过就按错误返回，避免把 WebView 撑爆 */
    private static final int MAX_TEXT = 4 * 1024 * 1024;
    private static final int MAX_BIN = 8 * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;

    /** 并发度：同时 6 个够覆盖一次搜索（4 源）+ 取流解析的并发探测 */
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    private static volatile HttpBridge instance;

    /**
     * 全局单例。
     *
     * 原来的写法是 MainActivity 每次 onCreate 建一个、onDestroy 关掉。加了「划掉最近任务
     * 仍在播放」之后这个生命周期就不成立了：Activity 会被销毁，但页面里的请求还在飞，
     * 而线程池一关，在途的取流解析全部作废。桥跟着进程走，与 Activity 无关。
     */
    public static HttpBridge get() {
        HttpBridge local = instance;
        if (local == null) {
            synchronized (HttpBridge.class) {
                local = instance;
                if (local == null) {
                    local = new HttpBridge();
                    instance = local;
                }
            }
        }
        return local;
    }

    private HttpBridge() {
    }

    @JavascriptInterface
    public void httpRequest(final String id, final String reqJson) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String payload;
                try {
                    payload = execute(reqJson);
                } catch (Throwable t) {
                    payload = errorPayload(String.valueOf(t.getMessage() != null ? t.getMessage() : t));
                }
                deliver(id, payload);
            }
        });
    }

    @JavascriptInterface
    public void shutdown() {
        try {
            pool.shutdownNow();
        } catch (Throwable ignore) {
        }
        // 关了就别再被人拿到：本项目里单例只在「真正退出 App」时关闭，
        // 但万一以后有人提前调，这里保证下次 get() 会重新建一个可用的。
        synchronized (HttpBridge.class) {
            if (instance == this) instance = null;
        }
    }

    /* ---------------- 结果回投 ---------------- */

    private void deliver(String id, String payloadJson) {
        // 回投交给 MediaBridge —— 它持有「当前 WebView」，而 WebView 可能已经
        // 随着 Activity 重建换过一轮了；这里存一份自己的引用早晚会投到废弃的那个上。
        MediaBridge.eval("__LXB_HTTP(" + JSONObject.quote(id) + "," + JSONObject.quote(payloadJson) + ")");
    }

    /* ---------------- 实际请求 ---------------- */

    private String execute(String reqJson) throws IOException, JSONException {
        JSONObject req = new JSONObject(reqJson);
        String rawUrl = req.getString("url");
        String method = req.optString("method", "GET");
        int timeout = req.optInt("timeout", 20000);
        JSONObject headers = req.optJSONObject("headers");
        String body = req.isNull("body") ? null : req.optString("body", null);

        String currentUrl = rawUrl;
        String currentMethod = method;
        String currentBody = body;

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = open(currentUrl, currentMethod, timeout, headers, currentBody);
            int status = conn.getResponseCode();

            if (status >= 300 && status < 400) {
                String loc = conn.getHeaderField("Location");
                closeQuietly(conn);
                if (loc == null || loc.isEmpty()) {
                    return errorPayload("重定向缺少 Location：" + currentUrl);
                }
                // 相对跳转要按当前地址补全
                currentUrl = new URL(new URL(currentUrl), loc).toString();
                Log.d(TAG, "重定向 " + status + " → " + currentUrl);
                // 303 / 302 视为 GET；其余保留原方法
                if (status == 303 || status == 302) {
                    currentMethod = "GET";
                    currentBody = null;
                }
                continue;
            }
            return readResponse(conn, status, currentUrl);
        }
        return errorPayload("重定向次数过多：" + rawUrl);
    }

    private HttpURLConnection open(String url, String method, int timeout,
                                   JSONObject headers, String body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(Math.min(timeout, 15000));
        conn.setReadTimeout(timeout);
        // 自己跟重定向：跨协议的自动跟随不可靠
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Accept-Encoding", "gzip, deflate");

        if (headers != null) {
            Iterator<String> it = headers.keys();
            while (it.hasNext()) {
                String k = it.next();
                // 这几个交给系统自己协商，硬塞会出错（Host 不能改，长度由实现算）
                if (k.equalsIgnoreCase("host") || k.equalsIgnoreCase("content-length")
                        || k.equalsIgnoreCase("accept-encoding")
                        || k.equalsIgnoreCase("connection")) {
                    continue;
                }
                try {
                    conn.setRequestProperty(k, headers.optString(k));
                } catch (Throwable ignore) {
                    // 个别非法头名不该让整个请求失败
                }
            }
        }

        if (body != null && !"GET".equals(method) && !"HEAD".equals(method)) {
            byte[] payload = body.getBytes("UTF-8");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(payload.length);
            OutputStream os = conn.getOutputStream();
            try {
                os.write(payload);
            } finally {
                closeQuietly(os);
            }
        }
        return conn;
    }

    private String readResponse(HttpURLConnection conn, int status, String finalUrl) throws IOException {
        String contentType = conn.getContentType();
        String encoding = conn.getContentEncoding();
        boolean binary = isBinary(contentType);
        int limit = binary ? MAX_BIN : MAX_TEXT;

        InputStream is = null;
        try {
            is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        } catch (IOException e) {
            is = conn.getErrorStream();
        }
        if (is == null) {
            closeQuietly(conn);
            return errorPayload("HTTP " + status + "（无响应体）");
        }

        try {
            if (encoding != null) {
                String enc = encoding.toLowerCase();
                if (enc.contains("gzip")) {
                    is = new GZIPInputStream(is);
                } else if (enc.contains("deflate")) {
                    is = new InflaterInputStream(is);
                }
            }

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            boolean truncated = false;
            while ((n = is.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > limit) {
                    truncated = true;
                    break;
                }
            }
            byte[] bytes = bos.toByteArray();

            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("url", finalUrl);
            out.put("truncated", truncated);
            out.put("headers", headersToJson(conn));

            if (binary) {
                // 图片 / 音频：base64 带回，页面侧还原成 ArrayBuffer 再包成 Response
                out.put("enc", "base64");
                out.put("body", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
            } else {
                out.put("enc", "text");
                out.put("body", new String(bytes, "UTF-8"));
            }
            return out.toString();
        } catch (JSONException e) {
            return errorPayload("响应封装失败：" + e.getMessage());
        } finally {
            closeQuietly(is);
            closeQuietly(conn);
        }
    }

    private static boolean isBinary(String contentType) {
        if (contentType == null) return false;
        String ct = contentType.toLowerCase();
        return !(ct.startsWith("text/")
                || ct.contains("json")
                || ct.contains("javascript")
                || ct.contains("xml")
                || ct.contains("x-www-form-urlencoded")
                || ct.contains("svg"));
    }

    private static JSONObject headersToJson(HttpURLConnection conn) {
        JSONObject h = new JSONObject();
        try {
            for (Map.Entry<String, java.util.List<String>> e : conn.getHeaderFields().entrySet()) {
                String k = e.getKey();
                if (k == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                h.put(k, e.getValue().get(0));
            }
        } catch (Throwable ignore) {
        }
        return h;
    }

    private static String errorPayload(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("error", message);
        } catch (Throwable ignore) {
        }
        return o.toString();
    }

    private static void closeQuietly(Object c) {
        try {
            if (c instanceof HttpURLConnection) ((HttpURLConnection) c).disconnect();
            else if (c instanceof InputStream) ((InputStream) c).close();
            else if (c instanceof OutputStream) ((OutputStream) c).close();
        } catch (Throwable ignore) {
        }
    }
}
