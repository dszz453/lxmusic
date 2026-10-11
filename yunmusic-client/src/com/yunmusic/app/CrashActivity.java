package com.yunmusic.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 云音乐 - 崩溃现场页
 *
 * 纯代码布局、不碰 WebView、不碰任何业务逻辑 —— 保证它在「主界面已经崩了」的
 * 前提下依然能显示出来。用户把这一屏截图发过来，就等于拿到了 logcat。
 */
public class CrashActivity extends Activity {

    private String report = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        report = getIntent() == null ? null : getIntent().getStringExtra(App.EXTRA_CRASH);
        if (report == null || report.trim().isEmpty()) {
            report = App.readCrashLog(this);
        }
        if (report == null || report.trim().isEmpty()) {
            report = "（没有捕获到崩溃信息）";
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#F5F5F6"));

        root.addView(buildHeader());
        root.addView(buildBody(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(buildFooter());

        setContentView(root);
    }

    private View buildHeader() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#EC4141"));
        int p = dp(16);
        box.setPadding(p, dp(24), p, p);

        TextView title = new TextView(this);
        title.setText("云音乐 启动失败");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);

        TextView sub = new TextView(this);
        sub.setText("下面是崩溃现场。请截图发给开发者，即可定位问题。");
        sub.setTextColor(Color.parseColor("#FFE0E0"));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setPadding(0, dp(6), 0, 0);
        box.addView(sub);
        return box;
    }

    private View buildBody() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        int p = dp(12);
        scroll.setPadding(p, p, p, p);

        TextView tv = new TextView(this);
        tv.setText(report);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tv.setTextColor(Color.parseColor("#222222"));
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setTextIsSelectable(true);
        scroll.addView(tv);
        return scroll;
    }

    private View buildFooter() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int p = dp(12);
        bar.setPadding(p, p, p, p);
        bar.setBackgroundColor(Color.parseColor("#F5F5F6"));

        Button copy = new Button(this);
        copy.setText("复制日志");
        copy.setAllCaps(false);
        copy.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("云音乐崩溃日志", report));
                        toast("日志已复制");
                    }
                } catch (Throwable ignored) {
                }
            }
        });
        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(copy, lp1);

        Button retry = new Button(this);
        retry.setText("重新打开");
        retry.setAllCaps(false);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    App.clearCrashLog(CrashActivity.this);
                    Intent i = new Intent(CrashActivity.this, MainActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    startActivity(i);
                } catch (Throwable ignored) {
                }
                finish();
            }
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp2.leftMargin = dp(10);
        bar.addView(retry, lp2);
        return bar;
    }

    private void toast(String s) {
        try {
            Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
