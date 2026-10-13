package com.yunmusic.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.LruCache;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 云音乐 - 原生与前端交互桥梁
 */
public class YunBridge {
    private final MainActivity activity;
    private final ServerConfig config;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public YunBridge(MainActivity activity, ServerConfig config) {
        this.activity = activity;
        this.config = config;
    }

    /** 读取当前完整的双服务器配置 */
    @JavascriptInterface
    public String getServerConfig() {
        return config.toJson().toString();
    }

    /**
     * 一键快速切换线路：0 为线路一 (CF)，1 为线路二 (Docker)
     *
     * 这里**故意不弹 Toast**。切线提示统一由页面侧发一次：
     * 早先原生和前端各弹一个，用户点一次会连蹦两条；
     * 而现在页面侧只在「线路真的变了」时才提示，页面加载时的配置同步是静默的。
     */
    @JavascriptInterface
    public String switchLine(int lineIndex) {
        config.setActiveLine(lineIndex);
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                activity.updateTopBarLineStatus();
            }
        });
        return config.toJson().toString();
    }

    /** 一次性保存双服务器配置（提示同样交给页面侧统一发） */
    @JavascriptInterface
    public String saveDualConfig(String url1, String user1, String pass1,
                                 String url2, String user2, String pass2, int activeIndex) {
        config.saveDualServers(url1, user1, pass1, url2, user2, pass2, activeIndex);
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                activity.updateTopBarLineStatus();
            }
        });
        return config.toJson().toString();
    }

    /** 弹出原生提示 */
    @JavascriptInterface
    public void showToast(final String msg) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 更新系统媒体通知栏播放状态（旧签名：只有歌名/歌手/播放中） */
    @JavascriptInterface
    public void updateMedia(String title, String artist, boolean isPlaying) {
        updateMedia(title, artist, isPlaying, "", 0, 0);
    }

    /**
     * 更新锁屏 / 通知栏 / 控制中心的媒体状态。
     *
     * 为什么要一次传这么多：Android 11+ 的锁屏媒体卡片与控制中心媒体控件，
     * 内容是照着 **MediaSession 的 Metadata + PlaybackState** 渲染的，
     * 不是照着我们那条通知渲染的。只给歌名和歌手的话，锁屏上就没有封面、
     * 没有时长、拖动条也是死的。所以封面、时长、进度都得一起交过去。
     *
     * @param cover    封面地址（http/https，可为空）
     * @param duration 总时长（毫秒，未知给 0）
     * @param position 当前进度（毫秒，未知给 0）
     */
    @JavascriptInterface
    public void updateMedia(String title, String artist, boolean isPlaying,
                            String cover, long duration, long position) {
        // Android 13+ 通知默认是关的，没有运行时授权，通知发出去也看不见。
        // 播放真正开始时才申请，比一进 App 就弹权限框体验好。
        try {
            activity.ensureNotificationPermission();
        } catch (Throwable ignored) {
        }
        MusicService.updateMediaState(activity, title, artist, isPlaying, cover, duration, position);
    }

    /** 原生层高性能 HTTP 代理请求（彻底绕过 WebView 的 CORS 限制与混合内容拦截） */
    @JavascriptInterface
    public void httpFetch(final String reqId, final String urlStr, final String method,
                          final String headersJson, final String bodyStr) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL u = new URL(urlStr);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setRequestMethod(method != null ? method.toUpperCase() : "GET");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);

                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject headers = new JSONObject(headersJson);
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            conn.setRequestProperty(k, headers.optString(k));
                        }
                    }

                    if (bodyStr != null && !bodyStr.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                        conn.setDoOutput(true);
                        OutputStream os = conn.getOutputStream();
                        os.write(bodyStr.getBytes("UTF-8"));
                        os.flush();
                        os.close();
                    }

                    int code = conn.getResponseCode();
                    InputStream is = code >= 200 && code < 400 ? conn.getInputStream() : conn.getErrorStream();
                    String responseBody = "";
                    if (is != null) {
                        BufferedReader br = new BufferedReader(new InputStreamReader(is, "UTF-8"));
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line).append("\n");
                        br.close();
                        responseBody = sb.toString();
                    }

                    final String resText = responseBody;
                    final int statusCode = code;
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            activity.notifyHttpSuccess(reqId, statusCode, resText);
                        }
                    });
                } catch (final Exception e) {
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            activity.notifyHttpError(reqId, e.getMessage() != null ? e.getMessage() : "网络请求失败");
                        }
                    });
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    /* ============================ 歌曲下载 ============================ */

    /** 正在下载的任务：reqId -> 取消标记 */
    private final ConcurrentHashMap<String, Boolean> cancelFlags = new ConcurrentHashMap<String, Boolean>();

    /**
     * 下载一首歌到本机。
     *
     * 为什么要走原生：页面在 file:// 源下既拿不到二进制响应（httpFetch 只回文本），
     * 也没法把文件写进相册/音乐库。这里用 HttpURLConnection 拉流，
     * Android 10+ 通过 MediaStore 落进「音乐/云音乐」，无需任何存储权限；
     * 老系统退到应用私有外部目录（同样不需要权限），保证功能不因权限弹窗而断。
     *
     * 进度通过 window.onNativeDownload({reqId,state,percent,path,bytes,total}) 回传，
     * state ∈ running | progress | done | error | cancelled。
     */
    @JavascriptInterface
    public void downloadSong(final String reqId, final String urlStr, final String fileName) {
        if (reqId == null || urlStr == null || urlStr.isEmpty()) return;
        cancelFlags.remove(reqId);
        new Thread(new Runnable() {
            @Override
            public void run() {
                doDownload(reqId, urlStr, fileName);
            }
        }).start();
    }

    /** 取消一个下载任务（下一次读取分片时生效） */
    @JavascriptInterface
    public void cancelDownload(final String reqId) {
        if (reqId != null) cancelFlags.put(reqId, Boolean.TRUE);
    }

    private boolean isCancelled(String reqId) {
        return Boolean.TRUE.equals(cancelFlags.get(reqId));
    }

    private void doDownload(String reqId, String urlStr, String fileName) {
        String name = (fileName == null || fileName.trim().isEmpty())
                ? ("云音乐_" + System.currentTimeMillis() + ".mp3")
                : fileName.trim().replace('/', '_').replace('\\', '_');

        HttpURLConnection conn = null;
        OutputStream os = null;
        InputStream is = null;
        Uri mediaUri = null;
        File plainFile = null;

        notifyDownload(reqId, "running", 0, null, null, 0, -1);
        try {
            URL u = new URL(urlStr);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) YunMusic/2.2");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
            // 服务端可能不给 Content-Length（分片/代理），-1 表示总长未知，进度按「已下载字节」显示
            long total = conn.getContentLength();

            ContentResolver cr = activity.getContentResolver();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Audio.Media.MIME_TYPE, mimeOf(name));
                v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/云音乐");
                v.put(MediaStore.Audio.Media.IS_MUSIC, 1);
                mediaUri = cr.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
                if (mediaUri == null) throw new IOException("无法创建媒体条目");
                os = cr.openOutputStream(mediaUri);
            } else {
                File dir = new File(activity.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "云音乐");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
                plainFile = new File(dir, name);
                os = new FileOutputStream(plainFile);
            }
            if (os == null) throw new IOException("无法打开输出流");

            is = conn.getInputStream();
            byte[] buf = new byte[64 * 1024];
            long done = 0L;
            long lastReport = 0L;
            int n;
            while ((n = is.read(buf)) > 0) {
                if (isCancelled(reqId)) throw new IOException("__cancelled__");
                os.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastReport > 200L) {
                    lastReport = now;
                    int pct = total > 0 ? (int) (done * 100L / total) : -1;
                    notifyDownload(reqId, "progress", pct, null, null, done, total);
                }
            }
            os.flush();

            String path = mediaUri != null ? realPathOf(mediaUri) : plainFile.getAbsolutePath();
            if (path == null || path.isEmpty()) {
                path = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)
                        + "/云音乐/" + name;
            }
            cancelFlags.remove(reqId);
            notifyDownload(reqId, "done", 100, path, null, done, total);
        } catch (Throwable e) {
            boolean cancelled = "__cancelled__".equals(e.getMessage());
            // 半截文件不能留在媒体库里，否则用户在音乐 App 里会看到一堆坏文件
            if (mediaUri != null) {
                try {
                    activity.getContentResolver().delete(mediaUri, null, null);
                } catch (Throwable ignored) {
                }
            }
            if (plainFile != null && plainFile.exists()) {
                try {
                    plainFile.delete();
                } catch (Throwable ignored) {
                }
            }
            if (cancelled) {
                notifyDownload(reqId, "cancelled", 0, null, null, 0, -1);
            } else {
                String msg = e.getMessage() == null ? "下载失败" : e.getMessage();
                notifyDownload(reqId, "error", 0, null, msg, 0, -1);
            }
        } finally {
            cancelFlags.remove(reqId);
            try {
                if (is != null) is.close();
            } catch (Throwable ignored) {
            }
            try {
                if (os != null) os.close();
            } catch (Throwable ignored) {
            }
            if (conn != null) conn.disconnect();
        }
    }

    /** MediaStore 的 content:// 换算回真实文件路径，供页面用 file:// 直接播放 */
    private String realPathOf(Uri uri) {
        Cursor c = null;
        try {
            c = activity.getContentResolver().query(uri, new String[]{MediaStore.MediaColumns.DATA}, null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Throwable ignored) {
        } finally {
            try {
                if (c != null) c.close();
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    private static String mimeOf(String fileName) {
        String lower = fileName == null ? "" : fileName.toLowerCase();
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
        if (lower.endsWith(".ape")) return "audio/ape";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".ogg")) return "audio/ogg";
        return "audio/mpeg";
    }

    private void notifyDownload(final String reqId, final String state, final int percent,
                                final String path, final String error,
                                final long bytes, final long total) {
        try {
            JSONObject o = new JSONObject();
            o.put("reqId", reqId);
            o.put("state", state);
            o.put("percent", percent);
            if (path != null) o.put("path", path);
            if (error != null) o.put("error", error);
            o.put("bytes", bytes);
            o.put("total", total);
            activity.runJs("if(window.onNativeDownload) { window.onNativeDownload(" + o.toString() + "); }");
        } catch (Throwable ignored) {
        }
    }

    /* ============================ 音频字节缓存 ============================ */

    /**
     * 音频**字节**缓存（缓存的是歌本身，不是解析出来的地址）。
     *
     * ── 为什么必须落在原生 ────────────────────────────────────────
     * 页面跑在 file:// 源下：`fetch()` 被同源策略拦，`httpFetch` 走的是
     * BufferedReader + InputStreamReader，音频流会被当文本读成乱码。
     * 只有 Java 侧的 HttpURLConnection 能把字节老老实实写进磁盘，
     * 页面播放时拿一个绝对路径做 `audio.src = file:///...` 直接用。
     *
     * ── 为什么不维护索引文件 ──────────────────────────────────────
     * 索引与实际文件一旦不同步（下载中断、用户清了应用数据），就会出现
     * 「索引说有、文件没有」的**假命中**：点歌直接报错，还看不出为什么。
     * 直接扫目录反而自愈，几百个文件也就几毫秒。
     * 文件名 = md5(键) + 扩展名，键由页面给（平台_歌曲id_音质），
     * 哈希一下是为了让 id 里的 `/` `?` 之类字符不至于把路径搞坏。
     *
     * ── 淘汰口径 ──────────────────────────────────────────────────
     * 命中时把 mtime 刷新成「现在」，于是 mtime 天然就是「最近使用时间」，
     * 超上限时按 mtime 从旧到新删。不需要额外的 LRU 结构。
     */
    private static File audioCacheDir;

    /** 单文件上限：野地址（或服务端给了个巨大的流）别把用户磁盘写满 */
    private static final long AUDIO_MAX_FILE_BYTES = 128L * 1024 * 1024;

    private synchronized File audioCacheDir() {
        if (audioCacheDir == null) {
            File d = new File(activity.getFilesDir(), "audiocache");
            if (!d.exists()) d.mkdirs();
            audioCacheDir = d;
        }
        return audioCacheDir;
    }

    /**
     * 查这首有没有缓存。命中回本地绝对路径，没有回 null。
     *
     * 同步返回 —— 页面在 loadCurrent() 里要立刻决定「放本地还是去解析」，
     * 走异步回调反而会把「秒开」这个唯一的价值给等没了。
     */
    @JavascriptInterface
    public String audioCacheGet(final String key) {
        if (key == null || key.isEmpty()) return null;
        try {
            final String h = md5Hex(key);
            File[] files = audioCacheDir().listFiles();
            if (files == null) return null;
            for (File f : files) {
                if (!f.isFile()) continue;
                if (!f.getName().startsWith(h + ".")) continue;
                if (f.getName().endsWith(".part")) continue;   // 半截文件不算命中
                if (f.length() <= 0) continue;
                f.setLastModified(System.currentTimeMillis()); // 兼作 LRU 的「最近使用」
                return f.getAbsolutePath();
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** 让原生把这歌下下来存进缓存（异步，不阻塞播放；失败静默，不影响当前播放） */
    @JavascriptInterface
    public void audioCachePut(final String key, final String urlStr, final long limitBytes) {
        if (key == null || key.isEmpty() || urlStr == null || urlStr.isEmpty()) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                doAudioCachePut(key, urlStr, limitBytes);
            }
        }).start();
    }

    private void doAudioCachePut(String key, String urlStr, long limitBytes) {
        File part = null;
        HttpURLConnection conn = null;
        InputStream is = null;
        OutputStream os = null;
        try {
            if (audioCacheGet(key) != null) return;      // 已经有了（可能是别的扩展名）
            final String h = md5Hex(key);
            part = new File(audioCacheDir(), h + ".part");

            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) YunMusic/2.16");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return;

            String ctype = conn.getContentType();
            if (ctype != null) {
                String c = ctype.toLowerCase(java.util.Locale.US);
                // 上游出错时常回一个 HTML 错误页 / JSON；存下来只会变成
                // 「明明缓存了却播不出来」这种最难查的故障
                if (c.contains("text/html") || c.contains("application/json") || c.contains("text/plain")) return;
            }
            long total = conn.getContentLength();
            if (total > AUDIO_MAX_FILE_BYTES) return;

            is = conn.getInputStream();
            os = new FileOutputStream(part);
            byte[] buf = new byte[64 * 1024];
            long done = 0L;
            int n;
            while ((n = is.read(buf)) > 0) {
                done += n;
                if (done > AUDIO_MAX_FILE_BYTES) return;  // 没给 Content-Length 的野地址
                os.write(buf, 0, n);
            }
            os.flush();
            if (done < 1024) return;                      // 太小，多半是错误页
            closeQuietly(os);
            os = null;
            closeQuietly(is);
            is = null;

            File dst = new File(audioCacheDir(), h + audioExtOf(urlStr, ctype));
            if (!part.renameTo(dst)) {                    // 跨挂载点等情况下 rename 会失败
                writeAllBytes(dst, readAllBytes(part));
                part.delete();
            }
            part = null;
            audioCacheTrimSync(limitBytes);
        } catch (Throwable ignored) {
        } finally {
            closeQuietly(is);
            closeQuietly(os);
            if (part != null && part.exists()) part.delete();
            if (conn != null) conn.disconnect();
        }
    }

    /** 按上限裁剪缓存（同步；内部也会顺手清掉残留的 .part） */
    private void audioCacheTrimSync(long limitBytes) {
        try {
            File dir = audioCacheDir();
            File[] files = dir.listFiles();
            if (files == null) return;
            java.util.ArrayList<File> list = new java.util.ArrayList<File>();
            long total = 0L;
            for (File f : files) {
                if (!f.isFile()) continue;
                if (f.getName().endsWith(".part")) {
                    f.delete();       // 下载中断留下的半截文件，一律不留
                    continue;
                }
                list.add(f);
                total += f.length();
            }
            if (limitBytes <= 0 || total <= limitBytes) return;
            java.util.Collections.sort(list, new java.util.Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(a.lastModified(), b.lastModified());
                }
            });
            for (File f : list) {
                if (total <= limitBytes) break;
                long len = f.length();
                if (f.delete()) total -= len;
            }
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public void audioCacheTrim(final long limitBytes) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                audioCacheTrimSync(limitBytes);
            }
        }).start();
    }

    /** 统计当前占用，回 window.onNativeAudioCacheStat({bytes}) */
    @JavascriptInterface
    public void audioCacheStat() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                notifyAudioCacheStat(audioCacheBytesSync());
            }
        }).start();
    }

    private long audioCacheBytesSync() {
        long total = 0L;
        try {
            File[] files = audioCacheDir().listFiles();
            if (files == null) return 0L;
            for (File f : files) {
                if (f.isFile() && !f.getName().endsWith(".part")) total += f.length();
            }
        } catch (Throwable ignored) {
        }
        return total;
    }

    /** 清空缓存，回 window.onNativeAudioCacheCleared({bytes}) —— bytes 是释放掉的量 */
    @JavascriptInterface
    public void audioCacheClear() {
        new Thread(new Runnable() {
            @Override
            public void run() {
                long freed = 0L;
                try {
                    File[] files = audioCacheDir().listFiles();
                    if (files != null) {
                        for (File f : files) {
                            if (!f.isFile()) continue;
                            long len = f.length();
                            if (f.delete()) freed += len;
                        }
                    }
                } catch (Throwable ignored) {
                }
                notifyAudioCacheCleared(freed);
            }
        }).start();
    }

    private void notifyAudioCacheStat(final long bytes) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                activity.runJs("if(window.onNativeAudioCacheStat) { window.onNativeAudioCacheStat({bytes:"
                        + bytes + "}); }");
            }
        });
    }

    private void notifyAudioCacheCleared(final long bytes) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                activity.runJs("if(window.onNativeAudioCacheCleared) { window.onNativeAudioCacheCleared({bytes:"
                        + bytes + "}); }");
            }
        });
    }

    /** 从地址（优先）或响应头里猜一个音频扩展名 —— 播放器认扩展名更省事 */
    private static String audioExtOf(String url, String contentType) {
        String s = url == null ? "" : url.toLowerCase(java.util.Locale.US);
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        String[] exts = {".flac", ".m4a", ".mp4", ".ape", ".wav", ".aac", ".ogg", ".mp3"};
        for (String e : exts) {
            if (s.endsWith(e)) return e;
        }
        if (contentType != null) {
            String c = contentType.toLowerCase(java.util.Locale.US);
            if (c.contains("flac")) return ".flac";
            if (c.contains("mp4") || c.contains("m4a")) return ".m4a";
            if (c.contains("ogg")) return ".ogg";
            if (c.contains("wav")) return ".wav";
            if (c.contains("aac")) return ".aac";
        }
        return ".mp3";
    }

    /* ============================ 本地插件导入 ============================ */

    /**
     * 让用户从手机里挑一个插件脚本（.js）。
     *
     * 为什么不让页面用 `<input type=file>` 自己读：壳里跑的是 file:// 源，
     * 这个入口在部分 WebView 上唤不起文件选择器；而且插件脚本动辄几百 KB，
     * 走 JS 桥来回传长字符串有被截断的风险。交给原生：选完直接读成文本，
     * 用 window.onNativePluginFile({name, content}) 一次回给页面。
     */
    @JavascriptInterface
    public void pickPluginFile() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.startPluginFilePicker();
                } catch (Throwable t) {
                    String msg = t.getMessage();
                    notifyPluginFile(null, null, (msg == null || msg.isEmpty()) ? "无法打开文件选择器" : msg);
                }
            }
        });
    }

    /** 由 MainActivity 在选完文件（或读取失败）后回调 */
    public void onPluginFilePicked(String name, String content, String error) {
        notifyPluginFile(name, content, error);
    }

    private void notifyPluginFile(String name, String content, String error) {
        try {
            JSONObject o = new JSONObject();
            if (name != null) o.put("name", name);
            if (error != null) o.put("error", error);
            else o.put("content", content == null ? "" : content);
            /*
             * U+2028 / U+2029 在 JSON 里是合法字符，但在 JS 源码的字符串字面量里
             * 是**换行符** —— 直接把 JSON 塞进 evaluateJavascript 会被解析成换行，
             * 整条脚本语法错误、静默失效。org.json 不转义这两个字符，只能自己补。
             * 转义后仍是合法 JSON（\u2028 是标准转义），页面侧读到的内容一模一样。
             */
            String json = o.toString()
                    .replace("\u2028", "\\u2028")
                    .replace("\u2029", "\\u2029");
            activity.runJs("if(window.onNativePluginFile) { window.onNativePluginFile(" + json + "); }");
        } catch (Throwable ignored) {
        }
    }

    /* ============================ 原生外壳显隐 ============================ */

    /**
     * 全屏播放器打开/收起时，让原生顶栏跟着让位。
     *
     * 原生顶栏是 WebView 的兄弟节点，网页里的 z-index 再高也盖不住它；
     * 不隐藏的话，播放器顶部的「收起箭头 + 音质按钮」只能排在红色顶栏下面，
     * 看着就是「位置太靠下」。隐藏后 WebView 顶到屏幕最上沿，
     * 状态栏高度由原生写进 `--safe-top`，播放器自己让开。
     */
    @JavascriptInterface
    public void setChromeHidden(final boolean hidden) {
        try {
            activity.setTopBarVisible(!hidden);
        } catch (Throwable ignored) {
        }
    }

    /* ============================ 封面图缓存 ============================ */

    /**
     * 封面图缓存。
     *
     * 为什么必须放原生：页面跑在 file:// 源下，WebView 对跨源图片不保证复用 HTTP 缓存，
     * 上游封面接口通常也不带 Cache-Control，于是每次回到首页都要把十几个封面重新拉一遍，
     * 用户看到的就是「榜单封面好几秒不显示」。
     *
     * 这里做两级缓存：
     *   内存 —— 同一进程内第二次用到直接命中，零延迟；
     *   磁盘 —— files/imgcache，跨进程、重启后也命中，不再走网络。
     * 取到字节后编码成 data:URL 回给页面，页面直接赋给 img.src / background-image，
     * 完全绕开 WebView 的图片网络栈，「重新加载」这件事就不存在了。
     */
    private static final int IMG_MEM_MAX = 8 * 1024 * 1024;    // 内存缓存上限 8MB
    private static final long IMG_MAX_BYTES = 6L * 1024 * 1024; // 单张上限，防意外大图把内存撑爆

    private static LruCache<String, String> imgMem;
    private static File imgCacheDir;

    /**
     * 取一张封面，结果通过 window.onNativeImage({reqId,url,dataUrl,error}) 回传。
     * 只接受绝对 http(s) 地址：相对路径的图（如果有）交给 WebView 自己处理，
     * 免得在原生侧还要补 token、补 base，反而引入新的失败面。
     */
    @JavascriptInterface
    public void fetchImage(final String reqId, final String urlStr) {
        if (reqId == null || urlStr == null) return;
        final String u = urlStr.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            notifyImage(reqId, u, null, "仅支持绝对地址");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                doFetchImage(reqId, u);
            }
        }).start();
    }

    private void doFetchImage(String reqId, String urlStr) {
        try {
            String key = md5Hex(urlStr);

            String mem = imgMemGet(key);
            if (mem != null) {
                notifyImage(reqId, urlStr, mem, null);
                return;
            }

            File f = new File(imgCacheDir(), key);
            if (f.exists() && f.length() > 0 && f.length() <= IMG_MAX_BYTES) {
                String dataUrl = toDataUrl(readAllBytes(f), guessImageMime(urlStr));
                if (dataUrl != null) {
                    imgMemPut(key, dataUrl);
                    notifyImage(reqId, urlStr, dataUrl, null);
                    return;
                }
            }

            byte[] bytes = httpGetBytes(urlStr);
            if (bytes == null || bytes.length == 0) {
                notifyImage(reqId, urlStr, null, "空响应");
                return;
            }
            if (bytes.length > IMG_MAX_BYTES) {
                notifyImage(reqId, urlStr, null, "图片过大");
                return;
            }
            writeAllBytes(f, bytes);
            String dataUrl = toDataUrl(bytes, guessImageMime(urlStr));
            if (dataUrl == null) {
                notifyImage(reqId, urlStr, null, "编码失败");
                return;
            }
            imgMemPut(key, dataUrl);
            notifyImage(reqId, urlStr, dataUrl, null);
        } catch (Throwable t) {
            String msg = t.getMessage();
            notifyImage(reqId, urlStr, null, (msg == null || msg.isEmpty()) ? "取图失败" : msg);
        }
    }

    private synchronized File imgCacheDir() {
        if (imgCacheDir == null) {
            File d = new File(activity.getFilesDir(), "imgcache");
            if (!d.exists()) d.mkdirs();
            imgCacheDir = d;
        }
        return imgCacheDir;
    }

    private static synchronized String imgMemGet(String key) {
        return imgMem == null ? null : imgMem.get(key);
    }

    private static synchronized void imgMemPut(String key, String value) {
        if (imgMem == null) {
            imgMem = new LruCache<String, String>(IMG_MEM_MAX) {
                @Override
                protected int sizeOf(String k, String v) {
                    return v == null ? 0 : v.length();
                }
            };
        }
        imgMem.put(key, value);
    }

    private byte[] httpGetBytes(String urlStr) throws IOException {
        HttpURLConnection conn = null;
        InputStream is = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android) YunMusic/2.16");
            // 部分图床看 Referer，缺了会返回 403；这里补上自身 origin 就够了
            try {
                URL u = new URL(urlStr);
                conn.setRequestProperty("Referer", u.getProtocol() + "://" + u.getHost() + "/");
            } catch (Throwable ignore) { }
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            is = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            long total = 0;
            while ((n = is.read(buf)) > 0) {
                total += n;
                if (total > IMG_MAX_BYTES) return null;   // 超限直接放弃
                bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        } finally {
            closeQuietly(is);
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAllBytes(File f) {
        InputStream is = null;
        try {
            is = new java.io.FileInputStream(f);
            return readAllBytes(is);
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(is);
        }
    }

    private static byte[] readAllBytes(InputStream is) {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    private static void writeAllBytes(File f, byte[] bytes) {
        FileOutputStream os = null;
        try {
            os = new FileOutputStream(f);
            os.write(bytes);
            os.flush();
        } catch (Throwable ignore) {
        } finally {
            closeQuietly(os);
        }
    }

    private static String toDataUrl(byte[] bytes, String mime) {
        if (bytes == null || bytes.length == 0) return null;
        try {
            return "data:" + mime + ";base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String guessImageMime(String url) {
        String s = url == null ? "" : url.toLowerCase(java.util.Locale.US);
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        if (s.endsWith(".png")) return "image/png";
        if (s.endsWith(".webp")) return "image/webp";
        if (s.endsWith(".gif")) return "image/gif";
        return "image/jpeg";
    }

    /**
     * 取一张封面的 Bitmap —— 给锁屏 / 控制中心的媒体卡片用。
     *
     * 为什么不能直接把 URL 交给 MediaSession：MediaMetadata 的
     * METADATA_KEY_ALBUM_ART 只认 Bitmap，或者一个**本机**的 content/file URI；
     * 给 http 地址系统不会自己去下。所以必须在这里先落成 Bitmap。
     *
     * 复用页面那套两级缓存（files/imgcache/<md5>），命中就直接解码，
     * 页面刚显示过的封面这里必然是命中的，不会多打一次网络。
     * 解码时按最长边 512 采样 —— 通知栏/锁屏最多也就显示这么大，
     * 原图动辄 1000+，不采样既费内存又可能触发 TransactionTooLargeException。
     */
    public static Bitmap coverBitmap(Context ctx, String url) {
        if (ctx == null || url == null) return null;
        final String u = url.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) return null;
        try {
            String key = md5Hex(u);
            File dir = new File(ctx.getFilesDir(), "imgcache");
            File f = new File(dir, key);
            if (!f.exists() || f.length() <= 0 || f.length() > IMG_MAX_BYTES) {
                // 缓存里没有（页面还没显示过这张封面）就自己下一次
                if (!dir.exists()) dir.mkdirs();
                byte[] bytes = httpGetBytesStatic(u);
                if (bytes == null || bytes.length == 0 || bytes.length > IMG_MAX_BYTES) return null;
                writeAllBytes(f, bytes);
            }
            return decodeSampled(f.getAbsolutePath(), 512);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Bitmap decodeSampled(String path, int maxSide) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, o);
            int w = o.outWidth, h = o.outHeight;
            if (w <= 0 || h <= 0) return null;
            int sample = 1;
            while (Math.max(w, h) / sample > maxSide * 2) sample *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            o2.inPreferredConfig = Bitmap.Config.RGB_565; // 锁屏封面不需要透明度，省一半内存
            return BitmapFactory.decodeFile(path, o2);
        } catch (Throwable t) {
            return null;
        }
    }

    /** httpGetBytes 的静态版本：MusicService 拿封面时没有 YunBridge 实例可用 */
    private static byte[] httpGetBytesStatic(String urlStr) {
        HttpURLConnection conn = null;
        InputStream is = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) YunMusic");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            is = conn.getInputStream();
            return readAllBytes(is);
        } catch (Throwable t) {
            return null;
        } finally {
            closeQuietly(is);
            if (conn != null) {
                try { conn.disconnect(); } catch (Throwable ignored) { }
            }
        }
    }

    private static String md5Hex(String s) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return "k" + Integer.toHexString(s.hashCode());
        }
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c != null) {
            try { c.close(); } catch (Throwable ignore) { }
        }
    }

    private void notifyImage(final String reqId, final String url, final String dataUrl, final String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("reqId", reqId);
            o.put("url", url);
            if (dataUrl != null) o.put("dataUrl", dataUrl);
            if (error != null) o.put("error", error);
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    activity.runJs("if(window.onNativeImage) { window.onNativeImage(" + o.toString() + "); }");
                }
            });
        } catch (Throwable ignored) {
        }
    }
}
