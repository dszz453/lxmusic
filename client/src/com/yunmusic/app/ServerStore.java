package com.yunmusic.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 服务器档案（客户端要连哪台服务器）—— 纯原生持有，跨端层只读结果。
 *
 * ── 为什么要有「档案」而不是一个地址输入框 ──────────────────────
 * 这个客户端是**通用**的：CF、Docker、局域网上随手起的 node、反代出来的域名，
 * 都可能是用户要连的东西。而同一个用户的这几台往往**同时存在**（家里 Docker、
 * 外面 CF），来回切是常态。只存一个地址的话，每次切换都要重新手打一遍。
 *
 * ── 和网页端那份「服务端地址」是什么关系 ────────────────────────
 * 网页端（设置页 / 登录页）早先就有 serverBase 配置，存在 localStorage 的
 * `lx.serverBase` 里。客户端里**这份原生档案才是唯一事实来源**：
 *   · 页面加载时由宿主把当前档案注入 localStorage（见 ClientActivity 的注入脚本）；
 *   · 网页端那个输入框在客户端里被跨端层藏掉，改由原生「服务器连接」页管理
 *     （否则两边各存一份，必然出现「原生显示 A、网页连的是 B」）。
 *
 * ── 键名与结构 ──────────────────────────────────────────────────
 * 存在 SharedPreferences 的一个 JSON 字符串里（不用 SQLite：总共几行数据，
 * 而且要能整体读出、整体写回，JSON 比建表省事得多）。结构：
 *   {"active":"cf","onboarded":true,"profiles":[{"id":"builtin", …}, …]}
 */
public final class ServerStore {

    private static final String TAG = "LXC/Store";
    private static final String PREF = "lx.client";
    private static final String KEY = "profiles";

    /* ---------------- 档案类型 ---------------- */

    /**
     * 内置离线：后端**完全跑在设备内**（包内 backend.bundle.js + 手机 SQLite），
     * 不连任何服务器，一个字节都不出设备。
     *
     * 判据在跨端侧：native.js 看 localStorage 的 `lx.serverBase` 是不是空 ——
     * 空就走本机后端并自动开户。所以这个档案的 base 恒为空，
     * 它存在的意义是把「本机模式」显式化成列表里可选的一项，
     * 而不是让用户靠「地址都不填」去间接得到它。
     */
    public static final String KIND_BUILTIN = "builtin";
    /** Cloudflare Worker 那条线 */
    public static final String KIND_CF = "cf";
    /** Docker / 本机 node 那条线 */
    public static final String KIND_DOCKER = "docker";
    /** 用户自建的其它地址（反代、局域网其它机器…） */
    public static final String KIND_CUSTOM = "custom";

    /** 三档预设的固定 id —— 它们是「槽位」，地址由用户填，不随增删走动 */
    public static final String ID_BUILTIN = "builtin";
    public static final String ID_CF = "cf";
    public static final String ID_DOCKER = "docker";

    /** 双地址槽位映射：地址 1 (主线路) 与 地址 2 (备用线路) */
    public static final String ID_LINE1 = ID_DOCKER;
    public static final String ID_LINE2 = ID_CF;

    /**
     * 三个固定槽位的显示名（代码写死，用户改不了）。
     * 短、带序号、把「主/备」写清楚 —— 切换时一眼能认出哪条是哪条。
     */
    public static final String NAME_LINE1 = "地址 1 · 主线路";
    public static final String NAME_LINE2 = "地址 2 · 备用线路";
    public static final String NAME_BUILTIN = "内置离线";

    public static final class Profile {
        public String id = "";
        /** 界面上显示的名字 */
        public String name = "";
        /** 见上面 KIND_* */
        public String kind = KIND_DOCKER;
        /** 基址，形如 https://music.example.com */
        public String base = "";
        /** 登录用户名，仅用于预填登录页，不参与鉴权 */
        public String user = "";
        /** 最近一次握手得到的品牌键（cf/docker），空 = 还没握手过 */
        public String host = "";
        /** 最近一次握手得到的服务端版本，空 = 还没握手过 */
        public String version = "";
        /** 最近一次握手得到的构建标识 */
        public String build = "";
        /** 最近一次握手时间（毫秒），0 = 从未 */
        public long checkedAt = 0;

        /** 这条档案能不能直接用来启动：内置离线不用地址，其余必须填了地址 */
        public boolean usable() {
            if (KIND_BUILTIN.equals(kind)) return true;
            return base != null && !base.trim().isEmpty();
        }

        /** 界面上显示的品牌名（还没握手时按档案类型兜底） */
        public String brandName() {
            if (!host.isEmpty()) return ClientBrand.nameOf(host);
            if (KIND_BUILTIN.equals(kind)) return ClientBrand.builtinName();
            if (KIND_DOCKER.equals(kind)) return ClientBrand.NAME_DOCKER;
            return ClientBrand.NAME_CF;
        }

        public JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("kind", kind);
            o.put("base", base);
            o.put("user", user);
            o.put("host", host);
            o.put("version", version);
            o.put("build", build);
            o.put("checkedAt", checkedAt);
            return o;
        }

        public static Profile fromJson(JSONObject o) {
            Profile p = new Profile();
            p.id = o.optString("id", "");
            p.name = o.optString("name", "");
            p.kind = o.optString("kind", KIND_DOCKER);
            p.base = o.optString("base", "");
            p.user = o.optString("user", "");
            p.host = o.optString("host", "");
            p.version = o.optString("version", "");
            p.build = o.optString("build", "");
            p.checkedAt = o.optLong("checkedAt", 0);
            return p;
        }
    }

    private static volatile ServerStore instance;

    private final SharedPreferences prefs;
    private List<Profile> profiles = new ArrayList<Profile>();
    private String activeId = ID_LINE1;
    private boolean onboarded = false;

    private ServerStore(Context ctx) {
        prefs = ctx.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
        load();
    }

    public static ServerStore get(Context ctx) {
        ServerStore s = instance;
        if (s == null) {
            synchronized (ServerStore.class) {
                s = instance;
                if (s == null) {
                    s = new ServerStore(ctx);
                    instance = s;
                }
            }
        }
        return s;
    }

    /* ---------------- 读写 ---------------- */

    private void load() {
        profiles = new ArrayList<Profile>();
        activeId = ID_LINE1;
        onboarded = false;
        String raw = prefs.getString(KEY, null);
        if (raw != null) {
            try {
                JSONObject o = new JSONObject(raw);
                activeId = o.optString("active", ID_LINE1);
                onboarded = o.optBoolean("onboarded", false);
                JSONArray arr = o.optJSONArray("profiles");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject po = arr.optJSONObject(i);
                        if (po != null) {
                            profiles.add(Profile.fromJson(po));
                        }
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "服务器档案解析失败，回退默认: " + t.getMessage());
            }
        }
        ensureDefaults();
    }

    /**
     * 补齐预设槽位：地址 1 (主线路 / Docker)、地址 2 (备用线路 / Cloudflare)、内置离线。
     *
     * 顺序即列表里的展示顺序：两条线路在前（老板要的「双线路」是主用法），
     * 内置离线垫后，作为「哪台服务器都连不上时的落脚点」。
     *
     * ⚠ 固定槽位的**名字由代码写死**（每轮 load 都重新盖一遍）：它们在界面上
     * 不可改名，若只在新建时命名，老用户会一直留着上一个版本的长名字
     * （曾叫「地址 1 (主线路 / Docker)」，在窄屏上把整行挤成省略号）。
     */
    private void ensureDefaults() {
        if (find(ID_LINE1) == null) {
            Profile p = new Profile();
            p.id = ID_LINE1;
            p.kind = KIND_DOCKER;
            profiles.add(p);
        }
        find(ID_LINE1).name = NAME_LINE1;

        if (find(ID_LINE2) == null) {
            Profile p = new Profile();
            p.id = ID_LINE2;
            p.kind = KIND_CF;
            profiles.add(p);
        }
        find(ID_LINE2).name = NAME_LINE2;

        if (find(ID_BUILTIN) == null) {
            Profile p = new Profile();
            p.id = ID_BUILTIN;
            p.kind = KIND_BUILTIN;
            profiles.add(p);
        }
        find(ID_BUILTIN).name = NAME_BUILTIN;

        if (find(activeId) == null) {
            activeId = ID_LINE1;
        }
    }

    public void save() {
        try {
            JSONObject o = new JSONObject();
            o.put("active", activeId);
            o.put("onboarded", onboarded);
            JSONArray arr = new JSONArray();
            for (Profile p : profiles) arr.put(p.toJson());
            o.put("profiles", arr);
            prefs.edit().putString(KEY, o.toString()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "保存服务器档案失败: " + t.getMessage());
        }
    }

    /* ---------------- 查询 ---------------- */

    public List<Profile> profiles() {
        return new ArrayList<Profile>(profiles);
    }

    public Profile find(String id) {
        if (id == null) return null;
        for (Profile p : profiles) if (id.equals(p.id)) return p;
        return null;
    }

    public Profile active() {
        Profile p = find(activeId);
        if (p == null) {
            p = getLine1();
        }
        return p;
    }

    public String activeId() {
        return activeId;
    }

    /** 获取地址 1 (主线路) 档案 */
    public Profile getLine1() {
        Profile p = find(ID_LINE1);
        if (p == null) {
            ensureDefaults();
            p = find(ID_LINE1);
        }
        return p;
    }

    /** 获取地址 2 (备用线路) 档案 */
    public Profile getLine2() {
        Profile p = find(ID_LINE2);
        if (p == null) {
            ensureDefaults();
            p = find(ID_LINE2);
        }
        return p;
    }

    /**
     * 首次启动（从没走完过引导）。
     * 注意判据不只是「有没有存过地址」—— 用户可能选了内置离线就打算这么用，
     * 那也算走完引导。所以单独立一个 onboarded 标记。
     */
    public boolean isOnboarded() {
        return onboarded;
    }

    public void setOnboarded(boolean v) {
        onboarded = v;
        save();
    }

    /* ---------------- 修改 ---------------- */

    /**
     * 选中某条档案。
     *
     * 只有**可用**（内置模式，或已填了地址）的档案才切得动 —— 点一个空地址的槽位
     * 等于把客户端切到「连不上任何东西」的状态，那不该是一次点击的后果。
     * 地址能不能真连通**不在这里校验**：那是握手的活。这里只管「有没有填」。
     *
     * ⚠ 切不动时**不抛异常也不报错**，只是原样返回当前生效的那条 ——
     * 所以调用方**必须先看 `p.usable()`**，否则用户点了没反应还查不出原因。
     * （2026-10-14 老板报「切换到线路 2 不生效」就是踩在这个静默失败上：
     * 界面那边连 `setActive` 都没调，只改了一个局部变量。）
     */
    public Profile setActive(String id) {
        Profile p = find(id);
        if (p != null && p.usable()) {
            activeId = id;
            save();
        }
        return active();
    }

    /** 新建一条自定义档案，返回它（id 自动生成） */
    public Profile addCustom(String name, String base, String user) {
        Profile p = new Profile();
        p.id = "custom-" + System.currentTimeMillis();
        p.name = (name == null || name.trim().isEmpty()) ? "自建服务器" : name.trim();
        p.kind = KIND_CUSTOM;
        p.base = base == null ? "" : base.trim();
        p.user = user == null ? "" : user.trim();
        profiles.add(p);
        save();
        return p;
    }

    /** 写入/更新一条档案（按 id 匹配），并保存 */
    public Profile upsert(Profile p) {
        if (p == null || p.id == null || p.id.isEmpty()) return null;
        Profile cur = find(p.id);
        if (cur == null) {
            profiles.add(p);
        } else {
            cur.name = p.name;
            cur.kind = p.kind;
            cur.base = p.base;
            cur.user = p.user;
            cur.host = p.host;
            cur.version = p.version;
            cur.build = p.build;
            cur.checkedAt = p.checkedAt;
        }
        save();
        return find(p.id);
    }

    /** 删除档案。三个预设槽位（地址 1 / 地址 2 / 内置离线）不给删，双地址槽位只清空地址 */
    public boolean remove(String id) {
        // 内置离线没有地址可清，固定槽位直接拒绝删除
        if (ID_BUILTIN.equals(id)) return false;
        if (ID_LINE1.equals(id) || ID_LINE2.equals(id)) {
            Profile p = find(id);
            if (p != null) {
                p.base = "";
                p.user = "";
                p.host = "";
                p.version = "";
                p.build = "";
                p.checkedAt = 0;
                ensureDefaults();
                save();
            }
            return false;
        }
        Profile p = find(id);
        if (p == null) return false;
        profiles.remove(p);
        if (id.equals(activeId)) {
            activeId = ID_LINE1;
            ensureDefaults();
        }
        save();
        return true;
    }

    /** 握手结果回写（用于服务器页显示实际连上的东西） */
    public void saveHandshake(String id, Handshake.Result r) {
        Profile p = find(id);
        if (p == null || r == null) return;
        if (r.ok) {
            p.host = r.host == null ? "" : r.host;
            p.version = r.version == null ? "" : r.version;
            p.build = r.build == null ? "" : r.build;
            p.checkedAt = System.currentTimeMillis();
        }
        save();
    }
}
