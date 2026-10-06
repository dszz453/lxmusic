/**
 * D1 同名接口 —— 底座换成 node:sqlite。
 *
 * 为什么是 node:sqlite 而不是 better-sqlite3 / sql.js：
 *   · 它是 Node 22.5 起的**内置模块**（本机 22.22 实测无需 --experimental-sqlite 也能用，
 *     只会打一条 ExperimentalWarning），镜像里不用装任何原生依赖、不用编译、
 *     也不用挂 node_modules —— 这是「一个 Dockerfile 就能跑」的关键。
 *   · 接口是同步的，而 D1 的调用方本来就是 await，套一层 Promise 就对齐了。
 *
 * 只实现 D1 里**本项目真正用到的**那部分：prepare / bind / first / all / run / batch。
 * 项目里所有 SQL 都收敛在 src/db.js，所以这个面很小、也很好守。
 *
 * 三个必须记住的差异（踩过就知道疼）：
 *
 * 1) **绑定值类型**。node:sqlite 只接受 null / number / bigint / string / Uint8Array，
 *    传 undefined、布尔、对象会直接抛 "Provided value cannot be bound"。
 *    而 D1 宽容得多（undefined 当 null，布尔当 0/1）。所以这里统一 coerce 一道 ——
 *    不这么做，`isAdmin` 传布尔值的那几处就会在 Docker 上炸、在 CF 上没事。
 *
 * 2) **batch 必须是原子的**。D1 的 batch 会在一个事务里跑完；缺了事务，
 *    「删用户」那种一条语句碰 6 张表的操作中途失败就会留下半拉残局。
 *    而事务又不能跨 await —— 事务里一旦 await，别的请求的微任务就能插进来，
 *    那些语句会莫名其妙被算进同一个事务。所以批量执行走**全同步**路径
 *    （靠语句对象上留的 __sql/__args 重放），中间不出现任何 await。
 *
 * 3) **行对象是 null 原型**。node:sqlite 返回的行没有 prototype，
 *    直接往下传会遇到 `row.hasOwnProperty is not a function` 这类怪事。
 *    统一复制成普通对象。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 把任意 JS 值收敛成 node:sqlite 能绑定的类型 */
function coerce(v) {
  if (v === undefined || v === null) return null
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'bigint') return v
  if (t === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (v instanceof Uint8Array) return v
  // 兜底成字符串：宁可是一个不好看的字段，也不要让整条语句炸掉
  return String(v)
}

/** 行对象转普通对象（见文件头第 3 条） */
function plain(row) {
  if (!row) return row
  const out = {}
  for (const k of Object.keys(row)) out[k] = row[k]
  return out
}

/**
 * 打开（必要时创建）数据库文件，并设好容器里该有的 pragma。
 *
 * ── 为什么要在这里主动做「可写性体检」─────────────────────────────
 * 这是**自托管部署最常见的第一个坑**，而且原生产物给的信息完全指不到方向：
 *
 *   docker compose up -d   →   容器无限重启
 *   docker logs lxmusic    →   Error: unable to open database file
 *
 * 就这一句。用户看到它，第一反应是「数据库坏了 / 镜像有问题」，
 * 而真相通常是：宿主机上 `./data` 这个挂载点**被 Docker 以 root 建了出来**，
 * 容器里的进程是 `node`（uid 1000），没有写权限。目录就在那儿、权限也对不上。
 *
 * 换个 Node 环境的检查顺序也不一样：SQLite 对「目录不存在」/「文件只读」/
 * 「父目录不可写」**全都报同一句** unable to open database file，不区分。
 * 所以这里自己先把目录和权限分开探一遍，报出到底是哪一种、以及怎么修。
 */
export function openDatabase(file) {
  const dir = path.dirname(file)

  /**
   * 先建目录。`recursive: true` 在已存在时是 no-op，所以这里只可能因权限失败。
   * 失败基本只有一种情形：宿主机挂了个 root 属主、755 的目录进来。
   */
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    throw new Error(
      `数据目录建不出来：${dir}\n`
      + `  原因：${(e && e.message) || e}\n`
      + `  这通常是因为宿主机上这个目录属于 root、而容器内的进程是 uid 1000（node）。\n`
      + `  在宿主机上执行（把路径换成本机实际的数据目录）：\n`
      + `      sudo mkdir -p ${dir} && sudo chown -R 1000:1000 ${dir}\n`
      + `  或者改 docker-compose.yml 里的 volumes，让它指向一个有写权限的目录。`,
    )
  }

  /**
   * 目录在，但可能还是写不进去（存在但不可写）。
   * 这里**不去建真实文件**试 —— 那会碰坏正在用的库（尤其 WAL 模式下）。
   * 用一个只读的 accessSync 探，能写就过，不能写就把话说清楚。
   */
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    let owner = ''
    try {
      const st = fs.statSync(dir)
      owner = `（当前属主 uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o7777).toString(8)}）`
    } catch { /* 拿不到就算了，别把真正的错误盖掉 */ }
    throw new Error(
      `数据目录不可写：${dir} ${owner}\n`
      + `  容器内的进程以 uid ${typeof process.getuid === 'function' ? process.getuid() : '?'} 运行。\n`
      + `  修法：在宿主机上把这个目录交给该 uid（Docker 部署下通常是 1000）：\n`
      + `      sudo chown -R 1000:1000 ${dir}\n`
      + `  注意 chown 之后**不要再**用 root 跑 docker cp / 挂载覆盖，否则权限会被改回去。`,
    )
  }

  const db = new DatabaseSync(file)
  // WAL：一个进程里并发读写不互相阻塞，断电最坏只丢最后一个事务。
  // 容器里就一个进程，但 /api/stream 流式传输会长时间占着连接，WAL 能避免读被写挡住。
  try { db.exec('PRAGMA journal_mode = WAL') } catch { /* 只读挂载等场景忽略 */ }
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function createD1(db) {
  const cache = new Map()

  function stmtFor(sql) {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      if (cache.size > 400) cache.clear()   // 兜底；项目里的 SQL 是固定的几十条，正常到不了
      cache.set(sql, s)
    }
    return s
  }

  function make(sql, args) {
    return {
      // 留给 batch 做「同步重放」（见文件头第 2 条）
      __sql: sql,
      __args: args,
      bind() {
        return make(sql, Array.prototype.slice.call(arguments).map(coerce))
      },
      async first() {
        const row = stmtFor(sql).get(...args)
        return row ? plain(row) : null
      },
      async all() {
        return { results: stmtFor(sql).all(...args).map(plain) }
      },
      async run() {
        const r = stmtFor(sql).run(...args)
        return { success: true, changes: Number(r.changes || 0), lastRowId: Number(r.lastInsertRowid || 0) }
      },
    }
  }

  return {
    prepare(sql) { return make(String(sql), []) },

    async batch(stmts) {
      const list = (stmts || []).filter(s => s && typeof s.run === 'function')
      if (!list.length) return []

      // 全是本适配器造的语句 → 走同步事务，中间不可能被别的请求插队
      if (list.every(s => typeof s.__sql === 'string')) {
        db.exec('BEGIN')
        try {
          const out = list.map(s => {
            const r = stmtFor(s.__sql).run(...s.__args)
            return { success: true, changes: Number(r.changes || 0), lastRowId: Number(r.lastInsertRowid || 0) }
          })
          db.exec('COMMIT')
          return out
        } catch (e) {
          try { db.exec('ROLLBACK') } catch { /* 事务可能已自动回滚 */ }
          throw e
        }
      }

      // 外来语句（比如直接构造的模拟对象）→ 退回顺序执行，保住语义
      const out = []
      for (const s of list) out.push(await s.run())
      return out
    },

    async exec(sql) {
      db.exec(String(sql))
      return { count: 0, duration: 0 }
    },
  }
}
