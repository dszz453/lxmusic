package com.yunmusic.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * 云音乐 - 前台媒体播放服务
 *
 * ============================ 为什么要引入 MediaSession ============================
 *
 * 只发一条普通通知，是**不会**在锁屏出现媒体卡片、也不会进下拉控制中心的。
 *
 * Android 11 起，系统的「正在播放」媒体控件（锁屏卡片、控制中心/快捷设置里的
 * 媒体面板、蓝牙耳机与车机的 AVRCP 按键）全部由 **MediaSession** 驱动：
 *   系统自己去读 MediaSession 的 Metadata（歌名/歌手/封面/时长）和 PlaybackState
 *   （播放中还是暂停、进度多少、支持哪些操作），然后**自己画**那个控件。
 * 通知只负责在下拉栏里露一条，样式上通过 MediaStyle.setMediaSession(token)
 * 与这个会话绑定 —— 系统靠这个绑定把「通知」和「会话」认成同一个播放器。
 *
 * 所以三者缺一不可：
 *   1) MediaSession 且 setActive(true) + 有 Metadata + 有 PlaybackState；
 *   2) 通知用 Notification.MediaStyle 并 setMediaSession(session.getSessionToken())；
 *   3) 前台服务（前台服务保证进程不被杀，会话才不会断）。
 *
 * 另外封面必须是 Bitmap（或本机 content/file URI），MediaMetadata 不接受 http 地址，
 * 所以封面走 YunBridge.coverBitmap() 先落成本机 Bitmap。
 */
public class MusicService extends Service {

    public static final String ACTION_UPDATE = "com.yunmusic.app.ACTION_UPDATE";
    public static final String ACTION_TOGGLE = "com.yunmusic.app.ACTION_TOGGLE";
    public static final String ACTION_NEXT = "com.yunmusic.app.ACTION_NEXT";
    public static final String ACTION_PREV = "com.yunmusic.app.ACTION_PREV";
    public static final String ACTION_STOP = "com.yunmusic.app.ACTION_STOP";

    public static final String EXTRA_TITLE = "extra_title";
    public static final String EXTRA_ARTIST = "extra_artist";
    public static final String EXTRA_IS_PLAYING = "extra_is_playing";
    public static final String EXTRA_COVER = "extra_cover";
    public static final String EXTRA_DURATION = "extra_duration";
    public static final String EXTRA_POSITION = "extra_position";

    private static final String CHANNEL_ID = "yunmusic_channel";
    private static final int NOTIFICATION_ID = 2001;
    private static final String SESSION_TAG = "YunMusic";
    private static final int REQ_NOTIF_PERM = 9001;

    /** 会话本体。锁屏与控制中心看到的全部信息都从这里来。 */
    private MediaSession session;
    private final Handler main = new Handler(Looper.getMainLooper());

    private String currentTitle = "云音乐";
    private String currentArtist = "好音乐，随时听";
    private boolean isPlaying = false;

    /** 当前这首歌的封面地址 */
    private String currentCover = "";
    /** 已经下好并解成 Bitmap 的那张封面地址，避免同一张反复下载 */
    private String loadedCover = "";
    private Bitmap coverBmp;

    private long durationMs = 0;
    private long positionMs = 0;

    /* ============================ 静态入口 ============================ */

    /** 旧入口：只有歌名/歌手/播放状态 */
    public static void updateNotification(Context context, String title, String artist, boolean isPlaying) {
        updateMediaState(context, title, artist, isPlaying, "", 0, 0);
    }

    /**
     * 更新锁屏 / 通知栏 / 控制中心的媒体状态。
     *
     * @param cover    封面地址（http/https，可为空）
     * @param duration 总时长（毫秒，未知给 0）
     * @param position 当前进度（毫秒，未知给 0）
     */
    public static void updateMediaState(Context context, String title, String artist, boolean isPlaying,
                                        String cover, long duration, long position) {
        if (context == null) return;
        Intent intent = new Intent(context, MusicService.class);
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_TITLE, title == null ? "" : title);
        intent.putExtra(EXTRA_ARTIST, artist == null ? "" : artist);
        intent.putExtra(EXTRA_IS_PLAYING, isPlaying);
        intent.putExtra(EXTRA_COVER, cover == null ? "" : cover);
        intent.putExtra(EXTRA_DURATION, duration);
        intent.putExtra(EXTRA_POSITION, position);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable t) {
            // Android 12+ 后台启动前台服务可能被系统拦下（ForegroundServiceStartNotAllowedException），
            // 部分定制 ROM 也会拦。这属于「锦上添花」，静默降级，绝不能连累播放。
        }
    }

    /* ============================ 生命周期 ============================ */

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        ensureSession();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_UPDATE.equals(action) || action == null) {
            if (intent != null) {
                String t = intent.getStringExtra(EXTRA_TITLE);
                if (t != null && !t.isEmpty()) currentTitle = t;
                String a = intent.getStringExtra(EXTRA_ARTIST);
                if (a != null && !a.isEmpty()) currentArtist = a;
                isPlaying = intent.getBooleanExtra(EXTRA_IS_PLAYING, isPlaying);
                String c = intent.getStringExtra(EXTRA_COVER);
                if (c != null) currentCover = c;
                durationMs = intent.getLongExtra(EXTRA_DURATION, durationMs);
                positionMs = intent.getLongExtra(EXTRA_POSITION, positionMs);
            }
            ensureSession();
            loadCoverIfNeeded();
            updateSessionState();
            buildAndShowNotification();
        } else if (ACTION_TOGGLE.equals(action)) {
            MainActivity a = MainActivity.getInstance();
            if (a != null) a.togglePlayPauseFromNative();
        } else if (ACTION_NEXT.equals(action)) {
            MainActivity a = MainActivity.getInstance();
            if (a != null) a.nextTrackFromNative();
        } else if (ACTION_PREV.equals(action)) {
            MainActivity a = MainActivity.getInstance();
            if (a != null) a.prevTrackFromNative();
        } else if (ACTION_STOP.equals(action)) {
            isPlaying = false;
            updateSessionState();
            try {
                stopForeground(true);
            } catch (Throwable ignored) {
            }
            stopSelf();
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
            }
        } catch (Throwable ignored) {
        }
        session = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ============================ MediaSession ============================ */

    private void ensureSession() {
        if (session != null) return;
        try {
            session = new MediaSession(this, SESSION_TAG);
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);

            /*
             * 锁屏卡片 / 控制中心 / 蓝牙耳机上的按键最终都会走到这里。
             *
             * ⚠ 不要把 onPlay / onPause 直接当成「切换」：网页才是播放状态的唯一真相，
             * 系统可能因为重连蓝牙、或用户连点而重复派发同一个动作。
             * 所以这里传的是**目标状态**（要播 / 要停），由网页自己判断要不要真的动作，
             * 这样重复派发是幂等的，不会出现「按一次暂停、结果又播起来」。
             */
            session.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    setPagePlaying(true);
                }

                @Override
                public void onPause() {
                    setPagePlaying(false);
                }

                @Override
                public void onStop() {
                    setPagePlaying(false);
                }

                @Override
                public void onSkipToNext() {
                    MainActivity a = MainActivity.getInstance();
                    if (a != null) a.nextTrackFromNative();
                }

                @Override
                public void onSkipToPrevious() {
                    MainActivity a = MainActivity.getInstance();
                    if (a != null) a.prevTrackFromNative();
                }

                @Override
                public void onSeekTo(long pos) {
                    MainActivity a = MainActivity.getInstance();
                    if (a != null) a.seekFromNative(pos);
                }
            });

            session.setSessionActivity(contentPendingIntent());
            session.setActive(true);
        } catch (Throwable t) {
            session = null;
        }
    }

    private void setPagePlaying(boolean want) {
        MainActivity a = MainActivity.getInstance();
        if (a == null) return;
        a.runJs("if(window.nativeSetPlaying){ try{ window.nativeSetPlaying(" + want + ") }catch(e){} }");
    }

    /** 把歌名/歌手/封面/时长/进度写进会话 —— 锁屏卡片显示的就是这里的内容 */
    private void updateSessionState() {
        if (session == null) return;
        try {
            MediaMetadata.Builder mb = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, "云音乐");
            if (durationMs > 0) {
                mb.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
            }
            if (coverBmp != null) {
                mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBmp);
                mb.putBitmap(MediaMetadata.METADATA_KEY_ART, coverBmp);
            }
            session.setMetadata(mb.build());

            long actions = PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
                    | PlaybackState.ACTION_STOP;
            PlaybackState state = new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            Math.max(0L, positionMs), isPlaying ? 1f : 0f)
                    .build();
            session.setPlaybackState(state);

            if (!session.isActive()) session.setActive(true);
        } catch (Throwable ignored) {
        }
    }

    /* ============================ 封面 ============================ */

    /**
     * 封面只在「换了另一首」时才重新取。
     * 下好后回主线程刷新会话与通知 —— 这时锁屏上才会出现封面图。
     */
    private void loadCoverIfNeeded() {
        final String url = currentCover;
        if (url == null || url.isEmpty()) {
            coverBmp = null;
            loadedCover = "";
            return;
        }
        if (url.equals(loadedCover)) return;
        loadedCover = url;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Bitmap bmp = YunBridge.coverBitmap(getApplicationContext(), url);
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        // 下载期间用户可能已经切歌，过期结果直接丢弃
                        if (!url.equals(currentCover)) return;
                        coverBmp = bmp;
                        updateSessionState();
                        buildAndShowNotification();
                    }
                });
            }
        }).start();
    }

    /* ============================ 通知 ============================ */

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        "音乐播放控制",
                        NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription("云音乐前台播放控制器与通知");
                channel.setShowBadge(false);
                // 锁屏上要能看到内容，否则锁屏只显示「一条通知」而不显示歌名封面
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.createNotificationChannel(channel);
                }
            } catch (Throwable ignored) {
            }
        }
    }

    private PendingIntent contentPendingIntent() {
        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, 0, appIntent,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );
    }

    private PendingIntent servicePendingIntent(int reqCode, String action) {
        Intent i = new Intent(this, MusicService.class).setAction(action);
        return PendingIntent.getService(
                this, reqCode, i,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0
        );
    }

    private void buildAndShowNotification() {
        try {
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder = new Notification.Builder(this, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
            }

            int playIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
            String playTitle = isPlaying ? "暂停" : "播放";

            builder.setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(currentTitle)
                    .setContentText(currentArtist)
                    .setContentIntent(contentPendingIntent())
                    // 暂停后允许划掉，播放中常驻（前台服务本来也需要常驻通知）
                    .setOngoing(isPlaying)
                    // 每次切歌/切状态都重发通知，但不要再响一次、不要再震一次
                    .setOnlyAlertOnce(true)
                    .setShowWhen(false)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setColor(0xFFEC4141)
                    .addAction(android.R.drawable.ic_media_previous, "上一首", servicePendingIntent(1, ACTION_PREV))
                    .addAction(playIcon, playTitle, servicePendingIntent(2, ACTION_TOGGLE))
                    .addAction(android.R.drawable.ic_media_next, "下一首", servicePendingIntent(3, ACTION_NEXT));

            if (coverBmp != null) {
                builder.setLargeIcon(coverBmp);
            }

            /*
             * 关键一步：MediaStyle + setMediaSession。
             * 少了它，这条通知在下拉栏里就只是「一条普通通知」，
             * 锁屏不会变成媒体卡片，控制中心也不会出现媒体面板。
             */
            try {
                Notification.MediaStyle style = new Notification.MediaStyle()
                        .setShowActionsInCompactView(0, 1, 2);
                if (session != null) {
                    style.setMediaSession(session.getSessionToken());
                }
                builder.setStyle(style);
            } catch (Throwable ignored) {
            }

            startForegroundCompat(builder.build());
        } catch (Throwable t) {
            // 通知失败不该连累播放
        }
    }

    /**
     * ⚠ Android 14（targetSdk 34）起，startForeground() 必须能确定服务类型，
     * 否则抛 MissingForegroundServiceTypeException 直接把应用干掉。
     * 清单里已声明 android:foregroundServiceType="mediaPlayback"，
     * 这里在 API 29+ 再显式传一次类型，双保险。
     *
     * 再退一步：万一带类型也起不来，至少用不带类型的方式把它挂成前台 ——
     * 因为服务是用 startForegroundService() 拉起来的，系统在等这一次
     * startForeground()，完全不调会被判定为超时并杀掉进程。
     */
    private void startForegroundCompat(Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Throwable t) {
            try {
                startForeground(NOTIFICATION_ID, notification);
            } catch (Throwable t2) {
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.notify(NOTIFICATION_ID, notification);
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
