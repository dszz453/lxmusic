package com.yunmusic.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 服务器连接 —— 纯原生页面，双线路一站式直配。
 *
 * ══════════════ 极致交互设计 ══════════════
 * 1. 拒绝捉迷藏：地址输入框直接露在卡片上，进页面点进去就能打字，不需要点什么「编辑」。
 * 2. 切换一键直达：每条线路卡片自带「切换并连接」，点击时自动把当前输入框最新的地址落盘，
 *    绝不拿「握手成功」当保存门槛，改了就能存、存了就能切！
 * 3. 连通性即测即显：每条线路单独配「测试连接」，延迟、节点名称当场显示。
 * 4. 内置离线独立卡片：随时一键退回全单机离线模式。
 */
public class ServerActivity extends Activity {

    private static final String TAG = "LXC/Server";

    public static final String EXTRA_FIRST_RUN = "first_run";
    public static final String EXTRA_CHANGED = "changed";

    private boolean firstRun = false;
    private boolean changed = false;
    private boolean busy = false;

    // 两个线路的输入控件引用
    private EditText base1In;
    private EditText user1In;
    private TextView hint1;

    private EditText base2In;
    private EditText user2In;
    private TextView hint2;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        firstRun = getIntent() != null && getIntent().getBooleanExtra(EXTRA_FIRST_RUN, false);
        buildUi();
    }

    private void buildUi() {
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p1 = st.getLine1();
        ServerStore.Profile p2 = st.getLine2();
        ServerStore.Profile pb = st.find(ServerStore.ID_BUILTIN);
        String activeId = st.activeId();

        LinearLayout col = Ui.page(this, 30);

        // 顶栏
        col.addView(Ui.titleBar(this, firstRun ? "配置连接方式" : "服务器与线路配置",
                firstRun ? null : "完成", firstRun ? null : new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        saveAllInputs(false);
                        finishWith(false);
                    }
                }));

        if (firstRun) {
            TextView hi = Ui.text(this, "欢迎使用云音乐！请直接填写服务器地址即可开始听歌：", 14,
                    Ui.color(this, R.color.text), false);
            hi.setPadding(Ui.dp(this, 18), Ui.dp(this, 14), Ui.dp(this, 18), Ui.dp(this, 4));
            col.addView(hi);
        }

        // ==================== 1. 主线路卡片 (地址 1) ====================
        col.addView(Ui.section(this, "主线路 (地址 1)"));
        LinearLayout card1 = Ui.card(this);
        card1.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 14));

        boolean isAct1 = ServerStore.ID_LINE1.equals(activeId);
        card1.addView(buildCardHeader("地址 1 · 主线路", "通常为自建 Docker、内网群晖/NAS 或主自建服务", isAct1));

        base1In = Ui.input(this, "例如: http://192.168.1.100:8080 或域名",
                p1 != null ? p1.base : "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card1.addView(wrapField("服务器地址", base1In));

        user1In = Ui.input(this, "登录用户名（可选，填了登录页自动预填）",
                p1 != null ? p1.user : "", InputType.TYPE_CLASS_TEXT);
        card1.addView(wrapField("用户名 (可选)", user1In));

        hint1 = Ui.text(this, (p1 != null && p1.checkedAt > 0) ? statusLine(p1) : "",
                12f, Ui.color(this, R.color.text_3), false);
        hint1.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 2));
        card1.addView(hint1);

        card1.addView(buildLineActions(ServerStore.ID_LINE1, isAct1, base1In, user1In, hint1));
        col.addView(card1);

        // ==================== 2. 备用线路卡片 (地址 2) ====================
        col.addView(Ui.section(this, "备用线路 (地址 2)"));
        LinearLayout card2 = Ui.card(this);
        card2.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 14));

        boolean isAct2 = ServerStore.ID_LINE2.equals(activeId);
        card2.addView(buildCardHeader("地址 2 · 备用线路", "通常为 Cloudflare Workers 线上节点或备用域名", isAct2));

        base2In = Ui.input(this, "例如: https://你的-worker.workers.dev",
                p2 != null ? p2.base : "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card2.addView(wrapField("服务器地址", base2In));

        user2In = Ui.input(this, "登录用户名（可选）",
                p2 != null ? p2.user : "", InputType.TYPE_CLASS_TEXT);
        card2.addView(wrapField("用户名 (可选)", user2In));

        hint2 = Ui.text(this, (p2 != null && p2.checkedAt > 0) ? statusLine(p2) : "",
                12f, Ui.color(this, R.color.text_3), false);
        hint2.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 2));
        card2.addView(hint2);

        card2.addView(buildLineActions(ServerStore.ID_LINE2, isAct2, base2In, user2In, hint2));
        col.addView(card2);

        // ==================== 3. 内置离线卡片 ====================
        col.addView(Ui.section(this, "无网络 / 全离线模式"));
        boolean isActB = ServerStore.ID_BUILTIN.equals(activeId);
        LinearLayout cardB = Ui.card(this);
        cardB.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 14));

        LinearLayout topB = new LinearLayout(this);
        topB.setOrientation(LinearLayout.HORIZONTAL);
        topB.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout leftB = new LinearLayout(this);
        leftB.setOrientation(LinearLayout.VERTICAL);
        leftB.addView(Ui.text(this, "内置离线模式", 15, Ui.color(this, R.color.text), true));
        TextView subB = Ui.text(this, "后端完全在手机内运行，无需服务器。换机或重装会清空数据。",
                12.5f, Ui.color(this, R.color.text_3), false);
        Ui.margin(this, subB, 0, 2, 0, 0);
        leftB.addView(subB);
        topB.addView(leftB, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (isActB) {
            topB.addView(Ui.pill(this, "使用中", Color.WHITE, Ui.color(this, R.color.brand)));
        } else {
            TextView switchB = Ui.button(this, "切换离线", false, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    saveAllInputs(false);
                    ServerStore s = ServerStore.get(ServerActivity.this);
                    ServerStore.Profile p = s.find(ServerStore.ID_BUILTIN);
                    if (p != null) switchTo(p);
                }
            });
            switchB.setPadding(Ui.dp(this, 12), Ui.dp(this, 6), Ui.dp(this, 12), Ui.dp(this, 6));
            topB.addView(switchB);
        }
        cardB.addView(topB);
        col.addView(cardB);

        // ==================== 4. 底部一键保存 ====================
        col.addView(Ui.section(this, ""));
        TextView saveBtn = Ui.button(this, "保存配置并连接", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveAllInputs(true);
            }
        });
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 46));
        btnLp.setMargins(Ui.dp(this, 14), 0, Ui.dp(this, 14), Ui.dp(this, 20));
        col.addView(saveBtn, btnLp);

        col.addView(Ui.note(this, "提示：地址无需写 http/https，IP 与内网按 http，域名按 https 自动匹配。末尾的 /api 会自动纠正。"));
    }

    /** 卡片标题栏：左侧标题与说明，右侧状态药丸 */
    private View buildCardHeader(String title, String subtitle, boolean isActive) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 6));

        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        left.addView(Ui.text(this, title, 14.5f, Ui.color(this, R.color.text), true));
        TextView sub = Ui.text(this, subtitle, 12f, Ui.color(this, R.color.text_3), false);
        Ui.margin(this, sub, 0, 2, 0, 0);
        left.addView(sub);
        row.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (isActive) {
            row.addView(Ui.pill(this, "当前生效", Color.WHITE, Ui.color(this, R.color.brand)));
        } else {
            row.addView(Ui.pill(this, "备用中", Ui.color(this, R.color.text_3), Ui.color(this, R.color.surface_2)));
        }
        return row;
    }

    /** 线路操作按钮行：[ 启用此线路 ] + [ 测试连接 ] */
    private View buildLineActions(final String lineId, final boolean isActive,
                                  final EditText baseEt, final EditText userEt, final TextView hintTv) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), 0);

        // 按钮 1：启用/使用中
        String switchLabel = isActive ? "✔ 当前正在使用" : "切换并使用此线路";
        TextView switchBtn = Ui.button(this, switchLabel, !isActive, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (isActive) {
                    Ui.toast(ServerActivity.this, "当前生效的就是此线路");
                    return;
                }
                saveLineInput(lineId, baseEt, userEt);
                ServerStore st = ServerStore.get(ServerActivity.this);
                ServerStore.Profile p = st.find(lineId);
                if (p == null || !p.usable()) {
                    hintTv.setTextColor(Ui.color(ServerActivity.this, R.color.brand));
                    hintTv.setText("请先填写服务器地址再启用");
                    Ui.toast(ServerActivity.this, "请先填写服务器地址再启用");
                    return;
                }
                switchTo(p);
            }
        });
        if (isActive) {
            switchBtn.setEnabled(false);
            switchBtn.setAlpha(0.7f);
        }

        // 按钮 2：测试连接
        TextView probeBtn = Ui.button(this, "测试连接", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveLineInput(lineId, baseEt, userEt);
                ServerStore st = ServerStore.get(ServerActivity.this);
                ServerStore.Profile p = st.find(lineId);
                if (p != null) doProbe(p, baseEt, userEt, hintTv);
            }
        });

        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(0, Ui.dp(this, 40), 1.2f);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, Ui.dp(this, 40), 1f);
        lp2.setMargins(Ui.dp(this, 8), 0, 0, 0);

        row.addView(switchBtn, lp1);
        row.addView(probeBtn, lp2);
        return row;
    }

    /** 保存单个输入框的内容到 Profile */
    private void saveLineInput(String lineId, EditText baseEt, EditText userEt) {
        if (baseEt == null || userEt == null) return;
        String b = Handshake.normalize(baseEt.getText().toString());
        String u = userEt.getText().toString().trim();
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p = st.find(lineId);
        if (p != null) {
            p.base = b;
            p.user = u;
            st.upsert(p);
        }
    }

    /** 保存全部输入框，若 andReconnect 为 true 则直接刷新当前连接 */
    private void saveAllInputs(boolean andReconnect) {
        saveLineInput(ServerStore.ID_LINE1, base1In, user1In);
        saveLineInput(ServerStore.ID_LINE2, base2In, user2In);
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile cur = st.active();
        changed = true;
        if (andReconnect) {
            if (cur != null && !cur.usable()) {
                Ui.toast(this, "当前选中的线路还没填地址，请填写");
                return;
            }
            Ui.toast(this, "配置已保存，正在重新连接…");
            finishWith(true);
        }
    }

    /** 切换并退出 Activity 通知主界面刷新 */
    private void switchTo(ServerStore.Profile p) {
        saveLineInput(p.id, p.id.equals(ServerStore.ID_LINE1) ? base1In : base2In,
                p.id.equals(ServerStore.ID_LINE1) ? user1In : user2In);
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile now = st.setActive(p.id);
        st.setOnboarded(true);
        changed = true;
        Ui.toast(this, "已切到「" + now.name + "」，正在重新连接…");
        finishWith(true);
    }

    private View wrapField(String label, View input) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(this, 16), Ui.dp(this, 6), Ui.dp(this, 16), 0);
        TextView l = Ui.text(this, label, 12f, Ui.color(this, R.color.text_3), false);
        l.setPadding(0, 0, 0, Ui.dp(this, 4));
        box.addView(l);
        box.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return box;
    }

    private String statusLine(ServerStore.Profile p) {
        StringBuilder sb = new StringBuilder();
        sb.append("上次连接：").append(p.brandName());
        if (p.checkedAt > 0) {
            sb.append(" · ").append(handshakeAgo(p.checkedAt));
        }
        if (!p.version.isEmpty() && ClientBrand.compareVersion(p.version, ClientBrand.SERVICE_EXPECT) != 0) {
            sb.append("\n⚠ 版本与客户端期望的不同。通常仍然可用（接口是向后兼容的），"
                    + "但如果遇到奇怪的问题，先把两边都升到同一版再试。");
        }
        return sb.toString();
    }

    private static String handshakeAgo(long checkedAt) {
        long min = (System.currentTimeMillis() - checkedAt) / 60000;
        if (min < 1) return "刚刚握过手";
        if (min < 60) return min + " 分钟前握过手";
        return (min / 60) + " 小时前握过手";
    }

    private void doProbe(final ServerStore.Profile p, final EditText baseIn,
                         final EditText userIn, final TextView hint) {
        final String raw = baseIn.getText().toString();
        final String base = Handshake.normalize(raw);
        if (base.isEmpty()) {
            hint.setTextColor(Ui.color(this, R.color.brand));
            hint.setText("请先填写服务器地址");
            Ui.toast(this, "请先填写服务器地址");
            return;
        }
        busy = true;
        hint.setTextColor(Ui.color(this, R.color.text_3));
        hint.setText("正在测试连接 " + base + " …");

        new Thread(new Runnable() {
            @Override
            public void run() {
                final Handshake.Result r = Handshake.probe(raw);
                if (r.ok) r.needsSetup = Handshake.needsSetup(r.base);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        busy = false;
                        if (!r.ok) {
                            hint.setTextColor(Ui.color(ServerActivity.this, R.color.brand));
                            hint.setText("连不上：" + r.error);
                            Ui.toast(ServerActivity.this, "连不上：" + r.error);
                            return;
                        }
                        ServerStore st = ServerStore.get(ServerActivity.this);
                        st.saveHandshake(p.id, r);
                        ServerStore.Profile cur = st.find(p.id);
                        if (cur != null) {
                            cur.base = r.base;
                            cur.user = userIn.getText().toString().trim();
                            st.upsert(cur);
                        }
                        hint.setTextColor(Ui.color(ServerActivity.this, R.color.ok));
                        StringBuilder sb = new StringBuilder();
                        sb.append("连接成功（").append(r.ms).append("ms）→ ")
                                .append(r.brandName(ServerStore.KIND_DOCKER.equals(p.kind) ? "docker" : "cf"));
                        if (r.needsSetup) sb.append("\n该服务器尚未初始化，连接后将引导设置管理员。");
                        if (r.versionMismatch) {
                            sb.append("\n⚠ 服务端版本与客户端期望的不同，通常仍可用。");
                        }
                        hint.setText(sb.toString());
                        Ui.toast(ServerActivity.this, "连接成功 (" + r.ms + "ms)");
                    }
                });
            }
        }, "lx-handshake").start();
    }

    private void finishWith(boolean didChange) {
        if (didChange) changed = true;
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, changed);
        setResult(RESULT_OK, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        saveAllInputs(false);
        super.onBackPressed();
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, changed);
        setResult(RESULT_OK, data);
        Log.d(TAG, "返回键退出，changed=" + changed);
    }
}
