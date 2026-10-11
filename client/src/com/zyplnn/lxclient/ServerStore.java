package com.zyplnn.lxclient;

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

    /** Cloudflare Worker 那条线 */
    public static final String KIND_CF = "cf";
    /** Docker / 本机 node 那条线 */
    public static final String KIND_DOCKER = "docker";
    /** 用户自建的其它地址（反代、局域网其它机器…） */
    public static final String KIND_CUSTOM = "custom";

    /** 两档预设的固定 id —— 它们是「槽位」，地址由用户填，不随增删走动 */
    public static final String ID_CF = "cf";
    public static final String ID_DOCKER = "docker";

    /** 双地址槽位映射：地址 1 (主线路) 与 地址 2 (备用线路) */
    public static final String ID_LINE1 = ID_DOCKER;
    public static final String ID_LINE2 = ID_CF;

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

        /** 这条档案能不能直接用来启动：必须填了地址 */
        public boolean usable() {
            return base != null && !base.trim().isEmpty();
        }

        /** 界面上显示的品牌名（还没握手时按档案类型兜底） */
        public String brandName() {
            if (!host.isEmpty()) return ClientBrand.nameOf(host);
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
                            Profile p = Profile.fromJson(po);
                            // 丢弃历史残留的内置离线档案
                            if (!"builtin".equals(p.id)) {
                                profiles.add(p);
                            }
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
     * 补齐双地址预设槽位：地址 1 (主线路 / Docker) 与 地址 2 (备用线路 / Cloudflare)
     */
    private void ensureDefaults() {
        if (find(ID_LINE1) == null) {
            Profile p = new Profile();
            p.id = ID_LINE1;
            p.name = "地址 1 (主线路 / Docker)";
            p.kind = KIND_DOCKER;
            profiles.add(p);
        }
        if (find(ID_LINE2) == null) {
            Profile p = new Profile();
            p.id = ID_LINE2;
            p.name = "地址 2 (备用线路 / Cloudflare)";
            p.kind = KIND_CF;
            profiles.add(p);
        }
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
     * 一次性配置两个地址，并指定激活其中一条
     * @param addr1 地址 1 (如内网/公网 Docker)
     * @param user1 地址 1 用户名
     * @param addr2 地址 2 (如 Cloudflare Workers)
     * @param user2 地址 2 用户名
     * @param activeLine 要激活的线路 ID (ID_LINE1 或 ID_LINE2)
     */
    public Profile saveDualLines(String addr1, String user1, String addr2, String user2, String activeLine) {
        Profile p1 = getLine1();
        if (p1 != null) {
            p1.base = addr1 != null ? addr1.trim() : "";
            p1.user = user1 != null ? user1.trim() : "";
        }
        Profile p2 = getLine2();
        if (p2 != null) {
            p2.base = addr2 != null ? addr2.trim() : "";
            p2.user = user2 != null ? user2.trim() : "";
        }

        if (activeLine != null && (activeLine.equals(ID_LINE1) || activeLine.equals(ID_LINE2))) {
            activeId = activeLine;
        } else if (p1 != null && p1.usable()) {
            activeId = ID_LINE1;
        } else if (p2 != null && p2.usable()) {
            activeId = ID_LINE2;
        } else {
            activeId = ID_LINE1;
        }
        onboarded = true;
        save();
        return active();
    }

    /** 在地址 1 和 地址 2 之间快速切换 */
    public Profile toggleDualLine() {
        if (ID_LINE1.equals(activeId)) {
            Profile p2 = getLine2();
            if (p2 != null && p2.usable()) {
                activeId = ID_LINE2;
            }
        } else {
            Profile p1 = getLine1();
            if (p1 != null && p1.usable()) {
                activeId = ID_LINE1;
            }
        }
        save();
        return active();
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

    /** 删除档案。双地址预设槽位不给删，只清空地址 */
    public boolean remove(String id) {
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
