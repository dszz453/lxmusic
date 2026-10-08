package com.zyplnn.lxclient;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.AudioAttributes;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.view.KeyEvent;

/**
 * 播放期前台服务 = 媒体会话宿主。
 *
 * 它干三件事，缺一不可：
 *
 * 1) **给系统一个 MediaSession**。
 *    有了它，通知栏的媒体卡片、锁屏与息屏显示、控制中心的播放控件、蓝牙耳机与车机的
 *    上一首/下一首/暂停键，才会认这个 App。页面里那份 W3C navigator.mediaSession 在
 *    WebView 里根本不存在，所以这件事只能由原生做 —— 这也是「壳」和「客户端」的分界。
 *
 * 2) **抬住进程优先级**。网页在后台时 WebView 所在进程随时会被按内存压力回收，
 *    表现就是「切出去一会儿回来，音乐停了」。前台服务把优先级提到「正在播放」这一档，
 *    再配一个 PARTIAL_WAKE_LOCK，息屏后 CPU 也不会睡着。
 *
 * 3) **单向渲染**。曲目、进度、播放态全部由页面推上来（MediaBridge），这里只负责
 *    画成系统认识的样子；用户按了按键再反向送回页面。**这里不放任何播放逻辑**，
 *    免得出现两个真相源。也因此没有请求音频焦点：音频是 WebView 里的 <audio> 在放，
 *    Chromium 自己会申请并处理焦点（来电自动暂停、结束后恢复），原生再插一手反而会
 *    把 WebView 的焦点挤掉、把正在播的音频顶停。
 *
 * 生命周期：由页面侧「我在播」触发（MediaBridge.ensureService）。暂停后不立刻退出 ——
 * 否则通知栏里的播放键会跟着消失，用户没法在系统里恢复播放。留一个宽限期，超时才收摊。
 */
public class PlaybackService extends Service implements MediaBridge.Listener {

    private static final String TAG = "LXB/Play";

    /** 页面侧状态同步（每次上报都会打这条） */
    public static final String ACTION_SYNC = "com.zyplnn.lxclient.SYNC";
    /** 通知按钮 */
    public static final String ACTION_PREV = "com.zyplnn.lxclient.PREV";
    public static final String ACTION_TOGGLE = "com.zyplnn.lxclient.TOGGLE";
    public static final String ACTION_NEXT = "com.zyplnn.lxclient.NEXT";
    /** 划掉通知 / 明确停止 */
    public static final String ACTION_STOP = "com.zyplnn.lxclient.STOP";

    private static final String CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 1001;

    /** 诊断面板要查这个通道的开关状态，所以不是私有的 */
    public static String channelId() {
        return CHANNEL_ID;
    }

    /** 暂停后仍保留通知与服务多久 —— 留足「切出去干点别的再回来接着听」的时间 */
    private static final long PAUSED_LINGER_MS = 5 * 60 * 1000L;
    /** 纯位置变化时的通知重绘间隔。状态变化不受这个限制 */
    private static final long NOTIFY_THROTTLE_MS = 2000L;

    private MediaSession session;
    private PowerManager.WakeLock wake;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean foreground;
    /** 上一份通知的关键字段指纹，用来判断「这次值得重绘吗」 */
    private String lastNotifyKey = "";
    private long lastNotifyAt;

    private final Runnable lingerStop = new Runnable() {
        @Override
        public void run() {
            if (!MediaBridge.isPlaying()) {
                Log.d(TAG, "暂停超过宽限期，收摊");
                stopSession();
            }
        }
    };

    /**
     * 起来之后一直没曲目就自己收摊。
     * 占位通知是为了守住 startForeground 的 5 秒期限而发的，不该常驻 ——
     * 用户只是切了个页面、还没点歌，通知栏不该挂着一条点不动的「正在准备播放」。
     */
    private final Runnable emptyStop = new Runnable() {
        @Override
        public void run() {
            if (!MediaBridge.getState().hasTrack) {
                Log.i(TAG, "启动后一直没有曲目，收摊");
                stopSession();
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        MediaBridge.setServiceAlive(true);
        MediaBridge.setListener(this);
        createChannel();

        session = new MediaSession(this, "music-edge");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setSessionActivity(openAppIntent());

        /**
         * 把会话声明成「本机播放」。
         *
         * 不调这一步，某些系统组件（音量面板、媒体输出切换、部分 ROM 的锁屏卡片）
         * 读 PlaybackInfo 时看到的是一份没有属性、类型不明的信息，会**直接忽略**这条会话。
         *
         * 注意这里只是「声明这是什么类型的播放」，**不涉及音频焦点** ——
         * 焦点仍然完全交给 WebView 里的 Chromium 自己管，理由见类注释。
         */
        try {
            session.setPlaybackToLocal(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
        } catch (Throwable t) {
            MediaBridge.recordError("会话属性", t.getClass().getSimpleName() + " " + t.getMessage());
        }
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MediaBridge.command("play", 0);
            }

            @Override
            public void onPause() {
                MediaBridge.command("pause", 0);
            }

            @Override
            public void onSkipToNext() {
                MediaBridge.command("next", 0);
            }

            @Override
            public void onSkipToPrevious() {
                MediaBridge.command("prev", 0);
            }

            /** pos 是毫秒 —— 与页面交互一律用毫秒，只有页面自己的 currentTime 是秒 */
            @Override
            public void onSeekTo(long pos) {
                MediaBridge.command("seek", pos);
            }

            @Override
            public void onStop() {
                MediaBridge.command("pause", 0);
                stopSession();
            }

            /**
             * 耳机线控 / 蓝牙 / 车机 / 手表发来的实体按键。
             *
             * 框架自带的映射只认几种码，而且依赖 PlaybackState 猜「当前该播还是该停」；
             * 这里显式按码分发，行为可预期 —— 耳机上双击下一首、单击暂停这些是最常用的入口，
             * 猜错了用户会以为「按键坏了」。
             */
            @Override
            public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                if (mediaButtonIntent == null) return super.onMediaButtonEvent(mediaButtonIntent);
                KeyEvent ke = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (ke == null || ke.getAction() != KeyEvent.ACTION_DOWN) {
                    return super.onMediaButtonEvent(mediaButtonIntent);
                }
                if (handleKey(ke.getKeyCode())) return true;
                return super.onMediaButtonEvent(mediaButtonIntent);
            }
        });
        // setActive(true) 才是「我要接管媒体按键」的信号：系统据此把耳机线控、
        // 蓝牙按键、以及「最近播放过的 App」的优先级给到我们。
        session.setActive(true);

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lxmusic:playback");
            wake.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_SYNC : intent.getAction();
        if (action == null) action = ACTION_SYNC;

        /**
         * 先无条件进前台，再谈干什么。
         *
         * startForegroundService 有一条 5 秒硬期限：到点还没 startForeground，系统会直接
         * 抛 ForegroundServiceDidNotStartInTimeException 崩掉进程。而这里的第一帧渲染依赖
         * 「页面已经上报过一份带曲目的快照」—— 两者之间难免有间隙（页面刚起、队列空、
         * 上报还在路上）。所以先拿一条占位通知把前台坐实，随后 sync() 立刻用真实内容顶掉它。
         * 没曲目的话，emptyStop 会在几秒后自己收摊，不会留一条点不动的通知。
         */
        if (!foreground) goForeground(buildPlaceholder());

        switch (action) {
            case ACTION_PREV:
                MediaBridge.command("prev", 0);
                break;
            case ACTION_NEXT:
                MediaBridge.command("next", 0);
                break;
            case ACTION_TOGGLE:
                MediaBridge.command("toggle", 0);
                break;
            case ACTION_STOP:
                MediaBridge.command("pause", 0);
                stopSession();
                return START_NOT_STICKY;
            case Intent.ACTION_MEDIA_BUTTON:
                // 走广播这条路的机型（多为老版本系统 / 部分厂商定制）：
                // 按键从 Intent 里来，不进 MediaSession.Callback
                try {
                    KeyEvent ke = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                    if (ke != null && ke.getAction() == KeyEvent.ACTION_DOWN) handleKey(ke.getKeyCode());
                } catch (Throwable t) {
                    MediaBridge.recordError("媒体按键", String.valueOf(t.getMessage()));
                }
                break;
            case ACTION_SYNC:
            default:
                break;
        }

        sync();

        if (!MediaBridge.getState().hasTrack) {
            main.removeCallbacks(emptyStop);
            main.postDelayed(emptyStop, 6000);
        }

        // 不做 START_STICKY：服务与页面的 WebView 同进程，进程没了重启一个空服务没有意义，
        // 只会留一条点不动的通知。
        return START_NOT_STICKY;
    }

    /** 实体媒体键 → 页面命令。返回 true 表示这颗键我们认了 */
    private boolean handleKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                MediaBridge.command("play", 0);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                MediaBridge.command("pause", 0);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                MediaBridge.command("toggle", 0);
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                MediaBridge.command("next", 0);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                MediaBridge.command("prev", 0);
                return true;
            default:
                return false;
        }
    }

    /* ---------------- MediaBridge.Listener（主线程回调） ---------------- */

    @Override
    public void onState(MediaBridge.State s) {
        if (s.playing && s.hasTrack) {
            main.removeCallbacks(lingerStop);
            acquireWake();
        } else {
            releaseWake();
            main.removeCallbacks(lingerStop);
            main.postDelayed(lingerStop, PAUSED_LINGER_MS);
        }
        if (!s.hasTrack && !s.playing) {
            // 页面说没得播了（队列清空 / 用户停掉）
            stopSession();
            return;
        }
        sync();
    }

    @Override
    public void onSessionEnd() {
        main.removeCallbacks(lingerStop);
        stopSession();
    }

    /* ---------------- 渲染 ---------------- */

    /**
     * 把页面推上来的快照翻成「系统认识的样子」：MediaMetadata（曲目+封面）、
     * PlaybackState（状态+位置+可用按键）、以及通知本身。
     */
    private void sync() {
        if (session == null) return;
        MediaBridge.State s = MediaBridge.getState();
        if (!s.hasTrack) return;      // 还没有曲目，先别拿空通知去占位

        session.setMetadata(buildMetadata(s));
        session.setPlaybackState(buildPlaybackState(s));

        Notification n = buildNotification(s);
        boolean stateChanged = !keyOf(s).equals(lastNotifyKey);

        if (stateChanged) {
            lastNotifyKey = keyOf(s);
            lastNotifyAt = System.currentTimeMillis();
        }

        if (!foreground) {
            // 首次必进前台，否则后台播放随时会被回收
            goForeground(n);
            lastNotifyAt = System.currentTimeMillis();
            return;
        }

        // 只有进度在动的话，没必要每来一条上报就重画一次通知 —— 系统会按
        // PlaybackState 的位置自己外推进度条。2 秒够跟手，也省电。
        boolean playing = s.playing;
        if (stateChanged || (playing && System.currentTimeMillis() - lastNotifyAt >= NOTIFY_THROTTLE_MS)) {
            lastNotifyAt = System.currentTimeMillis();
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                try {
                    nm.notify(NOTIFICATION_ID, n);
                } catch (Throwable t) {
                    MediaBridge.recordError("通知刷新", t.getClass().getSimpleName() + " " + t.getMessage());
                }
            }
        }

        MediaBridge.setSessionState(session != null && session.isActive(), foreground, foreground);
    }

    /** 指纹：只含「变了就该重画通知」的字段，进度不在其中 */
    private static String keyOf(MediaBridge.State s) {
        return (s.playing ? "1" : "0") + "|" + s.title + "|" + s.artist + "|"
                + (s.cover == null ? "" : s.cover) + "|" + (MediaBridge.getCover() != null ? "c" : "-")
                + "|" + s.index + "/" + s.total;
    }

    private MediaMetadata buildMetadata(MediaBridge.State s) {
        MediaMetadata.Builder b = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.durationMs > 0 ? s.durationMs : -1);
        Bitmap c = MediaBridge.getCover();
        if (c != null) b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, c);
        if (s.cover != null && s.cover.length() > 0) {
            // 也挂一份地址：Android 13+ 的部分系统界面会优先用 URI 自己取图
            b.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, s.cover);
        }
        return b.build();
    }

    private PlaybackState buildPlaybackState(MediaBridge.State s) {
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_STOP;
        if (s.canNext()) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (s.canPrev()) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;

        // updateTime 用单调时钟：系统拿它配合 position 自己外推进度，不必我们每秒推一次
        long pos = s.positionMs;
        if (s.durationMs > 0 && pos > s.durationMs) pos = s.durationMs;

        PlaybackState.Builder b = new PlaybackState.Builder()
                .setActions(actions)
                .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        pos, s.playing ? 1f : 0f, s.at);
        if (s.durationMs > 0) b.setBufferedPosition(s.durationMs);
        return b.build();
    }

    private Notification buildNotification(MediaBridge.State s) {
        Notification.MediaStyle style = new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                // 折叠状态下只留这三个键（Android 13 以下才看这个设置，13+ 由系统统一渲染）
                .setShowActionsInCompactView(0, 1, 2);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        b.setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(s.title)
                .setContentText(s.artist)
                .setContentIntent(openAppIntent())
                .setDeleteIntent(serviceIntent(ACTION_STOP, 9))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(false)
                .setOngoing(true)
                .setColor(0xFFEC4141)
                .setStyle(style);

        Bitmap c = MediaBridge.getCover();
        if (c != null) b.setLargeIcon(c);

        // 进度条：Android 13 以下的通知折叠视图靠它显示播放进度；13+ 系统自己画
        if (s.durationMs > 0) {
            b.setProgress((int) (s.durationMs / 1000), (int) (s.positionMs / 1000), s.playing);
        }

        b.addAction(new Notification.Action.Builder(R.drawable.ic_media_prev,
                getString(R.string.act_prev), serviceIntent(ACTION_PREV, 1)).build());
        b.addAction(new Notification.Action.Builder(
                s.playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play,
                getString(s.playing ? R.string.act_pause : R.string.act_play),
                serviceIntent(ACTION_TOGGLE, 2)).build());
        b.addAction(new Notification.Action.Builder(R.drawable.ic_media_next,
                getString(R.string.act_next), serviceIntent(ACTION_NEXT, 3)).build());

        return b.build();
    }

    /* ---------------- 前台服务 / 会话收摊 ---------------- */

    private void goForeground(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
            MediaBridge.setStartError("");
            MediaBridge.setSessionState(session != null && session.isActive(), true, true);
        } catch (Throwable t) {
            // Android 12+ 在「后台启动前台服务」受限时可能抛 ForegroundServiceStartNotAllowed；
            // Android 14 起类型与权限对不上会抛 SecurityException。
            // 这类失败**不能吞掉**：进程没进前台，通知栏/锁屏就是空的，用户看到的是
            // 「控制不了」，而 logcat 里只有一行 w。留痕 + 退回普通通知兜底。
            String msg = t.getClass().getSimpleName() + " " + t.getMessage();
            MediaBridge.setStartError(msg);
            MediaBridge.recordError("startForeground 失败", msg);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                try {
                    nm.notify(NOTIFICATION_ID, n);   // 至少让通知露个头，用户能看到并点进来
                } catch (Throwable t2) {
                    MediaBridge.recordError("通知兜底投递", String.valueOf(t2.getMessage()));
                }
            }
        }
    }

    /**
     * 占位通知：只为坐实「我已进前台」，几毫秒后就被真实曲目顶掉。
     * 也挂上 MediaStyle + session token，免得某些 ROM 在前台服务类型校验上挑刺。
     */
    private Notification buildPlaceholder() {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notif_preparing))
                .setContentIntent(openAppIntent())
                .setDeleteIntent(serviceIntent(ACTION_STOP, 9))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(false)
                .setOngoing(true)
                .setColor(0xFFEC4141);
        if (session != null) {
            try {
                b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()));
            } catch (Throwable ignore) {
            }
        }
        return b.build();
    }

    /** 释放会话、撤掉通知、结束自己 —— 一条路走到黑，别留半死不活的状态 */
    private void stopSession() {
        main.removeCallbacks(lingerStop);
        main.removeCallbacks(emptyStop);
        releaseWake();
        if (foreground) {
            try {
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
                else stopForeground(true);
            } catch (Throwable ignore) {
            }
            foreground = false;
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                try {
                    nm.cancel(NOTIFICATION_ID);
                } catch (Throwable ignore) {
                }
            }
        }
        if (session != null) {
            try {
                session.setActive(false);
                session.release();
            } catch (Throwable ignore) {
            }
            session = null;
        }
        lastNotifyKey = "";
        MediaBridge.setSessionState(false, false, false);
        stopSelf();
    }

    private void acquireWake() {
        if (wake == null || wake.isHeld()) return;
        try {
            wake.acquire();
        } catch (Throwable t) {
            Log.w(TAG, "唤醒锁申请失败: " + t.getMessage());
        }
    }

    private void releaseWake() {
        if (wake == null || !wake.isHeld()) return;
        try {
            wake.release();
        } catch (Throwable ignore) {
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.enableVibration(false);
        ch.setSound(null, null);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    /* ---------------- Intent 工具 ---------------- */

    private PendingIntent serviceIntent(String action, int reqCode) {
        Intent i = new Intent(this, PlaybackService.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, reqCode, i, flags);
    }

    private PendingIntent openAppIntent() {
        Intent open = new Intent(this, ClientActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, open, flags);
    }

    /* ---------------- Service 常规 ---------------- */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * 用户从「最近任务」划掉 App。
     * 正在播就什么都不做 —— 音乐应当继续，这也是客户端和普通网页的差别；
     * 没在播才顺手收摊，免得留一条点不动的通知。
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!MediaBridge.isPlaying()) stopSession();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(lingerStop);
        if (session != null) {
            try {
                session.setActive(false);
                session.release();
            } catch (Throwable ignore) {
            }
            session = null;
        }
        releaseWake();
        MediaBridge.setServiceAlive(false);
        MediaBridge.setListener(null);
        super.onDestroy();
    }
}
