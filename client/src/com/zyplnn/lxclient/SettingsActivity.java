package com.zyplnn.lxclient;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 原生设置页。
 *
 * ══════════════ 为什么设置也分原生与跨端两半 ══════════════
 * 这不是偷懒，是**按「这块设置归谁管」分的**：
 *
 *   · 归原生管的（本页）：连哪台服务器、通知权限、本地音乐、系统设置直达、
 *     退出、诊断。这些要么依赖系统能力（权限、Activity 跳转、进程退出），
 *     要么是「服务器地址填错了还得能进来改」的救生艇 —— 必须在跨端层之外。
 *
 *   · 归跨端层管的（网页 #/settings）：音质、音色均衡、播放缓存、歌词偏移、
 *     音源插件的启停与顺序。这些是**业务规则**，网页端、老壳、客户端三处共用同一份，
 *     搬到原生来写等于把同一套规则实现三遍，以后每改一次就要同步三处。
 *     所以本页只给一个入口，点进去就把跨端层翻到那一页。
 *
 * 这个分法本身就是网易云那套架构里最实用的一条经验：
 * **系统能力归原生，业务规则归跨端**。
 */
public class SettingsActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout col = Ui.page(this, 32);
        col.addView(Ui.titleBar(this, "设置", null, null));

        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p = st.active();

        /* ---------------- 连接 ---------------- */
        col.addView(Ui.section(this, "连接"));
        LinearLayout c1 = Ui.card(this);
        c1.addView(Ui.row(this, null, "服务器连接",
                p.name + " · " + p.brandName()
                        + (p.version.isEmpty() ? "" : " · 服务端 " + p.version),
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        startActivity(new Intent(SettingsActivity.this, ServerActivity.class));
                    }
                }));
        c1.addView(Ui.divider(this, true));
        c1.addView(Ui.row(this, null, "客户端版本",
                ClientBrand.CLIENT_NAME + " " + ClientBrand.versionLine(SettingsActivity.this)
                        + "（" + ClientBrand.buildId(SettingsActivity.this) + "）"
                        + " · 期望服务端 " + ClientBrand.SERVICE_EXPECT,
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        startActivity(new Intent(SettingsActivity.this, AboutActivity.class));
                    }
                }));
        col.addView(c1);

        /* ---------------- 跨端层（业务设置） ---------------- */
        col.addView(Ui.section(this, "播放与音质"));
        LinearLayout c2 = Ui.card(this);
        c2.addView(Ui.row(this, null, "播放与账号设置",
                "音质 / 音色均衡 / 播放缓存 / 歌词偏移 / 音源插件",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        // 交给跨端层：这些是业务规则，原生不重复实现一遍。
                        // 用 MediaBridge 的 eval 直接驱动那个仍在运行中的 WebView，
                        // 不新建 Activity、页面状态不丢。
                        MediaBridge.eval("(function(){try{location.hash='#/settings'}catch(e){}})()");
                        finish();
                    }
                }));
        c2.addView(Ui.divider(this, true));
        c2.addView(Ui.row(this, null, "本地音乐",
                "扫描设备里的音频文件（底层能力层 AudioEngine）",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        startActivity(new Intent(SettingsActivity.this, LocalMusicActivity.class));
                    }
                }));
        col.addView(c2);

        /* ---------------- 系统权限 ---------------- */
        col.addView(Ui.section(this, "系统权限"));
        LinearLayout c3 = Ui.card(this);
        c3.addView(Ui.row(this, null, "通知权限", notifSubtitle(), notifRight(), true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        // 走 AndroidHost 那条既有通道，不另写一套权限申请：
                        // 那边已经处理了「只有真的在播才自动问」这类时机问题。
                        MediaBridge.eval("(function(){try{"
                                + "if(window.AndroidHost&&AndroidHost.askNotificationPermission)"
                                + "AndroidHost.askNotificationPermission()"
                                + "}catch(e){}})()");
                        Ui.toast(SettingsActivity.this, "已发起申请（若系统不再询问，请到系统设置里手动打开）");
                    }
                }));
        c3.addView(Ui.divider(this, true));
        c3.addView(Ui.row(this, null, "打开系统应用设置",
                "通知被永久拒绝、权限被关掉时只能从这里改",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        try {
                            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                            i.setData(android.net.Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Throwable t) {
                            Ui.toast(SettingsActivity.this, "打不开系统设置");
                        }
                    }
                }));
        col.addView(c3);

        /* ---------------- 诊断 ---------------- */
        col.addView(Ui.section(this, "诊断"));
        LinearLayout c4 = Ui.card(this);
        final TextView diag = Ui.text(this, "", 11.5f, Ui.color(this, R.color.text_2), false);
        diag.setVisibility(View.GONE);
        diag.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), Ui.dp(this, 12));
        diag.setTextIsSelectable(true);
        c4.addView(Ui.row(this, null, "查看客户端诊断信息",
                "版本 / 连接态 / 媒体会话链路的逐层状态（可复制）",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        if (diag.getVisibility() == View.VISIBLE) {
                            diag.setVisibility(View.GONE);
                            return;
                        }
                        diag.setText(buildDiag());
                        diag.setVisibility(View.VISIBLE);
                    }
                }));
        c4.addView(diag);
        col.addView(c4);

        /* ---------------- 退出 ---------------- */
        col.addView(Ui.section(this, "其它"));
        LinearLayout c5 = Ui.card(this);
        c5.addView(Ui.row(this, null, "退出客户端",
                "还在播放时会退到后台而不是停掉音乐",
                null, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        Ui.confirm(SettingsActivity.this, "退出客户端",
                                "确定退出吗？正在播放时会退到后台，音乐不会停。",
                                "退出", new Runnable() {
                                    @Override
                                    public void run() {
                                        try {
                                            finishAffinity();
                                            if (!MediaBridge.isPlaying()) {
                                                stopService(new Intent(SettingsActivity.this,
                                                        PlaybackService.class));
                                            }
                                        } catch (Throwable ignore) {
                                        }
                                    }
                                }, null);
                    }
                }));
        col.addView(c5);

        col.addView(Ui.note(this,
                "提示：音质、播放缓存、歌词偏移、音源插件这些在「播放与账号设置」里 —— "
                        + "它们与网页端共用同一份实现，改一处三端同时生效。"));
    }

    private String notifSubtitle() {
        if (android.os.Build.VERSION.SDK_INT < 33) {
            return "Android 13 以下不需要单独授权";
        }
        try {
            boolean granted = checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            return granted ? "已授权：锁屏、通知栏、控制中心都有播放控件"
                    : "未授权：前台服务的通知一条都不会显示";
        } catch (Throwable t) {
            return "状态未知";
        }
    }

    private String notifRight() {
        try {
            android.app.NotificationManager nm =
                    (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && !nm.areNotificationsEnabled()) return "总开关已关";
        } catch (Throwable ignore) {
        }
        return "申请";
    }

    /**
     * 客户端侧诊断快照。
     *
     * 为什么不直接显示 BridgeHub.diag() 的原始 JSON：那一份是给机器看的（键值对），
     * 用户截图发过来时希望**一眼能读懂**。所以这里摊成「一行一项」的文本，
     * 同时保留原始 JSON 的关键字段（版本、构建号、地址），方便对账。
     */
    private String buildDiag() {
        StringBuilder sb = new StringBuilder();
        try {
            ServerStore st = ServerStore.get(this);
            ServerStore.Profile p = st.active();
            sb.append("客户端 ").append(ClientBrand.CLIENT_NAME).append(" ")
                    .append(ClientBrand.versionLine(this))
                    .append("（code ").append(ClientBrand.versionCode(this)).append("）\n");
            sb.append("构建 ").append(ClientBrand.buildId(this))
                    .append("　期望服务端 ").append(ClientBrand.SERVICE_EXPECT).append("\n");
            sb.append("档案 ").append(p.name).append("（").append(p.kind).append("）")
                    .append("　使用中 ").append(st.activeId()).append("\n");
            sb.append("地址 ").append(p.base.isEmpty() ? "（内置离线，不连服务器）" : p.base).append("\n");
            sb.append("握手 ").append(p.checkedAt == 0 ? "从未"
                    : (p.brandName() + " · " + p.version + " · " + p.build)).append("\n");
            sb.append("品牌判定 ").append(p.host == null || p.host.isEmpty() ? "按档案类型兜底" : p.host)
                    .append(" → ").append(p.brandName()).append("\n");
            sb.append("系统 ").append(android.os.Build.BRAND).append(" ").append(android.os.Build.MODEL)
                    .append(" / Android ").append(android.os.Build.VERSION.RELEASE)
                    .append("（API ").append(android.os.Build.VERSION.SDK_INT).append("）\n");
            sb.append("解码引擎 ").append(com.zyplnn.lxclient.core.AudioEngine.engineInfo()).append("\n");
            sb.append("媒体会话 ").append(MediaBridge.diagJson()).append("\n");
            sb.append("账号 ").append(st.isOnboarded() ? "已走过引导" : "还没走过引导")
                    .append("　档案数 ").append(st.profiles().size());
        } catch (Throwable t) {
            sb.append("诊断生成失败：").append(t.getMessage());
        }
        return sb.toString();
    }
}
