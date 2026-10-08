package com.zyplnn.lxclient;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import com.zyplnn.lxclient.core.AudioEngine;

import java.util.ArrayList;
import java.util.List;

/**
 * 本地音乐 —— 底层能力层的门面页。
 *
 * ══════════════ 这一页在架构里的意义 ══════════════
 * 它对应网易云客户端的「本地播放 / 扫描本地歌曲」那一块：**完全原生**，
 * 不经过 WebView、不依赖网络、不依赖跨端层，走的是系统的媒体库与解码器。
 *
 * 为什么这件事必须原生做（跨端层做不到的）：
 *   · 扫设备音频要用系统的媒体库（MediaStore）与运行时权限；
 *   · 拿时长 / 比特率要用系统的 demuxer（MediaMetadataRetriever）；
 *   · 打开一首本地歌要交给系统播放器（ACTION_VIEW）—— 跨端层没有这个能力，
 *     WebView 里的 <audio> 也读不了 content:// 的本地媒体。
 * 这三件事都是「系统能力」，所以按分层的规矩落在原生侧。
 *
 * ══════════════ 权限为什么是运行时申请、而不是启动就要 ══════════════
 * 读媒体库在 Android 13 起是 READ_MEDIA_AUDIO（细粒度，只读音频，不碰照片与视频），
 * 更早是 READ_EXTERNAL_STORAGE。**只有点进这一页才会申请** ——
 * 一个音乐 App 一启动就要「读取你设备上的文件」是很劝退的，
 * 而用户可能压根不用本地音乐（这个客户端的主力是流媒体搜索）。
 * 用户拒绝也完全不影响其它功能，页面给一句说明就好。
 */
public class LocalMusicActivity extends Activity {

    private static final int REQ_AUDIO = 3001;

    private LinearLayout listHost;
    private ListView list;
    private TextView status;
    private final List<AudioEngine.Track> tracks = new ArrayList<AudioEngine.Track>();
    private boolean scanned = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout col = Ui.page(this, 16);
        col.addView(Ui.titleBar(this, "本地音乐", "重新扫描", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startScan();
            }
        }));

        col.addView(Ui.section(this, "设备音频"));
        status = Ui.text(this, "", 12.5f, Ui.color(this, R.color.text_3), false);
        status.setPadding(Ui.dp(this, 18), 0, Ui.dp(this, 18), Ui.dp(this, 8));
        status.setLineSpacing(Ui.dp(this, 3), 1f);
        col.addView(status);

        LinearLayout card = Ui.card(this);
        card.setPadding(0, Ui.dp(this, 2), 0, Ui.dp(this, 2));
        listHost = new LinearLayout(this);
        listHost.setOrientation(LinearLayout.VERTICAL);
        card.addView(listHost);
        col.addView(card);

        col.addView(Ui.note(this,
                "只列出系统媒体库里的音乐（铃声、通知音、录音不算）。"
                        + "点一首会交给系统播放器播放 —— 本地文件与在线音源是两套链路，"
                        + "客户端的播放器面板只负责在线流。"));
        col.addView(Ui.note(this,
                "解码引擎：" + AudioEngine.engineInfo()));

        // 首次进来自动扫一次，但**只在已经有权限时** —— 一进门就弹权限框太唐突
        if (AudioEngine.canReadAudio(this)) {
            startScan();
        } else {
            showPermissionPrompt();
        }
    }

    /* ═══════════════ 权限 ═══════════════ */

    private void showPermissionPrompt() {
        listHost.removeAllViews();
        status.setText("还没有读取媒体库的权限。点下面的按钮申请 —— 拒绝了也不影响在线搜索与播放。");
        LinearLayout card = Ui.card(this);
        card.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 12));
        TextView b = Ui.button(this, "申请读取音频权限", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                requestAudioPermission();
            }
        });
        card.addView(b, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 42)));
        listHost.addView(card);
    }

    private void requestAudioPermission() {
        try {
            requestPermissions(new String[]{AudioEngine.audioPermission()}, REQ_AUDIO);
        } catch (Throwable t) {
            Ui.toast(this, "申请权限失败：" + t.getMessage());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_AUDIO) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            startScan();
        } else {
            // 被拒时不能只留一句「没权限」——用户会以为这个功能坏了。
            // 明确说「这只是一个可选功能、不影响别的」，并给一条去系统设置的路。
            listHost.removeAllViews();
            status.setText("没有拿到权限，本地音乐用不了（在线搜索与播放不受影响）。"
                    + "如果系统已经不再弹窗询问，可以到系统设置里手动打开。");
            LinearLayout card = Ui.card(this);
            card.setPadding(Ui.dp(this, 16), Ui.dp(this, 12), Ui.dp(this, 16), Ui.dp(this, 12));
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            TextView again = Ui.button(this, "再申请一次", true, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    requestAudioPermission();
                }
            });
            TextView sys = Ui.button(this, "去系统设置", false, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    try {
                        Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                    } catch (Throwable ignore) {
                    }
                }
            });
            row.addView(again, new LinearLayout.LayoutParams(0, Ui.dp(this, 42), 1f));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, Ui.dp(this, 42), 1f);
            slp.setMargins(Ui.dp(this, 8), 0, 0, 0);
            row.addView(sys, slp);
            card.addView(row);
            listHost.addView(card);
        }
    }

    /* ═══════════════ 扫描 ═══════════════ */

    /**
     * 扫描放工作线程：媒体库大的设备上这一步要几秒，放主线程会直接 ANR。
     * 扫描期间先把状态写出来（「正在扫描…」），否则用户会以为点了没反应。
     */
    private void startScan() {
        if (!AudioEngine.canReadAudio(this)) {
            showPermissionPrompt();
            return;
        }
        scanned = false;
        status.setText("正在扫描设备媒体库…");
        listHost.removeAllViews();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<AudioEngine.Track> found = AudioEngine.scanLocal(
                        LocalMusicActivity.this, AudioEngine.SCAN_LIMIT);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        tracks.clear();
                        tracks.addAll(found);
                        scanned = true;
                        renderList();
                    }
                });
            }
        }, "lx-mediascan").start();
    }

    private void renderList() {
        listHost.removeAllViews();
        if (tracks.isEmpty()) {
            status.setText("媒体库里没有找到音频文件。"
                    + "如果你确定设备里有音乐，可能是系统还没建立索引 —— "
                    + "插着 U 盘 / SD 卡时稍等一会儿再点右上角「重新扫描」。");
            return;
        }
        long total = 0;
        for (int i = 0; i < tracks.size(); i++) total += tracks.get(i).durationMs;
        status.setText("共 " + tracks.size() + " 首 · 总时长 " + fmtDuration(total)
                + "　（上限 " + AudioEngine.SCAN_LIMIT + " 首，按标题排序）");

        /**
         * 用 ListView + BaseAdapter 而不是把行一次性 addView 到 LinearLayout：
         * 上限 2000 首，全量建视图会卡几秒。ListView 只创建可见的那些行，
         * 滚动时复用 —— 这是「列表交给系统」和「列表自己拼」的差别。
         */
        list = new ListView(this);
        list.setDivider(null);
        list.setDividerHeight(0);
        list.setBackgroundColor(Ui.color(this, R.color.surface));
        list.setAdapter(new BaseAdapter() {
            @Override
            public int getCount() {
                return tracks.size();
            }

            @Override
            public Object getItem(int position) {
                return tracks.get(position);
            }

            @Override
            public long getItemId(int position) {
                return tracks.get(position).id;
            }

            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                final AudioEngine.Track t = tracks.get(position);
                // 每次重建行：Ui.row 里已经处理了水波纹与省略，复用 convertView
                // 反而要处理「哪些控件要重设」的一堆细节，得不偿失（行数上千也不明显）
                // 点击交给 ListView 的 OnItemClickListener 处理（见下面），
                // 不在行内挂点击 —— 行内挂点击时 ListView 与子视图抢事件，
                // 表现是「点了有时灵有时不灵」，是最难查的那类问题。
                return Ui.row(LocalMusicActivity.this, null,
                        t.showTitle(), t.showArtist() + " · " + fmtDuration(t.durationMs)
                                + (t.sizeBytes > 0 ? " · " + fmtSize(t.sizeBytes) : ""),
                        "播放", false, null);
            }
        });
        list.setOnItemClickListener(new android.widget.AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(android.widget.AdapterView<?> parent, View view, int position, long id) {
                if (position >= 0 && position < tracks.size()) playLocal(tracks.get(position));
            }
        });
        // 高度按「最多露 6 行」算，装进外层 ScrollView 里整体滚动。
        // 不给固定高度的话，ListView 在 ScrollView 里量出来是 0（拿不到无限高度约束），
        // 表现是列表整个不见 —— 这是嵌套可滚动容器最经典的一个坑。
        int rows = Math.min(tracks.size(), 6);
        int h = rows * Ui.dp(this, 64) + Ui.dp(this, 6);
        listHost.addView(list, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, h));
    }

    /**
     * 播放一首本地歌：交给系统播放器。
     *
     * 为什么不塞进客户端的播放器：那套播放器（跨端层的 player.js）是**为在线取流设计的**
     * —— 它围绕队列、音源候选、歌词、缓存组织，本地文件既没有音源也没有歌词，
     * 硬塞进去只会两边都别扭。交给系统播放器是「各司其职」：
     * 用户点一首本地歌，期望的就是「放出来」，谁放不重要。
     */
    private void playLocal(AudioEngine.Track t) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(t.uri), "audio/*");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
        } catch (Throwable e) {
            // 少数精简 ROM 没有带能处理 audio/* 的应用，这时给一句能懂的话
            Ui.toast(this, "这台设备没有能播放该格式的应用");
        }
    }

    /* ═══════════════ 格式化 ═══════════════ */

    private static String fmtDuration(long ms) {
        if (ms <= 0) return "0:00";
        long total = ms / 1000;
        long h = total / 3600;
        long m = (total % 3600) / 60;
        long s = total % 60;
        if (h > 0) return h + ":" + two(m) + ":" + two(s);
        return m + ":" + two(s);
    }

    private static String two(long v) {
        return v < 10 ? "0" + v : String.valueOf(v);
    }

    private static String fmtSize(long bytes) {
        if (bytes < 1024) return bytes + "B";
        if (bytes < 1024 * 1024) return (bytes / 1024) + "KB";
        return String.format(java.util.Locale.US, "%.1fMB", bytes / 1048576.0);
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从系统设置改完权限回来：如果之前没扫过，补一次
        if (!scanned && AudioEngine.canReadAudio(this)) startScan();
    }
}
