package com.zyplnn.lxclient.core;

import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * 底层能力层：本地音频的发现与解码接口。
 *
 * ══════════════ 这一层对应网易云客户端的哪一块 ══════════════
 * 在网易云那边，这一层是 C/C++ 写的（音频解码、ffmpeg、音效、重采样），
 * 通过 JNI 被上层的 Java/Kotlin 调用；酷狗那边更极致 —— 蝰蛇音效、歌词渲染、
 * 信号处理全在 native，是它的核心卖点。
 *
 * 本工程**没有 NDK**：构建链路是 aapt2 → javac → d8（见 client/build-client.sh），
 * 连 Gradle 都没有，更没有 LLVM/NDK 工具链去编 .so。所以这一层的处理方式是：
 *
 *   1. **能用平台 API 做到的，就用平台 API 做到位**：
 *      本地音频发现走 MediaStore（系统已经建好的媒体库索引，比自己遍历文件系统快
 *      且不用申请全盘读取权限），音频元信息走 MediaMetadataRetriever
 *      （时长 / 比特率 / 采样率 / 声道，系统自带的 demuxer）。
 *      这些都是真正的「底层能力」，不是占位。
 *
 *   2. **native 部分预留出接口，但**不假装它存在**：
 *      {@link #nativeAvailable()} 会去尝试加载可选的解码库 liblxaudio.so；
 *      加载不到就返回 false，上层（本地音乐页）据此显示「解码引擎：系统内置」。
 *      绝不写一个「假装成功」的桩 —— 那会让「为什么没有音效」这类问题永远查不出来。
 *
 * 要真正接上 native 时的做法（留给以后）：
 *   在 client/ 下加 jni/ 与 CMake，产出 liblxaudio.so 放进 jniLibs，然后实现下面
 *   这几个 native 方法。**调用点已经写好了**，所以换成真实现时只需要改这一层，
 *   上层页面一行都不用动 —— 这正是分层的意义。
 */
public final class AudioEngine {

    private static final String TAG = "LXC/Audio";

    /** 可选的本地解码库名。没有它时整个 App 依然完整可用（走系统解码） */
    private static final String LIB = "lxaudio";

    /** 只尝试加载一次，结果缓存下来 —— loadLibrary 失败会抛异常，不能每次调用都试 */
    private static volatile Boolean libLoaded = null;

    /** 本地音频扫描的默认上限。设备里有几万首歌时，全量列出来只会让页面卡住 */
    public static final int SCAN_LIMIT = 2000;

    private AudioEngine() {
    }

    /* ══════════════════ native 解码接口（预留） ══════════════════ */

    /**
     * 是否加载到了可选的 native 解码库。
     *
     * @return true = 这套构建带了 liblxaudio.so（可以走 native 解码 / 音效）
     */
    public static boolean nativeAvailable() {
        Boolean cached = libLoaded;
        if (cached != null) return cached;
        synchronized (AudioEngine.class) {
            if (libLoaded != null) return libLoaded;
            boolean ok;
            try {
                System.loadLibrary(LIB);
                ok = true;
                Log.i(TAG, "已加载 native 解码库 lib" + LIB);
            } catch (Throwable t) {
                // 绝大多数构建都会走到这里（没编 .so）。降级到系统解码，
                // 不是错误，所以用 info 级别而不是 warn/error —— 免得日志里一片红。
                ok = false;
                Log.i(TAG, "没有 native 解码库 lib" + LIB + "，改用系统解码");
            }
            libLoaded = ok;
            return ok;
        }
    }

    /** 引擎信息，给诊断 / 关于页显示 */
    public static String engineInfo() {
        return nativeAvailable()
                ? "native（lib" + LIB + "）+ 系统解码"
                : "系统解码（无 native 库）";
    }

    /*
     * ↓↓↓ 以下三个方法只有在 nativeAvailable() 为真时才会被调用。
     * 声明成 native 不会导致类加载失败，但**一旦在没有实现时被调用**就会抛
     * UnsatisfiedLinkError —— 所以所有调用点都必须先过 nativeAvailable()。
     */

    /** 探测一个音频文件能否被 native 解码器打开（含容器格式与编码格式） */
    private static native boolean nativeCanDecode(String path);

    /** 用 native 解码器取时长（毫秒）。失败返回 -1 */
    private static native long nativeDurationMs(String path);

    /** 用 native 解码器取平均比特率（bps）。失败返回 -1 */
    private static native int nativeBitrate(String path);

    /**
     * 取时长：优先 native，退回系统 demuxer。
     *
     * 上层页面**不需要知道**用的是哪个 —— 这正是这一层存在的意义：
     * 以后接上 native 时，页面代码一行都不用改。
     *
     * @return 毫秒；取不到返回 0
     */
    public static long durationMs(Context ctx, Uri uri) {
        if (uri == null) return 0;
        if (nativeAvailable() && "file".equals(uri.getScheme())) {
            try {
                long ms = nativeDurationMs(uri.getPath());
                if (ms > 0) return ms;
            } catch (Throwable t) {
                Log.w(TAG, "native 取时长失败，回退系统: " + t.getMessage());
            }
        }
        return systemDurationMs(ctx, uri);
    }

    /** 系统 demuxer（MediaMetadataRetriever）取时长 */
    public static long systemDurationMs(Context ctx, Uri uri) {
        MediaMetadataRetriever r = null;
        try {
            r = new MediaMetadataRetriever();
            if (Build.VERSION.SDK_INT >= 14) r.setDataSource(ctx, uri);
            else r.setDataSource(uri.getPath());
            String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d == null) return 0;
            return Long.parseLong(d.trim());
        } catch (Throwable t) {
            return 0;
        } finally {
            close(r);
        }
    }

    /** 平均比特率（bps）。取不到返回 0。给「本地音乐」页显示用 */
    public static int bitrate(Context ctx, Uri uri) {
        MediaMetadataRetriever r = null;
        try {
            r = new MediaMetadataRetriever();
            r.setDataSource(ctx, uri);
            String b = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE);
            if (b == null) return 0;
            return Integer.parseInt(b.trim());
        } catch (Throwable t) {
            return 0;
        } finally {
            close(r);
        }
    }

    /** 采样率（Hz）。取不到返回 0 */
    public static int sampleRate(Context ctx, Uri uri) {
        MediaMetadataRetriever r = null;
        try {
            r = new MediaMetadataRetriever();
            r.setDataSource(ctx, uri);
            String s = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE);
            if (s == null) return 0;
            return Integer.parseInt(s.trim());
        } catch (Throwable t) {
            return 0;
        } finally {
            close(r);
        }
    }

    private static void close(MediaMetadataRetriever r) {
        if (r == null) return;
        try {
            r.release();
        } catch (Throwable ignore) {
        }
    }

    /* ══════════════════ 本地音频发现 ══════════════════ */

    /** 一首本地音频 */
    public static final class Track {
        public long id;
        public String title = "";
        public String artist = "";
        public String album = "";
        public long durationMs;
        public long sizeBytes;
        /** content:// 或 file:// 地址，直接交给系统播放器 / <audio> 用 */
        public String uri = "";
        /** 文件名（可能是「歌手 - 歌名.mp3」这种，标题字段为空时拿它兜底） */
        public String displayName = "";

        /** 展示用标题：库里没有标题字段时退回文件名（去掉扩展名） */
        public String showTitle() {
            if (title != null && !title.trim().isEmpty()) return title.trim();
            String n = displayName == null ? "" : displayName;
            int dot = n.lastIndexOf('.');
            if (dot > 0) n = n.substring(0, dot);
            return n.isEmpty() ? "未知曲目" : n;
        }

        public String showArtist() {
            String a = artist == null ? "" : artist.trim();
            if (!a.isEmpty() && !"<unknown>".equals(a)) return a;
            return "未知歌手";
        }
    }

    /**
     * 这个 App 现在有没有权限读设备音频。
     *
     * Android 13 起是 READ_MEDIA_AUDIO（细粒度，只读音频、不碰照片视频），
     * 之前是 READ_EXTERNAL_STORAGE。判据要跟着系统版本走 —— 在新系统上检查旧权限
     * 永远返回「没授权」，用户点「扫描」会一直失败而且想不通为什么。
     */
    public static boolean canReadAudio(Context ctx) {
        String perm = Build.VERSION.SDK_INT >= 33
                ? "android.permission.READ_MEDIA_AUDIO"
                : "android.permission.READ_EXTERNAL_STORAGE";
        try {
            return ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return true;
        }
    }

    /** 该请求哪个权限（与 canReadAudio 的判据必须同源，否则申请了也白申请） */
    public static String audioPermission() {
        return Build.VERSION.SDK_INT >= 33
                ? "android.permission.READ_MEDIA_AUDIO"
                : "android.permission.READ_EXTERNAL_STORAGE";
    }

    /**
     * 扫描设备上的本地音频。
     *
     * 走 MediaStore 而不是自己遍历目录：系统已经把媒体库索引建好了（含标题 / 歌手 /
     * 时长 / 专辑），遍历文件系统要全盘读取权限、慢几个数量级，还得自己解析 ID3。
     *
     * @return 曲目列表（按标题排序）；没权限或查询失败时返回空列表
     */
    public static List<Track> scanLocal(Context ctx, int limit) {
        List<Track> out = new ArrayList<Track>();
        if (!canReadAudio(ctx)) return out;
        Cursor c = null;
        try {
            String[] proj = {
                    MediaStore.Audio.Media._ID,
                    MediaStore.Audio.Media.TITLE,
                    MediaStore.Audio.Media.ARTIST,
                    MediaStore.Audio.Media.ALBUM,
                    MediaStore.Audio.Media.DURATION,
                    MediaStore.Audio.Media.SIZE,
                    MediaStore.Audio.Media.DISPLAY_NAME,
            };
            // IS_MUSIC != 0 过滤掉铃声、通知音、录音 —— 不加这个，
            // 用户的「本地音乐」里会混进一堆系统提示音
            c = ctx.getContentResolver().query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    proj,
                    MediaStore.Audio.Media.IS_MUSIC + " != 0",
                    null,
                    MediaStore.Audio.Media.TITLE + " ASC");
            if (c == null) return out;
            int cap = limit > 0 ? limit : SCAN_LIMIT;
            while (c.moveToNext() && out.size() < cap) {
                Track t = new Track();
                t.id = c.getLong(0);
                t.title = safe(c.getString(1));
                t.artist = safe(c.getString(2));
                t.album = safe(c.getString(3));
                t.durationMs = c.getLong(4);
                t.sizeBytes = c.getLong(5);
                t.displayName = safe(c.getString(6));
                t.uri = Uri.withAppendedPath(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                        String.valueOf(t.id)).toString();
                // 时长为 0 的多半是扫描时没能解析的损坏文件，放进来点了也放不出声
                if (t.durationMs > 0) out.add(t);
            }
        } catch (Throwable t) {
            Log.w(TAG, "本地音频扫描失败: " + t.getMessage());
        } finally {
            try {
                if (c != null) c.close();
            } catch (Throwable ignore) {
            }
        }
        return out;
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }
}
