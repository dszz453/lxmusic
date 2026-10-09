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
  const valid = keys.filter(k => ALL_SOURCES.includes(k))
  return valid.length ? valid : ALL_SOURCES.slice()
}
