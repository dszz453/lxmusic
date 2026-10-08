package com.zyplnn.lxclient;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/**
 * 跨端桥接层：跨端业务层（JS）与原生宿主之间的**唯一门面**，页面侧看到的是 window.LXNative。
 *
 * ── 为什么和 AndroidHost 分成两个对象 ──────────────────────────
 * AndroidHost 是**共用前端源码**（public/js/native.js）认定的那个协议：
 * http / db / log / mediaReport。它被网页端、老壳（music-edge）、这个客户端三处共用，
 * 所以签名一个都不能动、也不能往里塞客户端专属的方法（网页端没有的东西）。
 *
 * LXNative 则是**只有这个客户端才有**的能力：服务器档案、打开原生页面、
 * 底栏与路由同步、剪贴板、退出。跨端层（rn/src/client-layer.js）只认它，
 * 它在网页端与老壳里都不存在 —— client-layer.js 也正是靠「LXNative 在不在」
 * 来判断自己是不是跑在这个客户端里，不在就整个不介入（同一份前端资源三宿主共用）。
 *
 * ── 调用方向与线程 ──────────────────────────────────────────────
 * JS → 原生：本类的方法（标了 @JavascriptInterface 的那些）。
 *   注意这些方法跑在 WebView 的 **JavaBridge 线程**上，不是主线程 ——
 *   任何碰 UI 的动作都必须 post 到主线程（下面的 ui() 就是干这个的）。
 * 原生 → JS：ClientActivity.evalJs()。
 *
 * 所有返回字符串的方法都返回 **JSON 文本**而不是拼好的字符串：
 * 跨语言边界上传结构化数据只有一种稳的做法，让 JS 那边 JSON.parse 去。
 */
public final class BridgeHub {

    private static final String TAG = "LXC/Bridge";

    /** 打开原生页面的名字 → Activity 的映射。加原生页只改这一张表 */
    private static final String PAGE_SERVER = "server";
    private static final String PAGE_SETTINGS = "settings";
    private static final String PAGE_LOCAL = "local";
    private static final String PAGE_ABOUT = "about";

    private final ClientActivity act;
    private final Handler main = new Handler(Looper.getMainLooper());

    public BridgeHub(ClientActivity act) {
        this.act = act;
    }

    private void ui(Runnable r) {
        main.post(r);
    }

    /* ══════════════════ 身份与状态 ══════════════════ */

    /**
     * 客户端与当前连接态的一份快照。跨端层用它渲染版本行、补服务器入口，
     * 以及判断自己该显示哪个品牌。
     *
     * 里面的 serverVersion / serverBuild 只用于**日志与诊断**：
     * 服务端版本按规矩只在设置页展示（老板 2026-10-08），界面上别拿它们做文案。
     */
    @JavascriptInterface
    public String info() {
        try {
            ServerStore st = ServerStore.get(act);
            ServerStore.Profile p = st.active();
            JSONObject o = new JSONObject();
            o.put("client", ClientBrand.CLIENT_NAME);
            o.put("version", ClientBrand.versionName(act));
            o.put("versionCode", ClientBrand.versionCode(act));
            o.put("versionLine", ClientBrand.versionLine(act));
            o.put("build", ClientBrand.buildId(act));
            o.put("serviceExpect", ClientBrand.SERVICE_EXPECT);

            o.put("profileId", p.id);
            o.put("profileName", p.name);
            o.put("kind", p.kind);
            o.put("base", ServerStore.KIND_BUILTIN.equals(p.kind) ? "" : p.base);
            o.put("user", p.user == null ? "" : p.user);
            o.put("builtin", ServerStore.KIND_BUILTIN.equals(p.kind));
            o.put("brandKey", p.host == null || p.host.isEmpty()
                    ? (ServerStore.KIND_DOCKER.equals(p.kind) ? "docker" : "cf")
                    : p.host);
            o.put("brandName", p.brandName());
            o.put("serverVersion", p.version == null ? "" : p.version);
            o.put("serverBuild", p.build == null ? "" : p.build);
            o.put("connected", p.checkedAt > 0);
            o.put("onboarded", st.isOnboarded());
            return o.toString();
        } catch (Throwable t) {
            Log.w(TAG, "info 组装失败: " + t.getMessage());
            return "{\"error\":" + JSONObject.quote(String.valueOf(t.getMessage())) + "}";
        }
    }

    /** 服务器档案列表（供跨端层画一个「切换服务器」的列表） */
    @JavascriptInterface
    public String profiles() {
        try {
            ServerStore st = ServerStore.get(act);
            List<ServerStore.Profile> ps = st.profiles();
            JSONArray arr = new JSONArray();
            for (int i = 0; i < ps.size(); i++) {
                ServerStore.Profile p = ps.get(i);
                JSONObject o = new JSONObject();
                o.put("id", p.id);
                o.put("name", p.name);
                o.put("kind", p.kind);
                o.put("base", ServerStore.KIND_BUILTIN.equals(p.kind) ? "" : p.base);
                o.put("usable", p.usable());
                o.put("brand", p.brandName());
                o.put("version", p.version == null ? "" : p.version);
                o.put("checked", p.checkedAt > 0);
                o.put("active", p.id.equals(st.activeId()));
                arr.put(o);
            }
            return arr.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /**
     * 切换服务器档案。成功后**整页重载**（不热切换，理由见 ClientActivity.onActivityResult）。
     *
     * @return 是否真的换了。false = 档案不存在 / 没填地址 / 已经就是它
     */
    @JavascriptInterface
    public boolean selectProfile(String id) {
        try {
            ServerStore st = ServerStore.get(act);
            ServerStore.Profile before = st.active();
            if (before != null && before.id.equals(id)) return false;
            ServerStore.Profile after = st.setActive(id);
            if (after == null || !after.id.equals(id)) {
                Log.w(TAG, "切换档案失败（不存在或地址为空）: " + id);
                return false;
            }
            Log.i(TAG, "切换服务器档案: " + before.id + " → " + after.id);
            act.onProfilesChanged(true);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "selectProfile 异常: " + t.getMessage());
            return false;
        }
    }

    /* ══════════════════ 原生页面 ══════════════════ */

    /**
     * 从跨端层打开一个原生页面。
     *
     * 为什么由跨端层发起：跨端页面里到处都是「设置」「服务器」这类入口（登录页的
     * 服务器设置、我的页的设置项…），它们本该由原生页面来承接。让 JS 直接喊一声
     * 比在原生侧监听一堆 URL 拦截规则清爽得多，也不会把网页版的行为改坏。
     */
    @JavascriptInterface
    public void openPage(String page) {
        final String p = page == null ? "" : page.trim();
        ui(new Runnable() {
            @Override
            public void run() {
                Class<?> target = null;
                if (PAGE_SERVER.equals(p)) target = ServerActivity.class;
                else if (PAGE_SETTINGS.equals(p)) target = SettingsActivity.class;
                else if (PAGE_LOCAL.equals(p)) target = LocalMusicActivity.class;
                else if (PAGE_ABOUT.equals(p)) target = AboutActivity.class;
                if (target == null) {
                    Log.w(TAG, "未知的原生页: " + p);
                    return;
                }
                try {
                    act.startActivity(new Intent(act, target));
                } catch (Throwable t) {
                    Log.w(TAG, "打开原生页失败 " + p + ": " + t.getMessage());
                    Ui.toast(act, "打不开这个页面");
                }
            }
        });
    }

    /* ══════════════════ 外壳同步 ══════════════════ */

    /**
     * 跨端层报告路由变化（hashchange），原生底栏据此高亮。
     * 网页里点了搜索结果跳到歌单页、或者点了我的页里的某个入口，底栏也能跟着对。
     */
    @JavascriptInterface
    public void setRoute(String hash) {
        act.onRouteFromWeb(hash);
    }

    /** 整页重载（清缓存、切服务器之后用） */
    @JavascriptInterface
    public void reload() {
        act.reloadPage();
    }

    /**
     * 显示 / 收起原生底栏。
     *
     * 登录页与初始化页是**整屏状态**：底栏上那四个入口点了都会被登录页挡回来，
     * 留着只会让人觉得「坏了」。所以跨端层在这些路由上会把底栏收起来。
     */
    @JavascriptInterface
    public void setChrome(boolean visible) {
        act.setChromeVisible(visible);
    }

    /* ══════════════════ 小工具 ══════════════════ */

    @JavascriptInterface
    public void toast(final String msg) {
        ui(new Runnable() {
            @Override
            public void run() {
                Ui.toast(act, msg);
            }
        });
    }

    /** 复制到剪贴板。返回是否成功 —— 失败时跨端层要回退到它自己的方案 */
    @JavascriptInterface
    public boolean copy(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("lxmusic", text == null ? "" : text));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 退出 App。
     *
     * 为什么要给跨端层这个能力：网页版没有「退出」这个概念（关掉标签页就是退出），
     * 而 App 里用户会找它。这里做的是「结束所有 Activity + 停前台服务」，
     * 不是 System.exit —— 后者会跳过 onDestroy，正在写的下载/缓存可能被截断。
     */
    @JavascriptInterface
    public void exitApp() {
        ui(new Runnable() {
            @Override
            public void run() {
                try {
                    if (!MediaBridge.isPlaying()) {
                        act.stopService(new Intent(act, PlaybackService.class));
                        act.finishAffinity();
                    } else {
                        // 还在放就别整个退出（用户多半是想「收起界面」而不是「停音乐」）
                        Ui.toast(act, "正在播放，已退到后台");
                        act.moveTaskToBack(true);
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "退出失败: " + t.getMessage());
                }
            }
        });
    }

    /**
     * 客户端侧诊断快照：环境、版本、连接态、媒体链路。
     * 与 AndroidHost.mediaStatus() 分开 —— 那个是给网页版用的媒体诊断，
     * 这个多了客户端自己的信息（构建号、档案、品牌判定），设置页的「诊断」用。
     */
    @JavascriptInterface
    public String diag() {
        try {
            ServerStore st = ServerStore.get(act);
            ServerStore.Profile p = st.active();
            JSONObject o = new JSONObject();
            o.put("client", ClientBrand.CLIENT_NAME);
            o.put("version", ClientBrand.versionName(act));
            o.put("versionCode", ClientBrand.versionCode(act));
            o.put("build", ClientBrand.buildId(act));
            o.put("serviceExpect", ClientBrand.SERVICE_EXPECT);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("device", Build.BRAND + " " + Build.MODEL);
            o.put("android", Build.VERSION.RELEASE);
            o.put("profile", p.id);
            o.put("profileName", p.name);
            o.put("kind", p.kind);
            o.put("base", p.base);
            o.put("brandKey", p.host == null ? "" : p.host);
            o.put("serverVersion", p.version == null ? "" : p.version);
            JSONObject media = new JSONObject();
            try {
                media = new JSONObject(MediaBridge.diagJson());
            } catch (Throwable ignore) {
            }
            o.put("media", media);
            return o.toString();
        } catch (Throwable t) {
            return "{\"error\":" + JSONObject.quote(String.valueOf(t.getMessage())) + "}";
        }
    }
}
