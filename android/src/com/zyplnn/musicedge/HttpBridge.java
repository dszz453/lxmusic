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
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
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

    /** 整个请求（含全部重定向跳）总预算的兜底下限：页面侧发来的 timeout 小于它时按它算 */
    private static final int MIN_BUDGET_MS = 3000;

    /* ---------------- 线程池：弹性，且不许「静默排队」 ---------------- */

    /** 核心并发：覆盖「一次搜索 4~6 源 + 取流探测」的常态 */
    private static final int CORE_THREADS = 6;
    /** 峰值并发：长请求扎堆时（跨源搜索、取流解析、首页冷算）放宽，避免后面的人排队 */
    private static final int MAX_THREADS = 24;
    private static final long KEEPALIVE_SECONDS = 30L;

    /**
     * ⚠ 「桥请求超时: /api/playlists」这个报障的落点，改之前先把这段读完。
     *
     * 桥是**所有**出站请求的唯一出口（远程模式下连 /api/* 也走这里），而它原来是
     * `Executors.newFixedThreadPool(6)` —— 一个不会伸缩的池。6 个线程一旦被长请求
     * 占满（跨源搜索、取流解析探测、首页冷算，每个都可能读到读超时），后面来的请求
     * 只能进队列干等。
     *
     * 而页面侧的计时是**从「请求发出」那一刻**就开始跑的（见 public/js/native.js：
     * entry.timer 在塞进 pendingHttp 之前就装好了），**排队时间照样算进去**。于是
     * 用户看到的是：
     *
     *     桥请求超时: /api/playlists
     *
     * 可那个接口在服务端只是一条 SQLite 查询（毫秒级）。也就是 ——
     * **慢的不是接口，是排队**；而文案把矛头指向了接口，谁都查不到真因。
     *
     * 两处一起改才成立：
     *   1) 池改成弹性的（这里），并发上限 6 → 24，排队基本消失；
     *   2) 队列容量 0（SynchronousQueue：直接交接给线程）—— 满员时**立刻**拒掉、
     *      并回投「桥太忙」，而不是默默排队到页面自己超时。
     *
     * 为什么**不用** LinkedBlockingQueue：它无界，而 ThreadPoolExecutor 只在
     * 「队列满」时才扩容 —— 无界队列永远不满，于是 maximumPoolSize 形同虚设，
     * 池就永远只有 6 个线程。这是这个类最经典的一个坑，别改回去。
     */
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(
            CORE_THREADS, MAX_THREADS, KEEPALIVE_SECONDS, TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>());

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
        // 核心线程也允许空闲回收：用户可能在后台挂很久，不该常驻 6 个线程不放。
        // 与 SynchronousQueue 搭配时唯一的小代价是「刚回收完又来请求」会新建一次线程，
        // 相比常驻一个池，这点开销可以忽略。
        pool.allowCoreThreadTimeOut(true);
    }

    @JavascriptInterface
    public void httpRequest(final String id, final String reqJson) {
        try {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    String payload;
                    try {
                        payload = execute(reqJson);
                    } catch (Throwable t) {
                        payload = errorPayload(errText(t));
                    }
                    deliver(id, payload);
                }
            });
        } catch (RejectedExecutionException busy) {
            // 满员：立刻如实回投，别让页面干等到它自己的计时器到点 ——
            // 那句话会写成「桥请求超时: <某个接口>」，把矛头指向一个根本不慢的接口。
            deliver(id, errorPayload("桥太忙（并发出站请求过多），请稍后重试"));
        }
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

        /**
         * 总预算：从开始执行算起，**所有跳转共享一份**。
         *
         * 原来每跳各自用满 timeout，5 跳最坏能拖到 150 秒 —— 而页面侧的等待上限
         * 比这短得多，于是一串慢跳转最后报出来的还是「桥请求超时」，真正卡在哪一
         * 跳、卡了多久照样查不到。现在超预算就直接带着「已跳几跳」如实返回。
         */
        final long deadline = System.currentTimeMillis() + Math.max(timeout, MIN_BUDGET_MS);
        int hops = 0;

        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            long remain = deadline - System.currentTimeMillis();
            if (remain <= 0) {
                return errorPayload("请求超时（已重定向 " + hops + " 次）：" + rawUrl);
            }

            // 每跳各自计时，但都不得超过剩余总预算
            int hopTimeout = (int) Math.min(remain, timeout);
            HttpURLConnection conn = null;
            try {
                conn = open(currentUrl, currentMethod, hopTimeout, headers, currentBody);
                int status = conn.getResponseCode();

                if (status >= 300 && status < 400) {
                    String loc = conn.getHeaderField("Location");
                    closeQuietly(conn);
                    if (loc == null || loc.isEmpty()) {
                        return errorPayload("重定向缺少 Location：" + currentUrl);
                    }
                    // 相对跳转要按当前地址补全
                    currentUrl = new URL(new URL(currentUrl), loc).toString();
                    hops++;
                    Log.d(TAG, "重定向 " + status + " → " + currentUrl);
                    // 303 / 302 视为 GET；其余保留原方法
                    if (status == 303 || status == 302) {
                        currentMethod = "GET";
                        currentBody = null;
                    }
                    continue;
                }
                return readResponse(conn, status, currentUrl);
            } catch (SocketTimeoutException te) {
                closeQuietly(conn);
                return errorPayload("请求超时：" + currentUrl);
            } catch (IOException ioe) {
                // 连不上 / 读到一半断了 —— 一定要把地址带上，否则页面侧只有
                // 一句「网络错误」，是哪个音源挂了完全看不出来
                closeQuietly(conn);
                return errorPayload("网络错误：" + errText(ioe) + " ← " + currentUrl);
            }
        }
        return errorPayload("重定向次数过多（超过 " + MAX_REDIRECTS + " 跳）：" + rawUrl);
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
            /**
             * ⚠️ 这里**绝不能**再对 conn 调 disconnect()。
             *
             * HttpURLConnection.disconnect() 的语义是「关掉这条连接」，底层 socket
             * 会被直接销毁 —— 于是下一次请求走不到连接池，得把 DNS + TCP 三次握手
             * + TLS 握手整套重做一遍。实测同一台自建服务器：
             *
             *     冷连接（含握手） 418 ms    /    复用连接 20 ms
             *
             * 差了 20 倍。通用客户端（client/）那份早就改了，这份是同一个类的另一
             * 个副本，当时漏掉了 —— 两个文件的逻辑必须一模一样，别再让它们分叉。
             * 正确做法：读完响应后只关输入流，连接会自动归还池里（池有上限、
             * 空闲超时自己会清，不会泄漏）。重定向那处需要换地址，另有显式处理。
             */
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

    /**
     * 异常压成一行可读文案。这条字符串会经回投一路传到页面上（用户可能直接看到），
     * 所以不要出现 null、也不要把整个堆栈塞进去。
     */
    private static String errText(Throwable t) {
        if (t == null) return "未知错误";
        String m = t.getMessage();
        return (m == null || m.isEmpty()) ? String.valueOf(t) : m;
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
