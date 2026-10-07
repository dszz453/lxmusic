#!/usr/bin/env node
/**
 * 取流候选挑选：**体积优先**（防试听片段）。
 *
 * 为什么单独测这一条：
 *   各音源插件对不同音质返回的是**不同来源**的地址 —— 低音质常落到第三方中转源，
 *   那些源给的是试听片段（三十多秒）；Hi-Res 走正版直链给完整曲目。
 *   而原逻辑是「谁先探通就用谁」，试听片段只要先探通就会被选中，
 *   用户看到的现象就是「同一首歌换个音质，长度就变了」。
 *
 *   修法是在探通第一条之后再等一个 450ms 的收敛窗口，把同期探通的候选收齐，
 *   按「官方直链 → 体积大 → 非弱源」挑。本脚本用一个假的 outbound fetch
 *   把「先探通的是片段、后探通的是完整版」这个时序精确造出来，验挑选结果。
 *
 * 用法：node test/stream-pick.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'stream.js'), 'utf8')

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

/* ---------------- 被测函数：把 stream.js 里的挑选逻辑单独拿出来验 ---------------- */

/**
 * **不自己另写一套正则和排序** —— 这是上一版测试的问题所在。
 *
 * 上一版在测试里带了 OFFICIAL/WEAK 两套平行正则，其中把 music.163.com 当成
 * 官方域名，而源码里它恰恰在 WEAK_HOSTS（已知死接口：outer/url 302 → /404）。
 * 于是「测试全绿、线上照错」，而且测试里那句断言本身的描述文字都自相矛盾。
 *
 * 现在改成**从源码里抽真身**：正则名单直接 eval 源码里那两行的字面量，
 * 排序规则抽函数体再 eval。这样测试验的是产品里跑的那份逻辑，
 * 源码改了测试立刻跟着变（改坏了会红），不存在两套实现漂移的余地。
 */
function extractArrayLiteral(name) {
  const m = SRC.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])`, 'm'))
  if (!m) throw new Error(`没能在 src/lib/stream.js 里找到 ${name} —— 是不是改名了？`)
  // 字面量里只有正则和空白，eval 是安全的；用 Function 求值避免污染作用域
  return new Function(`return ${m[1]}`)()
}

const OFFICIAL = extractArrayLiteral('OFFICIAL_HOSTS')
const WEAK = extractArrayLiteral('WEAK_HOSTS')

/** 从源码抽 pickBest 的函数体 —— 抽出来的就是产品里那一份 */
function extractPickBest() {
  const m = SRC.match(/const pickBest = \(list\) => \{([\s\S]*?)\n  \}/)
  if (!m) throw new Error('没能在 src/lib/stream.js 里找到 pickBest')
  return new Function('list', m[1])
}
const pickBest = extractPickBest()

/** 同理抽出 compareCandidates，用来断言两份排序档位一致 */
function extractCompare() {
  const m = SRC.match(/function compareCandidates\(a, b\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('没能在 src/lib/stream.js 里找到 compareCandidates')
  return new Function('a', 'b', m[1])
}
const compareCandidates = extractCompare()

function hostMatches(u, res) {
  try { const h = new URL(u).hostname; return res.some(re => re.test(h)) } catch { return false }
}

/* ---------------- 1. 纯挑选规则 ---------------- */

console.log('\n== 1. 挑选规则：体积优先 ==')
// 来源用源码里真实存在的名单来标，别自己臆造域名（见上面 extractArrayLiteral 的说明）
const snippet = { url: 'https://weak-cdn.example.com/snippet.mp3', from: '第三方中转片段', size: 1 * 1024 * 1024, official: false, weak: false, native: false }
const full = { url: 'https://m801.music.126.net/full.mp3', from: '官方直链', size: 9 * 1024 * 1024, official: true, weak: false, native: false }

check('完整版胜出（即使它后探通）', pickBest([snippet, full]) === full)
check('顺序反过来也一样（与到达顺序无关）', pickBest([full, snippet]) === full)
check('只要片段可用时仍然用它（能出声比不出声强）', pickBest([snippet]) === snippet)

console.log('\n== 2. 官方直链优先于「体积更大但来源弱」 ==')
const bigWeak = { url: 'https://weak-cdn.example.com/big.mp3', from: '中转大文件', size: 20 * 1024 * 1024, official: false, weak: false, native: false }
check('官方 9MB > 弱源 20MB', pickBest([bigWeak, full]) === full,
  pickBest([bigWeak, full]).from)

console.log('\n== 2b. 已知死接口（weak）永远排最后 ==')
/**
 * 这一组是**本轮从测试里揪出来的真 bug**。
 * 上一版 pickBest 把 official 排第一档、weak 排第三档；而 compareCandidates
 * 是 weak 第一档。同一份文件两套顺序 ⇒ 走哪条路径结果不同。
 * 现实后果：WEAK_HOSTS 里是已知死接口（music.163.com 的 outer/url 实测 302 → /404），
 * 它只要 HEAD 探测时侥幸回了 content-range，就会在 pickBest 那一路被抬到
 * 健康的官方 CDN 前面 —— 而它恰恰是放不出声的那条。
 */
const deadButBig = { url: 'https://music.163.com/song/media/outer/url?id=1.mp3', from: '已知死接口', size: 50 * 1024 * 1024, official: false, weak: true, native: false }
check('死接口体积再大也输给健康官方直链', pickBest([deadButBig, full]) === full, pickBest([deadButBig, full]).from)
check('死接口也输给普通第三方源（它有声）', pickBest([deadButBig, snippet]) === snippet, pickBest([deadButBig, snippet]).from)
check('只有死接口可用时仍返回它（不是直接判无源）', pickBest([deadButBig]) === deadButBig)

console.log('\n== 3. 体积未知（size=0）==')
const unknown = { url: 'https://x.example.com/a.mp3', from: '未知源', size: 0, official: false, weak: false, native: false }
/**
 * size=0 的语义是「探不出体积」。两个方向都要说清楚，别只验一半：
 *
 *   ① 输给**已知的完整版** —— 有实据（9MB > 0）。这一条是用户报的那个 bug
 *      的主要修复路径，必须有。
 *   ② 输给**已知的小片段** —— 看起来反直觉，但**这是对的**，不是 bug。
 *      理由在 stream.js:280 那句注释里：「官方 CDN……探测得到 content-range
 *      （第三方中转往往不返回，体积算不出来）」。也就是说 size=0 在实测里
 *      与「第三方中转」强相关，而第三方中转正是三十多秒试听片段的来源 ——
 *      所以 size=0 是一个**轻微负面信号**，不是中性。
 *
 *      反过来说：一个「有体积且已知很小」的候选至少是**可度量的**，
 *      优先它好过一个连长度都问不出来的。真要严格区分「小片段」和
 *      「完整但不说长度」，当前信息量不够，硬猜只会引入新的误判。
 *
 * 上一版这里写反了（期望 unknown 赢过 snippet），而且断言描述本身自相矛盾
 * （「未知体积仍优先于已知的小片段吗？—— 不」）。本轮按实测语义修正，
 * 并把两个方向都钉住。
 */
check('已知完整版优先于未知体积（有实据 > 无实据）', pickBest([unknown, full]) === full)
check('未知体积输给已知的小片段（size=0 与第三方中转强相关，属轻微负面信号）',
  pickBest([unknown, snippet]) === snippet, pickBest([unknown, snippet]).from)
const bigUnknown = { url: 'https://y.example.com/b.mp3', from: '未知源大', size: 0, official: false, weak: false, native: false }
check('两条都未知时退化为稳定（不抛错、必返回一条）',
  pickBest([unknown, bigUnknown]) !== null)
check('未知体积仍然赢过「已知死接口」（weak 那一档压过体积）',
  pickBest([unknown, { url: 'https://music.163.com/song/media/outer/url?id=1.mp3', from: '已知死接口', size: 80 * 1024 * 1024, official: false, weak: true, native: false }]) === unknown)

console.log('\n== 4. 官方标识与弱源标识的判定（用源码里的真名单）==')
check('网易 CDN（music.126.net）识别为官方',
  hostMatches('https://m801.music.126.net/x.mp3', OFFICIAL) === true)
check('网易网页域（music.163.com）识别为**弱源/死接口**，不是官方',
  hostMatches('https://music.163.com/song/media/outer/url?id=1.mp3', WEAK) === true
  && hostMatches('https://music.163.com/x', OFFICIAL) === false)
check('酷狗 CDN 识别为官方', hostMatches('https://xxx.kugou.com/y.mp3', OFFICIAL) === true)
check('随便一个域名两边都不算',
  hostMatches('https://foo.bar/z', OFFICIAL) === false && hostMatches('https://foo.bar/z', WEAK) === false)

/* ---------------- 2. 与源码的一致性 ---------------- */

console.log('\n== 5. 与 src/lib/stream.js 的一致性（防止只改一边） ==')
const src = SRC
check('stream.js 里有收敛窗口常量 SETTLE_MS', /const SETTLE_MS = \d+/.test(src),
  (src.match(/const SETTLE_MS = \d+/) || [''])[0])
check('stream.js 里有 pickBest 挑选函数', /const pickBest = \(list\)/.test(src))
check('挑选里有「已知死接口排最后」这一档', /if \(!!a\.weak !== !!b\.weak\) return a\.weak \? 1 : -1/.test(src))
check('挑选里有「官方优先」这一档', /!!a\.official !== !!b\.official/.test(src))
check('挑选里有「体积大优先」这一档', /if \(as !== bs\) return bs - as/.test(src))
check('探通后不再立刻收工（armSettle 被调用）', /armSettle\(\)/.test(src))
check('窗口到点后确实用了 pickBest', /pickBest\(probed\)/.test(src))
check('放弃先探通的那条时会留下说明（可排查）', /疑似试听片段/.test(src))
check('探通后返回的是多条候选（不只一条）', /const ordered = \[best, \.\.\.probed\.filter/.test(src))

console.log('\n== 5b. 两份排序必须同档位同顺序（本轮揪出的真 bug） ==')
/**
 * pickBest 与 compareCandidates 是同一个文件里的两条排序路径：
 * 前者走「有候选探通」的主路径，后者走「一条都没探通」的兜底路径。
 * 上一版 pickBest 是 official → size → weak，compareCandidates 是
 * weak → official → size —— 同一份文件两套顺序，走哪条路径结果不同，
 * 而且 weak 那一档放错位会让**已知死接口**被优先选中。
 * 这里直接把两个函数拿来对拍：同一组候选，两边排出来的第一名必须相同。
 */
const sampleSet = [
  { url: 'https://m801.music.126.net/a.mp3', from: 'official', size: 2 * 1024 * 1024, official: true, weak: false, native: false },
  { url: 'https://music.163.com/song/media/outer/url?id=1.mp3', from: 'dead-big', size: 50 * 1024 * 1024, official: false, weak: true, native: false },
  { url: 'https://cdn3.example.com/b.mp3', from: 'plain-big', size: 9 * 1024 * 1024, official: false, weak: false, native: false },
  { url: 'https://cdn4.example.com/c.mp3', from: 'plain-small', size: 1 * 1024 * 1024, official: false, weak: false, native: false },
]
for (let i = 0; i < sampleSet.length; i++) {
  for (let j = i + 1; j < sampleSet.length; j++) {
    const a = sampleSet[i], b = sampleSet[j]
    const pa = pickBest([a, b]), ca = [a, b].sort(compareCandidates)[0]
    check(`两路排序对 ${a.from} vs ${b.from} 结论一致`, pa === ca,
      pa === ca ? '' : `pickBest=${pa.from} compareCandidates=${ca.from}`)
  }
}
check('两路都不会把已知死接口排在健康官方直链前面',
  pickBest(sampleSet) === sampleSet[0] && sampleSet.slice().sort(compareCandidates)[0] === sampleSet[0])

console.log('\n== 6. 播放器侧也按体积排了（两道保险） ==')
const player = fs.readFileSync(path.join(ROOT, 'public', 'js', 'player.js'), 'utf8')
check('player.js 把 size 带进候选', /size: Number\(x\.size\) \|\| 0/.test(player))
check('player.js 对候选按体积降序排', /list\.sort\(\(a, b\) => \(b\.size \|\| 0\) - \(a\.size \|\| 0\)\)/.test(player))
check('player.js 有「播放长度与声明时长不符」的提示', /function warnIfSnippet/.test(player))
check('提示足够保守（声明时长要 > 60s）', /declared < 60/.test(player))
check('本地缓存不算音源的锅', /audio\.dataset\.cached === '1'\) return/.test(player))

console.log('\n===== stream-pick：' + pass + ' 通过 / ' + fail + ' 失败 =====')
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '))
process.exit(fail ? 1 : 0)
