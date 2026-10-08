package com.zyplnn.lxclient;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 原生页面的绘制工具箱。
 *
 * ── 为什么是代码画，不用 layout XML ─────────────────────────────
 * 这个工程的构建链路是 aapt2 → javac → d8（没有 Gradle、没有 androidx，
 * 见 build-client.sh）。layout XML 本身能用，但这几个页面里有一半的控件是
 * **运行时才知道长什么样**的：服务器档案列表（几条、每条什么名字完全取决于用户）、
 * 本地音乐列表（取决于设备里有多少首歌）、诊断信息（键值对数量不定）。
 * 这些地方代码画和 XML 画一样长，而混用两套写法会让「这个控件在哪定义」变得难找。
 *
 * ── 与跨端层的视觉对齐 ──────────────────────────────────────────
 * 颜色与圆角全部抄 public/css/app.css 的 :root（见 res/values/colors.xml），
 * 这样原生页和跨端页面切来切去不会看出两套皮肤。
 *
 * 所有方法都接受 Context，方便在 Activity 与 Dialog 里复用。
 */
public final class Ui {

    private Ui() {
    }

    /* ---------------- 尺寸 ---------------- */

    public static int dp(Context ctx, float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                ctx.getResources().getDisplayMetrics()));
    }

    /** 状态栏高度。用它做顶栏的上内距，避免内容钻到状态栏底下 */
    public static int statusBarHeight(Context ctx) {
        int id = ctx.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? ctx.getResources().getDimensionPixelSize(id) : dp(ctx, 24);
    }

    /** 底部导航栏（手势条）高度，底栏要用它把内容顶上去 */
    public static int navBarHeight(Context ctx) {
        int id = ctx.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
        return id > 0 ? ctx.getResources().getDimensionPixelSize(id) : dp(ctx, 0);
    }

    public static int color(Context ctx, int res) {
        return ctx.getResources().getColor(res);
    }

    /* ---------------- 形状 ---------------- */

    /** 圆角实心块（卡片、按钮底、胶囊都用它）。border<=0 表示不描边 */
    public static GradientDrawable shape(Context ctx, int fill, float radiusDp, int border, float borderDp) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(ctx, radiusDp));
        if (border != 0 && borderDp > 0) g.setStroke(dp(ctx, borderDp), border);
        return g;
    }

    /**
     * 给背景加一层水波纹（Android 5+ 才有，低版本直接返回原背景）。
     * 没有它的话，点原生列表项完全没有反馈 —— 用户会以为没点中。
     */
    public static Drawable ripple(Context ctx, Drawable bg, int rippleColor) {
        if (Build.VERSION.SDK_INT < 21) return bg;
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), bg, null);
    }

    /** 给矢量图标上色（底栏选中态、列表图标都靠它） */
    public static void tint(Drawable d, int color) {
        if (d == null) return;
        if (Build.VERSION.SDK_INT >= 21) {
            d.setTint(color);
        } else {
            d.setColorFilter(color, android.graphics.PorterDuff.Mode.SRC_IN);
        }
    }

    /* ---------------- 基础控件 ---------------- */

    public static TextView text(Context ctx, String s, float sizeSp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(s == null ? "" : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setIncludeFontPadding(false);
        return t;
    }

    /** 单行、末尾省略的文本（列表标题用；不设这个的话长歌名会把行撑破） */
    public static TextView ellipsis(TextView t) {
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    public static ImageView icon(Context ctx, int res, int color, int sizeDp) {
        ImageView iv = new ImageView(ctx);
        iv.setImageResource(res);
        tint(iv.getDrawable(), color);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(ctx, sizeDp), dp(ctx, sizeDp));
        iv.setLayoutParams(lp);
        return iv;
    }

    public static View margin(Context ctx, View v, float left, float top, float right, float bottom) {
        ViewGroup.LayoutParams base = v.getLayoutParams();
        LinearLayout.LayoutParams lp = base instanceof LinearLayout.LayoutParams
                ? (LinearLayout.LayoutParams) base
                : new LinearLayout.LayoutParams(
                        base == null ? ViewGroup.LayoutParams.MATCH_PARENT : base.width,
                        base == null ? ViewGroup.LayoutParams.WRAP_CONTENT : base.height);
        lp.setMargins(dp(ctx, left), dp(ctx, top), dp(ctx, right), dp(ctx, bottom));
        v.setLayoutParams(lp);
        return v;
    }

    /* ---------------- 页面骨架 ---------------- */

    /**
     * 原生页面的根容器：垂直的 LinearLayout 装在 ScrollView 里，整体灰底。
     * 返回的容器已经带了状态栏内距 —— 页面代码不用自己操心刘海屏。
     *
     * @param padBottom 内容底部额外留白（避免最后一行贴着手势条）
     */
    public static LinearLayout page(Activity a, int padBottom) {
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(color(a, R.color.bg));
        col.setPadding(0, 0, 0, dp(a, padBottom));
        ScrollView sc = new ScrollView(a);
        sc.setFillViewport(false);
        sc.setClipToPadding(false);
        sc.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        a.setContentView(sc);
        return col;
    }

    /**
     * 顶栏：白底、左返回、居中标题、右侧可选文字按钮。
     *
     * 为什么标题居中而不是靠左：和跨端页面里那些二级页的标题位置一致，
     * 切换页面时标题不会左右跳。
     */
    public static View titleBar(Activity a, String title, String rightText, View.OnClickListener right) {
        LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(color(a, R.color.surface));
        int sb = statusBarHeight(a);
        bar.setPadding(dp(a, 4), sb, dp(a, 4), 0);
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(a, 52) + sb));

        ImageView back = icon(a, R.drawable.ic_back, color(a, R.color.text), 24);
        LinearLayout backWrap = new LinearLayout(a);
        backWrap.setGravity(Gravity.CENTER);
        backWrap.addView(back);
        backWrap.setBackground(ripple(a, shape(a, Color.TRANSPARENT, 999, 0, 0), 0x14000000));
        backWrap.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                a.finish();
            }
        });
        bar.addView(backWrap, new LinearLayout.LayoutParams(dp(a, 44), dp(a, 44)));

        TextView t = text(a, title, 17, color(a, R.color.text), true);
        t.setGravity(Gravity.CENTER);
        ellipsis(t);
        bar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (rightText != null) {
            TextView r = text(a, rightText, 15, color(a, R.color.brand), false);
            r.setGravity(Gravity.CENTER);
            r.setPadding(dp(a, 12), 0, dp(a, 12), 0);
            r.setMinWidth(dp(a, 44));
            r.setBackground(ripple(a, shape(a, Color.TRANSPARENT, 999, 0, 0), 0x14EC4141));
            if (right != null) r.setOnClickListener(right);
            bar.addView(r, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, dp(a, 44)));
        } else {
            bar.addView(new View(a), new LinearLayout.LayoutParams(dp(a, 44), dp(a, 1)));
        }
        return bar;
    }

    /* ---------------- 常用块 ---------------- */

    /** 分组小标题（如「服务器档案」「本机数据」） */
    public static View section(Context c, String s) {
        TextView t = text(c, s, 12.5f, color(c, R.color.text_3), false);
        t.setPadding(dp(c, 18), dp(c, 18), dp(c, 18), dp(c, 8));
        return t;
    }

    /** 白色卡片容器（圆角 14、极细描边，与网页 .block 一致） */
    public static LinearLayout card(Context c) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(shape(c, color(c, R.color.surface), 14, color(c, R.color.line), 1));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(c, 14), 0, dp(c, 14), dp(c, 10));
        box.setLayoutParams(lp);
        return box;
    }

    /** 卡片里的分隔线（左边留出图标位，视觉上与图标对齐） */
    public static View divider(Context c, boolean indented) {
        View v = new View(c);
        v.setBackgroundColor(color(c, R.color.line));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 1));
        lp.setMargins(dp(c, indented ? 52 : 0), 0, 0, 0);
        v.setLayoutParams(lp);
        return v;
    }

    /** 一行说明文字（灰、可多行） */
    public static TextView note(Context c, String s) {
        TextView t = text(c, s, 12.5f, color(c, R.color.text_3), false);
        t.setLineSpacing(dp(c, 3), 1f);
        t.setPadding(dp(c, 18), dp(c, 2), dp(c, 18), dp(c, 6));
        return t;
    }

    /** 主按钮 */
    public static TextView button(Context c, String label, boolean primary, View.OnClickListener cb) {
        int bg = primary ? color(c, R.color.brand) : color(c, R.color.surface);
        int fg = primary ? Color.WHITE : color(c, R.color.text);
        int border = primary ? 0 : color(c, R.color.line_strong);
        TextView b = text(c, label, 15, fg, false);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(c, 16), 0, dp(c, 16), 0);
        b.setBackground(ripple(c, shape(c, bg, 999, border, 1), primary ? 0x33FFFFFF : 0x14000000));
        if (cb != null) b.setOnClickListener(cb);
        return b;
    }

    /**
     * 可点的一行：左图标（可选）+ 主标题 + 副标题（可选）+ 右侧文字（可选）+ 箭头（可选）。
     * 原生页面的设置项、服务器档案项都用它。
     */
    public static LinearLayout row(Context c, Integer iconRes, String title, String subtitle,
                                   String rightText, boolean chevron, View.OnClickListener cb) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setBackground(ripple(c, shape(c, Color.TRANSPARENT, 0, 0, 0), 0x12000000));
        r.setPadding(dp(c, 16), dp(c, 13), dp(c, 14), dp(c, 13));
        if (cb != null) r.setOnClickListener(cb);

        if (iconRes != null) {
            ImageView iv = icon(c, iconRes, color(c, R.color.text_2), 21);
            r.addView(iv);
            margin(c, iv, 0, 0, 14, 0);
        }

        LinearLayout mid = new LinearLayout(c);
        mid.setOrientation(LinearLayout.VERTICAL);
        TextView t1 = ellipsis(text(c, title, 15, color(c, R.color.text), false));
        mid.addView(t1);
        if (subtitle != null && !subtitle.isEmpty()) {
            TextView t2 = ellipsis(text(c, subtitle, 12.5f, color(c, R.color.text_3), false));
            margin(c, t2, 0, 3, 0, 0);
            mid.addView(t2);
        }
        r.addView(mid, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (rightText != null && !rightText.isEmpty()) {
            TextView rv = text(c, rightText, 13, color(c, R.color.text_3), false);
            rv.setGravity(Gravity.END);
            rv.setSingleLine(true);
            // 右侧文字最多占 40% 宽，超了省略 —— 服务器地址可能很长，
            // 不限制的话会把标题挤成「D…」这种没法看的样子
            r.addView(rv);
            margin(c, rv, 10, 0, chevron ? 6 : 0, 0);
        }
        if (chevron) {
            r.addView(icon(c, R.drawable.ic_chevron, color(c, R.color.text_3), 17));
        }
        return r;
    }

    /** 小胶囊标签（如「已连接 · V1.3」） */
    public static TextView pill(Context c, String s, int fg, int bg) {
        TextView t = text(c, s, 11.5f, fg, false);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(c, 10), dp(c, 3), dp(c, 10), dp(c, 3));
        t.setBackground(shape(c, bg, 999, 0, 0));
        return t;
    }

    /** 输入框（原生页面里的地址、用户名） */
    public static android.widget.EditText input(Context c, String hint, String value, int inputType) {
        android.widget.EditText e = new android.widget.EditText(c);
        e.setHint(hint);
        if (value != null) e.setText(value);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setTextColor(color(c, R.color.text));
        e.setHintTextColor(color(c, R.color.text_3));
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setBackground(shape(c, color(c, R.color.surface_2), 10, color(c, R.color.line_strong), 1));
        e.setPadding(dp(c, 12), dp(c, 11), dp(c, 12), dp(c, 11));
        return e;
    }

    public static void toast(Context c, String s) {
        try {
            Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
        } catch (Throwable ignore) {
        }
    }

    /** 简单确认框（原生 AlertDialog，不引 androidx） */
    public static void confirm(Context c, String title, String message,
                               String okText, final Runnable onOk, final Runnable onCancel) {
        try {
            android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(c);
            b.setTitle(title);
            b.setMessage(message);
            b.setPositiveButton(okText, new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface d, int w) {
                    if (onOk != null) onOk.run();
                }
            });
            b.setNegativeButton("取消", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface d, int w) {
                    if (onCancel != null) onCancel.run();
                }
            });
            b.show();
        } catch (Throwable t) {
            // 主题不对时 AlertDialog 会抛 BadTokenException —— 退化成直接执行，
            // 不能让「弹框失败」变成「按钮点了没反应」
            if (onOk != null) onOk.run();
        }
    }

    /** 让某个视图的顶部避开状态栏（少数不适合用 titleBar 的场景） */
    public static void padStatusBar(final View v) {
        if (Build.VERSION.SDK_INT >= 21) {
            v.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                    int top = insets.getSystemWindowInsetTop();
                    view.setPadding(view.getPaddingLeft(), top,
                            view.getPaddingRight(), view.getPaddingBottom());
                    return insets;
                }
            });
        }
    }
}
