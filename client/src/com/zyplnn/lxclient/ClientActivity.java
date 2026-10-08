package com.zyplnn.lxclient;

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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 客户端主界面 —— 原生外壳 + 跨端内容区。
 *
 * ══════════════ 这个类在分层里的位置 ══════════════
 *
 * 它对应网易云客户端里的「原生宿主（Activity/Fragment 壳）」那一层。整机分四层：
 *
 *   ① 原生宿主层（本类 + 四个原生页面 + PlaybackService）
 *        顶栏、底部导航、页面切换、生命周期、权限、系统交互。
 *   ② 跨端桥接层（AndroidHost 内部类 + BridgeHub）
 *        把 http / db / 媒体会话 / 原生 UI 能力暴露给跨端层，两个方向都有（JS 调原生、
 *        原生回调 JS）。
 *   ③ 跨端业务层（WebView 里跑的 public/ 前端 + rn/src/client-layer.js）
 *        首页、搜索、歌单、播放器这些**频繁迭代的业务页面**。这一层是「一套代码
 *        三宿主共用」的直接受益者 —— 网页端写完，客户端白拿。
 *   ④ 底层能力层（core/AudioEngine + PlaybackService 的媒体会话）
 *        音频扫描、解码接口（JNI 预留）、通知栏 / 锁屏 / 耳机按键。
 *
 * 与网易云那份技术栈的差异（为什么不是 React Native / Kotlin）：
 * 见 docs/client-android.md，一句话是「构建链路里没有 Gradle，也没有 RN 工具链」。
 * 但**分层与职责划分是完全照搬的** —— 换渲染载体不改架构。
 *
 * ══════════════ 原生外壳接管了网页的哪部分 ══════════════
 *
 * 网页自己本来有顶栏（☰ + 搜索框 + 账号）和底部标签栏。客户端里这两个都换成原生的：
 *   · 为什么要换：底部导航是「App 的手感」最集中的地方 —— 触摸反馈、点击热区、
 *     切换速度、跟手动画。放在 WebView 里永远差一截（点击要跨进程、命中判定靠 JS）。
 *   · 怎么换：注入一段 CSS 把网页的 .topbar / .tabbar 隐藏（在 <head> 里注入，
 *     所以不会闪一下再消失），原生底栏点击时驱动 location.hash，
 *     跨端层监听 hashchange 回调原生高亮 —— 双向同步在 client-layer.js 里。
 *
 * ══════════════ 与 music-edge 壳（android/）的关系 ══════════════
 *
 * 那个壳是「离线自包含」的：后端整个跑在设备内，永远不连服务器。
 * 这个客户端是「通用」的：首启让你选连哪条线（内置离线 / CF / Docker / 自建），
 * 连上之后服务端自报是什么，界面就显示什么品牌与版本。两者的 WebView 配置、
 * 桥接协议、保活策略完全一致 —— 那部分是被验证过的资产，直接复用不重写。
 */
public class ClientActivity extends Activity {

    private static final String TAG = "LXC/Main";

    private static final int REQ_NOTIFICATIONS = 1001;
    /** 首启向导 / 服务器页回来的结果码。用它决定要不要重建页面 */
    private static final int REQ_SERVER = 2001;

    /**
     * 页面 origin 用线上域名，内容由 assets 供给（内容拦截层做）。
     *
     * 为什么不用 file://：file:// 页面是 opaque origin —— localStorage / IndexedDB /
     * Worker 全都别扭甚至不可用，而前端大量既有的存储与 Worker 逻辑（插件池、缓存、
     * 自动登录）全指望这些。用一个真实的 https origin，这些代码一行都不用改。
     * 拦截层保证这个「假域名」下面的每一个字节都来自 APK 内部，一个请求都不出设备；
     * 而**远程模式**下真正要出网的 /api/* 请求走原生桥（见第 8 节与跨端层），
     * 也不经过这个域名。
     */
    private static final String START_URL = "https://music.zyplnn.dpdns.org/";
    private static final String ASSET_ROOT = "www";

    /**
     * 标准 Chrome 移动端 UA。WebView 默认 UA 带 "; wv" 标记，
     * 一部分音乐 CDN / 反爬网关会据此拒绝请求 —— 表现是「搜索有结果，点播没声音」。
     */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    /**
     * 只放纯 MIME 类型，不带 "; charset="。
     * 实测部分 WebView 对 WebResourceResponse 的 mimeType 解析很死板：
     * 带 charset 参数会被当成不认识的类型按 text/plain 渲染 —— 整页源码铺在屏幕上。
     * 字符集走 WebResourceResponse 的 encoding 参数（固定 utf-8），信息不丢。
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

    /** 跨端层的四个 tab。key 与 public/index.html 里 .tabbar__item 的 data-tab 一致 */
    private static final String[] TAB_KEYS = {"home", "library", "favorite", "mine"};
    private static final String[] TAB_HASH = {"#/", "#/library", "#/favorite", "#/mine"};
    private static final int[] TAB_ICONS = {
            R.drawable.ic_tab_home, R.drawable.ic_tab_library,
            R.drawable.ic_tab_favorite, R.drawable.ic_tab_mine};
    private static final int[] TAB_LABELS = {
            R.string.tab_home, R.string.tab_library,
            R.string.tab_favorite, R.string.tab_mine};

    private WebView web;
    private ProgressBar bar;
    /** 顶栏下方那条细状态条：显示当前连的是哪条线、服务端版本、构建号 */
    private TextView statusText;
    private View statusDot;
    /** 原生底栏整块（含上边框），跨端层在整屏状态（登录页）时要把它收起来 */
    private View navRoot;
    private boolean navBarVisible = true;
    private LinearLayout[] tabViews;
    private ImageView[] tabIcons;
    private TextView[] tabLabels;

    /** 原生底栏当前高亮的下标（-1 = 还不在四个主 tab 上，比如进了二级页） */
    private int currentTab = -1;

    private boolean errored = false;
    private boolean webPaused = false;
    private boolean notifAsked = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Ui.color(this, R.color.bg));

        root.addView(buildTopBar());
        root.addView(buildStatusStrip());

        /**
         * 复用上一次留下的 WebView（与壳里同一套保活策略）。
         *
         * 场景：用户在播放中从「最近任务」划掉了 App，Activity 被销毁，
         * 但我们故意没销毁 WebView（音乐还在放）。重新点开时若新建一个 WebView，
         * 页面会重新加载、播放从头开始，上面那套保活就白费了。
         * 把旧的从原父容器摘下来装回新布局即可 —— 队列、进度、滚动位置原样保留。
         *
         * 摘 parent 这步不能省：旧 Activity 的视图树已销毁，但 WebView 对象不会
         * 自动摘除，留着会以「已有父容器」为由拒绝被 addView。
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

        FrameLayout content = new FrameLayout(this);
        content.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content.addView(bar, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 3)));
        // 内容区吃掉剩余高度（顶栏 / 状态条 / 底栏都是固定高）
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        navRoot = buildBottomNav();
        root.addView(navRoot);
        setContentView(root);

        // 桥都是单例：跟进程走，不跟 Activity 走（见各类里的说明）
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

        refreshStatus();
        firstRunIfNeeded(savedInstanceState != null);
    }

    /**
     * 首启引导：还没走过一遍的话，把服务器连接页**盖在主界面之上**推出来。
     *
     * 放在主界面之后而不是之前：即使引导页被用户按返回键关掉，主界面也已经在跑了
     * （默认走内置离线模式），不会出现「一个空壳 Activity 什么都没有」的状态。
     *
     * @param restoring true = 这是旋转屏幕 / 进程重建，不要重复弹引导
     */
    private void firstRunIfNeeded(boolean restoring) {
        if (restoring) return;
        ServerStore st = ServerStore.get(this);
        if (st.isOnboarded()) return;
        try {
            Intent i = new Intent(this, ServerActivity.class);
            i.putExtra(ServerActivity.EXTRA_FIRST_RUN, true);
            startActivityForResult(i, REQ_SERVER);
        } catch (Throwable t) {
            Log.w(TAG, "打开首启引导失败: " + t.getMessage());
        }
    }

    /* ══════════════════ 原生顶栏 ══════════════════ */

    /**
     * 顶栏 = ☰ + 搜索胶囊 + ⚙，与网页顶栏同构（原来那个「账号」按钮的活由底栏「我的」承担）。
     *
     * 搜索胶囊点了走跨端层的 #/search —— 位置、形状、点击行为都跟网页版一致，
     * 用户从浏览器换到 App 不会找不到搜索在哪。
     */
    private View buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Ui.color(this, R.color.surface));
        int sb = Ui.statusBarHeight(this);
        bar.setPadding(Ui.dp(this, 6), sb, Ui.dp(this, 6), 0);
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 52) + sb));

        // 左：菜单。网页那个抽屉（#btnMenu 背后）还有用 —— 插件导入、音源选择都在里面，
        // 所以原生按钮直接去点那个被隐藏的按钮，逻辑一份不重写。
        bar.addView(topIconBtn(R.drawable.ic_menu, "菜单", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                eval("(function(){var b=document.getElementById('btnMenu');if(b)b.click()})()");
            }
        }));

        // 中：搜索胶囊
        TextView pill = Ui.text(this, "搜索歌曲、专辑、有声书", 13, Ui.color(this, R.color.text_3), false);
        pill.setGravity(android.view.Gravity.CENTER_VERTICAL);
        pill.setPadding(Ui.dp(this, 28), 0, Ui.dp(this, 12), 0);
        pill.setSingleLine(true);
        pill.setEllipsize(android.text.TextUtils.TruncateAt.END);
        pill.setBackground(Ui.ripple(this, Ui.shape(this, 0xFFF2F2F3, 999, 0, 0), 0x14000000));
        pill.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openRoute("#/search");
            }
        });
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(0, Ui.dp(this, 34), 1f);
        plp.setMargins(Ui.dp(this, 2), 0, Ui.dp(this, 2), 0);
        bar.addView(pill, plp);

        // 右：设置（原生页面）
        bar.addView(topIconBtn(R.drawable.ic_settings, "设置", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(ClientActivity.this, SettingsActivity.class));
            }
        }));
        return bar;
    }

    private View topIconBtn(int iconRes, String desc, View.OnClickListener cb) {
        ImageView iv = Ui.icon(this, iconRes, Ui.color(this, R.color.text), 22);
        FrameLayout wrap = new FrameLayout(this);
        wrap.addView(iv, new FrameLayout.LayoutParams(
                Ui.dp(this, 22), Ui.dp(this, 22), android.view.Gravity.CENTER));
        wrap.setContentDescription(desc);
        wrap.setBackground(Ui.ripple(this, Ui.shape(this, Color.TRANSPARENT, 999, 0, 0), 0x14000000));
        wrap.setOnClickListener(cb);
        wrap.setLayoutParams(new LinearLayout.LayoutParams(Ui.dp(this, 42), Ui.dp(this, 42)));
        return wrap;
    }

    /* ══════════════════ 连接状态条 ══════════════════ */

    /**
     * 顶栏下面那条 24dp 的细条：`● music-edge · 服务端 V1.3 · 3a41e22a1b2c`。
     *
     * 为什么值得占这 24dp：这个客户端是**通用**的，同一个 APK 可能连着家里的 Docker、
     * 公司内网的一台、或者外面那台 CF —— 用户最容易搞混的就是「我现在看的这份数据是谁的」。
     * 把它常驻在顶部、点一下就能换，比藏在设置页里翻要靠谱得多。
     */
    private View buildStatusStrip() {
        LinearLayout strip = new LinearLayout(this);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setGravity(android.view.Gravity.CENTER_VERTICAL);
        strip.setBackgroundColor(Ui.color(this, R.color.surface_2));
        strip.setPadding(Ui.dp(this, 14), 0, Ui.dp(this, 14), 0);
        strip.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 24)));

        statusDot = new View(this);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(Ui.dp(this, 7), Ui.dp(this, 7));
        dlp.setMargins(0, 0, Ui.dp(this, 7), 0);
        strip.addView(statusDot, dlp);

        statusText = Ui.text(this, "", 11.5f, Ui.color(this, R.color.text_3), false);
        statusText.setSingleLine(true);
        statusText.setEllipsize(android.text.TextUtils.TruncateAt.END);
        strip.addView(statusText, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView more = Ui.text(this, "切换", 11.5f, Ui.color(this, R.color.brand), false);
        strip.addView(more);

        strip.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivityForResult(new Intent(ClientActivity.this, ServerActivity.class), REQ_SERVER);
            }
        });
        return strip;
    }

    /** 刷新状态条上的品牌 / 版本 / 连接态。握手结果变了、切换了档案都要调 */
    private void refreshStatus() {
        if (statusText == null) return;
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p = st.active();
        boolean builtin = ServerStore.KIND_BUILTIN.equals(p.kind);
        String name = p.brandName();

        StringBuilder sb = new StringBuilder();
        sb.append(name);
        if (builtin) {
            sb.append(" · 内置离线：数据都在这台手机上");
        } else {
            sb.append(" · 服务端 ").append(p.version.isEmpty() ? "未握手" : p.version);
            if (!p.build.isEmpty() && !"dev".equals(p.build)) sb.append(" · ").append(p.build);
            if (!p.base.isEmpty()) sb.append(" · ").append(stripScheme(p.base));
        }

        statusText.setText(sb.toString());
        int dot = builtin ? Ui.color(this, R.color.text_3)
                : (p.checkedAt > 0 ? Ui.color(this, R.color.ok) : Ui.color(this, R.color.warn));
        statusDot.setBackground(Ui.shape(this, dot, 999, 0, 0));
    }

    /** 地址太长会挤掉品牌名，状态条上只留主机名 */
    private static String stripScheme(String base) {
        return base.replaceFirst("(?i)^https?://", "");
    }

    /* ══════════════════ 原生底部导航 ══════════════════ */

    /**
     * 底部导航条：四项，跟网页 tabbar 一一对应。
     *
     * 高度 = 52dp + 系统导航栏高度（手势条/虚拟键区域）—— 不加后面这个的话，
     * 在虚拟键机型上底栏会被系统栏压住，用户点不到最后一行文字。
     */
    private View buildBottomNav() {
        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setBackgroundColor(Ui.color(this, R.color.surface));

        View top = new View(this);
        top.setBackgroundColor(Ui.color(this, R.color.line));

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(top, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(this, 0.7f))));
        wrap.addView(nav, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                Ui.dp(this, 52) + Ui.navBarHeight(this)));
        nav.setPadding(0, 0, 0, Ui.navBarHeight(this));

        tabViews = new LinearLayout[TAB_KEYS.length];
        tabIcons = new ImageView[TAB_KEYS.length];
        tabLabels = new TextView[TAB_KEYS.length];

        for (int i = 0; i < TAB_KEYS.length; i++) {
            final int idx = i;
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setGravity(android.view.Gravity.CENTER);
            item.setBackground(Ui.ripple(this, Ui.shape(this, Color.TRANSPARENT, 0, 0, 0), 0x0F000000));

            ImageView iv = Ui.icon(this, TAB_ICONS[i], Ui.color(this, R.color.nav_off), 21);
            item.addView(iv, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            TextView tv = Ui.text(this, getString(TAB_LABELS[i]), 10.5f,
                    Ui.color(this, R.color.nav_off), false);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            tlp.topMargin = Ui.dp(this, 2);
            item.addView(tv, tlp);

            item.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    // 重复点当前 tab：回到该 tab 的根（网页里也是这个行为）
                    openRoute(TAB_HASH[idx]);
                }
            });
            nav.addView(item, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.MATCH_PARENT, 1f));

            tabViews[i] = item;
            tabIcons[i] = iv;
            tabLabels[i] = tv;
        }
        return wrap;
    }

    /**
     * 高亮某个 tab。跨端层在 hashchange 时会回调这里（见 BridgeHub.setRoute），
     * 所以「网页里点了搜索结果跳去歌单页」这种事，底栏高亮也会跟着对。
     *
     * @param idx -1 = 当前不在四个主 tab 上（二级页），底栏全部回到未选中态
     */
    private void applyTab(int idx) {
        if (tabViews == null || idx == currentTab) return;
        currentTab = idx;
        for (int i = 0; i < tabViews.length; i++) {
            boolean on = i == idx;
            int c = Ui.color(this, on ? R.color.nav_on : R.color.nav_off);
            Ui.tint(tabIcons[i].getDrawable(), c);
            tabLabels[i].setTextColor(c);
        }
    }

    /** 原生 → 跨端：切路由。用 location.hash 而不是 reload，页面不重载、播放不断 */
    private void openRoute(String hash) {
        if (web == null) return;
        eval("(function(){var h=" + org.json.JSONObject.quote(hash)
                + ";if(location.hash!==h){location.hash=h}else{"
                // 同一个 hash 再点一次不会触发 hashchange，手工派一个，
                // 让「重复点当前 tab 回到该页根」这类行为仍能生效。
                // 事件构造器做两层兜底：老 WebView 上 HashChangeEvent 可能不存在。
                + "try{window.dispatchEvent(new HashChangeEvent('hashchange'))}"
                + "catch(e){window.dispatchEvent(new Event('hashchange'))}}})()");
    }

    /**
     * 跨端 → 原生：把网页当前的 hash 读回来，校正底栏高亮。
     *
     * 用 evaluateJavascript 的回调（而不是让 JS 反过来调桥）来读：
     * 这是**原生主动问**的路径 —— 页面加载完成、从原生页返回、切换服务器后都要对一次，
     * 而 JS 那边只负责在 hashchange 时喊一声（见 BridgeHub.setRoute）。
     * 两条路径互补：一条保证「随时能问准」，一条保证「变化立刻知道」。
     */
    private void syncRouteFromWeb() {
        if (web == null) return;
        try {
            web.evaluateJavascript("(function(){try{return String(location.hash||'')}catch(e){return ''}})()",
                    new android.webkit.ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            onRouteFromWeb(unquoteJson(value));
                        }
                    });
        } catch (Throwable t) {
            Log.w(TAG, "读取路由失败: " + t.getMessage());
        }
    }

    /** evaluateJavascript 回传的是 JSON 字面量（字符串带引号，空值是 "null"） */
    private static String unquoteJson(String v) {
        if (v == null || "null".equals(v)) return "";
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            return v.substring(1, v.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return v;
    }

    private void eval(String js) {
        if (web == null) return;
        try {
            web.evaluateJavascript(js, null);
        } catch (Throwable t) {
            Log.w(TAG, "evaluateJavascript 失败: " + t.getMessage());
        }
    }

    /* ══════════════════ 跨端层容器配置 ══════════════════ */

    private void configureWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // 登录态、插件列表、服务器地址都在 localStorage
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
             * 一部分音源只给 http 直链。https 页面下浏览器会按混合内容拦掉，
             * 只能绕服务端代理（多一跳、还依赖服务端活着）。壳里放开这一层，
             * 音频与封面就能真·直连。
             */
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        // 关闭 HTTP 缓存：资源全部来自本地 assets，缓存只会制造「换了包还跑旧代码」
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);

        /**
         * 两个门面对象，职责分开：
         *   AndroidHost —— 老的、被 public/js/native.js 依赖的那一套（http / db / 媒体会话）。
         *                  名字与签名**不能改**：共用前端源码在找它。
         *   LXNative    —— 客户端新增的原生 UI 能力（服务器档案、开原生页、切 tab…）。
         *                  只有这个客户端里存在，网页端 / 老壳里都没有。
         */
        web.addJavascriptInterface(new AndroidHost(), "AndroidHost");
        web.addJavascriptInterface(new BridgeHub(this), "LXNative");
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
             * 内容拦截：站点域名下的所有请求就地解决，不经过网络。
             * 这个方法在后台线程被调用，所以这里读文件是安全的。
             * index.html 走 serveIndex（要注入客户端外壳脚本），其余走 serveAsset。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    String host = request.getUrl().getHost();
                    if (host == null || !host.endsWith("zyplnn.dpdns.org")) return null;
                    String path = request.getUrl().getPath();
                    if (path == null || path.isEmpty() || "/".equals(path) || "/index.html".equals(path)) {
                        return serveIndex();
                    }
                    return serveAsset(path);
                } catch (Throwable t) {
                    Log.w(TAG, "拦截失败: " + t.getMessage());
                    return null;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                // 底栏高亮按当前 hash 对一次。整页重载后 hash 会保留（跨端层是本页重载），
                // 而原生这边默认是「全未选中」，不校正的话高亮会与页面内容不符。
                syncRouteFromWeb();
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

    /* ══════════════════ 资源供应 + 客户端外壳注入 ══════════════════ */

    /**
     * 供应 index.html，并**在 <head> 最前面**注入一段引导脚本 + 屏蔽样式。
     *
     * 为什么是在这里注入、而不是靠 Java 桥事后补：
     *   三件事都必须在**页面脚本跑起来之前**就位，晚了就是一次可见的错误状态：
     *     1. localStorage 里的服务器地址 —— native.js 在**加载时**就读它决定
     *        「本机后端 vs 远程服务器」，晚一步这一整页连的就是错的那套后端；
     *     2. 品牌同步判据 —— brand.js 读取时若没有它就会退回「壳一定是 cf」的猜测，
     *        Docker 那条线会被装成 music-edge 的 PWA 身份（见 brand.js 的注释）；
     *     3. 隐藏网页自带顶栏/底栏的样式 —— 不在这里注入的话，会先看到网页底栏
     *        闪一下再被原生底栏取代。
     */
    private WebResourceResponse serveIndex() {
        try {
            String html = readAsset(ASSET_ROOT + "/index.html");
            if (html == null) return null;
            String out = injectClientShell(html);
            return new WebResourceResponse("text/html", "utf-8",
                    new ByteArrayInputStream(out.getBytes("UTF-8")));
        } catch (Throwable t) {
            Log.w(TAG, "注入客户端外壳失败，退回原始页面: " + t.getMessage());
            return serveAsset("/index.html");
        }
    }

    private String injectClientShell(String html) throws Exception {
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p = st.active();
        boolean builtin = ServerStore.KIND_BUILTIN.equals(p.kind);
        String base = builtin ? "" : (p.base == null ? "" : p.base);

        /**
         * 品牌同步判据：优先用握手时服务端自报的 host；还没握手过就按档案类型推。
         * 内置离线跑的是从 CF 那条线打包下来的同一份前端，所以按 cf 算。
         */
        String brandKey = p.host == null || p.host.isEmpty()
                ? (ServerStore.KIND_DOCKER.equals(p.kind) ? "docker" : "cf")
                : p.host;

        JSONObject c = new JSONObject();
        c.put("version", ClientBrand.versionName(this));
        c.put("versionCode", ClientBrand.versionCode(this));
        c.put("build", ClientBrand.buildId(this));
        c.put("service", ClientBrand.SERVICE_EXPECT);
        c.put("brandKey", brandKey);
        c.put("brandName", ClientBrand.nameOf(brandKey));
        c.put("kind", p.kind);
        c.put("profileId", p.id);
        c.put("profileName", p.name);
        c.put("base", base);
        c.put("user", p.user == null ? "" : p.user);
        c.put("serverVersion", p.version == null ? "" : p.version);
        c.put("builtin", builtin);

        JSONArray arr = new JSONArray();
        List<ServerStore.Profile> ps = st.profiles();
        for (int i = 0; i < ps.size(); i++) {
            ServerStore.Profile q = ps.get(i);
            JSONObject j = new JSONObject();
            j.put("id", q.id);
            j.put("name", q.name);
            j.put("kind", q.kind);
            j.put("base", ServerStore.KIND_BUILTIN.equals(q.kind) ? "" : q.base);
            j.put("usable", q.usable());
            j.put("brand", q.brandName());
            j.put("version", q.version == null ? "" : q.version);
            arr.put(j);
        }
        c.put("profiles", arr);

        // 把 "<" 转义掉：档案名是用户输入的，万一里面带着 "</script>" 就会提前终止脚本块
        String json = c.toString().replace("<", "\\u003c");

        // 服务器地址与用户名：**每次加载都按档案重写**（原生是唯一事实来源）。
        // 网页端那个「服务端地址」输入框在客户端里被隐藏（见下面的样式），
        // 所以不存在「两边各存一份、互相覆盖」的问题。
        String boot = "<script>(function(){try{"
                + "window.LX_CLIENT=" + json + ";"
                + "window.LX_VERSION=" + JSONObject.quote(ClientBrand.versionName(this)) + ";"
                + "window.LX_BUILD=" + JSONObject.quote(ClientBrand.buildId(this)) + ";"
                + "window.LX_CLIENT_SERVICE=" + JSONObject.quote(ClientBrand.SERVICE_EXPECT) + ";"
                + "window.LX_CLIENT_HOST_HINT=" + JSONObject.quote(brandKey) + ";"
                + "var B=" + JSONObject.quote(base) + ";"
                + "if(B){localStorage.setItem('lx.serverBase',JSON.stringify(B))}"
                + "else{localStorage.removeItem('lx.serverBase')}"
                + "var U=" + JSONObject.quote(p.user == null ? "" : p.user) + ";"
                + "if(U){localStorage.setItem('lx.serverUser',JSON.stringify(U))}"
                + "else{localStorage.removeItem('lx.serverUser')}"
                + "}catch(e){}})()</script>";

        /**
         * 隐藏网页自带的顶栏与底栏（原生接管），并把版式里为它们预留的空间收回来：
         *   · --safe-top / --safe-bottom 归零 —— 状态栏与手势条现在由原生顶栏/底栏消化，
         *     网页再各让一份就会出现「底下莫名多一条白」。
         *   · .view 的 padding-bottom 原本给「迷你播放条 + 底栏」留位置，底栏没了，
         *     只留迷你条的高度。
         *   · #serverBlock 是网页设置页里的「服务端」卡片 —— 客户端里由原生
         *     「服务器连接」页管理，留着两个入口必然打架（改了原生那边、网页这边还显示旧值）。
         */
        String css = "<style id=\"lxClientChrome\">"
                + ":root{--safe-top:0px !important;--safe-bottom:0px !important}"
                + ".topbar{display:none !important}"
                + ".tabbar{display:none !important}"
                + ".view{padding-bottom:calc(var(--mini-h) + 10px) !important}"
                + "#serverBlock{display:none !important}"
                + "</style>";

        // 跨端层脚本放在 </body> 之前：它要等 app.js 把界面搭起来之后再接管
        String layer = "<script src=\"/js/client-layer.js\"></script>";

        String out = html;
        int head = out.indexOf("<head>");
        if (head >= 0) {
            out = out.substring(0, head + 6) + boot + css + out.substring(head + 6);
        } else {
            out = boot + css + out;
        }
        int body = out.lastIndexOf("</body>");
        if (body >= 0) {
            out = out.substring(0, body) + layer + out.substring(body);
        } else {
            out = out + layer;
        }
        return out;
    }

    /**
     * 从 assets/www 取资源。
     *   · 无扩展名的路径（SPA 路由）→ index.html
     *   · 有扩展名但文件不存在     → 返回 null，交给 WebView 自己处理
     */
    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty()) path = "/";
        String clean = path;
        while (clean.startsWith("/")) clean = clean.substring(1);

        boolean looksLikeFile = clean.contains(".");
        String assetPath = looksLikeFile ? (ASSET_ROOT + "/" + clean) : (ASSET_ROOT + "/index.html");

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

    private String readAsset(String assetPath) {
        InputStream in = null;
        try {
            in = getAssets().open(assetPath);
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        } finally {
            try {
                if (in != null) in.close();
            } catch (Throwable ignore) {
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

    /* ══════════════════ 门面一：AndroidHost（老桥，签名不能改） ══════════════════ */

    /**
     * 页面侧只认一个对象名 AndroidHost，这是**共用前端源码**（public/js/native.js）
     * 认定的协议 —— 网页端、老壳、这个客户端三处都用它，所以签名一个都不能变。
     * 具体实现在 HttpBridge / StoreBridge / MediaBridge，这里只做转发与兜底。
     */
    public class AndroidHost {

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
                return StoreBridge.get(ClientActivity.this).dbQuery(sql, argsJson);
            } catch (Throwable t) {
                Log.w(TAG, "dbQuery 失败: " + t.getMessage());
                return "[]";
            }
        }

        @JavascriptInterface
        public int dbExec(String sql, String argsJson) {
            try {
                return StoreBridge.get(ClientActivity.this).dbExec(sql, argsJson);
            } catch (Throwable t) {
                Log.w(TAG, "dbExec 失败: " + t.getMessage());
                return 0;
            }
        }

        @JavascriptInterface
        public void log(String tag, String msg) {
            Log.d("LXC/" + tag, String.valueOf(msg));
        }

        /**
         * 媒体会话上报：页面把「正在放什么」推上来，原生据此更新通知栏 / 锁屏 / 控制中心。
         * 跑在 WebView 的 JS 线程上，重活都在 MediaBridge 里安排。
         */
        @JavascriptInterface
        public void mediaReport(String json) {
            MediaBridge.report(json);
            askNotifications(false);
        }

        /**
         * 诊断：把「系统媒体控制能不能用」这条链路上的每层状态摊成 JSON。
         * 这条链路的故障症状全都一样（用户只会说「控制不了」），但原因可能是
         * 页面没装配 / 服务没起来 / 通知权限没给 / 系统通知总开关关了 / startForeground 抛异常。
         * 开发机没有安卓运行时，只能靠设备回传这一份来定位。
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
         * 为什么不用网页的 a[download]：WebView 里它在部分机型上**只是静默失败**，
         * 用户看不到任何反馈 —— 这正是「点了下载没反应」的标准成因。所以走原生写文件，
         * 页面侧拿返回值判定成功与否，失败时再回退到网页那套。
         *
         * 参数用 base64 而不是字节数组：@JavascriptInterface 的可跨边界类型里没有 byte[]，
         * 字符串是唯一稳的通道（页面侧分块编码，见 audiocache.js）。
         *
         * @return 成功返回绝对路径，失败返回空串（页面据此回退）
         */
        @JavascriptInterface
        public String saveAudio(final String filename, final String b64) {
            try {
                return MediaBridge.saveToDownloads(ClientActivity.this, filename, b64);
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

    /* ══════════════════ 通知权限 ══════════════════ */

    /**
     * Android 13 起通知要运行时授权，不申请的话前台服务的通知**一条都不显示** ——
     * 用户会以为「根本没在播」，锁屏与控制中心也没有播放控件可点。
     *
     * 时机选在「真的开始播第一首」时，而不是冷启动就弹：这个弹窗打断成本不低，
     * 用户还没听到声音就先被问一句，很容易顺手拒掉。
     *
     * @param manual true = 用户在设置页主动点的，此时不看「是否已问过」
     */
    void askNotifications(boolean manual) {
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
                        Toast.makeText(ClientActivity.this, R.string.notif_ok, Toast.LENGTH_SHORT).show();
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

    /** 播放通道的状态：na / missing / blocked / low / ok */
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
        MediaBridge.refresh();
    }

    /* ══════════════════ 生命周期 ══════════════════ */

    /** 服务器页回来：档案可能变了（品牌、地址、版本都要重新反映到原生外壳上） */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SERVER) return;
        boolean changed = data != null && data.getBooleanExtra(ServerActivity.EXTRA_CHANGED, false);
        refreshStatus();
        if (changed) {
            /**
             * 换了服务器就整页重载 —— **故意不做「热切换」**：
             * 两套后端意味着 token、插件池、缓存、播放队列全都要换一套，
             * 热切换留下的残留状态比重新加载一次贵得多。
             * 重载后注入脚本会把新的地址写进 localStorage，页面从零开始连新服务器。
             */
            try {
                web.loadUrl(START_URL);
            } catch (Throwable t) {
                Log.w(TAG, "切换服务器后重载失败: " + t.getMessage());
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null && webPaused) {
            web.onResume();
            webPaused = false;
        }
        refreshStatus();
        // 从原生页（设置 / 服务器 / 本地音乐）回来时，跨端页面可能已经被翻到了别的路由
        // （比如用户在设置里点了某个入口），回来对一次高亮。
        syncRouteFromWeb();
    }

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
     * 队列自动续播。播放中一冻，表现就是「还在响，但通知栏进度不动、
     * 这一首卡住了也不会自动降级重试」。所以播放中必须让它继续跑 ——
     * 这也是前台服务存在的意义。
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

    /**
     * Activity 销毁时判断「这是真退出，还是只是被划掉了」。
     *
     * 正在播 → 什么都别拆：WebView 留着（重新打开时复用，页面不重载）、
     *          前台服务继续、MediaBridge 里的引用继续给页面下命令。
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

    /* ══════════════════ 给 BridgeHub 用的包内入口 ══════════════════ */

    /** 原生 → 跨端：执行一段 JS（BridgeHub 用） */
    void evalJs(String js) {
        eval(js);
    }

    /** 跨端层报告当前路由，原生底栏据此高亮 */
    void onRouteFromWeb(String hash) {
        int idx = -1;
        String h = hash == null ? "" : hash.trim();
        for (int i = 0; i < TAB_HASH.length; i++) {
            if (TAB_HASH[i].equals(h) || ("#/".equals(TAB_HASH[i]) && ("#".equals(h) || h.isEmpty()))) {
                idx = i;
                break;
            }
        }
        applyTab(idx);
    }

    /**
     * 显示 / 收起原生底栏（跨端层在登录页、初始化页这类整屏状态上调）。
     *
     * 必须回主线程：这个方法由跨端层通过桥调过来，跑在 WebView 的 JavaBridge 线程上，
     * 直接碰 View 会抛「Only the original thread that created a view hierarchy can touch its views」。
     */
    void setChromeVisible(final boolean visible) {
        if (navRoot == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    navRoot.setVisibility(visible ? View.VISIBLE : View.GONE);
                    if (!visible) {
                        // 底栏收起时把高亮也清掉：不然重新登录后第一帧会先亮一下旧的 tab
                        applyTab(-1);
                    }
                    navBarVisible = visible;
                } catch (Throwable t) {
                    Log.w(TAG, "切换底栏可见性失败: " + t.getMessage());
                }
            }
        });
    }

    /** 页面侧请求重载（切换服务器、清空缓存后） */
    void reloadPage() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    web.loadUrl(START_URL);
                } catch (Throwable t) {
                    Log.w(TAG, "重载失败: " + t.getMessage());
                }
            }
        });
    }

    /** 服务器档案变了（BridgeHub 改的），刷新原生外壳上的显示 */
    void onProfilesChanged(boolean needReload) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                refreshStatus();
            }
        });
        if (needReload) reloadPage();
    }

    /** 兜底页：只有在 assets 缺失或 WebView 初始化异常时才会看到 */
    private static final String OFFLINE_HTML =
            "<!doctype html><html><head><meta charset='utf-8'>"
                    + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;"
                    + "display:flex;align-items:center;justify-content:center;height:100vh;color:#2b2b2b}"
                    + "div{text-align:center;padding:24px}h2{font-size:18px;margin:0 0 8px}"
                    + "p{color:#a3a3a6;font-size:14px;margin:0 0 20px}"
                    + "a{display:inline-block;padding:10px 28px;background:#ec4141;color:#fff;"
                    + "border-radius:22px;text-decoration:none;font-size:15px}</style></head><body>"
                    + "<div><h2>页面资源缺失</h2><p>安装包不完整，请重新安装</p>"
                    + "<a href='" + START_URL + "'>重试</a></div></body></html>";
}
