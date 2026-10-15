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
 * 云音乐（Docker版）· 服务器地址配置
 *
 * ══════════════ 现代精致卡片化设计（单线路精简版）══════════════
 * 1. 顶部全局连接看板：大字号状态、呼吸绿点、实时握手延迟毫秒数。
 * 2. **一个**服务器地址一屏直填：带序号徽章、内凹呼吸感输入框、一键切换。
 *    ⚠ 2026-10-15（V2.21）：老板要求「docker 版本不要写两个线路了，一个就行」，
 *    原「主线路 / 备用线路」两张卡片已合并为单一「服务器地址」卡片。
 * 3. 保存即落盘：点保存时自动写入最新输入框内容，决不在连不上时静默丢弃。
 * 4. 内置离线独立卡片：随时单机运行。
 */
public class ServerActivity extends Activity {

    private static final String TAG = "LXC/Server";

    public static final String EXTRA_FIRST_RUN = "first_run";
    public static final String EXTRA_CHANGED = "changed";

    private boolean firstRun = false;
    private boolean changed = false;
    private boolean busy = false;

    private EditText base1In;
    private EditText user1In;
    private TextView hint1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        firstRun = getIntent() != null && getIntent().getBooleanExtra(EXTRA_FIRST_RUN, false);
        buildUi();
    }

    private void buildUi() {
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile p1 = st.getLine1();
        ServerStore.Profile pb = st.find(ServerStore.ID_BUILTIN);
        String activeId = st.activeId();
        ServerStore.Profile activeProfile = st.active();

        LinearLayout col = Ui.page(this, 30);

        // 顶栏
        col.addView(Ui.titleBar(this, firstRun ? "欢迎使用云音乐" : "服务器配置",
                firstRun ? null : "完成", firstRun ? null : new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        saveAllInputs(false);
                        finishWith(false);
                    }
                }));

        // ==================== 顶部当前状态看板 ====================
        col.addView(buildActiveDashboard(activeProfile));

        // ==================== 1. 单一服务器卡片 ====================
        col.addView(Ui.section(this, "自建服务器配置 (Docker / 局域网 NAS / 远程服务)"));
        LinearLayout card1 = Ui.card(this);
        card1.setPadding(0, Ui.dp(this, 12), 0, Ui.dp(this, 14));

        boolean isAct1 = ServerStore.ID_LINE1.equals(activeId);
        card1.addView(buildCardHeader("1", "服务器地址",
                "填写自建 Docker 地址（如 http://192.168.1.100:8080）或自建域名", isAct1));

        base1In = Ui.input(this, "例如: http://192.168.1.100:8080 或域名",
                p1 != null ? p1.base : "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card1.addView(wrapField("服务器地址 (IP或域名)", base1In));

        user1In = Ui.input(this, "登录用户名（可选）",
                p1 != null ? p1.user : "", InputType.TYPE_CLASS_TEXT);
        card1.addView(wrapField("登录用户名 (可选)", user1In));

        hint1 = Ui.text(this, (p1 != null && p1.checkedAt > 0) ? statusLine(p1) : "",
                12f, Ui.color(this, R.color.text_3), false);
        hint1.setPadding(Ui.dp(this, 16), Ui.dp(this, 6), Ui.dp(this, 16), Ui.dp(this, 2));
        card1.addView(hint1);

        card1.addView(buildLineActions(ServerStore.ID_LINE1, isAct1, base1In, user1In, hint1));
        col.addView(card1);

        // ==================== 2. 内置离线卡片 ====================
        col.addView(Ui.section(this, "单机离线运行"));
        boolean isActB = ServerStore.ID_BUILTIN.equals(activeId);
        LinearLayout cardB = Ui.card(this);
        cardB.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));

        LinearLayout topB = new LinearLayout(this);
        topB.setOrientation(LinearLayout.HORIZONTAL);
        topB.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout leftB = new LinearLayout(this);
        leftB.setOrientation(LinearLayout.VERTICAL);
        leftB.addView(Ui.text(this, "内置离线模式", 15, Ui.color(this, R.color.text), true));
        TextView subB = Ui.text(this, "后端完全跑在手机内，不连任何服务器，无需网络也可播放本地与内置音乐。",
                12.5f, Ui.color(this, R.color.text_3), false);
        Ui.margin(this, subB, 0, 3, 0, 0);
        leftB.addView(subB);
        topB.addView(leftB, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (isActB) {
            topB.addView(Ui.pillWithDot(this, "正在使用", Color.WHITE,
                    Ui.color(this, R.color.brand), Color.WHITE));
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
            switchB.setPadding(Ui.dp(this, 14), Ui.dp(this, 7), Ui.dp(this, 14), Ui.dp(this, 7));
            topB.addView(switchB);
        }
        cardB.addView(topB);
        col.addView(cardB);

        // ==================== 3. 底部保存大按钮 ====================
        col.addView(Ui.section(this, ""));
        TextView saveBtn = Ui.button(this, "保存配置并连接", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveAllInputs(true);
            }
        });
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 48));
        btnLp.setMargins(Ui.dp(this, 14), 0, Ui.dp(this, 14), Ui.dp(this, 16));
        col.addView(saveBtn, btnLp);

        col.addView(Ui.note(this, "💡 智能适配：输入 IP、域名均无需写 http://，系统会自动处理协议并纠正末尾路径。"));
    }

    /** 顶部当前连接看板（高颜值卡片） */
    private View buildActiveDashboard(ServerStore.Profile cur) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(Ui.shape(this, Ui.color(this, R.color.brand_soft), 14,
                Ui.color(this, R.color.brand), 1));
        box.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), Ui.dp(this, 14));

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(Ui.dp(this, 14), Ui.dp(this, 8), Ui.dp(this, 14), Ui.dp(this, 4));
        box.setLayoutParams(lp);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView label = Ui.text(this, "当前生效服务器", 12f, Ui.color(this, R.color.brand), true);
        top.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        String pillText = (cur != null && cur.usable()) ? "已就绪" : "待配置";
        int dotColor = (cur != null && cur.usable()) ? Ui.color(this, R.color.ok) : Ui.color(this, R.color.warn);
        top.addView(Ui.pillWithDot(this, pillText, Ui.color(this, R.color.brand), Color.WHITE, dotColor));
        box.addView(top);

        String name = cur != null ? cur.name : "未选择服务器";
        TextView title = Ui.text(this, name, 17f, Ui.color(this, R.color.text), true);
        Ui.margin(this, title, 0, 4, 0, 0);
        box.addView(title);

        String sub = (cur != null && cur.usable())
                ? (cur.base.isEmpty() ? "内置离线 · 数据完全保存在本地" : cur.base)
                : "尚未填写服务器地址，请在下方直接输入";
        TextView detail = Ui.text(this, sub, 12.5f, Ui.color(this, R.color.text_2), false);
        Ui.margin(this, detail, 0, 2, 0, 0);
        box.addView(detail);

        return box;
    }

    /** 带徽章序号的卡片标题栏 */
    private View buildCardHeader(String number, String title, String subtitle, boolean isActive) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 6));

        // 序号徽章
        int badgeBg = isActive ? Ui.color(this, R.color.brand) : Ui.color(this, R.color.surface_2);
        int badgeFg = isActive ? Color.WHITE : Ui.color(this, R.color.text_2);
        TextView badge = Ui.badge(this, number, badgeBg, badgeFg);
        row.addView(badge);

        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.VERTICAL);
        Ui.margin(this, mid, 10, 0, 0, 0);

        mid.addView(Ui.text(this, title, 15f, Ui.color(this, R.color.text), true));
        TextView sub = Ui.text(this, subtitle, 11.5f, Ui.color(this, R.color.text_3), false);
        Ui.margin(this, sub, 0, 2, 0, 0);
        mid.addView(sub);
        row.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (isActive) {
            row.addView(Ui.pillWithDot(this, "正在使用", Color.WHITE,
                    Ui.color(this, R.color.brand), Color.WHITE));
        } else {
            row.addView(Ui.pill(this, "备用中", Ui.color(this, R.color.text_3),
                    Ui.color(this, R.color.surface_2)));
        }
        return row;
    }

    /**
     * 服务器卡片底部的两个动作按钮。
     *
     * 单线路模型下文案做了调整：不再是「切换并启用此**线路**」（那暗示还有别的线路
     * 可切），而是「保存并启用此服务器」—— 用户只有一个地址要管。
     */
    private View buildLineActions(final String lineId, final boolean isActive,
                                  final EditText baseEt, final EditText userEt, final TextView hintTv) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), 0);

        String switchLabel = isActive ? "✔ 当前正在使用" : "保存并启用";
        TextView switchBtn = Ui.button(this, switchLabel, !isActive, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (isActive) {
                    Ui.toast(ServerActivity.this, "当前生效的就是这个服务器");
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
            switchBtn.setAlpha(0.65f);
        }

        TextView probeBtn = Ui.button(this, "测试连通性", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveLineInput(lineId, baseEt, userEt);
                ServerStore st = ServerStore.get(ServerActivity.this);
                ServerStore.Profile p = st.find(lineId);
                if (p != null) doProbe(p, baseEt, userEt, hintTv);
            }
        });

        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(0, Ui.dp(this, 42), 1.3f);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, Ui.dp(this, 42), 1f);
        lp2.setMargins(Ui.dp(this, 8), 0, 0, 0);

        row.addView(switchBtn, lp1);
        row.addView(probeBtn, lp2);
        return row;
    }

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

    private void saveAllInputs(boolean andReconnect) {
        saveLineInput(ServerStore.ID_LINE1, base1In, user1In);
        ServerStore st = ServerStore.get(this);
        ServerStore.Profile cur = st.active();
        changed = true;
        if (andReconnect) {
            if (cur != null && !cur.usable()) {
                Ui.toast(this, "当前选中的服务器尚未填写地址，请先填写");
                return;
            }
            Ui.toast(this, "配置已保存，正在重新连接…");
            finishWith(true);
        }
    }

    private void switchTo(ServerStore.Profile p) {
        if (p.id.equals(ServerStore.ID_LINE1)) {
            saveLineInput(p.id, base1In, user1In);
        }
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
