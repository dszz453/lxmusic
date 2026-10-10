/**
 * 「生效的搜索源」的**唯一口径**。
 *
 * ══════════════ 为什么值得单独一个文件 ══════════════
 * 这份口径原来私有在 api.js 里（`searchSources`），而 daily.js 也要用它 ——
 * 可 api.js 已经 `import { generateDaily } from './daily.js'`，反向再 import 就成环了。
 * 当初图省事，daily.js 里直接写死了 `['kg', 'wy', 'kw']`（酷狗还排在第一位），
 * 于是出现一个很隐蔽的不一致（2026-10-09 老板报障）：
 *
 *   · 「搜索」读 D1 设置 search.sources（管理后台的「默认搜索源」）—— 用户改了它生效；
 *   · 「每日推荐」读那份写死的清单 —— 用户改成只用网易云，推来的还是酷狗的歌。
 *
 * 两处口径不一致的 bug 最难查：界面上改的东西在 A 处生效、在 B 处不生效，
 * 用户只会说「设置不管用」，而代码里根本找不到那个设置被读了几次、各读的哪一份。
 * 所以现在把它抽出来，谁要「这个实例现在该用哪些音源」都读这里，**不许再写第二份**。
 *
 * 优先级：D1 settings `search.sources` > env `DEFAULT_SOURCES` > 全部平台。
 */
import { ALL_SOURCES } from '../providers/index.js'

/** D1 settings 里的键：逗号分隔的平台 key，如 "wy,kw" */
export const DEFAULT_SOURCES_SETTING = 'search.sources'

/**
 * 读出当前生效的搜索源（有序：谁排在前面谁的结果更靠前）。
 *
 * ⚠ 第二个参数是 **src/db.js 那个模块本身**（它带 `getSetting`），不是 D1 句柄。
 *   之所以容易看错：api.js 里 `import * as db from '../db.js'`，于是调用点写着
 *   `searchSources(env, db)` —— 那个 `db` 是模块。参数名因此写成 settingsDb，
 *   并且下面显式挡住「传成了句柄」的写法（句柄上没有 getSetting）：
 *   传错时退化成「用默认源」而不是抛异常，**但这是写法错误，不是运行期可容忍的分支**。
 *
 * 为什么要吞异常：三个宿主的「设置表」并不是永远可用 ——
 * 壳内 SQLite 替身、单元测试的内存替身都可能没有 settings 表。
 * 那种情况下退回 `env.DEFAULT_SOURCES`，再退回全部平台，**绝不能让调用方因为
 * 「读不到一个配置」而整个失败**（每日推荐、搜索都在这条路径上）。
 */
export async function searchSources(env, settingsDb) {
  let raw = ''
  try {
    if (settingsDb && typeof settingsDb.getSetting === 'function' && env && env.DB) {
      raw = String((await settingsDb.getSetting(env.DB, DEFAULT_SOURCES_SETTING, '')) || '').trim()
    }
  } catch {
    // 读不到设置（替身/老库）：交给 env 默认值兜底，别把上层一起拖挂
    raw = ''
  }
  if (!raw) {
    try {
      raw = env && env.DEFAULT_SOURCES ? String(env.DEFAULT_SOURCES).trim() : ''
    } catch {
      raw = ''
    }
  }
  if (!raw) return ALL_SOURCES.slice()
  const keys = raw.split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
  const known = ALL_SOURCES.concat(pluginSearchSourceKeys(env))
  const valid = keys.filter(k => known.includes(k))
  return valid.length ? valid : ALL_SOURCES.slice()
}

/**
 * 「可被搜索的插件专有源」的 key 清单 —— 不在 ALL_SOURCES 里、插件注册过、
 * 且**声明了 musicSearch** 的那些（例如 pdone-qdy 的 `qsvip`「汽水VIP」）。
 * 没有插件池 / 池子为空时回 []。
 *
 * 为什么只收 `musicSearch`：插件池里还有 `local`、`git` 这类只做取流/歌词的源，
 * 它们**搜不了**。放开它们只会造出「后台能勾上、搜索却没反应」的假开关。
 * 能搜才配进「搜索源」这一列，与 /sources 给前端的 `searchable` 是同一个判据。
 *
 * 为什么单独抽一个函数：`search.sources` 的**写入校验**（api.js 的
 * /admin/search-sources）与**读取校验**（这里的 searchSources）必须同一口径。
 * 两边各写一份的后果是最难查的那种不一致 —— 管理端能勾上、搜索却不认它，
 * 用户看到的只有「我明明开了汽水，怎么搜不到」。本项目已经为「同一件事两份口径」
 * 栽过至少两次（搜索源名单、D1 句柄），所以这里只留一处。
 *
 * 全程吞异常：三个宿主的插件池可用性不同（壳内延迟求值、测试替身可能没有池子），
 * 「读不到插件清单」绝不能把搜索整条链路带挂。
 */
export function pluginSearchSourceKeys(env) {
  try {
    const pool = env && env.PLUGIN_POOL
    if (!pool || typeof pool.listSources !== 'function') return []
    return pool.listSources()
      .filter(s => s.key && !ALL_SOURCES.includes(s.key))
      .filter(s => Array.isArray(s.actions) && s.actions.includes('musicSearch'))
      .map(s => s.key)
  } catch {
    return []
  }
}
