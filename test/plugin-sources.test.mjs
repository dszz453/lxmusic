/**
 * 「插件专有源」通道的回归测试（纯逻辑 + 源码结构，不联网）。
 *
 * 背景：插件可以注册**内置六平台之外**的源（pdone-qdy / wsl-quandou 的
 * `qsvip`「汽水VIP」，声明了 musicSearch/musicUrl/lyric）。在这条通道补上之前，
 * 那些源是死代码 —— 管理端勾不到、搜索不会路由到它，等于「加了插件什么都没发生」。
 *
 * 这套护栏盯住的是**接线**（谁把谁接上），不是某个上游接口能不能用：
 *   ① PluginPool 能把插件专有源列出来（listSources / sourceName）
 *   ② 写入校验与读取校验**同一口径**（只收声明了 musicSearch 的）
 *   ③ searchOnline 真的把非内置源路由给插件
 *   ④ 前端：能给用户看见、能勾上，且不污染「导入歌单」那条完全不同的链路
 *
 * ⚠ 结构类断言一律在**去注释**副本上做：注释里必然写着「反面写法的字面量」
 *   （比如本文档就写了 `qsvip`），拿整文件做 includes 会永远通过。这是本项目
 *   踩过两次的硬规矩（daily.test.mjs 的 deComment / home-cache 的 APPJS_NC）。
 *
 * 跑：node --test test/plugin-sources.test.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PluginPool } from '../src/lib/lxruntime.js'

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) pass++; else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond && detail) console.log(`      ${detail}`)
}

const read = (rel) => fs.readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

/**
 * 去注释（块 + 行），结构类断言必须用它。
 *
 * ⚠ 必须**字符串感知**：不能拿一条「块注释正则 + 一条行注释正则」一把梭。
 *   admin.js 里有一句普通字符串，内容含「斜杠 + admin 路径 + 星号」这么一段
 *   路径通配写法，其中的块注释起始符不是注释开头，却会和后面某个真正的块注释
 *   结束符配成一对，把中间**整段真代码**吞掉 —— 本文件第一次跑就踩了：
 *   `function shortOf` 被吃掉，于是取值函数抠回空壳、所有函数内断言静默变空。
 *   反斜杠转义与模板串同理，一律原样搬运，别做二次解析。
 *   （本条注释本身也刻意不写注释定界符，免得把注释提前截断。）
 */
function deComment(s) {
  const src = String(s)
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {        // 字符串 / 模板串：原样搬
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === c) { j++; break }
        j++
      }
      out += src.slice(i, j); i = j; continue
    }
    if (c === '/' && src[i + 1] === '/') {            // 行注释
      let j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {            // 块注释
      const j = src.indexOf('*/', i + 2)
      i = j < 0 ? src.length : j + 2
      continue
    }
    out += c; i++
  }
  return out
}

/**
 * 抠出一个函数体（用于「函数里必须有什么」这类断言）。
 *
 * ⚠ 必须**跳过参数表**：`searchOnline(keyword, { sources = ALL_SOURCES, … } = {})`
 *   里第一个 `{` 是解构参数，直接从那儿配对括号只会拿回 `{ sources = … }` 这个空壳，
 *   于是所有 in-body 断言全变空而依然「通过」—— 正是本项目那条硬规矩
 *   「切函数体再断言必须先断长度」要防的东西。调用方一律先用 assertBody 断长度。
 */
function fnBody(src, name) {
  const i = src.indexOf(name)
  if (i < 0) return ''
  let start = src.indexOf('{', i)
  if (start < 0) return ''
  const par = src.indexOf('(', i)
  if (par >= 0 && par < start) {                      // 有参数表：先配对括号，再取函数体
    let d = 0, k = par
    for (; k < src.length; k++) {
      if (src[k] === '(') d++
      else if (src[k] === ')') { d--; if (!d) { k++; break } }
    }
    const b = src.indexOf('{', k)
    if (b < 0) return ''
    start = b
  }
  let depth = 0
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1) }
  }
  return ''
}

/** 先断长度：抠空了就让「抠出来了」这条先红，避免后续断言全变空却仍显示通过 */
function assertBody(label, body, minLen) {
  ok(`${label} 抠出来了（不是空壳）`, body.length >= minLen, `len=${body.length}`)
  return body
}

const SRC_SOURCES = read('src/server/sources.js')
const SRC_PROVIDERS = read('src/providers/index.js')
const SRC_API = read('src/server/api.js')
const SRC_SUBSONIC = read('src/server/subsonic.js')
const SRC_POOL = read('src/lib/lxruntime.js')
const APP = read('public/js/app.js')
const ADMIN = read('public/js/admin.js')

const SOURCES_NC = deComment(SRC_SOURCES)
const PROVIDERS_NC = deComment(SRC_PROVIDERS)
const API_NC = deComment(SRC_API)
const SUBSONIC_NC = deComment(SRC_SUBSONIC)
const POOL_NC = deComment(SRC_POOL)
const APP_NC = deComment(APP)
const ADMIN_NC = deComment(ADMIN)

/* ================= 一、PluginPool.listSources / sourceName ================= */

{
  const empty = new PluginPool()
  ok('空池子 listSources() 回空数组，不抛',
    JSON.stringify(empty.listSources()) === '[]')
  ok('未知源的 sourceName 原样返回',
    empty.sourceName('nope') === 'nope')
}

{
  const pool = new PluginPool()
  pool.add({
    ok: true, id: 'p-qdy', meta: { name: '全豆要聚合音源' },
    sources: {
      wy: { name: '网易云音乐', actions: ['musicUrl'], qualitys: ['320k'] },
      qsvip: { name: '汽水VIP', actions: ['musicSearch', 'musicUrl', 'lyric'], qualitys: ['128k', 'flac'] },
    },
  })
  pool.add({
    ok: true, id: 'p-local', meta: { name: '本地源' },
    sources: { local: { actions: ['musicUrl', 'lyric'] } },
  })
  const list = pool.listSources()
  const by = Object.fromEntries(list.map(s => [s.key, s]))

  ok('插件声明的每个源都被列出来（含非内置平台的 qsvip / local）',
    list.map(s => s.key).sort().join(',') === 'local,qsvip,wy',
    JSON.stringify(list.map(s => s.key)))

  ok('actions 原样带出（能不能搜、能不能取流由调用方判断）',
    by.qsvip.actions.join(',') === 'musicSearch,musicUrl,lyric',
    JSON.stringify(by.qsvip.actions))

  ok('qualitys 带出',
    by.qsvip.qualitys.join(',') === '128k,flac')

  ok('源展示名取插件声明的 name（qsvip → 汽水VIP）',
    by.qsvip.name === '汽水VIP', by.qsvip.name)

  ok('没声明 name 的源退回 key',
    by.local.name === 'local', by.local.name)

  ok('sourceName() 与 listSources 同源',
    pool.sourceName('qsvip') === '汽水VIP' && pool.sourceName('local') === 'local')

  ok('只做取流的源不会被当成可搜源（searchable 判据在服务端做）',
    !by.local.actions.includes('musicSearch'))
}

{
  const pool = new PluginPool()
  pool.add({ ok: true, id: 'a', meta: { name: 'A' }, sources: { qsvip: { name: '汽水VIP', actions: ['musicSearch'], qualitys: ['128k'] } } })
  pool.add({ ok: true, id: 'b', meta: { name: 'B' }, sources: { qsvip: { name: '汽水VIP', actions: ['musicSearch', 'musicUrl'], qualitys: ['flac'] } } })
  const s = pool.listSources().find(x => x.key === 'qsvip')
  ok('同一源被两个插件注册：两个插件都记上（取流时互为备份）',
    s.plugins.length === 2, JSON.stringify(s.plugins))
  ok('同一源的 actions / qualitys 取并集',
    s.actions.includes('musicSearch') && s.actions.includes('musicUrl') && s.qualitys.join(',') === '128k,flac',
    JSON.stringify([s.actions, s.qualitys]))

  pool.remove('b')
  const s2 = pool.listSources().find(x => x.key === 'qsvip')
  ok('删掉一个插件后，源仍在（另一个插件还支持）',
    !!s2 && s2.plugins.length === 1)
  pool.remove('a')
  ok('插件全删光后该源从清单里消失',
    pool.listSources().every(x => x.key !== 'qsvip'))
}

{
  const pool = new PluginPool()
  pool.add({ ok: false, id: 'bad', meta: { name: '坏的' }, error: 'boom', sources: {} })
  ok('加载失败的插件不进 bySource，也就列不出来',
    pool.listSources().length === 0)
}

/* ================= 二、口径唯一：只收声明了 musicSearch 的 ================= */

ok('sources.js 导出 pluginSearchSourceKeys',
  /export function pluginSearchSourceKeys\s*\(env\)/.test(SOURCES_NC))

ok('pluginSearchSourceKeys 只收 musicSearch（local/git 这类取流源不该进搜索源）',
  /actions\.includes\('musicSearch'\)/.test(fnBody(SOURCES_NC, 'pluginSearchSourceKeys')),
  fnBody(SOURCES_NC, 'pluginSearchSourceKeys').slice(0, 200))

ok('pluginSearchSourceKeys 全程吞异常（壳内延迟求值/测试替身没有池子时不能让搜索挂）',
  /catch\s*\{/.test(fnBody(SOURCES_NC, 'pluginSearchSourceKeys')))

ok('searchSources 的 known 名单 = ALL_SOURCES + 插件可搜源（读写同一口径）',
  /ALL_SOURCES\.concat\(pluginSearchSourceKeys\(env\)\)/.test(fnBody(SOURCES_NC, 'searchSources')))

ok('searchSources 里没有残留的旧函数名 pluginSourceKeys(',
  !/[^h]pluginSourceKeys\(/.test(SOURCES_NC + API_NC + SUBSONIC_NC))

{
  const defs = (API_NC + SUBSONIC_NC).match(/function pluginSearchSourceKeys\s*\(/g) || []
  ok('api.js / subsonic.js 只是 import，不各自再定义一份',
    defs.length === 0, `定义了 ${defs.length} 次`)
}

ok('api.js / subsonic.js 都从 sources.js 导入同一份',
  /import \{[^}]*pluginSearchSourceKeys[^}]*\} from '\.\/sources\.js'/.test(API_NC)
  && /import \{[^}]*pluginSearchSourceKeys[^}]*\} from '\.\/sources\.js'/.test(SUBSONIC_NC))

/* ================= 三、searchOnline 把非内置源路由给插件 ================= */

const SEARCH_ONLINE = assertBody('searchOnline 函数体', fnBody(PROVIDERS_NC, 'searchOnline'), 1500)

ok('searchOnline 认「插件声明了 musicSearch」的源参与搜索',
  /sources\.filter\(s => PROVIDERS\[s\] \|\| canPluginSearch\(s\)\)/.test(SEARCH_ONLINE))

ok('非内置源走 pluginPool.invoke(src, \'musicSearch\', …)',
  /pluginPool\.invoke\(src, 'musicSearch'/.test(SEARCH_ONLINE))

ok('调插件时把 timeout 传下去（插件自带 15s，不传会拖慢整轮搜索）',
  /\{ keyword, page, pagesize: perSource \}, \{ timeout \}/.test(SEARCH_ONLINE))

ok('插件源的失败被记进 errors，不影响其它平台（既不抛也不把结果清零）',
  /errors\.push\(result\.timeout/.test(SEARCH_ONLINE))

ok('插件结果会被归一化成统一歌曲形状',
  /normalizePluginSong\(src, x, result\.plugin\)/.test(SEARCH_ONLINE))

{
  const nb = assertBody('normalizePluginSong 函数体', fnBody(PROVIDERS_NC, 'normalizePluginSong'), 300)
  ok('歌曲必须有 id 与 name 才收',
    /if \(!id \|\| !name\) return null/.test(nb))
  ok('interval 超过 3 小时当没给（插件若给毫秒，试听片段判据会被误判）',
    /interval > 10800\) interval = 0/.test(nb))
  ok('兼容各家字段名（duration/pic/cover/artist）',
    /raw\.duration/.test(nb) && /raw\.pic/.test(nb) && /raw\.cover/.test(nb) && /raw\.artist/.test(nb))
}

/* ================= 四、parseQuery 认插件源前缀（靠名单，不靠形状） ================= */

ok('parseQuery 有第三参 extraSources',
  /export function parseQuery\(input, fallbackSources = ALL_SOURCES, extraSources = \[\]\)/.test(PROVIDERS_NC))

ok('前缀识别靠名单校验（extraSources.some(...)），不是只看形状',
  /extraSources\.some\(s => String\(s\)\.toLowerCase\(\) === key\)/.test(fnBody(PROVIDERS_NC, 'parseQuery')))

ok('前缀不再写死 [a-z]{2}（qsvip 是五位）',
  !/\^\(all\|online\|local\|\[a-z\]\{2\}\)/.test(fnBody(PROVIDERS_NC, 'parseQuery')))

ok('providers 里 parseQuery 的前缀仍先认内置平台（不能被插件名单抢走）',
  /if \(PROVIDERS\[key\]\) return \{ sources: \[key\]/.test(fnBody(PROVIDERS_NC, 'parseQuery')))

/* ================= 五、api.js：列出来 / 勾得上 / 顺序存得住 ================= */

ok('/sources 回 pluginSources',
  /pluginSources,/.test(fnBody(API_NC, "'/sources'")) || /pluginSources,/.test(API_NC))

{
  const defs = (API_NC.match(/function pluginSourceList\s*\(/g) || []).length
  ok('pluginSourceList 只定义一次（/sources 与 /admin/search-sources 共用）', defs === 1, `定义了 ${defs} 次`)
}

ok('pluginSourceList 带 searchable 判据（前端据此只画能搜的）',
  /searchable: s\.actions\.includes\('musicSearch'\)/.test(fnBody(API_NC, 'pluginSourceList')))

ok('/admin/search-sources 的写入校验用同一份 known 名单',
  /const known = ALL_SOURCES\.concat\(pluginSearchSourceKeys\(env\)\)/.test(fnBody(API_NC, "'/admin/search-sources'")))

ok('POST 的顺序归一化也带插件源（否则已存的插件源顺序会被丢掉）',
  /normalizeSourceOrder\(body\.order, pluginSearchSourceKeys\(env\)\)/.test(fnBody(API_NC, "'/admin/search-sources'")))

ok('sourceOrder 读取时也带插件源（同一口径，不能只在写入侧）',
  (fnBody(API_NC, 'normalizeSourceOrder').length > 0
    && (API_NC.match(/normalizeSourceOrder\([^)]*pluginSearchSourceKeys\(env\)\)/g) || []).length >= 3))

ok('/search 的 parseQuery 带插件源名单（否则 source=qsvip 会被当关键词）',
  /parseQuery\(source \? `\$\{source\}:\$\{q\}` : q, await searchSources\(env, db\), pluginSearchSourceKeys\(env\)\)/.test(API_NC))

ok('subsonic 搜索同样认插件源（Subsonic 客户端也能 qsvip:关键词）',
  /parseQuery\(rawQuery, ALL_SOURCES, pluginSearchSourceKeys\(env\)\)/.test(SUBSONIC_NC))

/* ================= 六、前端：看得见、勾得上、不污染导入歌单 ================= */

{
  const rb = assertBody('管理页 renderSources 函数体', fnBody(ADMIN_NC, 'async function renderSources'), 2000)
  ok('管理页把 server.pluginSources 合并进「默认搜索源」那一列',
    /server\.pluginSources/.test(rb) && /concat\(pluginSrc\)/.test(rb))
  ok('只列 searchable 的插件源（勾一个搜不了的源 = 假开关）',
    /filter\(p => p && p\.searchable\)/.test(rb))
  ok('插件源也进 name 表（否则那列显示成 qsvip 这种 id）',
    /shortByKey\.set\(p\.key, p\.short \|\| p\.name \|\| p\.key\)/.test(rb))
}

ok('shortOf 先查 shortByKey 再回退到评分接口的 platforms',
  /if \(shortByKey\.has\(key\)\) return shortByKey\.get\(key\)/.test(
    assertBody('shortOf 函数体', fnBody(ADMIN_NC, 'function shortOf'), 100)))

ok('app.js 用 pluginSources 补 platformNames / platformShort（来源标签不失真）',
  /for \(const p of \(\(s && s\.pluginSources\) \|\| \[\]\)\)/.test(APP_NC)
  && /App\.platformShort\[p\.key\] = p\.short \|\| p\.name \|\| p\.key/.test(APP_NC))

ok('搜索页给插件源单独一行 chip（不挤进等分 nowrap 的七个里）',
  /const extraChips = \(source && !PLATFORMS\.some\(p => p\.key === source\)\)/.test(APP_NC))

ok('「导入歌单」的来源下拉仍只用内置 PLATFORMS，不吃 platformNames',
  /PLATFORMS\.map\(p => '<option value="' \+ p\.key \+ '">'/.test(fnBody(APP_NC, "id === 'importSource'") )
  || /PLATFORMS\.map\(p => '<option value="' \+ p\.key/.test(APP_NC))
ok('导入下拉不再从 App.platformNames 生成选项（那是搜索用的，含插件源）',
  !/Object\.keys\(App\.platformNames\)\.map\(k => '<option/.test(APP_NC))

ok('插件池侧 listSources/sourceName 都实现了',
  /listSources\(\)\s*\{/.test(POOL_NC) && /sourceName\(source\)\s*\{/.test(POOL_NC))

console.log(`\n===== plugin-sources：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
