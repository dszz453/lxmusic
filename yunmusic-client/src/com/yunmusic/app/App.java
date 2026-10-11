package com.yunmusic.app;

import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Process;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 云音乐 - Application 入口
 *
 * 这里只干一件事：装一个全局未捕获异常处理器。
 *
 * 为什么要装：APK 一旦「装完点图标打不开」，从外面看就是一瞬间的事，
 * 没有 adb / 没有 logcat 的话根本不知道死在哪一行。装了这个之后，
 * 崩溃会被拦下来、堆栈落到文件、并直接拉起 CrashActivity 把堆栈摊在屏幕上，
 * 用户截个图就能定位 —— 把「盲修」变成「可诊断」。
 */
public class App extends Application {

    /** CrashActivity 用它区分「正常启动」和「崩溃后启动」 */
    public static final String EXTRA_CRASH = "com.yunmusic.app.extra.CRASH";

    private static final String PREFS = "yunmusic_crash_prefs";
    private static final String KEY_LAST_SCREEN_AT = "last_screen_at";
    private static final String KEY_SHOWN_HASH = "shown_hash";
    private static final String CRASH_FILE = "last_crash.txt";
    private static final long LOOP_GUARD_MS = 8000L;
    private static final int MAX_LOG_BYTES = 64 * 1024;

    @Override
    public void onCreate() {
        super.onCreate();
        installCrashHandler();
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable error) {
                boolean showed = false;
                try {
                    String text = buildReport(thread, error);
                    saveCrashLog(App.this, text);
                    showed = tryShowCrashScreen(App.this, text);
                } catch (Throwable ignored) {
                    // 崩溃处理器自身绝不能再抛，否则连现场都留不下
                }
                if (!showed && previous != null) {
                    // 没能拉起现场页（例如系统不让起 Activity），交回系统默认处理，
                    // 至少用户能看到「应用已停止运行」而不是静默消失
                    try {
                        previous.uncaughtException(thread, error);
                    } catch (Throwable ignored) {
                    }
                }
                Process.killProcess(Process.myPid());
                System.exit(10);
            }
        });
    }

    /** 组装一份人类可读的崩溃报告 */
    private static String buildReport(Thread thread, Throwable error) {
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        pw.println("云音乐 崩溃报告");
        pw.println("时间: " + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()));
        pw.println("线程: " + (thread == null ? "?" : thread.getName()));
        pw.println("包名: com.yunmusic.app");
        pw.println("版本: V2.8 (280)");
        pw.println("Android: " + android.os.Build.VERSION.RELEASE
                + " (API " + android.os.Build.VERSION.SDK_INT + ")");
        pw.println("机型: " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
        pw.println("--------------------------------------------");
        if (error != null) error.printStackTrace(pw);
        pw.flush();
        return sw.toString();
    }

    /**
     * 拉起崩溃现场页。
     *
     * 防死循环：如果 8 秒内已经拉过一次（说明现场页自己也崩了），就不再拉，
     * 直接让进程死掉，避免无限重启。
     */
    private static boolean tryShowCrashScreen(Context ctx, String text) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long last = sp.getLong(KEY_LAST_SCREEN_AT, 0L);
            long now = System.currentTimeMillis();
            if (now - last < LOOP_GUARD_MS) return false;
            sp.edit().putLong(KEY_LAST_SCREEN_AT, now).apply();

            Intent intent = new Intent(ctx, CrashActivity.class);
            intent.putExtra(EXTRA_CRASH, text);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TASK
                    | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
            ctx.startActivity(intent);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /* ------------------------- 崩溃日志读写 ------------------------- */

    public static void saveCrashLog(Context ctx, String text) {
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(new File(ctx.getFilesDir(), CRASH_FILE));
            fos.write(text.getBytes("UTF-8"));
            fos.flush();
        } catch (Throwable ignored) {
        } finally {
            try {
                if (fos != null) fos.close();
            } catch (Throwable ignored) {
            }
        }
    }

    /** 读取上次崩溃日志；没有则返回空串 */
    public static String readCrashLog(Context ctx) {
        InputStream is = null;
        try {
            File f = new File(ctx.getFilesDir(), CRASH_FILE);
            if (!f.exists() || f.length() == 0) return "";
            is = new java.io.FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            int total = 0;
            while ((n = is.read(buf)) > 0) {
                if (total >= MAX_LOG_BYTES) break;
                bos.write(buf, 0, n);
                total += n;
            }
            return bos.toString("UTF-8");
        } catch (Throwable t) {
            return "";
        } finally {
            try {
                if (is != null) is.close();
            } catch (Throwable ignored) {
            }
        }
    }

    public static void clearCrashLog(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), CRASH_FILE);
            if (f.exists()) f.delete();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 是否需要在本次启动时把上次崩溃现场摊给用户看。
     *
     * 每份崩溃日志只自动弹一次（用内容哈希去重），既保证用户一定能看到，
     * 又不会变成每次打开都弹的骚扰。
     */
    public static boolean shouldAutoShowCrash(Context ctx) {
        try {
            String log = readCrashLog(ctx);
            if (log == null || log.trim().isEmpty()) return false;
            int hash = log.hashCode();
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (sp.getInt(KEY_SHOWN_HASH, 0) == hash) return false;
            sp.edit().putInt(KEY_SHOWN_HASH, hash).apply();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
