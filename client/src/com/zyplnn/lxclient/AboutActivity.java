package com.zyplnn.lxclient;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 关于页 —— 两条版本线在这里并排出现，这是本页存在的主要理由。
 *
 * ══════════════ 为什么「客户端版本」与「服务端版本」要分开显示 ══════════════
 * 这个客户端是**通用**的：同一个 APK 可以连内置后端、CF、Docker、局域网的任意一台。
 * 于是「版本」天然有两个：
 *
 *   客户端 V1.0  —— 你手机里装的这个东西
 *   服务端 V1.3  —— 你连的那台服务器
 *
 * 它们**本来就不是一个号**，而且不该强求一致：服务端升到 V1.4 时客户端通常不用重装
 * （接口向后兼容）；客户端修个原生层的 bug 时服务器一行都不用动。
 * 用户报问题时，这两个数字加上构建标识才是完整信息 —— 少一个就得来回猜
 * （本项目踩过：只给「V1.3」时，分不清是 App 旧还是服务端旧）。
 *
 * 顺带把「你这个 App 是谁」说清楚：连 CF 时界面显示 music-edge、连 Docker 时显示
 * LX-MUSIC —— 名字由**服务端自报**（/api/version 的 host 字段）决定，不是本地配置猜的。
 */
public class AboutActivity extends Activity {

    private static final String REPO_URL = "https://github.com/dszz453/lxmusic";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout col = Ui.page(this, 32);
        col.addView(Ui.titleBar(this, "关于", null, null));

        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p = st.active();

        /* ---------------- 客户端 ---------------- */
        col.addView(Ui.section(this, "客户端"));
        LinearLayout c1 = Ui.card(this);
        c1.addView(infoRow("名称", ClientBrand.CLIENT_NAME));
        c1.addView(Ui.divider(this, false));
        c1.addView(infoRow("客户端版本", ClientBrand.versionLine(this)
                + "（versionCode " + ClientBrand.versionCode(this) + "）"));
        c1.addView(Ui.divider(this, false));
        c1.addView(infoRow("构建标识", ClientBrand.buildId(this)
                + ("dev".equals(ClientBrand.buildId(this)) ? "（本地构建，未接 CI）" : "")));
        c1.addView(Ui.divider(this, false));
        c1.addView(infoRow("包名", getPackageName()));
        c1.addView(Ui.divider(this, false));
        c1.addView(infoRow("解码引擎", com.zyplnn.lxclient.core.AudioEngine.engineInfo()));
        col.addView(c1);
        col.addView(Ui.note(this,
                "客户端与服务端是两条独立的版本线：客户端从 V1.0 起算，"
                        + "服务端当前 V1.3。两者不必同号 —— 服务端升版时，只要接口兼容，"
                        + "这个 App 不用重装。客户端里那个「期望服务端 "
                        + ClientBrand.SERVICE_EXPECT + "」就是用来做握手比对的。"));

        /* ---------------- 服务端 ---------------- */
        col.addView(Ui.section(this, "当前连接的服务端"));
        LinearLayout c2 = Ui.card(this);
        boolean builtin = ServerStore.KIND_BUILTIN.equals(p.kind);
        c2.addView(infoRow("档案", p.name + "（" + kindLabel(p.kind) + "）"));
        c2.addView(Ui.divider(this, false));
        c2.addView(infoRow("地址", builtin ? "内置离线：不连任何服务器" : p.base));
        c2.addView(Ui.divider(this, false));
        c2.addView(infoRow("品牌", p.brandName()));
        c2.addView(Ui.divider(this, false));
        c2.addView(infoRow("服务端版本", builtin ? "（随安装包内置）"
                : (p.version.isEmpty() ? "还没握手" : p.version)));
        c2.addView(Ui.divider(this, false));
        c2.addView(infoRow("服务端构建", builtin ? "—" : (p.build.isEmpty() ? "—" : p.build)));
        col.addView(c2);
        col.addView(Ui.note(this,
                "品牌名由服务端自报：判据是 /api/version 里的 host 字段 —— "
                        + "CF 那条线回 music-edge，Docker 那条线回 LX-MUSIC。"
                        + "不用响应头或 CDN 特征判断，因为那些过一层反向代理就没了。"
                        + "点下面的「切换服务器」可以直接换一条线。"));

        LinearLayout cSwitch = Ui.card(this);
        cSwitch.addView(Ui.row(this, null, "切换服务器", "内置离线 / Cloudflare / Docker / 自建",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        startActivity(new Intent(AboutActivity.this, ServerActivity.class));
                    }
                }));
        col.addView(cSwitch);

        /* ---------------- 架构 ---------------- */
        col.addView(Ui.section(this, "架构"));
        col.addView(Ui.note(this,
                "同一份核心代码驱动三端宿主：\n"
                        + "· Docker 自托管 —— Node.js + 内置 SQLite 适配层，数据在自己手里；\n"
                        + "· Cloudflare Workers —— 零运维 Serverless + 全球 D1 数据库；\n"
                        + "· 安卓客户端（本 App）—— 原生宿主 + 跨端业务层 + 底层能力层，\n"
                        + "  既能连上面两条线，也能完全离线自包含地跑在设备内。\n\n"
                        + "客户端的分层（对应网易云客户端那套 原生 + React Native 混合架构）：\n"
                        + "· 原生宿主层：顶栏 / 底部导航 / 本页这类原生页面 / 播放前台服务；\n"
                        + "· 跨端桥接层：http / 数据库 / 媒体会话 / 原生 UI 能力统一门面；\n"
                        + "· 跨端业务层：首页、搜索、歌单、播放器（一套 JS 三宿主共用）；\n"
                        + "· 底层能力层：本地音频发现与解码接口（native 解码库预留）。"));

        /* ---------------- 开源 ---------------- */
        col.addView(Ui.section(this, "开源"));
        LinearLayout c3 = Ui.card(this);
        c3.addView(Ui.row(this, null, "GitHub 仓库", REPO_URL, null, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        openUrl(REPO_URL);
                    }
                }));
        c3.addView(Ui.divider(this, true));
        c3.addView(Ui.row(this, null, "复制仓库地址", "发到电脑上直接 clone", null, false,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        try {
                            android.content.ClipboardManager cm =
                                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                            if (cm != null) {
                                cm.setPrimaryClip(android.content.ClipData.newPlainText("repo", REPO_URL));
                                Ui.toast(AboutActivity.this, "已复制仓库地址");
                            }
                        } catch (Throwable t) {
                            Ui.toast(AboutActivity.this, "复制失败");
                        }
                    }
                }));
        col.addView(c3);

        col.addView(Ui.note(this,
                "播放的音乐来自各公开音源接口，仅供个人学习与自用；"
                        + "请勿用于商业用途，也不要分发受版权保护的内容。"));
    }

    private View infoRow(String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 12));
        TextView l = Ui.text(this, label, 13.5f, Ui.color(this, R.color.text_3), false);
        row.addView(l, new LinearLayout.LayoutParams(
                Ui.dp(this, 88), LinearLayout.LayoutParams.WRAP_CONTENT));
        TextView v = Ui.text(this, value == null ? "—" : value, 13.5f,
                Ui.color(this, R.color.text), false);
        v.setTextIsSelectable(true);
        row.addView(v, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private static String kindLabel(String kind) {
        if (ServerStore.KIND_CF.equals(kind)) return "Cloudflare";
        if (ServerStore.KIND_DOCKER.equals(kind)) return "Docker 自托管";
        if (ServerStore.KIND_BUILTIN.equals(kind)) return "内置离线";
        return "自建";
    }

    private void openUrl(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable t) {
            Ui.toast(this, "没有可打开链接的应用");
        }
    }
}
