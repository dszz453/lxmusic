package com.yunmusic.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 云音乐 - 主 Activity
 *
 * 纯净原生宿主，负责三件事：
 *   1) 边到边全屏（内容延伸到状态栏与导航栏之下，红顶栏自然铺满状态栏区域）；
 *   2) 顶栏常驻的当前线路胶囊，点一下即切线；
 *   3) 原生双向通信与跨域透明请求（YunBridge）。
 *
 * 设计原则：**启动路径上的每一步都不允许抛异常**。WebView 初始化、窗口装饰、
 * 内边距补偿，任何一环在特定机型上失败，都不该让整个应用起不来 ——
 * 失败就降级成一块能看到文字的原生兜底页，把原因写在屏幕上。
 */
public class MainActivity extends Activity {
    private static MainActivity instance;

    private WebView webView;
    private ServerConfig config;
    private YunBridge bridge;
    private TextView tvActiveLine;
    /** 原生顶栏：全屏播放器打开时要把它藏起来，否则播放器顶部那排按钮会掉在它下面 */
    private View topBarView;
    /** 实测的状态栏高度（px），给播放器当 --safe-top 用 */
    private int statusBarInset = 0;

    /** WebView 起不来时的原生兜底容器（默认隐藏） */
    private FrameLayout fallbackBox;

    public static MainActivity getInstance() {
        return instance;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;

        // 窗口装饰：失败也不能拖垮启动
        try {
            setupWindow();
        } catch (Throwable ignored) {
        }

        LinearLayout rootLayout = new LinearLayout(this);
        rootLayout.setOrientation(LinearLayout.VERTICAL);
        rootLayout.setBackgroundColor(Color.WHITE);

        // 顶栏：构造失败就退化成一条纯色条，不影响下面
        View topBar;
        try {
            topBar = createTopBar();
        } catch (Throwable t) {
            topBar = new View(this);
            topBar.setBackgroundColor(Color.parseColor("#EC4141"));
            topBar.setLayoutParams(new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));
        }
        topBarView = topBar;
        rootLayout.addView(topBar);

        FrameLayout webContainer = new FrameLayout(this);
        webContainer.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1.0f));

        // 兜底页与 WebView 叠在同一个容器里，谁需要谁显示
        fallbackBox = buildFallbackBox();
        fallbackBox.setVisibility(View.GONE);
        webContainer.addView(fallbackBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        try {
            config = new ServerConfig(this);
            bridge = new YunBridge(this, config);

            webView = new WebView(this);
            setupWebView();
            webView.setBackgroundColor(Color.WHITE);
            webContainer.addView(webView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } catch (Throwable t) {
            // WebView 不可用（系统组件被精简/降级）—— 至少把原因写出来
            showFallback("界面组件（WebView）初始化失败：\n\n" + describe(t)
                    + "\n\n请到应用商店更新「Android System WebView」后重试。");
        }

        rootLayout.addView(webContainer);
        setContentView(rootLayout);

        try {
            applyEdgeInsets(rootLayout, topBar);
        } catch (Throwable ignored) {
        }

        if (webView != null) {
            try {
                // 加载本地极速离线 Web 壳
                webView.loadUrl("file:///android_asset/web/index.html");
            } catch (Throwable t) {
                showFallback("本地页面加载失败：\n\n" + describe(t));
            }
        }

        // 上一次启动如果崩过，顶栏给个入口，别让崩溃信息白白丢掉
        try {
            maybeWarnLastCrash();
        } catch (Throwable ignored) {
        }
    }

    /* ============================ 启动期加固 ============================ */

    /**
     * 边到边全屏。
     *
     * 为什么必须显式声明 targetSdk（见 AndroidManifest 的注释）：targetSdk 过低时
     * Android 12+ 会把应用塞进兼容模式的小窗口，界面根本铺不满屏幕 ——
     * 那是系统层的行为，代码里再怎么调窗口参数都救不回来。
     *
     * 这里做的是「内容延伸到系统栏之下」：状态栏设为透明，红色顶栏自己垫高到
     * 状态栏高度，视觉上就是一整块红色顶到屏幕顶端。
     */
    private void setupWindow() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                    | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            // 状态栏透明 → 让红色顶栏透上来；导航栏白色 → 与底部标签栏同色
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.WHITE);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Api30.edgeToEdge(window);
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // 白色导航栏 → 需要深色图标；状态栏是红色，保持默认的白色图标
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    /**
     * API 30+ 的边到边实现单独放一个内部类。
     * 直接把 WindowInsetsController 写在主流程里，在老设备上类加载阶段可能
     * 因为找不到这个类而抛 NoClassDefFoundError —— 隔离之后只在真的走 30+ 分支时才加载。
     */
    private static class Api30 {
        static void edgeToEdge(Window window) {
            window.setDecorFitsSystemWindows(false);
            window.setNavigationBarContrastEnforced(false);
            android.view.WindowInsetsController c = window.getInsetsController();
            if (c != null) {
                c.setSystemBarsAppearance(
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        }
    }

    /**
     * 把系统栏高度补成内边距。
     *
     * 边到边之后窗口会盖住状态栏与导航栏，若不补偿，顶栏文字会被状态栏压住、
     * 底部标签栏会被导航栏挡住。这里：顶部给红顶栏，底部给根容器。
     */
    private void applyEdgeInsets(final LinearLayout root, final View topBar) {
        final int padH = dp(16);
        final int padV = dp(10);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top = insets.getSystemWindowInsetTop();
                int bottom = insets.getSystemWindowInsetBottom();
                statusBarInset = top;
                topBar.setPadding(padH, padV + top, padH, padV);
                v.setPadding(0, 0, 0, bottom);
                return insets;
            }
        });
        root.requestApplyInsets();
    }

    /**
     * 全屏播放器打开/收起时切换原生顶栏。
     *
     * 播放器是「盖住整个界面」的，但原生顶栏在 LinearLayout 里是 WebView 的**兄弟节点**，
     * 网页再怎么定位也盖不住它。顶栏留着，播放器顶部那排「收起箭头 + 音质按钮」
     * 就只能掉在红色顶栏下面 —— 用户的原话就是「位置太靠下」。
     *
     * 隐藏顶栏后 WebView 会顶到 y=0（窗口是边到边的），这时状态栏会压住播放器顶部，
     * 所以顺手把状态栏高度写给页面当 `--safe-top`，让播放器用自己的 padding-top 让开。
     */
    public void setTopBarVisible(final boolean visible) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (topBarView != null) {
                        topBarView.setVisibility(visible ? View.VISIBLE : View.GONE);
                    }
                    int pad = visible ? 0 : statusBarHeightPx();
                    runJs("document.documentElement.style.setProperty('--safe-top','" + pad + "px')");
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** 状态栏高度：优先用 insets 实测值，拿不到就查系统资源，再不行给个保守估计 */
    private int statusBarHeightPx() {
        if (statusBarInset > 0) return statusBarInset;
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) return getResources().getDimensionPixelSize(id);
        } catch (Throwable ignored) {
        }
        return dp(24);
    }

    private LinearLayout createTopBar() {
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setBackgroundColor(Color.parseColor("#EC4141"));
        int padH = dp(16);
        int padV = dp(10);
        topBar.setPadding(padH, padV, padH, padV);
        topBar.setGravity(Gravity.CENTER_VERTICAL);

        // 应用标题
        TextView tvTitle = new TextView(this);
        tvTitle.setText("云音乐 V2.7");
        tvTitle.setTextColor(Color.WHITE);
        tvTitle.setTextSize(17);
        tvTitle.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.0f);
        topBar.addView(tvTitle, titleLp);

        // 当前线路胶囊
        LinearLayout lineCapsule = new LinearLayout(this);
        lineCapsule.setOrientation(LinearLayout.HORIZONTAL);
        lineCapsule.setGravity(Gravity.CENTER_VERTICAL);
        lineCapsule.setBackgroundColor(Color.parseColor("#D73535"));
        lineCapsule.setPadding(dp(10), dp(4), dp(10), dp(4));

        tvActiveLine = new TextView(this);
        tvActiveLine.setTextColor(Color.WHITE);
        tvActiveLine.setTextSize(12);
        lineCapsule.addView(tvActiveLine);

        // 快速切换文字按钮
        TextView tvSwitch = new TextView(this);
        tvSwitch.setText(" 切换");
        tvSwitch.setTextColor(Color.parseColor("#FFE082"));
        tvSwitch.setTextSize(12);
        tvSwitch.setTypeface(null, Typeface.BOLD);
        lineCapsule.addView(tvSwitch);

        lineCapsule.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 原生顶栏点击：直接反转当前线路 (0 <-> 1)
                int nextLine = config.getActiveLine() == 0 ? 1 : 0;
                bridge.switchLine(nextLine);
                // 由前端弹「已切换至 X」提示（切线的 Toast 只在页面侧发一次，避免双提示）
                notifyFrontendLineSwitched();
            }
        });

        topBar.addView(lineCapsule);
        updateTopBarLineStatus();
        return topBar;
    }

    public void updateTopBarLineStatus() {
        if (tvActiveLine != null && config != null) {
            tvActiveLine.setText("● " + (config.getActiveLine() == 0 ? "CF端" : "Docker端"));
        }
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUseWideViewPort(false);
        settings.setLoadWithOverviewMode(false);

        // 注入 YunBridge，前端通过 window.YunBridge 访问
        webView.addJavascriptInterface(bridge, "YunBridge");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                return super.onConsoleMessage(cm);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                /*
                 * 页面加载完成后同步一次线路配置。
                 *
                 * 这里**只是同步**，不是"线路变了"。onPageFinished 在一次会话里会被回调
                 * 多次（含站内跳转），早先前端收到就无条件弹「已切换至线路 X」，
                 * 于是每点一个菜单都蹦一次提示。现在前端会比对线路是否真的变了，
                 * 没变就静默更新，不再打扰用户。
                 */
                notifyFrontendLineSwitched();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                // 只关心主框架：本地壳页如果都没加载出来，用户看到的就是白屏，
                // 那就把错误摊出来，别让人对着白屏猜
                try {
                    if (request != null && request.isForMainFrame()) {
                        showFallback("页面加载出错：\n\n" + (error == null ? "" : String.valueOf(error.getDescription())));
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /* ============================ 原生兜底页 ============================ */

    private FrameLayout buildFallbackBox() {
        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(Color.parseColor("#F5F5F6"));

        LinearLayout inner = new LinearLayout(this);
        inner.setOrientation(LinearLayout.VERTICAL);
        inner.setPadding(dp(20), dp(40), dp(20), dp(20));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inner.setLayoutParams(lp);

        TextView head = new TextView(this);
        head.setText("云音乐 无法显示界面");
        head.setTextColor(Color.parseColor("#EC4141"));
        head.setTextSize(17);
        head.setTypeface(null, Typeface.BOLD);
        inner.addView(head);

        TextView body = new TextView(this);
        body.setId(android.R.id.message);
        body.setTextColor(Color.parseColor("#333333"));
        body.setTextSize(13);
        body.setPadding(0, dp(12), 0, 0);
        body.setTextIsSelectable(true);
        inner.addView(body);

        box.addView(inner);
        return box;
    }

    private void showFallback(String message) {
        try {
            if (fallbackBox == null) return;
            fallbackBox.setVisibility(View.VISIBLE);
            TextView tv = (TextView) fallbackBox.findViewById(android.R.id.message);
            if (tv != null) tv.setText(message);
            if (webView != null) webView.setVisibility(View.GONE);
        } catch (Throwable ignored) {
        }
    }

    private static String describe(Throwable t) {
        if (t == null) return "未知错误";
        String msg = t.getMessage();
        return t.getClass().getSimpleName() + (msg == null ? "" : ": " + msg);
    }

    /** 上次启动崩过 → 把崩溃现场弹给用户看一次（每份日志只弹一次） */
    private void maybeWarnLastCrash() {
        if (!App.shouldAutoShowCrash(this)) return;
        Intent i = new Intent(this, CrashActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
    }

    /* ============================ 原生回调 ============================ */

    /** 把当前线路配置推给前端（前端自行判断是否需要提示/重登） */
    public void notifyFrontendLineSwitched() {
        if (webView != null && config != null) {
            try {
                final String json = config.toJson().toString();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            webView.evaluateJavascript(
                                    "if(window.onNativeLineChanged) { window.onNativeLineChanged(" + json + "); }", null);
                        } catch (Throwable ignored) {
                        }
                    }
                });
            } catch (Throwable ignored) {
            }
        }
    }

    /** 响应系统通知栏媒体按键：播放/暂停 */
    public void togglePlayPauseFromNative() {
        runJs("if(window.nativeTogglePlay) { window.nativeTogglePlay(); }");
    }

    /** 响应系统通知栏媒体按键：下一首 */
    public void nextTrackFromNative() {
        runJs("if(window.nativeNextTrack) { window.nativeNextTrack(); }");
    }

    /** 响应系统通知栏媒体按键：上一首 */
    public void prevTrackFromNative() {
        runJs("if(window.nativePrevTrack) { window.nativePrevTrack(); }");
    }

    /**
     * 响应锁屏 / 控制中心拖动进度条。
     * 系统给的是毫秒，网页那边用的是秒，转换放在网页侧（nativeSeekTo）。
     */
    public void seekFromNative(final long ms) {
        runJs("if(window.nativeSeekTo) { try{ window.nativeSeekTo(" + ms + ") }catch(e){} }");
    }

    /** 已经弹过一次权限框就不再弹，避免用户每次播放都被打扰 */
    private boolean askedNotifPerm = false;

    /**
     * Android 13（API 33）起，通知属于**运行时权限**，默认是关的。
     * 不申请的话，前台服务照样跑，但通知栏和锁屏上什么都看不到 ——
     * 表现就是用户说的「锁屏不显示、控制中心里没有」。
     *
     * 放在「真正开始播放」时申请，而不是一进 App 就弹框。
     */
    public void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (askedNotifPerm) return;
                    if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        return;
                    }
                    askedNotifPerm = true;
                    requestPermissions(
                            new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                            REQ_NOTIF_PERM);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private static final int REQ_NOTIF_PERM = 9001;

    /** 供 YunBridge 等从任意线程安全地执行一段页面脚本 */
    public void runJs(final String js) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** 异步回调 HTTP 成功 */
    public void notifyHttpSuccess(String reqId, int statusCode, String responseText) {
        if (webView == null) return;
        try {
            JSONObject obj = new JSONObject();
            obj.put("reqId", reqId);
            obj.put("status", statusCode);
            obj.put("body", responseText);
            runJs("if(window.onNativeHttpCallback) { window.onNativeHttpCallback(" + obj.toString() + "); }");
        } catch (Exception ignore) {
        }
    }

    /** 异步回调 HTTP 失败 */
    public void notifyHttpError(String reqId, String error) {
        if (webView == null) return;
        try {
            JSONObject obj = new JSONObject();
            obj.put("reqId", reqId);
            obj.put("error", error);
            runJs("if(window.onNativeHttpCallback) { window.onNativeHttpCallback(" + obj.toString() + "); }");
        } catch (Exception ignore) {
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        try {
            // 如果全屏播放器或搜索页打开，优先通过 JS 处理返回事件
            webView.evaluateJavascript("if(window.handleAppBack) { window.handleAppBack(); } else { 'default'; }",
                    new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if ("\"handled\"".equals(value) || "true".equals(value)) {
                                // 已由页面内部处理（如关闭播放器或弹窗）
                            } else {
                                if (webView.canGoBack()) {
                                    webView.goBack();
                                } else {
                                    MainActivity.super.onBackPressed();
                                }
                            }
                        }
                    });
        } catch (Throwable t) {
            super.onBackPressed();
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
    }
}
