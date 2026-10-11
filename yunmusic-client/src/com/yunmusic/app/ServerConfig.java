package com.yunmusic.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/**
 * 云音乐 - 双服务器节点配置管理器
 * 保证「一次配置两套地址，在设置或顶栏随时一键切换并真正即时生效」
 */
public class ServerConfig {
    private static final String PREF_NAME = "yunmusic_prefs";
    private static final String KEY_ACTIVE = "active_line"; // 0: 线路一(CF), 1: 线路二(Docker)
    
    // 线路一 (Cloudflare 节点)
    public static final String DEFAULT_LINE1_NAME = "线路一 (Cloudflare)";
    public static final String DEFAULT_LINE1_URL = "https://music.zyplnn.dpdns.org";
        /*
     * ⚠ 默认账号密码**必须是空串**，不要往这里填真实口令。
     *
     * 填了就等于把口令随 APK 一起发出去 —— 任何人反编译一下 strings 就能拿到，
     * 而且口令一改就得重新出包。账号密码统一由用户在本机「我的 → 双线路管理」里填写，
     * 落在这台设备的 SharedPreferences 里，既不进代码库也不进包。
     * 前端在登录前会检查凭据是否为空，为空就明确引导去设置页，不会拿空口令去撞接口。
     */
    public static final String DEFAULT_LINE1_USER = "";
    public static final String DEFAULT_LINE1_PASS = "";

    // 线路二 (Docker 自建节点)
    public static final String DEFAULT_LINE2_NAME = "线路二 (Docker自建)";
    public static final String DEFAULT_LINE2_URL = "https://lxmusic.19860819.xyz:8616";
    public static final String DEFAULT_LINE2_USER = "";
    public static final String DEFAULT_LINE2_PASS = "";

    /** 线路二早期用的 http 地址，仅用于老装机迁移 */
    private static final String LEGACY_LINE2_URL = "http://lxmusic.19860819.xyz:8616";

    private final SharedPreferences sp;

    public ServerConfig(Context context) {
        this.sp = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        migrateLegacyLine2();
    }

    /**
     * 把老版本写进 SharedPreferences 的线路二地址升级为 https。
     *
     * 光改 DEFAULT_LINE2_URL 对**已安装的用户无效** —— getLine2Url() 会优先读
     * SharedPreferences，里面存的还是旧的 http 地址，表现就是「升级了客户端还是连不上」。
     * 所以必须在构造时做一次迁移。只精确匹配那一个旧值，不动用户自己填过的地址。
     */
    private void migrateLegacyLine2() {
        try {
            String saved = sp.getString("line2_url", null);
            if (saved != null && LEGACY_LINE2_URL.equalsIgnoreCase(saved.trim())) {
                sp.edit().putString("line2_url", DEFAULT_LINE2_URL).apply();
            }
        } catch (Exception ignore) { }
    }

    public int getActiveLine() {
        return sp.getInt(KEY_ACTIVE, 0); // 默认为线路一
    }

    public void setActiveLine(int line) {
        sp.edit().putInt(KEY_ACTIVE, line == 1 ? 1 : 0).apply();
    }

    // 线路一配置
    public String getLine1Name() { return sp.getString("line1_name", DEFAULT_LINE1_NAME); }
    public String getLine1Url() { return sp.getString("line1_url", DEFAULT_LINE1_URL); }
    public String getLine1User() { return sp.getString("line1_user", DEFAULT_LINE1_USER); }
    public String getLine1Pass() { return sp.getString("line1_pass", DEFAULT_LINE1_PASS); }

    // 线路二配置
    public String getLine2Name() { return sp.getString("line2_name", DEFAULT_LINE2_NAME); }
    public String getLine2Url() { return sp.getString("line2_url", DEFAULT_LINE2_URL); }
    public String getLine2User() { return sp.getString("line2_user", DEFAULT_LINE2_USER); }
    public String getLine2Pass() { return sp.getString("line2_pass", DEFAULT_LINE2_PASS); }

    /** 一次性保存双服务器配置 */
    public void saveDualServers(String url1, String user1, String pass1,
                                String url2, String user2, String pass2, int active) {
        SharedPreferences.Editor ed = sp.edit();
        if (url1 != null && !url1.trim().isEmpty()) ed.putString("line1_url", normalizeUrl(url1));
        if (user1 != null) ed.putString("line1_user", user1.trim());
        if (pass1 != null) ed.putString("line1_pass", pass1.trim());

        if (url2 != null && !url2.trim().isEmpty()) ed.putString("line2_url", normalizeUrl(url2));
        if (user2 != null) ed.putString("line2_user", user2.trim());
        if (pass2 != null) ed.putString("line2_pass", pass2.trim());

        ed.putInt(KEY_ACTIVE, active == 1 ? 1 : 0);
        ed.apply();
    }

    /** 当前生效的活动节点 URL */
    public String getActiveUrl() {
        return getActiveLine() == 1 ? getLine2Url() : getLine1Url();
    }

    /** 当前生效的用户名 */
    public String getActiveUser() {
        return getActiveLine() == 1 ? getLine2User() : getLine1User();
    }

    /** 当前生效的密码 */
    public String getActivePass() {
        return getActiveLine() == 1 ? getLine2Pass() : getLine1Pass();
    }

    /** 当前生效的名称 */
    public String getActiveName() {
        return getActiveLine() == 1 ? getLine2Name() : getLine1Name();
    }

    /** 规范化 URL 前缀 */
    public static String normalizeUrl(String url) {
        if (url == null) return "";
        String s = url.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.toLowerCase().endsWith("/api")) s = s.substring(0, s.length() - 4);
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://" + s;
        }
        return s;
    }

    /** 导出给前端 JSON 对象 */
    public JSONObject toJson() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("active", getActiveLine());
            obj.put("activeUrl", getActiveUrl());
            obj.put("activeUser", getActiveUser());
            obj.put("activePass", getActivePass());
            obj.put("activeName", getActiveName());

            JSONObject l1 = new JSONObject();
            l1.put("name", getLine1Name());
            l1.put("url", getLine1Url());
            l1.put("user", getLine1User());
            l1.put("pass", getLine1Pass());
            obj.put("line1", l1);

            JSONObject l2 = new JSONObject();
            l2.put("name", getLine2Name());
            l2.put("url", getLine2Url());
            l2.put("user", getLine2User());
            l2.put("pass", getLine2Pass());
            obj.put("line2", l2);
        } catch (Exception ignore) {}
        return obj;
    }
}
