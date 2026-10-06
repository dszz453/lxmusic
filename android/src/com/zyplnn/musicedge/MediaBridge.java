package com.zyplnn.musicedge;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.LruCache;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 原生媒体层与 WebView 之间的唯一通道。
 *
 * 为什么要有这一层：
 *   播放引擎在 WebView 里（<audio> + src/ 那套取流逻辑），而「通知栏 / 锁屏 / 控制中心 /
 *   蓝牙耳机按键」全都要靠原生的 MediaSession —— WebView 里 navigator.mediaSession
 *   是**不存在**的（Chromium 没给 WebView 实现这套 W3C API），所以网页里写的
 *   MediaMetadata / setActionHandler 在壳里等于没写，系统根本不知道有东西在播。
 *   这个类的职责就是把「页面里正在播什么」翻译成原生能懂的东西，以及反向把
 *   系统来的按键送回页面。
 *
 * 为什么状态是静态的：
 *   它必须活得比 Activity 久。用户从「最近任务」划掉 App 时 Activity 会被销毁，
 *   但音乐不该断 —— WebView 由这里持有，Service 通过这里继续控制播放；
 *   重新打开时 MainActivity 把这个 WebView 重新挂回视图树，页面不用重载、播放无缝继续。
 *   所以：**这里持有的东西一律不绑 Activity**（Context 只存 application context）。
 *
 * 线程约定：
 *   · 被 @JavascriptInterface 调到的方法跑在 WebView 的 JS 线程上，只能改状态、不许碰 UI；
 *   · listen 回调统一 post 到主线程（Service 要用它更新通知）；
 *   · evaluateJavascript 也必须主线程。
 */
public final class MediaBridge {

    private static final String TAG = "LXB/Media";

    /** 与 MainActivity / HttpBridge 用同一个 UA —— 部分 CDN 见 "; wv" 会拒绝 */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /** 封面长边上限。512 是通知/锁屏足够清晰的尺寸，再大就顶到 Binder 的 1MB 传输上限了 */
    private static final int COVER_MAX = 512;
    private static final int COVER_FETCH_LIMIT = 8 * 1024 * 1024;
    /** 通知栏排队最多预热几张封面；列表页连点下一首也不会把内存吃满 */
    private static final int COVER_CACHE_MAX = 8;

    /* ---------------- 对外数据结构 ---------------- */

    /** 一份完整的「当前播放」快照 —— 页面侧每有变化就整份上报，不做增量 */
    public static final class State {
        public boolean hasTrack;        // 是否有曲目（false = 会话该收摊了）
        public String title = "";
        public String artist = "";
        public String album = "";
        public String cover = "";       // 封面地址；空 = 没有
        public long durationMs;
        public long positionMs;
        public boolean playing;
        public int index = -1;          // 队列下标（-1 = 单曲，无队列）
        public int total;               // 队列长度
        /** 这份快照到达的单调时刻：系统据此外推进度条，不必每秒都往通知里灌数据 */
        public long at;

        public boolean canPrev() { return total > 1 || index > 0; }
        public boolean canNext() { return total > 1; }
    }

    /** Service 侧的实现。所有回调都在主线程。 */
    public interface Listener {
        /** 快照有变化（含封面异步加载完成）。Service 在这里决定前台服务与通知的样子 */
        void onState(State s);
        /** 页面明确说「没得播了」（队列播完 / 用户清空）—— Service 可以收摊 */
        void onSessionEnd();
    }

    /* ---------------- 状态 ---------------- */

    private static Context appCtx;
    private static WebView web;
    private static Listener listener;

    private static final State state = new State();
    private static Bitmap cover;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final ExecutorService io = Executors.newFixedThreadPool(2);

    /**
     * 封面缓存：按 URL 存，避免来回切歌反复下载同一张图。
     * 淘汰时**不主动 recycle** —— 被淘汰的那张可能还挂在上一份 MediaMetadata 上，
     * 提前回收会让系统下次读元数据时拿到废图。交给 GC（8 张的容量本来也很少淘汰）。
     */
    private static final LruCache<String, Bitmap> coverCache = new LruCache<String, Bitmap>(COVER_CACHE_MAX);
    /** 封面请求序号：切歌很快时，先发的请求回来晚了要丢弃 */
    private static final AtomicInteger coverSeq = new AtomicInteger();
    private static volatile String coverRequested = "";

    /** 前台服务是否已经起来（Service 自己维护，判断是否需要 startForegroundService） */
    private static volatile boolean serviceAlive;

    /* ---------------- 诊断留痕 ----------------
     *
     * 为什么要留这一坨：这条链路上的故障**症状全都一样** —— 用户看到的都是
     * 「任务中心/锁屏里没有播放控件」。但原因可能是页面没装配、服务没起来、
     * 通知权限没给、系统把 App 的通知总开关关了、startForeground 抛异常……
     * 开发机没有安卓运行时，光靠「应该没问题」是修不了这类 bug 的（第一版就是
     * 这么翻车的：ensureService 写了但没人调，整条链路静默失效）。
     * 所以每一层都记一笔，设置页摊开给用户看，用户截个图就能定位。
     */

    private static final int ERR_KEEP = 6;
    private static final java.util.ArrayDeque<String> errors = new java.util.ArrayDeque<>();
    private static volatile long reportCount;
    private static volatile long lastReportAt;
    private static volatile String lastCmd = "";
    private static volatile long lastCmdAt;
    private static volatile String startError = "";
    private static volatile String coverError = "";
    private static volatile boolean sessionActive;
    private static volatile boolean foreground;
    private static volatile long notifiedAt;

    /** 记一条错误（最近 ERR_KEEP 条），同时打 logcat。诊断面板直接展示 */
    public static void recordError(String tag, String msg) {
        String line = tag + "：" + String.valueOf(msg);
        if (line.length() > 200) line = line.substring(0, 200);
        Log.w(TAG, line);
        synchronized (errors) {
            errors.addLast(SystemClock.elapsedRealtime() + "\u0001" + line);
            while (errors.size() > ERR_KEEP) errors.removeFirst();
        }
    }

    public static void setStartError(String msg) {
        startError = String.valueOf(msg);
    }

    /** Service 每次渲染完通知后回报一次，诊断面板据此判断「通知到底发出去没有」 */
    public static void setSessionState(boolean active, boolean fg, boolean notified) {
        sessionActive = active;
        foreground = fg;
        if (notified) notifiedAt = SystemClock.elapsedRealtime();
    }

    /** 给设置页的诊断面板用：把原生侧看到的一切摊成 JSON */
    public static String diagJson() {
        JSONObject o = new JSONObject();
        try {
            long now = SystemClock.elapsedRealtime();
            o.put("service", serviceAlive);
            o.put("session", sessionActive);
            o.put("foreground", foreground);
            o.put("notifiedAgoMs", notifiedAt > 0 ? now - notifiedAt : -1);
            o.put("reports", reportCount);
            o.put("reportAgoMs", lastReportAt > 0 ? now - lastReportAt : -1);
            o.put("lastCmd", lastCmd);
            o.put("cmdAgoMs", lastCmdAt > 0 ? now - lastCmdAt : -1);
            o.put("startError", startError);
            o.put("coverError", coverError);
            o.put("hasTrack", state.hasTrack);
            o.put("playing", state.playing);
            o.put("title", state.title);
            o.put("playingTitle", state.title);
            o.put("coverOk", cover != null);
            org.json.JSONArray arr = new org.json.JSONArray();
            synchronized (errors) {
                for (String e : errors) {
                    int cut = e.indexOf('\u0001');
                    long at = cut > 0 ? Long.parseLong(e.substring(0, cut)) : 0;
                    String msg = cut > 0 ? e.substring(cut + 1) : e;
                    JSONObject item = new JSONObject();
                    item.put("msg", msg);
                    item.put("agoMs", at > 0 ? now - at : -1);
                    arr.put(item);
                }
            }
            o.put("errors", arr);
        } catch (Throwable ignore) {
        }
        return o.toString();
    }

    private MediaBridge() {
    }

    /* ---------------- 宿主绑定 ---------------- */

    /** 由 MainActivity 在 onCreate 里调；ctx 只在新建 WebView 时用，这里只留 application context */
    public static void attach(Context ctx, WebView w) {
        appCtx = ctx.getApplicationContext();
        web = w;
    }

    /**
     * Activity 销毁时调。**注意不要在这里清掉 web**：
     * 用户划掉最近任务时 Activity 会走 onDestroy，但音乐还要继续，Service 之后仍得
     * 通过这个引用给页面下命令。真正的清理放在 clear() —— 只在会话彻底结束时调。
     */
    public static void detachActivity() {
        // 目前无需动作；保留这个方法是为了让调用点读起来有语义
    }

    public static void clear() {
        web = null;
        listener = null;
        serviceAlive = false;
        sessionActive = false;
        foreground = false;
        cover = null;
        coverRequested = "";
        coverError = "";
        startError = "";
        lastCmd = "";
        lastCmdAt = 0;
        notifiedAt = 0;
        coverCache.evictAll();
        synchronized (errors) {
            errors.clear();
        }
        state.hasTrack = false;
        state.playing = false;
    }

    public static WebView getWeb() {
        return web;
    }

    public static Context getContext() {
        return appCtx;
    }

    public static State getState() {
        return state;
    }

    public static Bitmap getCover() {
        return cover;
    }

    public static boolean isPlaying() {
        return state.playing && state.hasTrack;
    }

    public static void setListener(Listener l) {
        listener = l;
    }

    public static void setServiceAlive(boolean alive) {
        serviceAlive = alive;
    }

    /**
     * 按当前快照重渲染一次（会按需把服务拉起来）。
     * 用在「权限状态变化」这类不改快照、但要立刻重画的情形。
     */
    public static void refresh() {
        notifyState();
    }

    /* ---------------- 页面 → 原生：状态上报 ---------------- */

    /**
     * 页面侧的入口（AndroidHost.mediaReport 转发到这里）。
     * 跑在 WebView 的 JS 线程上，所以这里只做「解析 + 存 + 通知」，不碰 UI。
     */
    public static void report(String json) {
        State next = new State();
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);            next.hasTrack = o.optBoolean("track", false);
            next.title = o.optString("title", "");
            next.artist = o.optString("artist", "");
            next.album = o.optString("album", "");
            next.cover = o.optString("cover", "");
            next.durationMs = (long) (o.optDouble("duration", 0));
            next.positionMs = (long) (o.optDouble("position", 0));
            next.playing = o.optBoolean("playing", false);
            next.index = o.optInt("index", -1);
            next.total = o.optInt("total", 0);
        } catch (Throwable t) {
            Log.w(TAG, "上报解析失败: " + t.getMessage());
            return;
        }
        next.at = SystemClock.elapsedRealtime();
        if (next.durationMs < 0) next.durationMs = 0;
        if (next.positionMs < 0) next.positionMs = 0;
        if (next.durationMs > 0 && next.positionMs > next.durationMs) next.positionMs = next.durationMs;

        reportCount++;
        lastReportAt = next.at;

        // 曲目没变的话，位置/播放态可以直接覆盖；变了才需要重新取封面
        boolean sameTrack = state.hasTrack && state.title.equals(next.title)
                && state.artist.equals(next.artist) && state.cover.equals(next.cover);
        synchronized (MediaBridge.class) {
            state.hasTrack = next.hasTrack;
            state.title = next.title;
            state.artist = next.artist;
            state.album = next.album;
            state.cover = next.cover;
            state.durationMs = next.durationMs;
            state.positionMs = next.positionMs;
            state.playing = next.playing;
            state.index = next.index;
            state.total = next.total;
            state.at = next.at;
            if (!sameTrack) cover = null;      // 换了歌，先把上一张封面摘掉，别让通知闪错图
        }

        if (next.hasTrack && next.cover.length() > 0 && !next.cover.equals(coverRequested)) {
            loadCover(next.cover);
        }

        /**
         * 页面说有曲目了 → 把播放服务拉起来。
         *
         * **这一步曾经漏掉，是「安卓任务中心 / 锁屏完全没有播放控件」的根因**：
         * 服务没人启动 → onCreate 没跑 → listener 一直是 null → notifyState() 直接
         * 空转，于是没有 MediaSession、没有通知、没有任何控件。而且整条链路一声不响，
         * 从日志上看不出任何异常（不是报错，是压根没跑）。
         * 现在同时做了两件事：这里主动拉起，notifyState() 里还有一层兜底。
         */
        if (next.hasTrack) ensureService();

        notifyState();
    }

    private static void notifyState() {        final Listener l = listener;
        if (l == null) {
            // 兜底：服务还没起来（或刚被系统回收）时，别让上报白白丢掉 ——
            // 有曲目就再拉一次，服务起来后 onStartCommand → sync() 会按当前快照渲染。
            if (state.hasTrack) ensureService();
            return;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    l.onState(state);
                } catch (Throwable t) {
                    Log.w(TAG, "状态回调异常: " + t.getMessage());
                }
            }
        });
    }

    private static void notifyEnd() {
        final Listener l = listener;
        if (l == null) return;
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    l.onSessionEnd();
                } catch (Throwable t) {
                    Log.w(TAG, "收摊回调异常: " + t.getMessage());
                }
            }
        });
    }

    /* ---------------- 原生 → 页面：按键与命令 ---------------- */

    /** 命令：play / pause / toggle / next / prev / seek / stop；arg 只有 seek 用（毫秒） */
    public static void command(String cmd, long arg) {
        lastCmd = cmd + (cmd.equals("seek") ? "(" + arg + "ms)" : "");
        lastCmdAt = SystemClock.elapsedRealtime();
        StringBuilder js = new StringBuilder();
        js.append("(function(){try{var m=window.__nativeMedia;if(!m||typeof m.onCommand!=='function')return;")
                .append("m.onCommand(").append(JSONObject.quote(cmd)).append(',')
                .append(arg).append(");}catch(e){}})();");
        eval(js.toString());
    }

    /** 在页面里跑一段 JS。必须主线程，且调用时可能 WebView 已经不在了 */
    public static void eval(final String js) {
        final WebView w = web;
        if (w == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runEval(w, js);
        } else {
            main.post(new Runnable() {
                @Override
                public void run() {
                    runEval(w, js);
                }
            });
        }
    }

    private static void runEval(WebView w, String js) {
        try {
            w.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "注入失败: " + t.getMessage());
        }
    }

    /* ---------------- 服务生命周期 ---------------- */

    /**
     * 确保前台服务在跑。
     *
     * 页面只是报了一句「我在播」，服务得由这边拉起来 —— 放在这里而不是 MainActivity，
     * 是因为 Activity 可能已经不在了（划掉任务之后），而音乐还在继续。
     */
    public static void ensureService() {
        final Context ctx = appCtx;
        if (ctx == null) {
            recordError("播放服务", "拿不到 application context（Activity 还没 attach）");
            return;
        }
        if (serviceAlive) return;
        main.post(new Runnable() {
            @Override
            public void run() {
                if (serviceAlive) return;
                try {
                    Intent i = new Intent(ctx, PlaybackService.class);
                    i.setAction(PlaybackService.ACTION_SYNC);
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
                    else ctx.startService(i);
                } catch (Throwable t) {
                    // Android 12+ 后台启动前台服务会被拒（ForegroundServiceStartNotAllowed）
                    recordError("启动播放服务失败",
                            t.getClass().getSimpleName() + " " + t.getMessage());
                }
            }
        });
    }

    /** 页面说「没什么可播的了」→ 通知服务收摊 */
    public static void endSession() {
        notifyEnd();
    }

    /** 诊断面板放不下超长 URL，掐个头（保留能认出是哪张图的信息量） */
    private static String shorten(String url) {
        if (url == null) return "";
        return url.length() <= 90 ? url : url.substring(0, 44) + "…" + url.substring(url.length() - 40);
    }

    /* ---------------- 封面 ---------------- */

    private static void loadCover(final String url) {
        coverRequested = url;
        final int seq = coverSeq.incrementAndGet();

        Bitmap hit = coverCache.get(url);
        if (hit != null) {
            cover = hit;
            notifyState();
            return;
        }

        io.execute(new Runnable() {
            @Override
            public void run() {
                final Bitmap bmp = fetchCover(url);
                if (bmp == null) {
                    if (coverError.isEmpty()) {
                        coverError = "取不到图：" + shorten(url);
                        recordError("封面", coverError);
                    }
                    return;
                }
                // 期间又切了歌，这张已经没人要了 —— 直接丢掉，别覆盖新封面
                if (seq != coverSeq.get()) {
                    return;
                }
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (seq != coverSeq.get()) return;
                        coverCache.put(url, bmp);
                        cover = bmp;
                        coverError = "";
                        notifyState();     // 让 Service 带着封面重画一次通知
                    }
                });
            }
        });
    }

    /**
     * 下载并预处理封面。
     *
     * 为什么要「缩放 + JPEG 往返 + RGB_565」三道：
     *   MediaMetadata 里的 Bitmap 会跟着 Binder 送到 SystemUI，而 Binder 事务上限约 1MB。
     *   直接把源图（可能 1400×1400 ARGB_8888 ≈ 7.8MB）塞进去，轻则被系统丢弃，
     *   重则抛 TransactionTooLargeException 把播放打断。JPEG 往返一次能把 Bitmap 的
     *   底层像素缓冲压到「刚好这张图的尺寸」，RGB_565 再把每像素从 4 字节降到 2 字节
     *   —— 512×512 时约 512KB，安全。通知封面不需要透明度，丢 alpha 没有代价。
     */
    private static Bitmap fetchCover(String url) {
        HttpURLConnection conn = null;
        InputStream is = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", UA);
            int status = conn.getResponseCode();
            if (status < 200 || status >= 400) return null;

            is = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > COVER_FETCH_LIMIT) return null;
            }
            byte[] raw = bos.toByteArray();
            if (raw.length == 0) return null;

            // 先只读尺寸，决定采样率 —— 免得为了看一眼宽高就把整张大图解到内存里
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, probe);
            if (probe.outWidth <= 0 || probe.outHeight <= 0) return null;

            int scale = 1;
            int longest = Math.max(probe.outWidth, probe.outHeight);
            while (longest / (scale * 2) >= COVER_MAX) scale *= 2;

            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = scale;
            o.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap decoded = BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
            if (decoded == null) return null;

            return shrink(decoded);
        } catch (Throwable t) {
            Log.w(TAG, "封面加载失败: " + t.getMessage());
            return null;
        } finally {
            try {
                if (is != null) is.close();
            } catch (Throwable ignore) {
            }
            if (conn != null) conn.disconnect();
        }
    }

    private static Bitmap shrink(Bitmap src) {
        try {
            int w = src.getWidth();
            int h = src.getHeight();
            int longest = Math.max(w, h);
            float k = longest > COVER_MAX ? (float) COVER_MAX / longest : 1f;
            int tw = Math.max(1, Math.round(w * k));
            int th = Math.max(1, Math.round(h * k));
            Bitmap scaled = (k < 1f) ? Bitmap.createScaledBitmap(src, tw, th, true) : src;

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, 88, bos);
            byte[] jpeg = bos.toByteArray();

            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap out = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
            if (out == null) return scaled;      // 解码失败就退回中间图，别再动它的引用

            // 到这里 out 才是要留下的那张，前面两个临时件可以放掉了
            if (scaled != src && !scaled.isRecycled()) scaled.recycle();
            if (!src.isRecycled()) src.recycle();
            return out;
        } catch (Throwable t) {
            Log.w(TAG, "封面缩放失败: " + t.getMessage());
            return src;
        }
    }
}
