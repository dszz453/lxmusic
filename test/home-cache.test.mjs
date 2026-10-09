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
/**
 * 去注释副本 —— 所有「**不包含**」型断言必须用它。
 *
 * 注释里必然写着那条规则的**反面写法**（下面那段说明就一字不差地引用了旧的
 * `App.offline && !!API.getToken()`），拿整文件做「不包含」断言会永远红。
 * 这是这个项目已经踩过的坑，见 daily.test.mjs 的 deComment。
 */
const APPJS_NC = APPJS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
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
  /**
   * 切两段：外层的 cachedHomeFallback（算键：天 + 音源清单）与内层的
   * cachedHomeFallbackByKey（读缓存 / 回源 / 宽限期）。
   *
   * 为什么要切**两段**：2026-10-09 给「一次登录打三份 /home」加同刻单飞时，
   * 键的计算必须留在外层（它要 await searchSources），而单飞与宽限期在内层。
   * 原来只切 `cachedHomeFallback` 一个函数，加了这一层之后就会切到一个几百字节的
   * 壳子 —— 下面那些断言会**全部变成空断言而依然显示通过**，正是本文件开头
   * 「接好了但没人调」那类静默失效。所以这里两个都切，并各自断言长度。
   */
  const fb0 = (() => {
    const a = SRV.indexOf('async function cachedHomeFallback(')
    const b = SRV.indexOf('\n}', a)
    return (a >= 0 && b > a) ? SRV.slice(a, b) : ''
  })()
  const fb = (() => {
    const a = SRV.indexOf('async function cachedHomeFallbackByKey(')
    const b = SRV.indexOf('\n}', a)
    return (a >= 0 && b > a) ? SRV.slice(a, b) : ''
  })()
  const fbHelper = (() => {
    const a = SRV.indexOf('function homeFallbackFromCache(')
    const b = SRV.indexOf('\n}', a)
    return (a >= 0 && b > a) ? SRV.slice(a, b) : ''
  })()
  ok('cachedHomeFallback（算键那一层）切得出来', fb0.length > 200, 'len=' + fb0.length)
  ok('cachedHomeFallbackByKey 存在且切得出来（否则下面是空断言）', fb.length > 400, 'len=' + fb.length)
  ok('homeFallbackFromCache 切得出来（否则下面几条是空断言）', fbHelper.length > 100, 'len=' + fbHelper.length)
  ok('兜底分支改走它，不再内联现场搜索',
    /const fb = await cachedHomeFallback\(env, db\)/.test(SRV))
  ok('关键词轮换只在这一处算（散成两份迟早对不上）',
    (SRV.match(/HOME_KEYWORDS\[/g) || []).length === 1,
    '出现 ' + (SRV.match(/HOME_KEYWORDS\[/g) || []).length + ' 次')
  ok('缓存键按「天 + 音源清单」，不按用户（这份内容本来就跟用户无关）',
    /'https:\/\/lx\.cache\.internal\/home-fallback\/' \+ dayIndex \+ '\/' \+ sources\.join\('-'\)/.test(fb0))
  ok('只在拿到非空 hot 时才写（空结果多半是上游抖动，钉住它首页就空 20 分钟）',
    /if \(hot\.length\) \{/.test(fb))
  ok('榜单没拿到时给短 TTL，恢复后能很快补上',
    /const ttl = charts\.length \? HOME_FALLBACK_TTL_MS : HOME_FALLBACK_SHORT_TTL_MS/.test(fb))
  ok('TTL 存在记录里、按时间戳自己算（壳里 edgeCache 退化成 Map 时寿命只能靠它）',
    /const ttl = \(rec && rec\.ttl\) \|\| HOME_FALLBACK_TTL_MS/.test(fb) &&
    /const age = Date\.now\(\) - rec\.ts/.test(fb) &&
    /if \(age < ttl\) return homeFallbackFromCache\(rec, keyword, false\)/.test(fb))
  ok('命中缓存时连榜单都不回源',
    /Array\.isArray\(rec\.hot\) && rec\.hot\.length/.test(fb) && /fromCache: true/.test(fbHelper))
  /**
   * 这一组是 2026-10-08「首页又要转好几秒」的根因护栏。
   * TTL 一到就得完整重算（抓榜单 + 跨 6 源搜 24 首 = 好几秒），而用户隔一阵
   * 打开一次、几乎每次都正好撞在冷的那一侧。兜底内容全站同一份、当天更是一模一样，
   * 没有任何理由为了刷新时间戳让用户等 —— 先给旧的、后台补新的。
   */
  ok('过期后仍有宽限期，且宽限期内**不**回源（否则 TTL 一到用户就得再等几秒）',
    /HOME_FALLBACK_STALE_MS = 12 \* 60 \* 60 \* 1000/.test(SRV) &&
    /if \(age < HOME_FALLBACK_STALE_MS\) stale = rec/.test(fb))
  ok('宽限期内先交旧的、重算甩到后台（waitUntil），且**不**用 Promise.race 甩副作用',
    /const work = recompute\(\)/.test(fb) && /env\.waitUntil\(work\)/.test(fb) &&
    !/withDeadline\(compute/.test(fb))
  /**
   * 2026-10-09 加的同刻单飞。这一组要钉的是**粒度**，不是「有没有这个词」：
   *   · 单飞必须包住 compute（贵的只有它）；
   *   · 键必须带这份内容自己的缓存键 —— 不带就把不同音源 / 不同天算错成一份；
   *   · 失败要不留存，否则一次抖动会变成「永久不再重算」。
   */
  ok('真正贵的那一段（compute）走同刻单飞',
    /const recompute = \(\) => once\(key\.url \+ '#compute', compute\)/.test(fb))
  ok('单飞键带上这份内容自己的缓存键（否则不同音源/不同天会串成一份）',
    /key\.url \+ '#compute'/.test(fb))
  ok('单飞失败不留存（一次抖动不能变成「永久不再重算」）',
    /singleFlight\.delete\(key\)/.test(SRV))
  ok('交出去的那份被标记成 stale（debug 里能看出来走的是哪条路）',
    /homeFallbackFromCache\(stale, keyword, true\)/.test(fb) && /stale: !!stale/.test(fbHelper))
  ok('带 ?debug=1 时吐出两段的真实耗时（下次再慢，有数可看）',
    /url\.searchParams\.get\('debug'\) === '1'/.test(SRV) &&
    /fromCache: fb\.fromCache, hot: fb\.hot\.length/.test(SRV))
}

/* ══════════════ 4c. 客户端：首帧也要能用上磁盘缓存 ══════════════ */

console.log('\n== 4c. 首帧不等网络：身份还没确认时也读得到自己的缓存 ==')
{
  const idBody = (() => {
    const a = APPJS.indexOf('const LAST_USER_KEY')
    const b = APPJS.indexOf('function homeCacheIdentity', a)
    return (a >= 0 && b > a) ? APPJS.slice(a, b) : ''
  })()
  ok('身份回落那段切得出来（否则下面是空断言）', idBody.length > 200, 'len=' + idBody.length)
  /**
   * 这一组是 2026-10-08「打开客户端一片空白，点一下发现才出来」的另一半根因。
   *
   * 缓存身份 = 服务器 + 账号，而账号要等 `/api/me`。首帧若非等它不可，
   * 磁盘里那份明明还在的首页就一点也帮不上忙 —— 上游一慢就是「打开空白、
   * 点一下才出来」；而点完之后那份内容跟上次**一模一样**（用户原话），
   * 也就是说这趟等待从头到尾都是白等的。
   */
  ok('身份未知时回落到上一次登录的用户名（首帧才读得到自己的缓存）',
    /function currentUser\([\s\S]{0,400}lastUserName\(\)/.test(idBody))
  ok('真实身份优先于回落值（有 App.user 就不该用旧的）',
    /if \(App\.user && App\.user\.username\) return App\.user\.username/.test(idBody))
  ok('身份未知时**不**写缓存（否则会记成匿名，换个人登录先看到上一个人的推荐）',
    /if \(!who\) return/.test(writeBody))
  ok('登录成功就记下身份（别只依赖 /api/me 那一趟）',
    (APPJS.match(/rememberUser\(res\.user && res\.user\.username\)/g) || []).length >= 2)
  ok('退出登录清掉临时身份', /case 'logout'[\s\S]{0,500}rememberUser\(''\)/.test(APPJS))
  /**
   * 「登出」的判据必须是服务端**明确拒绝**（401/403），不能是「这一趟没问到」。
   *
   * 2026-10-09 报障：手机上「发现页一直显示未登录，重新登录后才正常」。
   * 根因就是这里把 meRes.error（超时 / 断网 / 服务器重启中）也当成了登出，
   * 令牌被当场擦掉。下面几条把两个方向都钉住：
   *   · 判据里有 401/403；
   *   · 「被明确拒绝」分支确实清令牌、清身份、回登录页（否则拿着死令牌一直转圈）；
   *   · 「只是没问到」分支**绝不**清令牌、绝不跳登录页（那等于把用户踢出去）。
   */
  ok('登出判据只看服务端明确拒绝（401/403），不是「没问到」',
    /tokenRejected\s*=\s*[\s\S]{0,60}401[\s\S]{0,40}403/.test(APPJS))
  const rejectedBranch = (/if \(tokenRejected\) \{([\s\S]*?)\n    \}/.exec(APPJS) || ['', ''])[1]
  ok('被明确拒绝 → 清令牌 + 清身份 + 回登录页',
    rejectedBranch.length > 40 && /API\.setToken\(''\)/.test(rejectedBranch)
    && /rememberUser\(''\)/.test(rejectedBranch) && /#\/login/.test(rejectedBranch),
    'len=' + rejectedBranch.length)
  const offlineBranch = (/if \(meRes\.error\) \{([\s\S]*?)\n    \} else if \(!meRes\.user\)/.exec(APPJS) || ['', ''])[1]
  ok('「没问到」那段切得出来（切不出来下面就是空断言）', offlineBranch.length > 80, 'len=' + offlineBranch.length)
  ok('超时/断网**不**清令牌、**不**跳登录页（否则服务器重启一下用户就被登出了）',
    offlineBranch.length > 80 && !/setToken/.test(offlineBranch)
    && !/rememberUser\(''\)/.test(offlineBranch) && !/#\/login/.test(offlineBranch))
  ok('没确认过身份时退回上一次的 username 继续渲染（发现页才不会显示成未登录）',
    /if \(identityTrusted\) \{[\s\S]{0,120}else \{[\s\S]{0,300}lastUserName\(\)/.test(offlineBranch))
  ok('身份确认后写入临时身份（下一次冷启动的首帧靠它）',
    /trustIdentity\(meRes\.user\)[\s\S]{0,200}rememberUser\(App\.user/.test(APPJS))

  /* ------------------------------------------------------------------------
   * 「手里那份身份是确认过的时候，不许被『这一趟没问到』降级」
   *
   * 2026-10-09 老板报：「Docker 版客户端**重新登录**之后，我的歌单是空白、加载要半天，
   * 这时候点『我的』发现未登录，大概 10 秒才能登录」。
   * 真浏览器取证（tools/login-flow-probe.mjs --me-fail）复现的是**降级**这一段：
   *
   *     /api/login 正文给的身份 {probe, isAdmin:true}
   *        ↓ 紧接着的 /api/me 失败
   *     App.user 变成 {probe, isAdmin:false, unconfirmed:true} + offline:true
   *
   * 登录正文里的身份是服务端几毫秒前刚核对过口令给的 —— 第二趟问不到只是「没问到」，
   * 不能把它抹掉。下面几条把这条规矩钉住（含「标记的来源」与「什么时候才作废」）。
   * ---------------------------------------------------------------------- */
  ok('有「身份已确认」这个标记，且默认是未确认',
    /userTrusted: false/.test(APPJS) && /let identityTrusted = false/.test(APPJS))
  ok('登录 / 初始化成功那一刻就把身份标成确认过的（不再等第二趟 /api/me 说了算）',
    (APPJS.match(/trustIdentity\(res\.user\)/g) || []).length >= 2,
    '出现 ' + (APPJS.match(/trustIdentity\(res\.user\)/g) || []).length + ' 次')
  ok('「没问到」时先看标记：确认过的身份原样留着，不去降级、也不标离线',
    /if \(meRes\.error\) \{[\s\S]{0,320}if \(identityTrusted\) \{[\s\S]{0,120}App\.offline = false/.test(APPJS))
  ok('「被明确拒绝」与「退出登录」都把标记一起清掉（那才是真的换人了）',
    /forgetIdentity\(\)/.test(rejectedBranch) && /case 'logout'[\s\S]{0,600}forgetIdentity\(\)/.test(APPJS))
  ok('清身份时把「代次」+1（补确认的定时器迟到时据此作废，不会把人又登回去）',
    /function forgetIdentity\(\) \{[\s\S]{0,80}identityGen\+\+/.test(APPJS))

  /* ------------------------------------------------------------------------
   * 补确认：档位、以及「确认回来之后屏幕要跟着改」
   *
   * 原来写的是 `setTimeout(..., 3000 * identityRetry)` + `if (identityRetry >= 2) return`，
   * 看着是退避两次，其实这个函数只有一个调用点（boot 的「没问到」分支），
   * 所以只排了一次 3 秒的定时器 —— 那一发要是也没够着，就**永远不再试**了。
   * 而且它成功时只改内存、不重画，用户屏幕上那句「未登录」会一直挂着。
   * ---------------------------------------------------------------------- */
  ok('补确认有档位表，且第一档是「立刻」（不为一次瞬时抖动白等 3 秒）',
    /IDENTITY_RETRY_DELAYS = \[0,/.test(APPJS))
  ok('档位不止两发（原来那个「两次」是假的，只有一个调用点）',
    (() => {
      const m = /IDENTITY_RETRY_DELAYS = \[([^\]]*)\]/.exec(APPJS)
      return !!m && m[1].split(',').filter((s) => s.trim()).length >= 3
    })())
  ok('一发失败就自己排下一档（否则第一发没够着就再也不试）',
    /\.catch\(\(\) => \{[\s\S]{0,160}if \(gen === identityGen\) confirmIdentityLater\(\)/.test(APPJS))
  ok('身份从「空 / 未确认」回到「已确认」时重画一次（否则屏幕上那句未登录永远留着）',
    /const wasBlind = !App\.user \|\| App\.user\.unconfirmed/.test(APPJS) &&
    /if \(wasBlind\) route\(\)/.test(APPJS))
  ok('补确认成功的回调会比对代次（用户已经登出的话就作废）',
    /if \(gen !== identityGen\) return/.test(APPJS))

  /**
   * 界面上「没问到身份」与「确实没登录」必须分得开。
   *
   * 老板看到的那句「未登录」就是这里来的 —— 而那一刻的真实状态是「令牌还在、
   * 只是没问到」。两者处置完全不同（前者等一下就好，后者才要输密码），
   * 长得一样就等于把用户逼去「退出再登一次」。顺带给一个手动重新确认的入口。
   */
  ok('「我的」页把「没问到」和「未登录」分开显示',
    /const pending = !u\.username && !!API\.getToken\(\) && !App\.userTrusted/.test(APPJS)
    && /pending \? '正在确认登录状态…' : '未登录'/.test(APPJS))
  /**
   * ⚠ 判据必须是「**有令牌 + 身份未确认**」，不能是 `App.offline`。
   *
   * 上一版写的是 `App.offline && !!API.getToken()`，**漏掉了「还没问」这一相**：
   * `boot()` 的「首帧不等网络」抢跑会先 `route()` 画一版，那一刻 `App.user` 还是 null
   * 而 `App.offline` 还是默认的 false —— 于是身份回来之前印的是「未登录」，
   * 而不是「正在确认登录状态…」。服务端一慢（Docker 上 `/api/home` 曾同步等 9 秒、
   * 把 `/api/me` 压在后面），这句错话会停留好几秒 ——
   * 报障原话「打开 APP 后，app 一直在重新登录后台」就是这么来的。
   */
  ok('⚠ pending 判据含「抢跑阶段」（那时 App.offline 还是 false，会误印「未登录」）',
    /const pending = !u\.username && !!API\.getToken\(\) && !App\.userTrusted/.test(APPJS_NC)
    && /App\.offline && !!API\.getToken\(\)/.test(APPJS_NC) === false)
  ok('只是没问到时不写死「普通账号」（那是「确实没登录」才该有的样子）',
    /u\.username\s*\n?\s*\?\s*\(u\.isAdmin \? '管理员账号' : '普通账号'\)/.test(APPJS))
  ok('给一个手动「重新确认」（四次自动补确认都没够着时的自救，不用退出重登）',
    /data-act="retry-identity"/.test(APPJS)
    && /case 'retry-identity'[\s\S]{0,160}identityRetry = 0[\s\S]{0,80}confirmIdentityLater\(\)/.test(APPJS))
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
