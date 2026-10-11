package com.zyplnn.lxclient;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/**
 * 服务器连接 —— 纯原生页面，客户端最要紧的一块地面。
 *
 * ══════════════ 为什么这块必须是原生的 ══════════════
 * 服务器地址填错时，跨端层（WebView 里那份前端）**自己都起不来** ——
 * 它拿不到数据、渲染不出界面、连「设置」都进不去。这时候如果服务器配置页
 * 也长在跨端层里，用户就彻底没有退路了（只能重装 App）。
 * 所以它是一块完全独立的原生地面：不依赖网络、不依赖 WebView、不依赖任何 JS。
 * （老壳里也有同样的考虑：登录页底部那个「服务器设置」入口，见 app.js 的 serverEntryHtml。）
 *
 * ══════════════ 三种形态，一个页面 ══════════════
 *   内置离线      后端完全跑在设备内，一个字节都不出设备。换机 / 重装会清空数据。
 *   Cloudflare    连线上那份 Worker（D1 数据库 + 静态资源），零运维、秒开。
 *   Docker 自托管 连自己那台（局域网 IP、域名、反代都可以），数据在自己手里。
 *   + 自建服务器   任意地址，可以存多条（家里一台、公司一台、外面一台）。
 *
 * 这三条线的**品牌名与版本各不相同**（Docker → LX-MUSIC，CF → music-edge），
 * 页面上的「连上后是什么」一栏就是握手问出来的结果 —— 不让用户去猜自己连的是谁。
 */
public class ServerActivity extends Activity {

    private static final String TAG = "LXC/Server";

    /** 首启向导模式（显示欢迎语，连上后直接回主界面） */
    public static final String EXTRA_FIRST_RUN = "first_run";
    /** 回给 ClientActivity：档案变了，需要整页重载 */
    public static final String EXTRA_CHANGED = "changed";

    private boolean firstRun = false;
    private boolean changed = false;

    /** 当前在编辑哪条档案（id）。null = 没展开任何编辑器 */
    private String editingId = null;

    private LinearLayout listHost;
    private LinearLayout editorHost;
    /** 正在测试连接 / 正在连接 —— 期间把按钮禁掉，免得连点发出多个请求 */
    private boolean busy = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        firstRun = getIntent() != null && getIntent().getBooleanExtra(EXTRA_FIRST_RUN, false);
        render();
    }

    /* ══════════════════ 页面骨架 ══════════════════ */

    private void render() {
        LinearLayout col = Ui.page(this, 24);
        col.addView(Ui.titleBar(this, firstRun ? "选择连接方式" : "服务器连接",
                firstRun ? null : "完成", firstRun ? null : new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        finishWith(false);
                    }
                }));

        if (firstRun) {
            TextView hi = Ui.text(this, "这个客户端可以连不同的后端，先选一个：", 15,
                    Ui.color(this, R.color.text), false);
            hi.setPadding(Ui.dp(this, 18), Ui.dp(this, 16), Ui.dp(this, 18), 0);
            col.addView(hi);
            col.addView(Ui.note(this, "选错也没关系，之后随时可以在顶栏「切换」或设置里改。"));
        }

        listHost = new LinearLayout(this);
        listHost.setOrientation(LinearLayout.VERTICAL);
        col.addView(listHost);

        // 双地址配置卡片（一次性配置地址 1 与地址 2）
        col.addView(buildDualAddressCard());

        editorHost = new LinearLayout(this);
        editorHost.setOrientation(LinearLayout.VERTICAL);
        col.addView(editorHost);

        col.addView(Ui.note(this,
                "地址可以不写协议：IP 与 localhost 按 http 处理（内网基本没证书），域名按 https。"
                        + "带路径也可以，末尾的 /api 会自动去掉。"));
        col.addView(Ui.note(this,
                "握手 = 向该服务器请求 /api/version，拿它自报的品牌名与版本。"
                        + "只用状态码判断是不够的 —— 反向代理挂掉时经常回一个 200 的错误页，"
                        + "所以这里会看正文像不像本项目的接口。"));

        rebuildList();
        rebuildEditor();
    }

    private void rebuildList() {
        if (listHost == null) return;
        listHost.removeAllViews();
        listHost.addView(Ui.section(this, "服务器档案"));

        ServerStore st = ServerStore.get(this);
        List<ServerStore.Profile> ps = st.profiles();
        String activeId = st.activeId();

        LinearLayout card = Ui.card(this);
        boolean first = true;
        for (int i = 0; i < ps.size(); i++) {
            final ServerStore.Profile p = ps.get(i);
            if (!first) card.addView(Ui.divider(this, true));
            first = false;
            card.addView(profileRow(p, p.id.equals(activeId)));
        }
        listHost.addView(card);

        // 自建服务器：局域网里的另一台、反代出来的域名等
        LinearLayout addCard = Ui.card(this);
        addCard.addView(Ui.row(this, null, "＋ 添加自建服务器",
                "任意地址，可存多条（家里 / 公司 / 外面各一台）", null, false,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ServerStore st2 = ServerStore.get(ServerActivity.this);
                        ServerStore.Profile p = st2.addCustom("自建服务器", "", "");
                        editingId = p.id;
                        rebuildList();
                        rebuildEditor();
                    }
                }));
        listHost.addView(addCard);
    }

    /** 一条档案：名称 + 副标题（类型 / 地址 / 品牌）+ 右侧状态 + 选中标记 */
    private View profileRow(final ServerStore.Profile p, boolean active) {
        String right;
        if (!p.usable()) right = "未配置";
        else if (p.checkedAt > 0) right = "已连接";
        else right = "未握手";

        String subtitle;
        if (p.base.isEmpty()) {
            subtitle = kindLabel(p.kind) + " · 还没填地址";
        } else {
            subtitle = kindLabel(p.kind) + " · " + p.base
                    + (p.checkedAt > 0 ? " · " + p.brandName() : "");
        }

        final String label = p.name;
        LinearLayout row = Ui.row(this, null, label, subtitle, right, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editingId = p.id.equals(editingId) ? null : p.id;
                        rebuildList();
                        rebuildEditor();
                    }
                });
        if (active) {
            View mark = new View(this);
            mark.setBackgroundColor(Ui.color(this, R.color.brand));
            LinearLayout wrap = new LinearLayout(this);
            wrap.setOrientation(LinearLayout.HORIZONTAL);
            wrap.addView(mark, new LinearLayout.LayoutParams(Ui.dp(this, 3),
                    ViewGroup.LayoutParams.MATCH_PARENT));
            wrap.addView(row, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            return wrap;
        }
        return row;
    }

    private static String kindLabel(String kind) {
        if (ServerStore.KIND_CF.equals(kind)) return "Cloudflare";
        if (ServerStore.KIND_DOCKER.equals(kind)) return "Docker 自托管";
        return "自建";
    }

    /* ══════════════════ 编辑器 ══════════════════ */

    private void rebuildEditor() {
        if (editorHost == null) return;
        editorHost.removeAllViews();
        if (editingId == null) return;

        final ServerStore st = ServerStore.get(this);
        final ServerStore.Profile p = st.find(editingId);
        if (p == null) {
            editingId = null;
            return;
        }

        editorHost.addView(Ui.section(this, "编辑：" + p.name));
        LinearLayout card = Ui.card(this);
        card.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 12));

        // 名称（仅自定义档案可改）
        final EditText nameIn = Ui.input(this, "名称（列表里显示）", p.name,
                InputType.TYPE_CLASS_TEXT);
        if (!ServerStore.KIND_CUSTOM.equals(p.kind)) nameIn.setEnabled(false);
        card.addView(wrapField("名称", nameIn));

        final EditText baseIn = Ui.input(this,
                ServerStore.KIND_CF.equals(p.kind) ? "https://你的-worker.workers.dev"
                        : "https://music.example.com 或 192.168.1.9:8080",
                p.base, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(wrapField("服务器地址", baseIn));

        final EditText userIn = Ui.input(this, "登录用户名（可选，填了登录页自动带上）",
                p.user, InputType.TYPE_CLASS_TEXT);
        card.addView(wrapField("用户名", userIn));

        final TextView hint = Ui.text(this, "", 12.5f, Ui.color(this, R.color.text_3), false);
        hint.setPadding(Ui.dp(this, 16), Ui.dp(this, 4), Ui.dp(this, 16), Ui.dp(this, 2));
        hint.setLineSpacing(Ui.dp(this, 3), 1f);
        card.addView(hint);
        if (p.checkedAt > 0) {
            hint.setText(statusLine(p));
        }

        card.addView(buttonRow(
                new String[]{"测试连接", "保存并连接", "删除本档案"},
                new Runnable[]{
                        new Runnable() {
                            @Override
                            public void run() {
                                doProbe(p, baseIn, userIn, hint, null);
                            }
                        },
                        new Runnable() {
                            @Override
                            public void run() {
                                doProbe(p, baseIn, userIn, hint, new Runnable() {
                                    @Override
                                    public void run() {
                                        // 握手过了（或用户就是要存）→ 设为当前并回主界面
                                        ServerStore s2 = ServerStore.get(ServerActivity.this);
                                        ServerStore.Profile cur = s2.find(p.id);
                                        if (cur != null) {
                                            cur.base = Handshake.normalize(baseIn.getText().toString());
                                            cur.user = userIn.getText().toString().trim();
                                            if (ServerStore.KIND_CUSTOM.equals(cur.kind)) {
                                                String nm = nameIn.getText().toString().trim();
                                                if (!nm.isEmpty()) cur.name = nm;
                                            }
                                            s2.upsert(cur);
                                        }
                                        s2.setActive(p.id);
                                        s2.setOnboarded(true);
                                        finishWith(true);
                                    }
                                });
                            }
                        },
                        new Runnable() {
                            @Override
                            public void run() {
                                final ServerStore s2 = ServerStore.get(ServerActivity.this);
                                Ui.confirm(ServerActivity.this, "删除档案",
                                        "确定删除「" + p.name + "」吗？只是从列表里去掉这条记录，"
                                                + "服务器上的数据不受影响。",
                                        "删除", new Runnable() {
                                            @Override
                                            public void run() {
                                                s2.remove(p.id);
                                                editingId = null;
                                                rebuildList();
                                                rebuildEditor();
                                            }
                                        }, null);
                            }
                        },
                }));

        editorHost.addView(card);

        if (!p.base.isEmpty() && p.checkedAt > 0) {
            editorHost.addView(Ui.note(this, statusLine(p)));
        }
    }

    /** 一行说明 + 输入框，统一左右留白 */
    private View wrapField(String label, View input) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), 0);
        TextView l = Ui.text(this, label, 12.5f, Ui.color(this, R.color.text_3), false);
        l.setPadding(0, 0, 0, Ui.dp(this, 5));
        box.addView(l);
        box.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return box;
    }

    /** 一行按钮（自动排布、自动留白） */
    private View buttonRow(String[] labels, Runnable[] actions) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(Ui.dp(this, 16), Ui.dp(this, 14), Ui.dp(this, 16), 0);
        for (int i = 0; i < labels.length; i++) {
            final Runnable a = actions[i];
            // 第一个按钮是主操作（品牌红），其余是次要
            TextView b = Ui.button(this, labels[i], i == 0, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (!busy) a.run();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(this, 42), 1f);
            if (i > 0) lp.setMargins(Ui.dp(this, 8), 0, 0, 0);
            row.addView(b, lp);
        }
        return row;
    }

    /**
     * 「已连接」那一行说明。
     *
     * ⚠ 不显示服务端版本与构建号（老板 2026-10-08：「服务端版本的显示，仅保留设置项里面，
     * 其他页面去掉」）。这一页是**挑服务器**用的，要回答的是「哪台、什么时候通过信」。
     * 唯一的例外是下面那条「版本对不上」的提示 —— 它不是一个给人看的数字，
     * 而是一条可执行的建议，且本身不含任何版本值。
     */
    private String statusLine(ServerStore.Profile p) {
        StringBuilder sb = new StringBuilder();
        sb.append("上次握手：").append(p.brandName());
        if (p.checkedAt > 0) {
            long min = (System.currentTimeMillis() - p.checkedAt) / 60000;
            sb.append(min < 1 ? " · 刚刚" : (min < 60 ? " · " + min + " 分钟前" : " · " + (min / 60) + " 小时前"));
        }
        if (!p.version.isEmpty() && ClientBrand.compareVersion(p.version, ClientBrand.SERVICE_EXPECT) != 0) {
            sb.append("\n⚠ 版本与客户端期望的不同。通常仍然可用（接口是向后兼容的），"
                            + "但如果遇到奇怪的问题，先把两边都升到同一版再试。");
        }
        return sb.toString();
    }

    /* ══════════════════ 双地址一站式配置卡片 ══════════════════ */

    private View buildDualAddressCard() {
        final ServerStore st = ServerStore.get(this);
        final ServerStore.Profile p1 = st.getLine1();
        final ServerStore.Profile p2 = st.getLine2();

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(Ui.section(this, "双服务器地址（一次填写两个地址）"));

        LinearLayout card = Ui.card(this);
        card.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 14));

        TextView intro = Ui.text(this, "可同时配置两套后端（例如主线路填内网/自建 Docker，备用线路填 Cloudflare Workers），随时在设置里自由切换。",
                12.5f, Ui.color(this, R.color.text_2), false);
        intro.setPadding(Ui.dp(this, 16), 0, Ui.dp(this, 16), Ui.dp(this, 8));
        card.addView(intro);

        // ===== 节点 1：主线路 (Docker) =====
        card.addView(Ui.divider(this, true));
        TextView title1 = Ui.text(this, "【地址 1 · 主线路】", 13.5f, Ui.color(this, R.color.brand), true);
        title1.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), 0);
        card.addView(title1);

        final EditText base1In = Ui.input(this, "如: http://192.168.1.100:8080 或域名",
                p1 != null ? p1.base : "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(wrapField("服务器地址 1", base1In));

        final EditText user1In = Ui.input(this, "用户名 1（可选）",
                p1 != null ? p1.user : "", InputType.TYPE_CLASS_TEXT);
        card.addView(wrapField("用户名 1", user1In));

        final TextView hint1 = Ui.text(this, (p1 != null && p1.checkedAt > 0) ? statusLine(p1) : "",
                12f, Ui.color(this, R.color.text_3), false);
        hint1.setPadding(Ui.dp(this, 16), Ui.dp(this, 2), Ui.dp(this, 16), Ui.dp(this, 4));
        card.addView(hint1);

        // ===== 节点 2：备用线路 (Cloudflare) =====
        card.addView(Ui.divider(this, true));
        TextView title2 = Ui.text(this, "【地址 2 · 备用线路】", 13.5f, Ui.color(this, R.color.brand), true);
        title2.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), 0);
        card.addView(title2);

        final EditText base2In = Ui.input(this, "如: https://你的-worker.workers.dev",
                p2 != null ? p2.base : "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(wrapField("服务器地址 2", base2In));

        final EditText user2In = Ui.input(this, "用户名 2（可选）",
                p2 != null ? p2.user : "", InputType.TYPE_CLASS_TEXT);
        card.addView(wrapField("用户名 2", user2In));

        final TextView hint2 = Ui.text(this, (p2 != null && p2.checkedAt > 0) ? statusLine(p2) : "",
                12f, Ui.color(this, R.color.text_3), false);
        hint2.setPadding(Ui.dp(this, 16), Ui.dp(this, 2), Ui.dp(this, 16), Ui.dp(this, 4));
        card.addView(hint2);

        card.addView(Ui.divider(this, true));

        // ===== 当前启用线路选择状态 =====
        final String[] curSelect = new String[]{
                ServerStore.ID_LINE2.equals(st.activeId()) ? ServerStore.ID_LINE2 : ServerStore.ID_LINE1
        };
        final TextView selectStatus = Ui.text(this,
                "当前选用生效：" + (ServerStore.ID_LINE2.equals(curSelect[0]) ? "地址 2 (备用线路)" : "地址 1 (主线路)"),
                13f, Ui.color(this, R.color.text), true);
        selectStatus.setPadding(Ui.dp(this, 16), Ui.dp(this, 8), Ui.dp(this, 16), Ui.dp(this, 6));
        card.addView(selectStatus);

        // 线路切换辅助切换行
        card.addView(buttonRow(new String[]{"测试地址 1 连通性", "测试地址 2 连通性"}, new Runnable[]{
                new Runnable() {
                    @Override
                    public void run() {
                        if (p1 != null) doProbe(p1, base1In, user1In, hint1, null);
                    }
                },
                new Runnable() {
                    @Override
                    public void run() {
                        if (p2 != null) doProbe(p2, base2In, user2In, hint2, null);
                    }
                }
        }));

        card.addView(buttonRow(new String[]{
                "启用地址 1", "启用地址 2", "一键保存双地址并连接"
        }, new Runnable[]{
                new Runnable() {
                    @Override
                    public void run() {
                        curSelect[0] = ServerStore.ID_LINE1;
                        selectStatus.setText("当前选用生效：地址 1 (主线路)");
                        Ui.toast(ServerActivity.this, "已选择地址 1 (主线路)");
                    }
                },
                new Runnable() {
                    @Override
                    public void run() {
                        curSelect[0] = ServerStore.ID_LINE2;
                        selectStatus.setText("当前选用生效：地址 2 (备用线路)");
                        Ui.toast(ServerActivity.this, "已选择地址 2 (备用线路)");
                    }
                },
                new Runnable() {
                    @Override
                    public void run() {
                        String b1 = Handshake.normalize(base1In.getText().toString());
                        String u1 = user1In.getText().toString().trim();
                        String b2 = Handshake.normalize(base2In.getText().toString());
                        String u2 = user2In.getText().toString().trim();

                        if (b1.isEmpty() && b2.isEmpty()) {
                            Ui.toast(ServerActivity.this, "请至少填写一个服务器地址");
                            return;
                        }

                        st.saveDualLines(b1, u1, b2, u2, curSelect[0]);
                        rebuildList();
                        finishWith(true);
                    }
                }
        }));

        wrap.addView(card);
        return wrap;
    }

    /* ══════════════════ 握手 ══════════════════ */

    /**
     * 走一遍握手。**阻塞代码放工作线程**，UI 回主线程。
     *
     * @param thenOk runnable：握手成功后要做什么（保存并连接时为「设为当前并回主界面」）
     */
    private void doProbe(final ServerStore.Profile p, final EditText baseIn,
                         final EditText userIn, final TextView hint, final Runnable thenOk) {
        final String raw = baseIn.getText().toString();
        final String base = Handshake.normalize(raw);
        if (base.isEmpty()) {
            hint.setTextColor(Ui.color(this, R.color.brand));
            hint.setText("请先填写服务器地址");
            return;
        }
        busy = true;
        hint.setTextColor(Ui.color(this, R.color.text_3));
        hint.setText("正在连接 " + base + " …");

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
                        // 握手成功 → 把结果落到档案上（品牌名 / 版本 / 构建号）再刷新界面
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
                        if (r.needsSetup) sb.append("\n这台服务器还没建管理员，连接后会引导你创建。");
                        if (r.versionMismatch) {
                            sb.append("\n⚠ 服务端版本与客户端期望的不同，通常仍可用。");
                        }
                        hint.setText(sb.toString());
                        Ui.toast(ServerActivity.this, "连接成功：" + r.brandName("cf"));
                        rebuildList();
                        if (thenOk != null) thenOk.run();
                    }
                });
            }
        }, "lx-handshake").start();
    }

    /* ══════════════════ 收尾 ══════════════════ */

    /**
     * 结束本页并告诉主界面「档案有没有变」。
     *
     * 变了就要整页重载（换后端意味着 token / 插件池 / 缓存 / 播放队列全要换一套），
     * 没变（只是看了一眼、点了「完成」）就不打扰用户当前的界面。
     */
    private void finishWith(boolean didChange) {
        if (didChange) changed = true;
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, changed);
        setResult(RESULT_OK, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        super.onBackPressed();
        // 用返回键退出时也要把结果带回去，否则主界面不知道要不要重载
        Intent data = new Intent();
        data.putExtra(EXTRA_CHANGED, changed);
        setResult(RESULT_OK, data);
        Log.d(TAG, "返回键退出，changed=" + changed);
    }
}
