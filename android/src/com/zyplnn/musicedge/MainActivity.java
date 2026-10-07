package com.zyplnn.musicedge;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import org.json.JSONObject;

/**
 * 单 Activity + WebView 壳（离线自包含版）。
 *
 * 整包前端不再从远端加载，而是由 shouldInterceptRequest 直接从 APK 的 assets/www 提供；
 * 后端逻辑（搜索 / 取流解析 / 歌单 / 收藏）也搬进了这个 APK，由
 * public/js/backend.bundle.js 在 WebView 里跑，网络与数据分别走 HttpBridge /
 * StoreBridge 两个原生桥。也就是说 —— 除了音频字节本身，其余全部不依赖任何服务端，
 * Cloudflare 上的那份部署挂了也不影响 App。
 *
 * 之所以仍然加载 https://music.zyplnn.dpdns.org/ 这个 URL 而不是 file://：
 *   · file:// 页面是 opaque origin，localStorage / IndexedDB / Worker 都会变得别扭；
 *   · https origin 才是正常的 secure context，前端里大量既有的存储与 Worker 逻辑不用改。
 * 拦截层保证这份「假域名」下面的东西全部来自本地 assets，一个字节都不出设备。
 *
 * 与「只是个套壳浏览器」的分界在原生侧这三件事：
 *   1. 页面装进原生窗口；
 *   2. 放开浏览器会拦、而原生壳没必要拦的限制 —— 自动播放、混合内容（http 音频/图片直链）；
 *   3. **MediaSession 媒体会话**：通知栏媒体卡片、锁屏与息屏显示、控制中心播放控件、
 *      蓝牙耳机与车机按键。这些都要原生参与（见 PlaybackService / MediaBridge），
 *      WebView 里那份 navigator.mediaSession 是拿不到的。
 *
 * 还有一条容易被忽略的：**Activity 被销毁 ≠ 结束**。用户从最近任务划掉 App 时
 * 只要还在播，WebView 就不销毁、服务不停，重新打开时把这个 WebView 挂回去
 * ——页面不重载、播放不中断。见 onDestroy。
 */
public class MainActivity extends Activity {

    private static final String TAG = "LXB/Main";

    private static final int REQ_NOTIFICATIONS = 1001;

    /** 页面 origin 用线上域名，保证是 secure context；内容由拦截层从 assets 供给 */
    private static final String START_URL = "https://music.zyplnn.dpdns.org/";
    private static final String ASSET_ROOT = "www";

    /**
     * 用标准 Chrome 移动端 UA 而不是 WebView 默认 UA。
     * WebView 默认 UA 里带 "; wv" 标记，部分音乐 CDN 会据此拒绝请求 —— 直连播放会莫名失败。
     */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /**
     * 只放纯 MIME 类型，不带 "; charset=" 参数。
     * 实测部分 WebView 版本对 WebResourceResponse 的 mimeType 解析很死板：
     * 带 charset 参数会被当成不认识的类型，按 text/plain 渲染 —— 表现就是
     * 整页 HTML 源码原样铺在屏幕上。字符集走 WebResourceResponse 的
     * encoding 参数传（serveAsset 里固定 "utf-8"），信息不丢。
     */
    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("mjs", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
    }

    private WebView web;
    private ProgressBar bar;
    private boolean errored = false;
    /** WebView 当前是否处于 onPause 冻结态，决定 onResume 要不要解冻 */
    private boolean webPaused = false;
    private boolean notifAsked = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        /**
         * 复用上一次留下的 WebView。
         *
         * 什么时候会走到这里：用户在播放中从「最近任务」划掉了 App，Activity 被销毁，
         * 但我们故意没销毁 WebView（音乐还在放）。重新点开时如果新建一个 WebView，
         * 页面会重新加载、播放从头开始 —— 那就白费了上面那套保活。
         * 把旧的从它原来的父容器摘下来、装回新的布局即可，页面状态（队列、进度、滚动位置）
         * 原样保留。
         *
         * 摘 parent 这步不能省：旧 Activity 的视图树已销毁，但 WebView 对象不会自动
         * 从父容器里摘除，留着会以「已有父容器」为由拒绝被 addView。
         */
        WebView reused = MediaBridge.getWeb();
        boolean restoring = reused != null;
        if (restoring) {
            try {
                ViewParent p = reused.getParent();
                if (p instanceof ViewGroup) ((ViewGroup) p).removeView(reused);
                web = reused;
                Log.i(TAG, "复用上次的 WebView，页面不重载");
            } catch (Throwable t) {
                Log.w(TAG, "复用 WebView 失败，改为新建: " + t.getMessage());
                web = new WebView(this);
                restoring = false;
            }
        } else {
            web = new WebView(this);
        }

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(bar, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        setContentView(root);

        // 桥都是单例：跟进程走，不跟 Activity 走（见两个类里的说明）
        HttpBridge.get();
        try {
            StoreBridge.get(this);
        } catch (Throwable t) {
            Log.e(TAG, "本地数据库打开失败: " + t.getMessage());
        }
        MediaBridge.attach(this, web);

        configureWeb();

        if (!restoring) {
            if (savedInstanceState != null) {
                web.restoreState(savedInstanceState);
            } else {
                web.loadUrl(START_URL);
            }
        }
    }

    /** 每个 Activity 实例都完整配一次；复用的 WebView 也重新配，让客户端回调指向新实例 */
    private void configureWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 登录态、插件列表存在 localStorage / IndexedDB
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(UA);
        if (Build.VERSION.SDK_INT >= 17) {
            // 不做这一步，「点歌后自动播放」会被当成无用户手势而被拒
            s.setMediaPlaybackRequiresUserGesture(false);
        }
        if (Build.VERSION.SDK_INT >= 21) {
            /**
             * 关键：一部分音源只给 http 直链。线上网页版在 https 下会被浏览器按混合内容
             * 拦掉，只能绕服务端代理（多一跳、还依赖服务端活着）。壳里直接把这一层放开，
             * 音频与封面都能真·直连 —— 这也是「App 不需要 /api/stream」的根因。
             */
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        // 关闭 HTTP 缓存：资源全部来自本地 assets，缓存只会让「换了包还跑旧代码」
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);

        /**
         * 注入门面。页面侧只认一个对象名 AndroidHost：
         *   httpRequest / dbQuery / dbExec / log  → 离线自包含所需
         *   mediaReport                           → 把「在放什么」推给原生媒体会话
         */
        web.addJavascriptInterface(new Host(), "AndroidHost");
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 站外链接也留在壳里，避免跳出去回不来
                view.loadUrl(url);
                return true;
            }

            /**
             * 把站点域名下的所有请求就地解决掉，不经过网络。
             * 这个重载在后台线程被调用，所以这里做文件读取是安全的。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    String host = request.getUrl().getHost();
                    if (host == null || !host.endsWith("zyplnn.dpdns.org")) return null;
                    return serveAsset(request.getUrl().getPath());
                } catch (Throwable t) {
                    Log.w(TAG, "拦截失败: " + t.getMessage());
                    return null;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                injectVersion(view);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(START_URL) && !errored) {
                    errored = true;
                    view.loadDataWithBaseURL(START_URL, OFFLINE_HTML, "text/html", "utf-8", null);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                bar.setProgress(newProgress);
                bar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
    }

    /* ---------------- 版本号注入 ---------------- */

    /**
     * 把 APP 版本号塞进页面，供设置页 / 关于页显示。
     *
     * 为什么要从 Java 侧注入、而不是写死在 index.html：
     *   同一个 public/ 被三个宿主共用（CF / 壳 / Docker），前端源码里不能写壳的版本号。
     *   而「App 是哪一版」只有 Android 自己知道，所以由宿主在页面加载完成后回填。
     *
     * 为什么用 onPageFinished 而不是 addJavascriptInterface：
     *   索引里的内联脚本要**在任何业务脚本之前**读到 window.LX_VERSION，
     *   而 onPageFinished 是在文档脚本跑完之后才触发的 —— 那时 index.html 里的兜底
     *   已经把它设成了 'web'。所以这里**再覆盖一次**，并同步刷新 LX_VERSION_LINE。
     *   设置页是异步渲染的（要等 /api/me），等它画出来时这里早就写好了。
     *
     * 版本号从 PackageManager 读 —— 与 aapt2 link 时写进清单的 --version-name 是同一个，
     * 因此「APK 属性里看到的版本」和「应用内显示的版本」永远不会不一致。
     */
    private void injectVersion(WebView view) {
        String name = "?";
        long code = 0;
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            name = pi.versionName == null ? "?" : pi.versionName;
            code = android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Throwable t) {
            Log.w(TAG, "读版本号失败: " + t.getMessage());
        }
        // 用 quote() 转义，避免版本名里出现引号时把这段 JS 弄成语法错误
        String js = "(function(){"
                + "window.LX_VERSION=" + quote(name) + ";"
                + "window.LX_VERSION_CODE=" + code + ";"
                + "window.LX_VERSION_LINE='客户端 V" + name.replaceFirst("^[Vv]", "") + "';"
                + "})();";
        view.evaluateJavascript(js, null);
    }

    /** 把字符串安全地嵌进 JS 字面量（等价 JSON.stringify 对字符串的行为）。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /* ---------------- 本地资源 ---------------- */

    /**
     * 从 assets/www 取资源。
     *   · 无扩展名的路径（SPA 路由）→ index.html
     *   · 有扩展名但文件不存在     → 返回 null，交给 WebView 自己处理（不会触网，
     *                              因为域名指向的线上站此时只是备份，正常不会走到）
     */
    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty()) path = "/";
        String clean = path;
        while (clean.startsWith("/")) clean = clean.substring(1);

        boolean looksLikeFile = clean.contains(".");
        String assetPath = looksLikeFile ? (ASSET_ROOT + "/" + clean) : (ASSET_ROOT + "/index.html");
        if (!looksLikeFile && !clean.isEmpty() && !"/".equals(path)) {
            // 无扩展名的深链接，如 /charts → 也回 index.html（前端用 hash 路由，正常不会发生）
            assetPath = ASSET_ROOT + "/index.html";
        }

        try {
            InputStream is = getAssets().open(assetPath);
            return new WebResourceResponse(mimeOf(assetPath), "utf-8", is);
        } catch (IOException e) {
            if (looksLikeFile) return null;
            try {
                return new WebResourceResponse("text/html", "utf-8",
                        getAssets().open(ASSET_ROOT + "/index.html"));
            } catch (IOException e2) {
                return null;
            }
        }
    }

    private static String mimeOf(String assetPath) {
        int dot = assetPath.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = assetPath.substring(dot + 1).toLowerCase(Locale.US);
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    /**
     * 注入门面：页面只看到 AndroidHost 一个对象。
     * 具体实现在 HttpBridge / StoreBridge / MediaBridge，这里只做转发。
     */
    public class Host {

        /* —— 出站请求（页面发起，原生执行，绕开同源策略） —— */
        @JavascriptInterface
        public void httpRequest(String id, String reqJson) {
            HttpBridge.get().httpRequest(id, reqJson);
        }

        /* —— 本地数据（顶替 Cloudflare D1） —— */
        @JavascriptInterface
        public String dbQuery(String sql, String argsJson) {
            // 库打不开（存储异常、极少数机型权限问题）时不能把异常抛回 JS 线程 ——
            // 那会连带把这一条 API 请求整个打断，前端看到的是「接口 500」而不是「没数据」。
            try {
                return StoreBridge.get(MainActivity.this).dbQuery(sql, argsJson);
            } catch (Throwable t) {
                Log.w(TAG, "dbQuery 失败: " + t.getMessage());
                return "[]";
            }
        }

        @JavascriptInterface
        public int dbExec(String sql, String argsJson) {
            try {
                return StoreBridge.get(MainActivity.this).dbExec(sql, argsJson);
            } catch (Throwable t) {
                Log.w(TAG, "dbExec 失败: " + t.getMessage());
                return 0;
            }
        }

        @JavascriptInterface
        public void log(String tag, String msg) {
            Log.d("LXB/" + tag, String.valueOf(msg));
        }

        /**
         * 媒体会话上报：页面把「正在放什么」推上来，原生据此更新通知栏 / 锁屏 / 控制中心。
         * 注意这个方法跑在 WebView 的 JS 线程上，重活都在 MediaBridge 里安排。
         */
        @JavascriptInterface
        public void mediaReport(String json) {
            MediaBridge.report(json);
            askNotifications(false);
        }

        /**
         * 诊断：把「系统媒体控制能不能用」这条链路上的每一层状态摊成 JSON。
         *
         * 这条链路的故障症状全都一样（用户只会说「控制不了」），但原因可能是
         * 页面没装配 / 服务没起来 / 通知权限没给 / 系统通知总开关关了 / startForeground 抛异常。
         * 开发机没有安卓运行时，只能靠设备回传这一份来定位 —— 设置页把它摊开给用户看。
         */
        @JavascriptInterface
        public String mediaStatus() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", true);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("brand", Build.BRAND + " " + Build.MODEL);
                o.put("android", Build.VERSION.RELEASE);
                o.put("notifGranted", notifGranted());
                o.put("notifEnabled", notifEnabled());
                o.put("channel", channelState());
                o.put("native", new JSONObject(MediaBridge.diagJson()));
            } catch (Throwable t) {
                try {
                    o.put("ok", false);
                    o.put("error", String.valueOf(t.getMessage()));
                } catch (Throwable ignore) {
                }
            }
            return o.toString();
        }

        /** 有些问题（权限被永久拒绝、通知总开关被关）只能去系统设置里改，给一个直达入口 */
        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Throwable t) {
                        Log.w(TAG, "打开系统设置失败: " + t.getMessage());
                    }
                }
            });
        }

        /** 设置页里的「申请通知权限」按钮：手动触发时不受「只问一次」的限制 */
        @JavascriptInterface
        public void askNotificationPermission() {
            askNotifications(true);
        }

        /**
         * 导出一首歌到系统「下载」目录。
         *
         * 为什么不用网页的 `a[download]`：WebView 里它**在部分机型上只是静默失败**
         * （尤其页面是从本地拦截层喂出来的非真实 https 响应时），用户看不到任何反馈 ——
         * 这正是「点了下载没反应」这类问题的标准成因。所以壳里走原生写文件，
         * 页面侧拿返回值判定成功与否，失败时再回退到网页那套。
         *
         * 参数用 base64 而不是字节数组：@JavascriptInterface 的可跨语言边界类型里
         * 没有 byte[]，字符串是唯一稳的通道（页面侧分块编码，见 audiocache.js）。
         *
         * @param filename 目标文件名（含扩展名）
         * @param b64      文件内容的 base64
         * @return 成功返回绝对路径，失败返回空串（页面据此回退）
         */
        @JavascriptInterface
        public String saveAudio(final String filename, final String b64) {
            try {
                return MediaBridge.saveToDownloads(MainActivity.this, filename, b64);
            } catch (Throwable t) {
                Log.w(TAG, "保存文件失败: " + t.getMessage());
                return "";
            }
        }

        /** 保存能力的探测：页面据此决定要不要优先走原生 */
        @JavascriptInterface
        public boolean canSaveAudio() {
            return Build.VERSION.SDK_INT >= 29 || MediaBridge.hasLegacyStorage();
        }
    }

    /* ---------------- 通知权限 ---------------- */

    /**
     * Android 13 起通知要运行时授权，不申请的话前台服务的通知**一条都不会显示** ——
     * 用户会以为「根本没在播」，而且锁屏、控制中心都没有播放控件可点。
     *
     * 时机选在「真的开始播第一首」时，而不是冷启动就弹：这个弹窗打断成本不低，
     * 用户还没听到声音就先被问一句，很容易顺手拒掉。
     *
     * @param manual true = 用户在设置页主动点的「申请通知权限」，此时不看「是否已问过」
     */
    private void askNotifications(boolean manual) {
        if (Build.VERSION.SDK_INT < 33) {
            notifAsked = true;
            return;
        }
        if (!manual) {
            if (notifAsked) return;
            if (!MediaBridge.isPlaying()) return;      // 等真的播起来再问
        }
        notifAsked = true;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                            == PackageManager.PERMISSION_GRANTED) {
                        Toast.makeText(MainActivity.this, R.string.notif_ok, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},
                            REQ_NOTIFICATIONS);
                } catch (Throwable t) {
                    Log.w(TAG, "申请通知权限失败: " + t.getMessage());
                }
            }
        });
    }

    /* ---------------- 通知状态查询（诊断面板用） ---------------- */

    /** 3 = 已授权，2 = 未授权，1 = 系统版本不需要授权（< 13） */
    private int notifGranted() {
        if (Build.VERSION.SDK_INT < 33) return 1;
        try {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED ? 3 : 2;
        } catch (Throwable t) {
            return 2;
        }
    }

    /** 系统里这个 App 的通知总开关是否开着（被用户整体关掉时，权限给了也白给） */
    private boolean notifEnabled() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            return nm == null || nm.areNotificationsEnabled();
        } catch (Throwable t) {
            return true;
        }
    }

    /** 播放通道的状态：missing / blocked / low / ok */
    private String channelState() {
        if (Build.VERSION.SDK_INT < 26) return "na";
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return "na";
            NotificationChannel ch = nm.getNotificationChannel(PlaybackService.channelId());
            if (ch == null) return "missing";
            int imp = ch.getImportance();
            if (imp == NotificationManager.IMPORTANCE_NONE) return "blocked";
            if (imp <= NotificationManager.IMPORTANCE_LOW) return "low";
            return "ok";
        } catch (Throwable t) {
            return "error";
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_NOTIFICATIONS) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            Toast.makeText(this, R.string.notif_denied, Toast.LENGTH_LONG).show();
            MediaBridge.recordError("通知权限", "被拒绝 —— 锁屏与控制中心不会有播放控件");
        }
        // 授权与否决定前台服务会不会被系统回收，重渲染一次会话状态
        MediaBridge.refresh();
    }

    /* ---------------- 生命周期 ---------------- */

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    /**
     * 切后台时**只在没播的情况下**冻结 WebView。
     *
     * web.onPause() 会把 WebView 里所有 JS 定时器停掉，而这个播放器的后台能力恰好
     * 全都长在定时器上：进度上报（5 秒心跳）、取流卡死看门狗（8 秒）、歌词逐行点亮、
     * 队列自动续播。播放中一冻，表现就是「还在响，但通知栏进度不动、这一首卡住了也
     * 不会自动降级重试」。所以播放中必须让它继续跑 —— 这也是前台服务存在的意义。
     *
     * 用 onStop 而不是 onPause：onPause 在弹权限框、分屏、来电悬浮窗时也会触发，
     * 那些场景下页面还是可见的，冻了纯属帮倒忙。
     */
    @Override
    protected void onStop() {
        super.onStop();
        if (web != null && !MediaBridge.isPlaying()) {
            web.onPause();
            webPaused = true;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null && webPaused) {
            web.onResume();
            webPaused = false;
        }
    }

    /**
     * Activity 销毁时判断「这是真退出，还是只是被划掉了」。
     *
     * 正在播 → 什么都别拆：WebView 留着（重新打开时复用，页面不重载）、
     *          前台服务继续、MediaBridge 里的 WebView 引用继续给页面下命令。
     * 其余情况 → 才是真的关掉：停服务、关桥、销毁 WebView。
     */
    @Override
    protected void onDestroy() {
        boolean stillPlaying = MediaBridge.isPlaying();
        if (isFinishing() && !stillPlaying) {
            stopService(new Intent(this, PlaybackService.class));
            HttpBridge.get().shutdown();
            MediaBridge.clear();
            if (web != null) {
                try {
                    web.destroy();
                } catch (Throwable ignore) {
                }
            }
        } else {
            Log.i(TAG, "Activity 销毁但仍在播放，保留 WebView 与会话");
        }
        super.onDestroy();
    }

    /** 兜底页：只有在 assets 缺失或 WebView 初始化异常时才会看到 */
    private static final String OFFLINE_HTML =
            "<!doctype html><html><head><meta charset='utf-8'>"
                    + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;"
                    + "display:flex;align-items:center;justify-content:center;height:100vh;color:#333}"
                    + "div{text-align:center;padding:24px}h2{font-size:18px;margin:0 0 8px}"
                    + "p{color:#888;font-size:14px;margin:0 0 20px}"
                    + "a{display:inline-block;padding:10px 28px;background:#ec4141;color:#fff;"
                    + "border-radius:22px;text-decoration:none;font-size:15px}</style></head><body>"
                    + "<div><h2>页面资源缺失</h2><p>安装包不完整，请重新安装</p>"
                    + "<a href='" + START_URL + "'>重试</a></div></body></html>";
}
