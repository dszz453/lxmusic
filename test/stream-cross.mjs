/**
 * 跨平台同名判据（`sameTitle`）的回归测试。
 *
 * ── 为什么单独立一份 ────────────────────────────────
 * 「QQ 返回的放不出来」这条反馈，实测根因之一是**跨源兜底压根匹配不上**：
 * 同一张喜马拉雅有声书专辑，QQ 侧叫 `李哪吒惊奇毕业旅丨33 都是因为爱`，
 * 酷狗侧叫 `东海小学广播站、喜马拉雅 - 李哪吒惊奇毕业旅丨33 都是因为爱`
 * —— 歌手名被塞进了标题，而 `丨`（U+4E28）与 `｜`（U+FF5C）还不是一个字符。
 * 以前要求归一化后**完全相等**，于是 234 集一集都匹配不到。
 *
 * 但放宽成「包含」会引入新 bug：同专辑 `…丨1 出发` 与 `…丨10 出发` 互相包含，
 * 会播错集。所以判据收紧成「多出来的那截必须正好是歌手名」。
 * 这份测试就是钉住这条边界。
 */
import { sameTitle } from '../src/lib/stream.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) }
}

const SINGER = '东海小学广播站、喜马拉雅'
const QQ = '李哪吒惊奇毕业旅丨33 都是因为爱'
const KG = '东海小学广播站、喜马拉雅 - 李哪吒惊奇毕业旅丨33 都是因为爱'

console.log('\n== 1. 歌手名被塞进标题（酷狗最常见） ==')
ok(sameTitle(QQ, KG, SINGER), '酷狗「歌手 - 标题」前缀算同一首')
ok(sameTitle(KG, QQ, SINGER), '反过来也成立（参数顺序无关）')
ok(sameTitle(QQ, '李哪吒惊奇毕业旅丨33 都是因为爱 - ' + SINGER, SINGER), '歌手名塞在后面也算')
ok(sameTitle(QQ, '李哪吒惊奇毕业旅｜33 都是因为爱', SINGER), '全角竖线 ｜ 与 丨 视为同一个分隔符')

console.log('\n== 2. 绝不能误判（会播错集） ==')
ok(!sameTitle('李哪吒惊奇毕业旅丨33 都是因为爱', '李哪吒惊奇毕业旅丨34 都是因为爱', SINGER), '33 集 ≠ 34 集')
ok(!sameTitle('李哪吒惊奇毕业旅丨1 出发', '李哪吒惊奇毕业旅丨10 出发', SINGER), '1 集 ≠ 10 集')
ok(!sameTitle('李哪吒惊奇毕业旅丨1 出发', '李哪吒惊奇毕业旅丨1 出发啦', SINGER), '多出来的「啦」不是歌手名 → 不算同一首')
ok(!sameTitle('晴天', '七里香', '周杰伦'), '完全不同的歌不算')
ok(!sameTitle('', '晴天', '周杰伦'), '空标题不算')
ok(!sameTitle('晴天', '周杰伦晴天现场版', ''), '空歌手时不做包含判断（多出来的那截无从解释）')
ok(sameTitle('晴天', '晴天', ''), '完全同名永远成立（不看歌手）')

console.log('\n== 3. 归一化细节 ==')
ok(sameTitle('七里香 (Live)', '七里香', '周杰伦'), '括号补充说明被去掉')
ok(sameTitle('七里香（Live）', '七里香', '周杰伦'), '全角括号同样去掉')
ok(!sameTitle('a', 'ab', 'x'), '过短的标题不做包含判断（防误判）')

console.log(`\n===== stream-cross：${pass} 通过 / ${fail} 失败 =====`)
if (fail) process.exitCode = 1
