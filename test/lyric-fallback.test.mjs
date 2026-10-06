/**
 * 歌词取词的回归测试（纯逻辑，不联网）。
 *
 * 背景 —— 线上出过「所有平台都没有歌词」：
 *   插件即使取不到词，也会**成功地**返回
 *   `{ lyric: '', tlyric: null, rlyric: null, lxlyric: null }`（对象是真的，一个字没有）。
 *   而 resolveLyric 原来只判 `if (res.value)`，空壳对象算「成功」直接返回，
 *   后面那份本来能用的平台原生歌词**一次都没被调用过**。
 *   修法：以「有没有正文」为准，空壳一律当成没拿到，退到原生接口。
 *
 * 跑：node --test test/lyric-fallback.test.mjs
 */
import { resolveLyric, PROVIDERS } from '../src/providers/index.js'

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      got=${a}\n      exp=${e}`)
}

/* 造一个只在测试里存在的「平台」，不去碰真实的 provider */
const SRC = 'zz'
const EMPTY_SHELL = { lyric: '', tlyric: null, rlyric: null, lxlyric: null }
const REAL = '[00:01.00]真正的歌词'

let nativeCall = 0
let nativeReturn = null
PROVIDERS[SRC] = {
  id: SRC,
  async getLyric() { nativeCall++; return nativeReturn },
}

/** 假的插件池：supports 一律 true，invoke 返回给定值 */
function mkPool(value, { supports = true } = {}) {
  return {
    supports: () => supports,
    invoke: async () => ({ value, plugin: 'fake-plugin' }),
  }
}

/* 1. 插件吐空壳 -> 必须退到原生，并且原生真的被调用 */
{
  nativeCall = 0
  nativeReturn = { lyric: REAL, tlyric: null }
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool(EMPTY_SHELL))
  check('插件返回空壳时退到原生接口', got && got.lyric, REAL)
  check('原生接口确实被调用过一次', nativeCall, 1)
}

/* 2. 插件有正文 -> 用插件的，不去碰原生 */
{
  nativeCall = 0
  nativeReturn = { lyric: REAL, tlyric: null }
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool({ lyric: '插件给的词' }))
  check('插件有正文就用插件的', got && got.lyric, '插件给的词')
  check('插件命中时不再调用原生', nativeCall, 0)
}

/* 3. 插件返回纯字符串也算数 */
{
  nativeCall = 0
  nativeReturn = { lyric: REAL }
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool('字符串歌词'))
  check('插件返回字符串同样采纳', got, '字符串歌词')
  check('字符串命中时不再调用原生', nativeCall, 0)
}

/* 4. 两边都空 -> null，而不是拿空壳糊上去 */
{
  nativeCall = 0
  nativeReturn = EMPTY_SHELL
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool(EMPTY_SHELL))
  check('两边都没有正文时返回 null', got, null)
  check('原生被调用过（用来确认不是提前返回）', nativeCall, 1)
}

/* 5. 插件不声明 lyric 能力 -> 直接走原生 */
{
  nativeCall = 0
  nativeReturn = { lyric: REAL }
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool(EMPTY_SHELL, { supports: false }))
  check('插件不支持 lyric 时直接走原生', got && got.lyric, REAL)
  check('此时原生只被调用一次', nativeCall, 1)
}

/* 6. 原生抛错不能让整个请求炸掉（返回 null，界面显示「暂无歌词」） */
{
  PROVIDERS[SRC].getLyric = async () => { throw new Error('上游 502') }
  const got = await resolveLyric({ source: SRC, id: '1' }, mkPool(EMPTY_SHELL))
  check('原生抛错时安全降级为 null', got, null)
  PROVIDERS[SRC].getLyric = async () => { nativeCall++; return nativeReturn }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
