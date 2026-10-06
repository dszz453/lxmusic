package com.zyplnn.musicedge;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * SQLite 桥 —— 顶替 Cloudflare D1。
 *
 * 页面侧的 src/db.js 是按 D1 的接口写的（prepare / bind / first / all / run / batch），
 * public/js/native.js 在页面里用同一个接口包了一层，底下调到这里，
 * 所以业务代码一行都不用改。
 *
 * 为什么读写用两套实现：
 *   查询走 rawQuery(sql, String[])，参数是字符串也够用（SQLite 对 LIMIT/比较有类型亲和性）。
 *   写入走 SQLiteStatement 逐参绑定，这样 null / 整数 / 浮点能按真实类型落库 ——
 *   用 rawQuery 的字符串数组会把 created_at 之类存成 TEXT，之后 ORDER BY 就乱了。
 *
 * 同步返回：
 *   这两个方法是 @JavascriptInterface 同步调用，会占用 WebView 的 JS 线程。
 *   本地 SQLite 的单次查询在毫秒级，可接受；换来的是 db.js 不需要改成异步模型。
 */
public class StoreBridge {

    private static final String TAG = "LXB/Db";
    private static final String DB_NAME = "lxmusic.db";

    private SQLiteDatabase db;

    /** 与 schema.sql 一致；全部 IF NOT EXISTS，每次启动执行一遍即可 */
    private static final String[] SCHEMA = {
            "CREATE TABLE IF NOT EXISTS users ("
                    + " id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,"
                    + " is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",

            "CREATE TABLE IF NOT EXISTS playlists ("
                    + " id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, cover TEXT,"
                    + " source TEXT, source_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id)",

            "CREATE TABLE IF NOT EXISTS playlist_songs ("
                    + " playlist_id TEXT NOT NULL, position INTEGER NOT NULL, song_id TEXT NOT NULL,"
                    + " song_json TEXT NOT NULL, PRIMARY KEY (playlist_id, position))",
            "CREATE INDEX IF NOT EXISTS idx_plsongs_playlist ON playlist_songs(playlist_id)",

            "CREATE TABLE IF NOT EXISTS favorites ("
                    + " user_id TEXT NOT NULL, song_id TEXT NOT NULL, song_json TEXT NOT NULL,"
                    + " created_at INTEGER NOT NULL, PRIMARY KEY (user_id, song_id))",

            "CREATE TABLE IF NOT EXISTS plugins ("
                    + " id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'public', name TEXT NOT NULL,"
                    + " version TEXT, author TEXT, description TEXT, homepage TEXT, url TEXT,"
                    + " script TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",

            "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",

            "CREATE TABLE IF NOT EXISTS search_history ("
                    + " id TEXT PRIMARY KEY, user_id TEXT NOT NULL, keyword TEXT NOT NULL,"
                    + " created_at INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS idx_search_user ON search_history(user_id, created_at DESC)",
    };

    private static volatile StoreBridge instance;
    private static final Object LOCK = new Object();

    /**
     * 全局单例，且只吃 application context。
     *
     * 两个原因：
     *   · 库要跟着进程活 —— 「划掉最近任务但音乐还在播」时 Activity 会销毁，
     *     数据库连接不能跟着走，否则回到 App 后所有读写都会失败；
     *   · 用 application context 打开就不会持有 Activity，不构成泄漏
     *     （SQLiteDatabase 内部会持有传入的 Context）。
     */
    public static StoreBridge get(Context ctx) {
        StoreBridge local = instance;
        if (local == null) {
            synchronized (LOCK) {
                local = instance;
                if (local == null) {
                    local = new StoreBridge(ctx.getApplicationContext());
                    instance = local;
                }
            }
        }
        return local;
    }

    private StoreBridge(Context ctx) {
        db = ctx.openOrCreateDatabase(DB_NAME, Context.MODE_PRIVATE, null);
        for (String sql : SCHEMA) {
            try {
                db.execSQL(sql);
            } catch (Throwable t) {
                Log.w(TAG, "建表失败: " + t.getMessage() + " :: " + sql);
            }
        }
        // 单次查询用不上 WAL 的并发优势，但能明显减少「查询与写入交错」时的卡顿
        try {
            db.enableWriteAheadLogging();
        } catch (Throwable ignore) {
        }
    }

    /** 查询：返回行数组的 JSON 文本（与 D1 的 results 同形） */
    @JavascriptInterface
    public String dbQuery(String sql, String argsJson) {
        String[] args = toStringArgs(argsJson);
        Cursor c = null;
        try {
            c = db.rawQuery(sql, args);
            JSONArray arr = new JSONArray();
            String[] names = c.getColumnNames();
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                for (int i = 0; i < names.length; i++) {
                    switch (c.getType(i)) {
                        case Cursor.FIELD_TYPE_NULL:
                            row.put(names[i], JSONObject.NULL);
                            break;
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(names[i], c.getLong(i));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(names[i], c.getDouble(i));
                            break;
                        default:
                            row.put(names[i], c.getString(i));
                    }
                }
                arr.put(row);
            }
            return arr.toString();
        } catch (Throwable t) {
            Log.w(TAG, "查询失败: " + t.getMessage() + " :: " + sql);
            return "[]";
        } finally {
            if (c != null) {
                try {
                    c.close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /** 写入：返回受影响行数 */
    @JavascriptInterface
    public int dbExec(String sql, String argsJson) {
        SQLiteStatement st = null;
        try {
            st = db.compileStatement(sql);
            bindArgs(st, argsJson);
            String head = sql.trim().toUpperCase();
            if (head.startsWith("INSERT") || head.startsWith("REPLACE")) {
                long id = st.executeInsert();
                return id >= 0 ? 1 : 0;
            }
            if (head.startsWith("UPDATE") || head.startsWith("DELETE")) {
                return st.executeUpdateDelete();
            }
            st.execute();
            return 1;
        } catch (Throwable t) {
            Log.w(TAG, "写入失败: " + t.getMessage() + " :: " + sql);
            return 0;
        } finally {
            if (st != null) {
                try {
                    st.close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /* ---------------- 参数绑定 ---------------- */

    private static String[] toStringArgs(String argsJson) {
        try {
            JSONArray a = new JSONArray(argsJson == null || argsJson.isEmpty() ? "[]" : argsJson);
            String[] out = new String[a.length()];
            for (int i = 0; i < a.length(); i++) {
                Object v = a.get(i);
                out[i] = (v == null || v == JSONObject.NULL) ? null : String.valueOf(v);
            }
            return out;
        } catch (Throwable t) {
            return new String[0];
        }
    }

    private static void bindArgs(SQLiteStatement st, String argsJson) throws JSONException {
        JSONArray a = new JSONArray(argsJson == null || argsJson.isEmpty() ? "[]" : argsJson);
        for (int i = 0; i < a.length(); i++) {
            int idx = i + 1;
            Object v = a.get(i);
            if (v == null || v == JSONObject.NULL) {
                st.bindNull(idx);
            } else if (v instanceof Integer) {
                st.bindLong(idx, (Integer) v);
            } else if (v instanceof Long) {
                st.bindLong(idx, (Long) v);
            } else if (v instanceof Double) {
                st.bindDouble(idx, (Double) v);
            } else if (v instanceof Boolean) {
                st.bindLong(idx, ((Boolean) v) ? 1 : 0);
            } else {
                st.bindString(idx, String.valueOf(v));
            }
        }
    }
}
