/**
 * 首页缓存 + 服务端版本收敛 —— 静态接线审计
 *
 * 为什么这两件事需要一份「不跑起来的」测试：
 *
 * 1) **首页缓存是「接好了但没人调」的高危形状。**
 *    这类 bug 的运行特征是「不报错、也不生效」—— 函数写好了，可某个分支里
 *    根本没走到它，用户那边一切照旧（还是几秒骨架屏），而日志里干干净净。
 *    单元测试抓不到（函数本身是对的），真机上也很难看出差别。
 *    只能从接线层面查：缓存到底在哪个分支被读、在哪个分支被写、
 *    有没有一条路径会把它绕过。本文件就干这个。
 *
 * 2) **缓存的正确性全在边界上，而不在主路径上。**
 *    主路径「读到旧的就先画出来」写错了一眼能看出来；真正会出事故的是：
 *    · 换服务器 / 换账号之后还拿上一个人的数据（串号）；
 *    · 读到坏数据后「读一次写一次」把它续命，于是永远刷不掉；
 *    · 后台刷新把用户正在看的内容整块换掉。
 *    这三条都没有报错，只有断言能钉住。
 *
 * 3) **服务端版本「只留在设置页」是条会被无声打破的规矩。**
 *    它的破坏方式极其自然：某个新页面想显示版本，顺手读一下全局变量 ——
 *    而那个全局变量恰好会被设置页写脏。所以既要断言设置页**保留**了那一行，
 *    也要断言别处**不再**出现。
 *
 * 跑法：node test/home-cache.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fails.push(name + (detail ? '  → ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''))
  }
}

const APPJS = read('public/js/app.js')
const SRV = read('src/server/api.js')
const SHELL = read('client/rn/src/50-shell.js')
const BRANDJS = read('client/rn/src/20-brand.js')

/* 把 pageHome 的函数体切出来。
 * 边界取下一个函数（dailyDesc）而不是「某个大括号」—— 大括号计数在
 * 模板字符串里的 `}` 上一定会数错，而这种错误会表现为「断言悄悄测了半段」。 */
const homeBody = (() => {
  const a = APPJS.indexOf('async function pageHome()')
  const b = APPJS.indexOf('function dailyDesc(')
  return (a >= 0 && b > a) ? APPJS.slice(a, b) : ''
})()

/* writeHomeCache 的函数体。边界取下一个函数 homeSignature —— 同上，别数大括号。 */
const writeBody = (() => {
  const a = APPJS.indexOf('function writeHomeCache(data, who)')
  const b = APPJS.indexOf('function homeSignature(', a)
  return (a >= 0 && b > a) ? APPJS.slice(a, b) : ''
})()

/* ══════════════ 1. 主路径：先出旧内容，再后台刷新 ══════════════ */

console.log('\n== 1. 首页主路径：冷启动先画旧内容，再后台补一次 ==')
{
  ok('pageHome 真的被切出来了（否则后面全是空断言）',
    homeBody.length > 400, 'len=' + homeBody.length)
  ok('冷启动会去读持久缓存',
    /const rec = readHomeCache\(who\)/.test(homeBody))
  ok('读到旧内容就标记来自磁盘（决定要不要补刷新）',
    /if \(rec\) \{ cached = rec\.data; fromDisk = true \}/.test(homeBody))
  ok('**先**把内容画出来，**再**去请求 —— 这就是「秒开」的全部秘密',
    homeBody.indexOf('renderHome(cached)') >= 0 &&
    homeBody.indexOf('renderHome(cached)') < homeBody.indexOf('await API.home()'),
    'renderHome@' + homeBody.indexOf('renderHome(cached)') +
    ' / fetch@' + homeBody.indexOf('await API.home()'))
  ok('只有「从磁盘捞出来的」才补一次刷新；内存命中不重复拉',
    /if \(fromDisk\) refreshHomeInBackground\(who\)/.test(homeBody))
  ok('拿到真数据后写缓存', /writeHomeCache\(data, who\)/.test(homeBody))
  ok('内存里那份会记住归属账号',
    /App\.homeOwner = who/.test(homeBody))
}

/* ══════════════ 2. 边界：串号 / 超期 / 坏数据 / 打断用户 ══════════════ */

console.log('\n== 2. 边界：缓存身份、超期、坏数据、不打断用户 ══════════════')
{
  const ident = /function homeCacheIdentity\(who\)\s*\{([\s\S]*?)\n  \}/.exec(APPJS)
  ok('缓存身份函数存在', !!ident)
  ok('身份含「服务器」（换档案 = 换地址）',
    !!ident && /LX_REMOTE_BASE/.test(ident[1]),
    ident ? ident[1].trim().slice(0, 120) : '')
  ok('身份含「账号」（同一台手机换人登录不能串）',
    !!ident && /\+\s*who\b/.test(ident[1]))

  ok('读到身份不匹配就当没有（比拼 key 更抗改错）',
    /rec\.id !== homeCacheIdentity\(who\)/.test(APPJS))
  ok('缓存有最大年龄，超期直接丢弃',
    /const HOME_CACHE_MAX_AGE/.test(APPJS) &&
    /Date\.now\(\) - rec\.ts > HOME_CACHE_MAX_AGE/.test(APPJS))
  ok('坏数据（ok!==true）不读也不写 —— 否则会自己给自己续命',
    /if \(!rec \|\| !rec\.data \|\| !rec\.data\.ok\) return null/.test(APPJS) &&
    /if \(!data \|\| !data\.ok\) return/.test(APPJS))
  ok('写缓存整段吞异常（配额满 / 无痕模式不能把首页搞崩）',
    writeBody.length > 100 && /try \{/.test(writeBody) && /catch \{/.test(writeBody),
    'len=' + writeBody.length)
  ok('写完回读一次自检：U.store.set 是静默吞错的，不查就永远查不出「写了没写成」',
    /const back = U\.store\.get\(HOME_CACHE_KEY, null\)/.test(writeBody) &&
    /console\.warn\('\[lx\] 首页缓存没能落到本地存储/.test(writeBody))

  ok('后台刷新不 await（不能挡住首屏）',
    !/async function refreshHomeInBackground/.test(APPJS) &&
    /function refreshHomeInBackground\(who\)[\s\S]{0,120}API\.home\(\)\.then/.test(APPJS))
  ok('后台请求失败静默（旧内容还在，弹错误更糟）',
    /\.catch\(\(\) => \{ \/\* 后台失败静默/.test(APPJS))
  ok('页面已经切走就不动 DOM',
    /function refreshHomeInBackground[\s\S]{0,900}parseHash\(\)\.path !== '\/'/.test(APPJS))
  ok('用户已经往下翻过就不重绘（不整块换掉他正在看的东西）',
    /if \(view\.scrollTop > 60\) return/.test(APPJS))
  ok('内容其实没变也不重绘（封面地址抖一下不算变）',
    /homeSignature\(before\) === homeSignature\(data\)/.test(APPJS) &&
    /function homeSignature/.test(APPJS))
  ok('指纹只看看得见的内容（标题 / 榜单 id / 歌名歌手）',
    /keyword/.test(/function homeSignature\(data\)\s*\{([\s\S]*?)\n  \}/.exec(APPJS)[1]) &&
    /s\.name \+ '\|' \+ s\.singer/.test(APPJS))
  ok('指纹函数被切出来了（否则上一条是空断言）',
    /function homeSignature\(data\)\s*\{([\s\S]*?)\n  \}/.test(APPJS))
}

/* ══════════════ 3. 失效与回写点 ══════════════ */

console.log('\n== 3. 失效与回写：换账号、换一批、显式重载 ==')
{
  ok('换账号时内存那份作废（退出再登录不整页重载）',
    /if \(App\.home && App\.homeOwner !== who\) App\.home = null/.test(APPJS))
  ok('退出登录清内存那份，并写明磁盘缓存为什么故意留着',
    /App\.homeOwner = ''/.test(APPJS) && /磁盘缓存\*\*故意留着\*\*/.test(APPJS))
  ok('「换一批」之后回写缓存（否则下次冷启动又是旧那一批）',
    /writeHomeCache\(App\.home, App\.homeOwner\)/.test(APPJS))
  ok('显式失效（加歌进歌单 / 删歌单 / 重载首页）仍会把 App.home 置空',
    (APPJS.match(/App\.home = null/g) || []).length >= 4,
    '出现 ' + (APPJS.match(/App\.home = null/g) || []).length + ' 次')
}

/* ══════════════ 4. 服务端：榜单回源缓存 + 硬上限 ══════════════ */

console.log('\n== 4. 服务端榜单缓存（/home 里最贵的一步）==')
{
  ok('cachedToplists 存在', /async function cachedToplists\(\)/.test(SRV))
  ok('TTL 是 15 分钟', /TOPLISTS_TTL_MS = 15 \* 60 \* 1000/.test(SRV))
  ok('TTL 自己按时间戳算，不交给 Cache-Control',
    /typeof rec\.ts === 'number' && Date\.now\(\) - rec\.ts < TOPLISTS_TTL_MS/.test(SRV))
  ok('上游失败 / 空列表**不**写缓存（一次抖动不能钉住 15 分钟）',
    /const list = await withDeadline\(fetchToplists\(\), TOPLISTS_DEADLINE_MS, \[\]\)\s*\n\s*if \(Array\.isArray\(list\) && list\.length\)/.test(SRV))
  /**
   * 这条是本次的根因护栏。
   * `wy.getToplists()` 内部不是一次请求：先打 music.163.com（retry 1 = 两遍），
   * 失败再退 eapi，每一步都自带超时 —— 上游「连得上但回得慢」时能吃掉十几秒，
   * 而它是 /api/home 的第一段。裸 await 一旦被加回来，首页就又变成看运气。
   */
  ok('榜单回源带硬上限（不许裸 await fetchToplists）',
    /const list = await withDeadline\(fetchToplists\(\)/.test(SRV) &&
    !/await fetchToplists\(\)/.test(SRV),
    '裸 await 出现 ' + (SRV.match(/await fetchToplists\(\)/g) || []).length + ' 次')
  const dl = /const TOPLISTS_DEADLINE_MS = (\d+)/.exec(SRV)
  ok('上限是有限值且不大于 3 秒', !!dl && Number(dl[1]) <= 3000, dl ? dl[1] + ' ms' : '取不到')
  ok('/home 的两条出口都走缓存（AI 命中分支 + 榜单）',
    (SRV.match(/cachedToplists\(\)/g) || []).length >= 3,
    '出现 ' + (SRV.match(/cachedToplists\(\)/g) || []).length + ' 次')
  ok('榜单缓存键不含用户 / token（含了就等于每人一份，白缓存）',
    /new Request\('https:\/\/lx\.cache\.internal\/toplists\/wy'/.test(SRV))
}

/* ══════════════ 4b. 服务端：首页兜底内容整份进缓存 ══════════════ */

console.log('\n== 4b. /home 兜底分支：整份结果进缓存，不再每次回源 ==')
{
  const fb = (() => {
    const a = SRV.indexOf('async function cachedHomeFallback(')
    const b = SRV.indexOf('\n}', a)
    return (a >= 0 && b > a) ? SRV.slice(a, b) : ''
  })()
  ok('cachedHomeFallback 存在且切得出来（否则下面是空断言）', fb.length > 400, 'len=' + fb.length)
  ok('兜底分支改走它，不再内联现场搜索',
    /const fb = await cachedHomeFallback\(env, db\)/.test(SRV))
  ok('关键词轮换只在这一处算（散成两份迟早对不上）',
    (SRV.match(/HOME_KEYWORDS\[/g) || []).length === 1,
    '出现 ' + (SRV.match(/HOME_KEYWORDS\[/g) || []).length + ' 次')
  ok('缓存键按「天 + 音源清单」，不按用户（这份内容本来就跟用户无关）',
    /'https:\/\/lx\.cache\.internal\/home-fallback\/' \+ dayIndex \+ '\/' \+ sources\.join\('-'\)/.test(fb))
  ok('只在拿到非空 hot 时才写（空结果多半是上游抖动，钉住它首页就空 20 分钟）',
    /if \(hot\.length\) \{/.test(fb))
  ok('榜单没拿到时给短 TTL，恢复后能很快补上',
    /const ttl = charts\.length \? HOME_FALLBACK_TTL_MS : HOME_FALLBACK_SHORT_TTL_MS/.test(fb))
  ok('TTL 存在记录里、按时间戳自己算（壳里 edgeCache 退化成 Map 时寿命只能靠它）',
    /const ttl = \(rec && rec\.ttl\) \|\| HOME_FALLBACK_TTL_MS/.test(fb) &&
    /Date\.now\(\) - rec\.ts < ttl/.test(fb))
  ok('命中缓存时连榜单都不回源',
    /Array\.isArray\(rec\.hot\) && rec\.hot\.length/.test(fb) && /fromCache: true/.test(fb))
  ok('带 ?debug=1 时吐出两段的真实耗时（下次再慢，有数可看）',
    /url\.searchParams\.get\('debug'\) === '1'/.test(SRV) &&
    /fromCache: fb\.fromCache, hot: fb\.hot\.length/.test(SRV))
}

/* ══════════════ 5. 服务端版本只在设置页 ══════════════ */

console.log('\n== 5. 服务端版本只在设置页露出 ==')
{
  ok('设置页仍有专门的服务端版本行（收敛 ≠ 删掉）',
    /id="verHost"/.test(APPJS) && /getElementById\('verHost'\)/.test(APPJS))
  ok('app.js 只读 window.LX_VERSION_LINE，不再往里追加',
    !/LX_VERSION_LINE\s*(\+?=)/.test(APPJS),
    '出现了赋值：' + (/LX_VERSION_LINE\s*(\+?=)/.exec(APPJS) || ['', ''])[0])
  ok('跨端层的版本行只补客户端自己那一半',
    /lx-client-ver/.test(BRANDJS) && !/' · 服务端 '/.test(BRANDJS))
  ok('50-shell 不再声称「双版本号」',
    !/双版本号/.test(SHELL))
}

/* ------------------------------------------------------------------------- 汇总 */

console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log(`❌ 首页缓存 / 版本收敛：${pass} 通过，${fails.length} 失败`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
} else {
  console.log(`✅ 首页缓存 / 版本收敛：${pass} 项全部通过`)
}
