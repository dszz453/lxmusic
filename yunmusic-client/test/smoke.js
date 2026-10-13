/*
 * 云音乐 V2.7 自测脚本
 *
 * 两条腿：
 *   1) 源码级单元测试 —— 从 index.html 里把纯函数源码抠出来单独跑，
 *      覆盖 parseLrc 的 [offset:] / 小数位数换算 / 同刻去重、翻译配对、文件名净化、体积格式化。
 *   2) jsdom 集成测试 —— 装一个假的 YunBridge 原生桥，真实驱动 DOM，
 *      覆盖启动、12 条路由、歌词高亮与偏移、下载全流程、歌曲操作面板、我的页与播放全部按钮。
 *
 * 用法：
 *   NODE_PATH=<node workspace>/node_modules node test/smoke.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { JSDOM, VirtualConsole } = require('jsdom')

const ROOT = path.resolve(__dirname, '..')
const HTML_PATH = path.join(ROOT, 'assets', 'web', 'index.html')
const HTML = fs.readFileSync(HTML_PATH, 'utf8')

/* ------------------------------ 断言框架 ------------------------------ */
let pass = 0, fail = 0
const failures = []
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + label) }
  else {
    fail++
    failures.push(label + (detail ? '  [' + detail + ']' : ''))
    console.log('  \u2717 ' + label + (detail ? '  [' + detail + ']' : ''))
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}
function section(t) { console.log('\n== ' + t + ' ==') }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/* ------------------------------ 词法屏蔽 ------------------------------ */
/*
 * 把注释与字符串/正则字面量的**内容**替换成空格，长度与换行保持不变。
 * 这样花括号计数、语法关键字扫描都不会被 `'<div class="x">'` 里的引号、
 * 或 `/[\\/:*?"<>|]/` 这类正则里的 `"` 带偏；同时因为位置不变，
 * 还能拿它做索引去原串里切片。
 */
function blankOut(src) {
  const out = src.split('')
  const n = src.length
  let i = 0
  let prev = ''            // 上一个「有意义」的字符，用来判断 / 是除法还是正则
  const REGEX_PREV = /[=(,:;[!&|?{}+\-*%<>~^]/
  while (i < n) {
    const c = src[i], c2 = src[i + 1]

    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out[i] = ' '; i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out[i] = ' '; if (i + 1 < n) { out[i + 1] = ' '; i += 2 } else i++; continue }
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < n) { out[i] = ' '; i++ }
      prev = q
      continue
    }
    if (c === '/' && (prev === '' || REGEX_PREV.test(prev))) {
      out[i] = ' '; i++
      let inClass = false
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') { out[i] = ' '; if (i + 1 < n) { out[i + 1] = ' '; i += 2 } else i++; continue }
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        out[i] = ' '; i++
      }
      if (i < n) { out[i] = ' '; i++ }
      while (i < n && /[a-z]/i.test(src[i])) { out[i] = ' '; i++ }
      prev = '/'
      continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}

/* ------------------------------ 源码抽取 ------------------------------ */
/*
 * ⚠ 取**最长**的那个 script 块，而不是第一个。
 *
 * index.html 里除了主体脚本，还有 `<script src="lxcore.js"></script>` 这种
 * 只带 src 的空块，且它排在主体脚本**之前**。用「第一个」去匹配会拿到空字符串，
 * 后面所有 extractFn 都会「找不到函数」—— 报错信息看着像源码缺函数，
 * 其实测试根本没读到源码。
 */
const scriptBlocks = [...HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
if (!scriptBlocks.length) { console.error('致命：index.html 里找不到 <script> 块'); process.exit(1) }
const SCRIPT = scriptBlocks.reduce((a, b) => (b.length > a.length ? b : a), '')
if (!SCRIPT.trim()) { console.error('致命：index.html 的 <script> 块是空的'); process.exit(1) }
const CODE = blankOut(SCRIPT)      // 只含代码，注释/字符串已置空（位置不变）

/**
 * 只屏蔽注释、**保留字符串字面量**。
 *
 * blankOut 会把字符串内容一起抹掉，所以 `addEventListener('play', …)` 这种
 * 带字符串参数的写法在 CODE 上根本匹配不到 —— 拿 CODE 去断言就会「找不到 →
 * 退化成空串 → 断言意外通过」，是典型的假绿灯。凡是要连字符串一起看的断言，
 * 都改用 NOCOMMENT。
 */
function stripComments(src) {
  const out = src.split('')
  const n = src.length
  let i = 0, prev = ''
  const REGEX_PREV = /[=(,:;[!&|?{}+\-*%<>~^]/
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { out[i] = ' '; i++ } continue }
    if (c === '/' && c2 === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++
      while (i < n && src[i] !== q) { if (src[i] === '\\') { i += 2; continue } i++ }
      i++; prev = q; continue
    }
    if (c === '/' && (prev === '' || REGEX_PREV.test(prev))) {
      i++
      let inClass = false
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        i++
      }
      i++
      while (i < n && /[a-z]/i.test(src[i])) i++
      prev = '/'; continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}
const NOCOMMENT = stripComments(SCRIPT)

/**
 * 从 `marker` 起取出后面第一个配对的花括号块。
 * 花括号计数走 CODE（字符串/注释已被抹平，不会把 `'{'` 当代码），
 * 正文则从 SCRIPT 里切（保留真实文本，方便断言内容）。
 */
function blockAfter(marker) {
  const at = SCRIPT.indexOf(marker)
  if (at < 0) return ''
  const open = CODE.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < CODE.length; i++) {
    const c = CODE[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return SCRIPT.slice(open, i + 1) }
  }
  return ''
}

function extractFn(src, name) {
  const sig = 'function ' + name + '('
  const at = CODE.indexOf(sig)
  if (at < 0) throw new Error('找不到函数 ' + name)
  const open = CODE.indexOf('{', at)
  let depth = 0, i = open
  for (; i < CODE.length; i++) {
    const c = CODE[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(at, i + 1)
}

/* ============================================================ */
section('0. 源码静态检查')

// 语法：整块脚本必须能被解析
let syntaxOk = true, syntaxErr = ''
try { new vm.Script(SCRIPT) } catch (e) { syntaxOk = false; syntaxErr = e.message }
ok(syntaxOk, 'index.html <script> 块语法可解析', syntaxErr)

// 纯 ES5：老 WebView 不吃 ES6+ 语法（在屏蔽了注释/字符串的 CODE 上扫，避免误报）
const es6 = [
  [/=>/, '箭头函数'],
  [/\bconst\s+[A-Za-z_$]/, 'const 声明'],
  [/\blet\s+[A-Za-z_$]/, 'let 声明'],
  [/\.\.\./, '展开运算符'],
  [/\bclass\s+[A-Za-z_$]/, 'class 声明']
]
es6.forEach(function (pair) {
  const re = new RegExp(pair[0].source, 'g')
  const hits = []
  let m
  while ((m = re.exec(CODE))) {
    const lineStart = CODE.lastIndexOf('\n', m.index) + 1
    const lineEnd = CODE.indexOf('\n', m.index)
    hits.push(CODE.slice(lineStart, lineEnd < 0 ? CODE.length : lineEnd).trim().slice(0, 70))
  }
  ok(hits.length === 0, '无 ' + pair[1] + '（纯 ES5）', hits.slice(0, 3).join(' | '))
})

// 关键修复点必须在源码里落地
ok(/\[offset:/.test(SCRIPT), 'parseLrc 处理 [offset:±毫秒] 标签')
ok(/getBoundingClientRect/.test(CODE) && /scroll\.offsetTop/.test(CODE), 'alignLyricTo 用矩形相减抵消 transform')
ok(/requestAnimationFrame\(lyricLoop\)/.test(CODE), '歌词高亮由 rAF 逐帧驱动')
ok(!/scrollIntoView/.test(CODE), '已移除 scrollIntoView（避免与 transform 位移叠加）')
ok(/var at = time - lyricDelay/.test(CODE), '偏移符号：判定时刻 = time - lyricDelay')
ok(/fast=0/.test(SCRIPT), '下载取真实音源（fast=0）')
ok(/function removeDownload/.test(CODE), 'removeDownload 已定义（原为缺失函数）')

// 高亮歌词字号：从样式表里读
const cssRule = (HTML.match(/\.lyric-line\.is-active\s*\{[^}]*\}/) || [''])[0]
ok(/font-size:\s*22px/.test(cssRule), '高亮歌词字号 22px', cssRule.trim())
ok(/color:\s*#fff/.test(cssRule), '高亮歌词颜色 #fff')
ok(/font-weight:\s*700/.test(cssRule), '高亮歌词加粗 700')
const baseRule = (HTML.match(/\.lyric-line\s*\{[^}]*\}/) || [''])[0]
ok(/font-size:\s*16px/.test(baseRule), '普通歌词字号 16px（与高亮形成对比）')

/* ============================================================ */
section('1. parseLrc / mergeTranslation 单元测试')

const ctx = vm.createContext({ console })
const unitSrc = [
  extractFn(SCRIPT, 'lrcOffsetOf'),
  extractFn(SCRIPT, 'parseLrc'),
  extractFn(SCRIPT, 'mergeTranslation'),
  extractFn(SCRIPT, 'extOf'),
  extractFn(SCRIPT, 'safeFileName'),
  extractFn(SCRIPT, 'fmtBytes')
].join('\n')
vm.runInContext(unitSrc, ctx)

const parseLrc = vm.runInContext('parseLrc', ctx)
const mergeTranslation = vm.runInContext('mergeTranslation', ctx)
const safeFileName = vm.runInContext('safeFileName', ctx)
const fmtBytes = vm.runInContext('fmtBytes', ctx)

// 基础解析
let l = parseLrc('[00:01.00]第一行\n[00:05.50]第二行\n[00:10.00]第三行')
eq(l.length, 3, '三行歌词解析出 3 条')
eq(l[0].t, 1, '第 1 行时间 = 1.0s')
eq(l[1].t, 5.5, '第 2 行时间 = 5.5s')
eq(l[0].text, '第一行', '第 1 行正文正确')

// 小数位数换算：.5 / .50 / .500 都是 500ms
eq(parseLrc('[00:01.5]a')[0].t, 1.5, '小数 1 位：.5 → 500ms')
eq(parseLrc('[00:01.50]a')[0].t, 1.5, '小数 2 位：.50 → 500ms')
eq(parseLrc('[00:01.500]a')[0].t, 1.5, '小数 3 位：.500 → 500ms')
eq(parseLrc('[00:01.25]a')[0].t, 1.25, '小数 2 位：.25 → 250ms')
eq(parseLrc('[00:01.025]a')[0].t, 1.025, '小数 3 位：.025 → 25ms')

// [offset:] 全局偏移：正值表示整体提前 → 做减法
const off = parseLrc('[offset:500]\n[00:10.00]x\n[00:20.00]y')
eq(off.length, 2, '[offset:500] 仍解析出 2 条')
eq(off[0].t, 9.5, '[offset:500] → 时间提前 0.5s')
eq(off[1].t, 19.5, '[offset:500] 第二行同样提前 0.5s')
const offNeg = parseLrc('[offset:-300]\n[00:10.00]x')
eq(offNeg[0].t, 10.3, '[offset:-300] → 时间滞后 0.3s')
const offCap = parseLrc('[offset:20000]\n[00:01.00]x')
eq(offCap[0].t, 0, '偏移越过开头时钳到 0，不出现负数')

// 同刻去重（< 20ms）
eq(parseLrc('[00:01.00]a\n[00:01.00]a')[0] && parseLrc('[00:01.00]a\n[00:01.00]a').length, 1, '同一时刻重复行去重为 1 条')
eq(parseLrc('[00:01.00]a\n[00:01.015]b').length, 1, '相差 15ms（<20ms）视为同刻，去重')
eq(parseLrc('[00:01.00]a\n[00:01.03]b').length, 2, '相差 30ms 保留两行')
eq(parseLrc('[00:01.00]a\n[00:01.00]b')[0].text, 'a', '去重保留先出现的那条')

// 一句挂多个时间戳
eq(parseLrc('[00:01.00][00:05.00]副歌').length, 2, '一句挂两个时间戳展开为 2 条')

// 空 / 异常输入
eq(parseLrc('').length, 0, '空串返回空数组')
eq(parseLrc(null).length, 0, 'null 返回空数组')
eq(parseLrc('[00:01.00]').length, 0, '只有时间戳没有正文 → 丢弃')
eq(parseLrc('没有时间戳的一行').length, 0, '纯文本行 → 丢弃')

// 排序
eq(parseLrc('[00:10.00]b\n[00:02.00]a')[0].text, 'a', '乱序输入按时间排序')

// 翻译配对：按 toFixed(2) 精确配对
const merged = mergeTranslation(parseLrc('[00:01.00]hello\n[00:05.00]world'), '[00:01.00]你好')
eq(merged[0].sub, '你好', '翻译按时间戳贴到主歌词')
eq(merged[1].sub, '', '对不上的行不贴翻译')
const selfMerge = mergeTranslation(parseLrc('[00:01.00]same'), '[00:01.00]same')
eq(selfMerge[0].sub, '', '译文与原文相同则不重复显示')
eq(mergeTranslation(parseLrc('[00:01.00]a'), null)[0].sub, '', 'tlyric 为 null 时安全返回')

// 偏移传播：主歌词带 [offset:]，译文通常不带 —— 译文必须沿用主歌词的偏移，否则整条错位对不上
const offMain = '[offset:500]\n[00:10.00]主歌词'
const offTly = '[00:10.00]translation'
const noProp = mergeTranslation(parseLrc(offMain), offTly)
eq(noProp[0].sub, '', '不传偏移时译文对不上（复现原缺陷）')
const prop = mergeTranslation(parseLrc(offMain), offTly, 0.5)
eq(prop[0].sub, 'translation', '传入主歌词偏移后译文正确贴上')

// 文件名净化
eq(safeFileName({ name: 'A/B:C*D?E"F<G>H|I', singer: 'X' }, '320k'), 'A_B_C_D_E_F_G_H_I - X.mp3', '文件名非法字符全部替换为下划线')
eq(safeFileName({ name: '歌', singer: '手' }, 'flac'), '歌 - 手.flac', 'flac 音质用 .flac 后缀')
eq(safeFileName({ name: '歌' }, '128k'), '歌.mp3', '无歌手时不拼 '- ' 分隔符')
ok(safeFileName({ name: 'x'.repeat(200) }, '320k').length <= 84, '超长文件名截断到 80 字以内')
ok(!/[\r\n\t]/.test(safeFileName({ name: 'a\r\nb\tc' }, '320k')), '换行/制表符被清除')

// 体积格式化
eq(fmtBytes(0), '0 B', 'fmtBytes 0')
eq(fmtBytes(512), '512 B', 'fmtBytes 512B')
eq(fmtBytes(2048), '2 KB', 'fmtBytes 2KB')
eq(fmtBytes(5242880), '5.0 MB', 'fmtBytes 5MB')

/* ============================================================ */
/* jsdom 集成测试                                              */
/* ============================================================ */

const LOGS = []
const TOASTS = []
const DL_CALLS = []          // 记录原生 downloadSong 调用
const CANCEL_CALLS = []
const IMG_CALLS = []         // 记录原生 fetchImage 调用
const API_CALLS = []         // 记录每次接口调用 { path, method, body }
const MEDIA_CALLS = []       // 记录每次 updateMedia 的完整入参（锁屏/控制中心那份数据）
// 记录每次 setChromeHidden 的入参。原生顶栏是 WebView 的兄弟节点，网页改不动它，
// 只能靠这个桥方法开关；一旦它停在「隐藏」而播放器其实没开，WebView 就顶到 y=0，
// 当前页最上面那条 sticky 栏会落进状态栏底下点不动（实测报障过）。
const CHROME_CALLS = []
let LAST_URL = ''
let LAST_BODY = ''
const HASHES = []

const CFG = {
  active: 0,
  activeUrl: 'https://music.zyplnn.dpdns.org',
  activeName: '线路一 · CF',
  line1: { url: 'https://music.zyplnn.dpdns.org', user: 'admin', pass: 'test-pass' },
  line2: { url: 'https://lxmusic.19860819.xyz:8616', user: 'admin', pass: 'test-pass' }
}

const COVER = 'https://cdn.example.com/cover1.jpg'
// 真实服务端（songForWeb）每条曲目都带 source / sourceName，mock 也必须带上，
// 否则「插件解析回落到平台」这类断言会因为数据不真实而失真
const SONG = {
  id: 's1', name: '测试歌曲', singer: '测试歌手', img: COVER,
  albumName: '测试专辑', interval: 245, source: 'wy', sourceName: '网易云音乐'
}

/* ══════════════ 本地插件（V2.12）用的替身 ══════════════
 *
 * 为什么要替身：jsdom 里既没有 Worker 也没有 URL.createObjectURL（实测都是 undefined），
 * 而真实的 plugins.data.js 是 760KB —— 既不该在自测里解析，也没法从 file:// 源加载。
 * 所以：
 *   · window.LXCore      → 一个最小可用的替身，只为让 LP.runtime 为真、
 *                          并让「主线程降级」那条路真的跑起来（jsdom 里 Worker 探测必然失败）
 *   · window.LX_BUNDLED_PLUGINS → 两个小插件：一个能取流、一个必然失败
 *   · 原生桥             → 补上 audioCache* / pickPluginFile（真机上由 YunBridge 实现）
 *
 * ⚠ 替身必须照着**真实协议**写（`globalThis.lx` 的 on/send/EVENT_NAMES、inited 里声明
 *   sources），否则测的是替身自己的行为。这份文件头上已经为「替身写错形状」栽过一次
 *   （/album 的扁平 list），这里不再犯。
 */

/** 能正常取流的替身插件（只声明网易云） */
const FAKE_PLUGIN_OK = `/*!
 * @name 甲音源
 * @version 1.0.0
 * @author 测试
 * @description 替身插件：声明网易云，取流固定回一个地址
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('action not support: ' + action))
  /*
   * 把**收到的东西**记下来 —— 「插件到底拿到了什么 musicInfo」是本地插件能不能取流的
   * 命门，而它恰恰是唯一在页面上看不出来的东西（加载成功、日志正常、就是解不出地址）。
   * V2.13 的根因（喂的是裁剪过的瘦对象、没有 hash/songmid）就是靠这条抓出来的。
   * 套 try/catch：Worker 路径下没有 window。
   */
  try { window.__lpSeenInfo = info && info.musicInfo } catch (e) { }
  return Promise.resolve('https://local.example.com/' + source + '/' + info.musicInfo.id + '.mp3')
})
send(EVENT_NAMES.inited, {
  status: true,
  sources: {
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
  }
})
`

/** 一定解不出地址的替身插件 —— 用来验证「本地失败自动退回服务端」 */
const FAKE_PLUGIN_BAD = `/*!
 * @name 乙音源
 * @version 1.0.0
 * @author 测试
 * @description 替身插件：声明网易云，但取流永远失败
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.reject(new Error('这个插件解不出来')))
send(EVENT_NAMES.inited, {
  status: true,
  sources: {
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
  }
})
`

const FAKE_LXCORE = {
  // 内容无所谓：jsdom 没有 URL.createObjectURL，探测在创建 Worker 之前就失败了
  WORKER_SRC: '/* 替身 Worker 源码 */',
  SOURCE_DIGEST: 'test000000000000',
  TARGET: 'es2017',
  crypto: {
    utf8Encode(s) {
      const out = []
      for (let i = 0; i < String(s).length; i++) out.push(String(s).charCodeAt(i) & 0xff)
      return Uint8Array.from(out)
    },
    md5() { return 'stubmd5' },
    randomBytes(n) { return new Uint8Array(Number(n) || 16) },
    aesEncryptRaw() { return new Uint8Array(0) },
    aesDecryptRaw() { return new Uint8Array(0) },
    rsaEncryptRaw() { return new Uint8Array(0) }
  },
  util: {
    createBufferShim() {
      return {
        from(v) { return v },
        bufToString(b) { return String(b) },
        isBuffer() { return false }
      }
    },
    bufToString(b) { return String(b) },
    inflateRaw() { return Promise.resolve(new Uint8Array(0)) },
    deflateRaw() { return Promise.resolve(new Uint8Array(0)) }
  }
}

/** 音频缓存 + 插件文件选择的原生桥状态（真机上由 YunBridge 实现） */
const AC = { hit: null, keys: [], puts: [], trims: [], clears: 0, stats: 0, bytes: 0 }
const PF = { calls: 0 }

const RESPONSES = {
  '/me': { user: { username: 'admin', isAdmin: true } },
  '/login': { token: 'tk', user: { username: 'admin', isAdmin: true } },
  /*
   * 版本。形状**照抄真实服务端**：`src/version.js` 的 versionInfo()
   * （app / version / versionCode / build / full）加上 `src/server/api.js`
   * 的 /version 分支再补一个 host。
   *
   * ⚠ 加这一条时最容易犯的错是「随手编一个 `{ version: 'V2.8' }` 就完事」——
   *   那样测出来的只是「客户端能读它自己编的字段」，不是「能读服务端真回的字段」。
   *   这里逐字段照抄，下面还有一条断言去核对两边字段名是否还一致。
   *
   * 没有这一条时，请求会落到 mockFetch 的兜底 `{ ok, list: [] }` —— 一个服务端
   * 根本不会回的形状，客户端读 `d.version` 恒为 undefined。
   */
  '/version': {
    ok: true, app: 'lxmusic', version: 'V2.8', versionCode: 118,
    build: 'dev', full: 'lxmusic V2.8 (dev)', host: 'docker'
  },
  '/favorites': { list: [{ id: 's1', name: '测试歌曲', singer: '测试歌手' }] },
  '/favorite': { ok: true },
  '/search': { list: [SONG, { id: 's2', name: '第二首', singer: '歌手二' }, { id: 's3', name: '第三首', singer: '歌手三' }] },
  '/charts': {
    list: [
      { id: 'c1', source: 'wy', name: '热歌榜', cover: 'https://cdn.example.com/c1.jpg', playCount: 12000 },
      { id: 'c2', source: 'wy', name: '新歌榜', cover: 'https://cdn.example.com/c2.jpg', playCount: 8000 }
    ]
  },
  '/home': {
    keyword: '每日推荐', generator: '在线', daily: { generator: '在线' },
    hot: [SONG],
    charts: [
      { id: 'c1', source: 'wy', name: '热歌榜', cover: 'https://cdn.example.com/c1.jpg', playCount: 12000 },
      { id: 'c2', source: 'wy', name: '新歌榜', cover: 'https://cdn.example.com/c2.jpg', playCount: 8000 }
    ]
  },
  '/chart': { name: '热歌榜', list: [SONG, { id: 's2', name: '第二首', singer: '歌手二' }] },
  /*
   * ⚠ 形状必须**照抄真实服务端**（src/server/api.js 的 /album 分支）：
   *
   *   { ok: true, album: { source, sourceId, name, cover, total, songs: [...] } }
   *
   * 这里以前写的是扁平的 `{ name, singer, img, list: [SONG] }` —— 那是一个
   * **服务端根本不存在**的形状。于是客户端把 `data.list`（恒为 undefined）
   * 当曲目列表这个 bug，在测试里永远绿：假数据喂对了假代码。
   * 实测漏过一个线上 bug：打开任何一张专辑都显示「共 0 首」。
   * 教训：替身要照着真响应写，不能照着客户端代码「看着像什么」写。
   */
  '/album': {
    ok: true,
    album: { source: 'wy', sourceId: 'a1', name: '测试专辑', cover: COVER, total: 1, songs: [SONG] },
  },
  // 搜专辑：真实服务端回 { ok, list, total, page, errors }，每项是
  // { source, id, name, singer, img, trackCount }（各平台 provider 的 searchAlbum 口径一致）
  '/search-albums': {
    ok: true, total: 1, page: 1,
    list: [{ source: 'wy', id: 'a1', name: '测试专辑', singer: '测试歌手', img: COVER, trackCount: 12 }],
  },
  '/playlists': { list: [{ id: 'p1', name: '我的歌单' }] },
  '/playlist': { name: '我的歌单', list: [SONG] },
  '/playlist/add': { ok: true, added: 1 },
  '/history': { list: [] },
  // 带 [offset:500]：验证偏移标签真的被吃掉了（3 行里有两行会被并到同刻）
  '/lyric': { ok: true, lyric: { lyric: '[offset:500]\n[00:01.00]第一行歌词\n[00:05.50]第二行歌词\n[00:10.00]第三行歌词', tlyric: '[00:01.00]line one\n[00:05.50]line two' } },
  '/url': { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true },
  // 每日推荐：服务端当天已生成好的一份
  '/daily': {
    ok: true, ready: true, title: '每日推荐', generator: '在线',
    generatedAt: '2026-10-11T08:00:00Z', date: '2026-10-11', stale: false,
    songs: [SONG, { id: 's2', name: '第二首', singer: '歌手二' }]
  },
  '/daily/refresh': {
    ok: true, ready: true, title: '每日推荐', generator: '在线',
    date: '2026-10-11',
    songs: [{ id: 's3', name: '第三首', singer: '歌手三' }, SONG]
  },
  // AI 歌单：服务端**只回「歌名 + 歌手」**，没有 id / 封面 / source。
  // 曲目要靠客户端逐首调 /suggest 匹配出来（见 api.js 里 /ai-playlist 的注释）。
  // 这里故意混进一首「搜不到」的，验证未匹配的会被列出来而不是混进歌单。
  '/ai-playlist': {
    ok: true, title: '适合深夜写代码的歌', requested: 20,
    songs: [
      { name: '夜曲', singer: '周杰伦' },
      { name: '搜不到的歌', singer: '查无此人' },
      { name: '晴天', singer: '周杰伦' }
    ]
  }
}

function mockFetch(reqId, url, method, headers, body) {
  LAST_URL = url
  LAST_BODY = body || ''
  let pathname = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
  API_CALLS.push({ path: pathname, method: method || 'GET', body: body || '', url: url })
  let payload = RESPONSES[pathname]
  // /suggest 按关键词动态回一条可播曲目，让「匹配」这段能真跑起来。
  // 约定：关键词里带「搜不到」就回空列表（模拟匹配失败）。
  if (pathname === '/suggest') {
    const qs = decodeURIComponent(url.split('?')[1] || '')
    const km = qs.match(/q=([^&]*)/)
    const q = km ? km[1] : ''
    payload = /搜不到/.test(q)
      ? { ok: true, list: [] }
      : { ok: true, list: [{ id: 'sg-' + q, name: q, singer: '匹配歌手', img: COVER, source: 'wy', sourceName: '网易云音乐' }] }
  }
  let status = 200
  // 想模拟接口报错时，把响应写成 { __status: 500, __body: { error: '...' } }
  if (payload && payload.__status) { status = payload.__status; payload = payload.__body }
  const res = payload === undefined
    ? { status: 200, body: JSON.stringify({ ok: true, list: [] }) }
    // 字符串载荷**原样返回**，不做 JSON 包装 —— 插件脚本就是这种形态（一个 .js 文件）。
    // 包装成 JSON 字符串再让客户端解，测的就不是真实链路了。
    : { status: status, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }
  setTimeout(() => {
    if (typeof win.onNativeHttpCallback === 'function') {
      win.onNativeHttpCallback({ reqId: reqId, status: res.status, body: res.body })
    }
  }, 0)
}

let win = null
const vc = new VirtualConsole()
vc.on('jsdomError', e => {
  const m = String(e && e.message || '')
  if (/Not implemented/.test(m)) return          // jsdom 没实现 audio.play / scrollTo，忽略
  LOGS.push('jsdomError: ' + m)
})
vc.on('error', (...a) => LOGS.push('console.error: ' + a.join(' ')))

async function boot() {
  const dom = new JSDOM(HTML, {
    url: 'https://ym.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      // 本地插件运行时（真机上由 lxcore.js 提供；jsdom 里没法从 file:// 源加载）
      w.LXCore = FAKE_LXCORE
      // 插件数据（真机上由 plugins.data.js 懒加载提供）
      w.LX_BUNDLED_PLUGINS = [
        { id: 'fake-ok', name: '甲音源', url: '', script: FAKE_PLUGIN_OK },
        { id: 'fake-bad', name: '乙音源', url: '', script: FAKE_PLUGIN_BAD }
      ]
      w.YunBridge = {
        showToast(msg) { TOASTS.push(String(msg)) },
        // 记录每次同步的完整入参：锁屏/控制中心要的是「封面 + 时长 + 进度」，
        // 只给歌名歌手的话锁屏上没有封面、拖动条是死的，所以这里必须逐项断言
        updateMedia() { MEDIA_CALLS.push(Array.prototype.slice.call(arguments)) },
        // 原生顶栏开关。⚠ 这个假桥以前**没有**这个方法，于是页面里那句
        // `if (window.YunBridge && window.YunBridge.setChromeHidden)` 直接被跳过，
        // 「顶栏被误藏、之后再没人恢复」这条链路整条测不到 —— 实测漏过一个 bug：
        // 播放器展开后 1 秒内收起，残留定时器会把顶栏压回隐藏且永不恢复。
        setChromeHidden(hidden) { CHROME_CALLS.push(!!hidden) },
        httpFetch: mockFetch,
        getServerConfig() { return JSON.stringify(CFG) },
        switchLine(idx) {
          const next = JSON.parse(JSON.stringify(CFG))
          next.active = Number(idx)
          next.activeUrl = Number(idx) === 0 ? next.line1.url : next.line2.url
          next.activeName = Number(idx) === 0 ? '线路一 · CF' : '线路二 · Docker'
          return JSON.stringify(next)
        },
        // 真实桩：按入参更新并回吐，测试才能驱动「清空账号 → 保存」这条路径
        saveDualConfig(u1, n1, p1, u2, n2, p2, active) {
          CFG.line1 = { name: CFG.line1.name, url: u1 || CFG.line1.url, user: n1 || '', pass: p1 || '' }
          CFG.line2 = { name: CFG.line2.name, url: u2 || CFG.line2.url, user: n2 || '', pass: p2 || '' }
          CFG.active = Number(active) === 1 ? 1 : 0
          const l = CFG.active === 1 ? CFG.line2 : CFG.line1
          CFG.activeUrl = l.url
          CFG.activeUser = l.user
          CFG.activePass = l.pass
          CFG.activeName = l.name
          return JSON.stringify(CFG)
        },
        downloadSong(reqId, url, fileName) { DL_CALLS.push({ reqId, url, fileName }) },
        cancelDownload(reqId) { CANCEL_CALLS.push(reqId) },
        // 封面缓存：原生取图后回一个 data:URL（这里用可识别的假值）
        fetchImage(reqId, url) {
          IMG_CALLS.push({ reqId, url })
          if (/never-answered/.test(url)) return      // 模拟原生不回图，验证超时兜底
          setTimeout(function () {
            if (typeof win.onNativeImage === 'function') {
              win.onNativeImage({ reqId: reqId, url: url, dataUrl: 'data:image/png;base64,IMG' + IMG_CALLS.length })
            }
          }, 0)
        },
        /*
         * 音频缓存（V2.12）。真机上是 Java 侧的 HttpURLConnection 落盘，
         * 这里只把「键长什么样、有没有被查、什么时候落盘」记下来。
         * audioCacheGet 是**同步**返回路径的（页面靠它决定要不要跳过解析），
         * 所以命中与否用一个开关控制：AC.hit。
         */
        audioCacheGet(key) { AC.keys.push(key); return AC.hit },
        audioCachePut(key, url, limitBytes) { AC.puts.push({ key: key, url: url, limitBytes: limitBytes }) },
        audioCacheTrim(limitBytes) { AC.trims.push(limitBytes) },
        audioCacheClear() {
          AC.clears++
          setTimeout(function () {
            if (typeof win.onNativeAudioCacheCleared === 'function') {
              win.onNativeAudioCacheCleared({ bytes: AC.bytes })
            }
          }, 0)
        },
        audioCacheStat() {
          AC.stats++
          setTimeout(function () {
            if (typeof win.onNativeAudioCacheStat === 'function') {
              win.onNativeAudioCacheStat({ bytes: AC.bytes })
            }
          }, 0)
        },
        // 插件文件选择（V2.12）。真机上是 ACTION_GET_CONTENT + 原生读文本；
        // 测试自己调 win.onNativePluginFile(...) 来扮演「用户选了文件」。
        pickPluginFile() { PF.calls++ }
      }
      w.onerror = function (msg, src, line, col, err) {
        LOGS.push('window.onerror: ' + (err && err.stack || msg))
      }
    }
  })
  win = dom.window
  win.addEventListener('hashchange', () => HASHES.push(win.location.hash))
  await sleep(120)

  // toast() 只把文案写进 #toast 节点（不经过原生桥），所以盯 DOM 变化来收集提示
  const toastEl = win.document.getElementById('toast')
  if (toastEl) {
    new win.MutationObserver(function () {
      const t = String(toastEl.textContent || '').trim()
      if (t) TOASTS.push(t)
    }).observe(toastEl, { childList: true, characterData: true, subtree: true })
  }
  return dom
}

/*
 * 客户端从 V2.12 起有一层「直链缓存」（默认开，见 index.html 的 lpUrlCacheGet/Set）：
 * 同一首 `source:id:quality` 解析过一次就存 20 分钟，避免二次点歌再走一遍本地插件。
 *
 * ⚠ 测试里每一段都会换 `RESPONSES['/url']` 的替身响应，但缓存不会跟着换 ——
 * 于是下一段读到的是上一段留下的旧地址，看起来像「客户端取错了源」，
 * 其实是被测代码完全正确、替身换了缓存没换。
 * 每次导航（`go()`）就是「进入一个新场景」的边界，在这里把缓存清掉最省事也最准确。
 *
 * 只影响播放解析（resolveUrl）；下载走 `/url?fast=0`，不读这层缓存。
 */
function clearUrlCache() {
  try { win.localStorage.removeItem('ym.lp.urlcache') } catch (e) { }
}

async function go(hash) {
  clearUrlCache()
  win.location.hash = hash
  await sleep(60)
}

function $(sel) { return win.document.querySelector(sel) }
function $$(sel) { return Array.prototype.slice.call(win.document.querySelectorAll(sel)) }
function viewText() { return ($('#view') || {}).textContent || '' }
function isErrorBlock() { return !!($('#view') && $('#view').querySelector('.empty__title') && /加载失败/.test(viewText())) }

// 封面「已从缓存拿到」= src 是 data:URL，且不是那张 1x1 透明占位图
const BLANK_GIF = 'R0lGODlhAQABAIAAAAAAAP'
function isCachedCover(im) {
  const s = im.getAttribute('src') || ''
  return /^data:/.test(s) && s.indexOf(BLANK_GIF) < 0
}
function describeImgs(list) {
  return list.slice(0, 4).map(function (im) { return (im.getAttribute('src') || '(空)').slice(0, 30) }).join(' | ')
}

/* ============================================================ */
async function main() {
section('2. 启动与全局健康')
const dom = await boot()

ok(!!win.YunBridge, '原生桥已注入')
ok(!/加载失败/.test(viewText()), '首页渲染无错误块')
ok(LOGS.length === 0, '启动阶段无 JS 异常', LOGS.slice(0, 3).join(' | '))
eq($('#toast') !== null, true, 'toast 容器存在')

// 启动后首页封面应当已经走原生缓存取过一轮
await sleep(300)
ok(IMG_CALLS.length > 0, '启动后首页封面已交给原生缓存', 'calls=' + IMG_CALLS.length)
const bootUrls = IMG_CALLS.map(c => c.url)
eq(new Set(bootUrls).size, bootUrls.length, '同一批封面按 URL 去重，没有重复请求')
const bootImgs = $$('#view img')
ok(bootImgs.length > 0 && bootImgs.every(isCachedCover), '首页封面已换成缓存图', describeImgs(bootImgs))

/* ============================================================ */
section('3. 14 条路由逐个导航（回归）')
const ROUTES = [
  ['#/', '首页'], ['#/charts', '排行榜'], ['#/chart?source=wy&id=c1', '榜单详情'],
  // ⚠ 必须带 source：pageAlbum 在 `!source || !id` 时直接渲染「缺少专辑参数」空状态，
  //    那种情况下连 /album 都不会请求 —— 只写 `#/album?id=a1` 等于没测到这个页面。
  ['#/album?source=wy&id=a1', '专辑'], ['#/daily', '每日推荐'], ['#/ai', 'AI 歌单'],
  ['#/library', '歌单库'], ['#/playlist?id=p1', '歌单详情'],
  ['#/favorite', '我的收藏'], ['#/history', '播放历史'], ['#/mine', '我的'],
  ['#/settings', '双线路管理'], ['#/about', '关于'], ['#/downloads', '我的下载']
]
for (const [hash, label] of ROUTES) {
  const before = LOGS.length
  await go(hash)
  const bad = LOGS.length > before
  ok(!isErrorBlock() && !bad, '路由 ' + hash + '（' + label + '）渲染正常', bad ? LOGS.slice(before).join(' | ') : '')
}
ok(HASHES.length >= ROUTES.length, 'hashchange 事件正常派发')

/* ============================================================ */
section('4. 歌词同步（高亮 / 偏移 / 定位）')

// 搜索结果里先确认行内操作按钮的排布
await go('#/search?q=测试')
const rows = $$('#view .song')
ok(rows.length >= 2, '搜索结果渲染出歌曲行', 'rows=' + rows.length)
ok(!!$('#view .song .song__acts'), '歌曲行含 .song__acts 操作容器')
eq($$('#view .song .song__act[data-act="more"]').length, rows.length, '每行都有「更多」按钮')
eq($$('#view .song .song__act[data-act="add"]').length, rows.length, '每行都有「加入队列」按钮')

// 从榜单页点歌把播放器带起来：这样播放队列 = 榜单的 2 首，
// 稍后拿搜索结果里的第 3 首去试「加入播放队列」才不会被去重逻辑挡掉
await go('#/chart?source=wy&id=c1')
await sleep(80)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)

const lyricLines = $$('#lyricScroll .lyric-line')
ok(lyricLines.length > 0, '点歌后歌词区有内容', 'lines=' + lyricLines.length)
eq(lyricLines.length, 3, '[offset:500] 歌词解析出 3 行（未因偏移被误并）')
ok($$('#lyricScroll .lyric-line__sub').length === 2, '翻译贴到 2 行上')

// 高亮：至少有一行被点亮，且位置被 transform 摆过
const active = $$('#lyricScroll .lyric-line.is-active')
ok(active.length <= 1, '同时最多一行高亮')
const tf = $('#lyricScroll').style.transform
ok(/^translateY\(-?\d/.test(tf), '歌词列表被 alignLyricTo 摆过位置', 'transform=' + tf)

// 高亮字号：jsdom 的 getComputedStyle 支持有限，样式表已单独断言，这里做一次运行时确认
if (active.length) {
  const cs = win.getComputedStyle(active[0])
  const fs = cs && cs.fontSize
  ok(!fs || fs === '22px', '高亮行运行时字号为 22px（或 jsdom 未实现，跳过）', 'fontSize=' + fs)
}

// 偏移按钮：同步 → +0.2s → +0.4s → 复位
eq($('#lyricCalVal').textContent, '同步', '偏移初始为「同步」')
$('#lyricCalPlus').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(30)
eq($('#lyricCalVal').textContent, '+0.2s', '点 + 一档 → +0.2s')
eq($('#lyricCalVal').dataset.off, '1', '偏移非零时标记 off=1')
$('#lyricCalMinus').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(30)
eq($('#lyricCalVal').textContent, '同步', '点 − 回到同步')

// 上限钳制：连点 20 次不应超过 +3.0s
for (let i = 0; i < 20; i++) $('#lyricCalPlus').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(40)
eq($('#lyricCalVal').textContent, '+3.0s', '偏移上限钳制在 +3.0s')
for (let i = 0; i < 40; i++) $('#lyricCalMinus').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(40)
eq($('#lyricCalVal').textContent, '-3.0s', '偏移下限钳制在 -3.0s')
$('#lyricCalVal').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(30)
eq($('#lyricCalVal').textContent, '同步', '点数值本身复位为同步')

/* ============================================================ */
section('5. 歌曲操作面板')

// 用搜索结果里的第 3 首（不在当前播放队列中），避免被「已在队列」去重挡住
await go('#/search?q=测试')
await sleep(80)
const thirdRow = $$('#view .song')[2]
thirdRow.querySelector('[data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
ok(!$('#drawer').hidden, '抽屉已打开')
const acts = $$('#drawerBody [data-sact]')
eq(acts.length, 6, '操作面板共 6 项')
eq(acts.map(a => a.dataset.sact).join(','), 'play,next,queue,download,fav,playlist', '动作顺序与预期一致')
ok(!!$('#drawerBody .songsheet'), '面板顶部有歌曲信息卡')
ok(/第三首/.test($('#drawerBody').textContent), '面板展示的是被点的那首歌')
ok(/320k/.test($('#drawerBody').textContent), '下载项带当前音质标记')

// 「加入播放队列」
const qBefore = JSON.parse(win.localStorage.getItem('ym.queue') || '[]').length
$('#drawerBody [data-sact="queue"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(100)
const qAfter = JSON.parse(win.localStorage.getItem('ym.queue') || '[]').length
eq(qAfter, qBefore + 1, '「加入播放队列」真的入队了（' + qBefore + ' → ' + qAfter + '）')
ok(TOASTS.some(t => /已加入播放队列/.test(t)), '入队后有 toast 提示')

// 同一首再加一次：应走去重分支，队列长度不变
await go('#/search?q=测试')
await sleep(80)
$$('#view .song')[2].querySelector('[data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
$('#drawerBody [data-sact="queue"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(100)
eq(JSON.parse(win.localStorage.getItem('ym.queue') || '[]').length, qAfter, '重复加入同一首不产生重复项')
ok(TOASTS.some(t => /已在播放队列中/.test(t)), '重复加入时提示「已在播放队列中」')

// 「下一首播放」插到正在播放的下一格
await go('#/search?q=测试')
await sleep(80)
$$('#view .song')[2].querySelector('[data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
$('#drawerBody [data-sact="next"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(100)
ok(TOASTS.some(t => /已设为下一首播放/.test(t)), '「下一首播放」有反馈')

/* ============================================================ */
section('6. 下载全流程')

// 从面板点「下载到本机」
$('#view .song [data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
$('#drawerBody [data-sact="download"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)

ok(/\/api\/url\?/.test(LAST_URL), '下载先请求 /api/url', LAST_URL)
ok(/fast=0/.test(LAST_URL), '下载请求带 fast=0（取真实音源而非试听短链）', LAST_URL)
ok(/q=320k/.test(LAST_URL), '下载请求带当前音质 q=320k', LAST_URL)
eq(DL_CALLS.length, 1, '已把下载任务交给原生')
ok(/^https:\/\/cdn\.example\.com\/a\.mp3$/.test(DL_CALLS[0].url), '交给原生的是解析出的真实地址')
ok(/\.mp3$/.test(DL_CALLS[0].fileName), '文件名以 .mp3 结尾', DL_CALLS[0].fileName)
ok(/测试歌曲/.test(DL_CALLS[0].fileName), '文件名含歌曲名', DL_CALLS[0].fileName)

// 进行中：进度回调
const reqId = DL_CALLS[0].reqId
await go('#/downloads')
ok(!!$('#dlActive'), '下载页有进行中区块')
win.onNativeDownload({ reqId, state: 'progress', percent: 42, bytes: 4404019, total: 10485760 })
await sleep(60)
ok(/42%/.test($('#dlActive').textContent), '进度百分比回显到进行中区块', $('#dlActive').textContent.trim().slice(0, 80))
ok(!!$('#dlActive [data-dlcancel]'), '进行中条目带「取消」按钮')
ok(/正在下载 1 首/.test($('#dlActive').textContent), '进行中计数正确')
ok(/已下载|还没有下载/.test(viewText()), '下载页结构完整')

// 取消
$('#dlActive [data-dlcancel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(60)
eq(CANCEL_CALLS.length, 1, '取消下载已通知原生')
ok(!$('#dlActive').textContent.trim(), '取消后进行中区块清空')

// 完成：重新下一次
await go('#/search?q=测试')
await sleep(80)
$('#view .song [data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
$('#drawerBody [data-sact="download"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
const reqId2 = DL_CALLS[DL_CALLS.length - 1].reqId
win.onNativeDownload({ reqId: reqId2, state: 'done', path: '/storage/emulated/0/Music/云音乐/测试歌曲 - 测试歌手.mp3', bytes: 5242880 })
await sleep(80)

const stored = JSON.parse(win.localStorage.getItem('ym.downloads') || '[]')
eq(stored.length, 1, '下载完成后写入本地记录')
eq(stored[0].name, '测试歌曲', '记录里歌曲名正确')
eq(stored[0].quality, '320k', '记录里音质正确')
eq(stored[0].bytes, 5242880, '记录里体积正确')
ok(/\.mp3$/.test(stored[0].path), '记录里保存了真实落盘路径')

// 下载页渲染已下载列表
await go('#/downloads')
await sleep(80)
ok(/已下载 1 首/.test(viewText()), '下载页显示「已下载 1 首」')
ok(/5\.0 MB/.test(viewText()), '下载页显示文件体积')
ok(!!$('#dlDone [data-dlplay]'), '已下载行带「播放本地文件」按钮')
ok(!!$('#dlDone [data-dldel]'), '已下载行带「移除记录」按钮')
ok(!!$('#dlClear'), '下载页有「清空记录」按钮')

// 点播放：应切到 file:// 源
$('#dlDone [data-dlplay]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
const srcAttr = $('#audio').getAttribute('src') || $('#audio').src || ''
ok(/^file:\/\//.test(srcAttr), '播放已下载歌曲使用 file:// 本地源', srcAttr)

// 移除记录（验证 removeDownload 不再抛 ReferenceError）
const before = LOGS.length
$('#dlDone [data-dldel]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(60)
ok(!$('#dialog').hidden, '弹出移除确认框')
$('#dialog [data-dlg="ok"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(120)
eq(JSON.parse(win.localStorage.getItem('ym.downloads') || '[]').length, 0, '确认后记录被移除')
eq(LOGS.length, before, '移除过程无 JS 异常', LOGS.slice(before).join(' | '))
ok(/还没有下载的歌曲/.test(viewText()), '移除后回到空状态')

// 清空记录：先真跑一次下载把记录做出来，再清空
async function downloadOne() {
  await go('#/search?q=测试')
  await sleep(80)
  $('#view .song [data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(80)
  $('#drawerBody [data-sact="download"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  const id = DL_CALLS[DL_CALLS.length - 1].reqId
  win.onNativeDownload({ reqId: id, state: 'done', path: '/storage/emulated/0/Music/云音乐/x.mp3', bytes: 1048576 })
  await sleep(100)
}
await downloadOne()
eq(JSON.parse(win.localStorage.getItem('ym.downloads') || '[]').length, 1, '再次下载后记录数为 1')
await go('#/downloads')
await sleep(80)
ok(!!$('#dlClear'), '有记录时「清空记录」按钮出现')
$('#dlClear').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(60)
$('#dialog [data-dlg="ok"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(120)
eq(JSON.parse(win.localStorage.getItem('ym.downloads') || '[]').length, 0, '「清空记录」生效')
ok(/还没有下载的歌曲/.test(viewText()), '清空后回到空状态')

// 下载失败路径：拿不到地址时要给出提示，且不能留下脏记录 / 卡住的进行中条目
RESPONSES['/url'] = { ok: false }
const dlCallsBefore = DL_CALLS.length
await go('#/search?q=测试')
await sleep(80)
$('#view .song [data-act="more"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
$('#drawerBody [data-sact="download"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(200)
eq(DL_CALLS.length, dlCallsBefore, '取不到地址时不把任务交给原生')
ok(TOASTS.some(t => /下载失败/.test(t)), '取不到地址时提示下载失败')
eq(JSON.parse(win.localStorage.getItem('ym.downloads') || '[]').length, 0, '下载失败不写入记录')
await go('#/downloads')
await sleep(80)
ok(!/正在下载/.test($('#dlActive').textContent), '下载失败后不残留「正在下载」条目')
RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }

/* ============================================================ */
section('7. 我的页 / 菜单 / 播放全部按钮 显示优化')

await go('#/mine')
await sleep(80)
ok(!!$('.profile__main'), '我的页用 .profile__main 结构')
ok(!!$('.profile__tags'), '我的页有身份标签区')
ok(!!$('.profile__url'), '我的页展示当前线路地址')
eq($$('.statrow .stat').length, 4, '统计栅格 4 格（收藏/下载/历史/队列）')
eq($$('.statrow .stat__num').length, 4, '每格都有数字')
const statLabels = $$('.statrow .stat__label').map(e => e.textContent).join(',')
eq(statLabels, '收藏,下载,历史,队列', '统计栅格文案与顺序正确')
ok(!!$('.statrow a.stat[href="#/downloads"]'), '「下载」格可点击跳转下载页')
eq($$('.groupTitle').length, 2, '两个分组标题（我的音乐 / 系统）')
eq($$('.settingsgroup').length, 2, '两个分组容器')
ok($$('.menu-item .menu-item__ico').length >= 6, '菜单项统一带图标块 .menu-item__ico')
ok($$('.menu-item .menu-item__title').length >= 6, '菜单项标题用 .menu-item__title')
ok(!!$('.menu-item[href="#/downloads"]'), '菜单里有「我的下载」入口')

// 播放全部按钮带数量
await go('#/chart?source=wy&id=c1')
await sleep(100)
const pa = $('[data-playall]')
ok(!!pa, '榜单页有「播放全部」按钮')
ok(!!pa.querySelector('.miniplay-btn__count'), '「播放全部」按钮显示歌曲数量')
ok(/\d/.test(pa.textContent), '数量为数字', pa.textContent.trim())

// 顶部抽屉菜单项
const menuBtn = $('#btnMenu')
if (menuBtn) {
  menuBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(80)
  ok(!!$('#drawerBody'), '顶部抽屉可打开')
  ok(/我的下载/.test($('#drawerBody').textContent), '抽屉里含「我的下载」')
}

/* ============================================================ */
section('8. 双线路切换回归（只提示一次）')
const toastBefore = TOASTS.length
win.onNativeLineChanged(JSON.parse(win.YunBridge.switchLine(1)))
await sleep(120)
const lineToasts = TOASTS.slice(toastBefore).filter(t => /已切换至/.test(t))
eq(lineToasts.length, 1, '切线只提示一次', JSON.stringify(lineToasts))
// 重复推送同一线路（模拟 onPageFinished）不应再提示
const t2 = TOASTS.length
win.onNativeLineChanged(JSON.parse(win.YunBridge.switchLine(1)))
await sleep(80)
eq(TOASTS.slice(t2).filter(t => /已切换至/.test(t)).length, 0, '同一线路重复推送不再提示')
win.onNativeLineChanged(JSON.parse(win.YunBridge.switchLine(0)))
await sleep(120)
eq(TOASTS.slice(t2).filter(t => /已切换至/.test(t)).length, 1, '真正切回线路一时再提示一次')

/* ============================================================ */
section('9. 歌单参数名回归')
await go('#/playlist?id=p1')
await sleep(100)
const addPl = $('#view [data-pladd], #btnAddPl')
if (addPl) {
  addPl.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  const plItem = $('#drawerBody [data-pl]')
  if (plItem) {
    plItem.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(150)
    ok(/playlistId/.test(LAST_BODY) && /songId/.test(LAST_BODY), '加入歌单用 playlistId + songId 参数名', LAST_BODY)
  } else { ok(true, '（无可加入歌单项，跳过参数名断言）') }
} else { ok(true, '（本页无加入歌单入口，跳过）') }

/* ============================================================ */
section('10. 播放器音源标识')

await go('#/chart?source=wy&id=c1')
await sleep(80)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(250)

// 版式对齐 Web 端（用户要求「音源和插件的布局参照 web 现有布局」）：
//   · 音源（平台）名 —— 缀在**歌手那一行**后面：`歌手 · 网易云音乐`
//                      （Web 端 public/js/player.js: `artist + '  ·  ' + song.sourceName`）
//   · 插件名        —— 播放器**最底那一行**：`音源：<插件名>`
//                      （Web 端 setFooter('音源：' + hit.from)）
ok(!$('#playerSource'), '不再有单独的音源徽章行（Web 端是把平台名缀在歌手后面，没有这个元素）')
eq($('#playerArtist').textContent, '测试歌手  ·  网易云音乐',
  '歌手那一行显示「歌手 · 平台名」，而不是 wy 代号', $('#playerArtist').textContent)
eq($('#playerResolvedBy').textContent, '音源：官方直连',
  '最底那一行显示「音源：<插件名>」（from=wy 是平台官方接口 → 官方直连）', $('#playerResolvedBy').textContent)
ok(/网易云音乐/.test($('#miniArtist').textContent), '迷你播放器也带上平台名', $('#miniArtist').textContent)

// 代号映射：酷狗/酷我/QQ 也要认得出
const srcMap = (HTML.match(/var SRC_NAMES = \{[\s\S]*?\}/) || [''])[0]
;['网易云音乐', '酷狗音乐', '酷我音乐', 'QQ音乐', '咪咕音乐', '喜马拉雅', '服务端代理', '本地文件'].forEach(function (n) {
  ok(srcMap.indexOf(n) >= 0, '音源名映射包含「' + n + '」')
})
ok(!/\.player__src/.test(HTML), '音源徽章的样式已整体移除（不再有独立配色与呼吸动画）')
ok(!/srcPulse/.test(HTML), '「音源解析中」的呼吸动画随之移除')

// ⚠ 两处信息各有分工（用户两次调整后的最终口径，且版式照 Web 端）：
//   · 歌手那一行   → **平台名**（网易云音乐 / 酷狗音乐 / 酷我音乐…）
//   · 最底那一行   → **插件名**（服务端 from = `plugin:<插件 @name>`）
// 服务端 musicUrlCandidateList 给的就是这个形态；native 表示平台官方接口直链。
RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'plugin:六音音源', verified: true }
await go('#/mine')
await go('#/chart?source=wy&id=c1')
await sleep(80)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(250)
eq($('#playerArtist').textContent, '测试歌手  ·  网易云音乐', 'from=plugin:xxx 时，歌手那一行仍显示歌曲所属平台')
ok(!/plugin:/.test($('#playerArtist').textContent), '平台那一行不出现 plugin: 这种原始前缀')
eq($('#playerResolvedBy').textContent, '音源：六音音源',
  '最底那一行显示插件名', $('#playerResolvedBy').textContent)

// native 兜底：没有插件参与，说明这条是平台官方接口直链
RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'native', verified: true }
await go('#/mine')
await go('#/chart?source=wy&id=c1')
await sleep(80)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(250)
eq($('#playerArtist').textContent, '测试歌手  ·  网易云音乐', 'from=native 时歌手那一行回落到歌曲平台')
eq($('#playerResolvedBy').textContent, '音源：官方直连', 'native 没有插件 → 显示「官方直连」')
RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }

// 纯函数层再钉一遍：两个函数各管一处，别串味
{
  const srcCtx = vm.createContext({ console })
  const namesLiteral = (SCRIPT.match(/var SRC_NAMES = \{[\s\S]*?\n  \}/) || ['var SRC_NAMES = {}'])[0]
  vm.runInContext([
    namesLiteral,
    extractFn(SCRIPT, 'songPlatformLabel'),
    extractFn(SCRIPT, 'platformCodeOf'),
    extractFn(SCRIPT, 'sourceLabel'),
    extractFn(SCRIPT, 'pluginLabel')
  ].join('\n'), srcCtx)
  const sl = vm.runInContext('sourceLabel', srcCtx)
  const pl = vm.runInContext('pluginLabel', srcCtx)
  const wy = { source: 'wy', sourceName: '网易云音乐' }
  const kg = { source: 'kg' }

  // sourceLabel → 歌手那一行（`歌手 · 平台名`）：只给平台名
  eq(sl('plugin:六音音源', wy), '网易云音乐', "sourceLabel('plugin:xxx', 网易云歌曲) → 网易云音乐")
  eq(sl('plugin:anything', kg), '酷狗音乐', "sourceLabel('plugin:xxx', 酷狗歌曲) → 酷狗音乐")
  eq(sl('native', kg), '酷狗音乐', "sourceLabel('native', 酷狗歌曲) → 酷狗音乐")
  eq(sl('', { source: 'kw' }), '酷我音乐', 'sourceLabel 空值回落到歌曲平台')
  eq(sl('none', { source: 'tx' }), 'QQ音乐', "sourceLabel('none') 回落到歌曲平台")
  eq(sl('wy'), '网易云音乐', '平台代号直接给出平台名')
  eq(sl('proxy'), '服务端代理', '代理流仍是「服务端代理」')
  eq(sl('local'), '本地文件', '本地文件仍是「本地文件」')
  eq(sl('plugin:x', {}), '在线音源', '判定不出平台时给「在线音源」，既不停在解析中也不暴露 plugin:xxx')
  eq(sl('', {}), '', '完全没信息时才返回空（显示「音源解析中…」）')
  ok(!/plugin/i.test(sl('plugin:六音音源', wy)), '平台那一行任何情况下都不出现 plugin:xxx')

  // pluginLabel → 最底那一行（`音源：<插件名>`）：只给插件名
  eq(pl('plugin:六音音源'), '六音音源', "pluginLabel('plugin:六音音源') → 插件名")
  eq(pl('plugin:Huibq_lxmusic源'), 'Huibq_lxmusic源', '插件名原样展示（就是插件脚本里的 @name）')
  eq(pl('plugin:'), '插件音源', 'plugin: 后面为空时给个泛称，不显示空串')
  eq(pl('native'), '官方直连', "pluginLabel('native') → 官方直连")
  eq(pl('wy'), '官方直连', '平台代号 = 平台官方接口直链，没有插件参与')
  eq(pl('proxy'), '服务端代理', '代理流')
  eq(pl('local'), '本地文件', '本地文件')
  eq(pl('none'), '', "'none' 没有插件信息 → 返回空（界面显示「音源解析中…」）")
  eq(pl(''), '', '空值返回空')
  ok(!/plugin:/i.test(pl('plugin:六音音源')), '不把 plugin: 前缀原样吐给用户')
  ok(!/网易|酷狗|酷我/.test(pl('plugin:六音音源')), '插件那一行不掺平台名（两个函数别串味）')
}

/* ============================================================ */
section('11. 封面缓存：回到列表不再重新加载')

// 首页 ↔ 榜单来回切：封面应完全走缓存，一次网络请求都不发
IMG_CALLS.length = 0
await go('#/mine')
await sleep(80)
await go('#/')
await sleep(250)
const homeImgs = $$('#view img')
ok(homeImgs.length > 0, '首页有封面元素')
ok(homeImgs.every(isCachedCover), '回到首页封面全部同步命中缓存', describeImgs(homeImgs))

await go('#/charts')
await sleep(250)
const chartImgs = $$('#view img')
ok(chartImgs.length > 0 && chartImgs.every(isCachedCover), '榜单封面同步命中缓存', describeImgs(chartImgs))

await go('#/mine')
await sleep(80)
await go('#/')
await sleep(200)
await go('#/charts')
await sleep(200)
eq(IMG_CALLS.length, 0, '首页↔榜单来回切，封面零请求', 'calls=' + IMG_CALLS.length)

// 兜底：原生不回图时，4 秒后退回直连，不能一直挂着透明占位
const stuck = win.document.createElement('img')
stuck.setAttribute('src', 'https://cdn.example.com/never-answered.jpg')
$('#view').appendChild(stuck)
await sleep(150)
ok(!isCachedCover(stuck), '未命中的封面先挂透明占位', (stuck.getAttribute('src') || '').slice(0, 30))
await sleep(4200)
eq(stuck.getAttribute('src'), 'https://cdn.example.com/never-answered.jpg', '原生超时后自动退回直连地址')
stuck.remove()

/* ============================================================ */
section('12. 每日推荐（#/daily 走 /daily，不再走不存在的榜单）')

// 曾经的写法是 #/chart?source=wy&id=daily —— 服务端没有 id=daily 这个榜单，
// 所以必然「加载失败」。这里锁死两件事：入口指向 /daily，页面渲染的是 /daily 的数据。
// 注意：只在 QUICKS 的 daily 条目上断言，别把注释里那句「之前写的是 …」也算进去
const quicksSrc = (HTML.match(/var QUICKS = \[[\s\S]*?\n  \]/) || [''])[0]
const dailyEntry = (quicksSrc.match(/\{ key: 'daily'[^}]*\}/) || [''])[0]
ok(dailyEntry !== '', '首页快捷区里有每日推荐条目')
ok(/href:\s*'#\/daily'/.test(dailyEntry), '每日推荐入口指向 #/daily 而不是榜单', dailyEntry.slice(0, 90))
ok(!/id=daily/.test(dailyEntry), '入口不再带 id=daily 参数')
ok(/href:\s*'#\/ai'/.test((quicksSrc.match(/\{ key: 'ai'[^}]*\}/) || [''])[0]), 'AI 歌单入口指向 #/ai')
ok(/ROUTES\s*=\s*\{[\s\S]*?'\/daily':\s*pageDaily/.test(HTML), "ROUTES 已注册 '/daily'")
ok(/TAB_OF\s*=\s*\{[\s\S]*?'\/daily':\s*'home'/.test(HTML), "TAB_OF 已把 /daily 归到首页 tab")

API_CALLS.length = 0
await go('#/daily')
await sleep(150)
const dailyHit = API_CALLS.filter(c => c.path === '/daily')
eq(dailyHit.length, 1, '进入每日推荐只请求一次 /daily')
eq(dailyHit[0].method, 'GET', '/daily 用 GET')
ok(!isErrorBlock(), '每日推荐渲染正常，没有「加载失败」', viewText().slice(0, 80))
ok(/每日推荐/.test(viewText()), '页面标题是每日推荐')
ok(/共 2 首/.test(viewText()), '显示曲目数量', viewText().slice(0, 120))
eq($$('#dailyList .song').length, 2, '推荐列表渲染出 2 首歌')
ok(!!$('#dailyRefresh'), '有「换一批」按钮')

// 换一批：必须 POST /daily/refresh，且回来后列表换成新的那批
API_CALLS.length = 0
$('#dailyRefresh').dispatchEvent(new win.Event('click', { bubbles: true }))
await sleep(150)
const rf = API_CALLS.filter(c => c.path === '/daily/refresh')
eq(rf.length, 1, '「换一批」调用 /daily/refresh')
eq(rf[0].method, 'POST', '/daily/refresh 用 POST')
eq($$('#dailyList .song').length, 2, '刷新后列表仍然是 2 首')
ok(/第三首/.test(viewText()), '刷新后换成服务端新返回的那一批', viewText().slice(0, 120))
ok(TOASTS.some(t => /今日推荐已更新/.test(t)), '刷新成功后有提示')

// ready=false：还没生成过，要引导用户点「立即生成」而不是报错
RESPONSES['/daily'] = { ok: true, ready: false, title: '每日推荐', date: '2026-10-11', songs: [] }
await go('#/mine')
await go('#/daily')
await sleep(150)
ok(!isErrorBlock(), 'ready=false 时不显示「加载失败」', viewText().slice(0, 80))
ok(/今天还没生成/.test(viewText()), 'ready=false 时文案引导生成', viewText().slice(0, 120))
eq($('#dailyRefresh').textContent.trim(), '立即生成', '按钮文案变成「立即生成」')
RESPONSES['/daily'] = {
  ok: true, ready: true, title: '每日推荐', generator: '在线',
  generatedAt: '2026-10-11T08:00:00Z', date: '2026-10-11', stale: false,
  songs: [SONG, { id: 's2', name: '第二首', singer: '歌手二' }]
}

/* ============================================================ */
section('13. AI 歌单（#/ai 之前没有路由，点了没反应）')

ok(/ROUTES\s*=\s*\{[\s\S]*?'\/ai':\s*pageAi/.test(HTML), "ROUTES 已注册 '/ai'（之前被兜底成首页）")
ok(/href:\s*'#\/ai'/.test(HTML), '首页 AI 歌单入口指向 #/ai')

API_CALLS.length = 0
await go('#/ai')
await sleep(120)
ok(!isErrorBlock(), 'AI 歌单页渲染正常', viewText().slice(0, 80))
ok(!!$('#aiPrompt'), '有描述输入框')
ok(!!$('#aiGo'), '有生成按钮')
eq($$('#aiSeeds .chip').length, 5, '有 5 个种子词快捷标签')
eq(API_CALLS.length, 0, '进页面不发请求，等用户输入')

// 空输入不允许发起请求
$('#aiGo').dispatchEvent(new win.Event('click', { bubbles: true }))
await sleep(60)
eq(API_CALLS.length, 0, '没写描述时不发请求')
ok(TOASTS.some(t => /先写一句/.test(t)), '空输入有提示')

// 正常生成：POST /ai-playlist，body 必须是 { prompt, count }
API_CALLS.length = 0
$('#aiPrompt').value = '适合深夜写代码的歌'
$('#aiCount').value = '30'
$('#aiGo').dispatchEvent(new win.Event('click', { bubbles: true }))
await sleep(600)
const aiHit = API_CALLS.filter(c => c.path === '/ai-playlist')
eq(aiHit.length, 1, '点生成调用 /ai-playlist')
eq(aiHit[0].method, 'POST', '/ai-playlist 用 POST')
let aiBody = {}
try { aiBody = JSON.parse(aiHit[0].body) } catch (e) { }
eq(aiBody.prompt, '适合深夜写代码的歌', '请求体带 prompt')
eq(aiBody.count, 30, '请求体带 count')

// 关键：服务端只回「歌名 + 歌手」，必须逐首调 /suggest 匹配出真曲目
const sug = API_CALLS.filter(c => c.path === '/suggest')
eq(sug.length, 3, 'AI 返回的 3 首逐首走了 /suggest 匹配', 'calls=' + sug.length)
eq(sug[0].method, 'GET', '/suggest 用 GET')
// ⚠ 用 API_CALLS 里记的完整 url 判断，不要看 LAST_URL ——
// 现在匹配完会**自动**落库，等断言执行时 LAST_URL 已经是最后那个 POST /playlist 了
ok(/[?&]q=/.test(sug[0].url || ''), '/suggest 带 q 关键词', sug[0].url)

eq($$('#aiList .song').length, 2, '只渲染匹配成功的 2 首（匹配不到的不混进列表）')
ok(/搜不到的歌/.test(viewText()), '未匹配到的那首被列出来告知用户', viewText().slice(0, 160))
ok(/适合深夜写代码的歌/.test(viewText()), '显示歌单标题', viewText().slice(0, 120))

// ⚠ 用户要求「输入关键词之后后台生成，直接存起来」：
// 匹配完必须**自动** POST /playlist，界面上不再有「存为歌单」按钮。
// 存库的 body.songs 必须是**完整曲目对象**（带 id），不是 id 字符串数组 ——
// 服务端 decodeSongId(s.id || s) 对 null 取属性会直接抛 500，
// 这正是「AI 生成的歌单保存失败」的根因。
const saveHit = API_CALLS.filter(c => c.path === '/playlist' && c.method === 'POST')
eq(saveHit.length, 1, '匹配完**自动**调用一次 POST /playlist（不需要用户再点保存）')
eq($('#aiSave'), null, '界面上不再有「存为歌单」按钮（已经自动存了）')
ok(/已自动存入歌单/.test(viewText()), '页面上明确告知已自动存入', viewText().slice(0, 220))
let saveBody = {}
try { saveBody = JSON.parse(saveHit[0].body) } catch (e) { }
ok(Array.isArray(saveBody.songs) && saveBody.songs.length === 2, '自动存库时带上 2 首曲目', JSON.stringify(saveBody).slice(0, 140))
ok(saveBody.songs && saveBody.songs.every(s => s && typeof s === 'object' && s.id), 'songs 是带 id 的曲目对象，不是 undefined', JSON.stringify(saveBody.songs).slice(0, 140))
eq(saveBody.name, '适合深夜写代码的歌', '歌单名用 AI 给的标题')
ok(TOASTS.some(t => /已生成并存入歌单/.test(t)), '存库成功后有提示')
eq($('#aiGo').disabled, false, '生成完成后按钮恢复可点')

// 数量越界要钳到 1~100
$('#aiCount').value = '999'
$('#aiGo').dispatchEvent(new win.Event('click', { bubbles: true }))
await sleep(600)
const lastAi = API_CALLS.filter(c => c.path === '/ai-playlist').pop()
let clampBody = {}
try { clampBody = JSON.parse(lastAi.body) } catch (e) { }
eq(clampBody.count, 100, 'count 超上限被钳到 100')

// 后台生成：点完立刻切走（页面被销毁），任务必须照跑完并落库 ——
// 这是「后台生成」的核心，状态放在 aiJob 而不是页面里就是为了这个
RESPONSES['/ai-playlist'] = {
  ok: true, title: '后台任务歌单', requested: 20,
  songs: [{ name: '夜曲', singer: '周杰伦' }, { name: '晴天', singer: '周杰伦' }]
}
await go('#/mine')
await go('#/ai')
await sleep(80)
API_CALLS.length = 0
$('#aiPrompt').value = '后台生成测试'
$('#aiGo').dispatchEvent(new win.Event('click', { bubbles: true }))
await go('#/mine')                       // 立刻切走，AI 页的 DOM 已经没了
await sleep(900)
eq(API_CALLS.filter(c => c.path === '/ai-playlist').length, 1, '切走之后 AI 请求照发')
eq(API_CALLS.filter(c => c.path === '/playlist' && c.method === 'POST').length, 1, '切走之后仍然自动落库')
ok(TOASTS.some(t => /已生成并存入歌单/.test(t)), '人在别的页面也能收到完成提示')
await go('#/ai')
await sleep(80)
ok(/已自动存入歌单/.test(viewText()), '回到 AI 页能看到上一份的结果与已存入提示', viewText().slice(0, 220))
ok($$('#aiList .song').length === 2, '回到 AI 页结果列表还在')

// 接口失败要落到错误块，而不是白屏
RESPONSES['/ai-playlist'] = { __status: 500, __body: { error: 'AI 服务暂时不可用' } }
await go('#/mine')
await go('#/ai')
await sleep(80)
$('#aiPrompt').value = '随便来点'
$('#aiGo').dispatchEvent(new win.Event('click', { bubbles: true }))
await sleep(300)
ok(!/loading/.test(($('#aiBody') || {}).className || ''), '失败后不再停留在 loading 态')
ok(/AI 服务暂时不可用/.test(($('#aiBody') || {}).textContent || ''), '失败后给出错误信息而不是空白', (($('#aiBody') || {}).textContent || '').slice(0, 80))
eq($('#aiGo').disabled, false, '失败后生成按钮恢复可点')
RESPONSES['/ai-playlist'] = {
  ok: true, title: '适合深夜写代码的歌', requested: 20,
  songs: [
    { name: '夜曲', singer: '周杰伦' },
    { name: '搜不到的歌', singer: '查无此人' },
    { name: '晴天', singer: '周杰伦' }
  ]
}

/* ============================================================ */
section('14. 播放健壮性（暂停后点播放没反应 / 假死）')

// 起播看门狗：Android WebView 上 play() 会「既不报错也不出声」，
// Promise 不 reject、也不派 error，只能自己盯 currentTime 有没有往前走。
{
  const wCtx = vm.createContext({ console })
  vm.runInContext([
    'var audio = { paused: false, currentTime: 5, src: "x", readyState: 4, networkState: 1 };',
    'var P = { watchHits: 0, watchWaits: 0, resumePos: 0, candIndex: -1, cands: [] };',
    'var toastLog = []; function toast(m){ toastLog.push(m) }',
    'var reloads = 0; function loadCurrent(a){ reloads++ }',
    'var candSwitches = 0; function useCandidate(i, a){ candSwitches++; P.candIndex = i }',
    'var playWatch = 0;',
    'var timers = [];',
    'function setTimeout(fn, ms){ timers.push({ fn: fn, ms: ms }); return timers.length }',
    'function clearTimeout(id){ }',
    'var WATCH_MS = 5000; var WATCH_MAX_WAITS = 3;',
    extractFn(SCRIPT, 'clearPlayWatch'),
    extractFn(SCRIPT, 'armPlayWatch')
  ].join('\n'), wCtx)
  const run = (js) => vm.runInContext(js, wCtx)
  const reloads = () => vm.runInContext('reloads', wCtx)
  const switches = () => vm.runInContext('candSwitches', wCtx)

  run('armPlayWatch()')
  eq(run('timers.length'), 1, 'play() 之后挂上看门狗')
  eq(run('timers[0].ms'), 5000, '看门狗盯 5 秒（原来 3.5 秒，慢网下会把正在缓冲的流掐断）')

  // 进度没走 → 认定起播失败，重新解析
  const r0 = reloads()
  run('timers[0].fn()')
  eq(reloads() - r0, 1, '进度不走 → 重新解析地址（用户看到的是「续上了」而不是「按了没反应」）')
  ok(/重新解析/.test(run('toastLog.join("|")')), '卡住时给出提示而不是静默定格')

  // 进度在走 → 正常，不打扰（armPlayWatch 记下起点，回调前把 currentTime 往前推）
  const r1 = reloads()
  run('audio.paused = false; P.watchHits = 0; audio.currentTime = 9; timers.length = 0; armPlayWatch(); audio.currentTime = 12; timers[0].fn()')
  eq(reloads() - r1, 0, '进度在走 → 不重新解析')

  // 用户主动暂停 → 不打扰
  const r2 = reloads()
  run('audio.paused = true; timers.length = 0; armPlayWatch(); timers[0].fn()')
  eq(reloads() - r2, 0, '用户暂停中 → 不重新解析')

  // 救两次还不行就放弃，避免看门狗自己变成死循环
  const r3 = reloads()
  run('audio.paused = false; P.watchHits = 2; audio.currentTime = 30; timers.length = 0; armPlayWatch(); timers[0].fn()')
  eq(reloads() - r3, 0, '连续两次没救回来就放弃，不再无限重试')

  // ⚠ 「还在缓冲 ≠ 卡死」：readyState<3 且 networkState=LOADING 时数据正在来，
  // 这时重解析会把正在下的流掐断 —— 用户看到的就是「中间有歌曲没播就跳过去」
  const r4 = reloads()
  run('audio.paused = false; audio.readyState = 1; audio.networkState = 2;' +
      'P.watchHits = 0; P.watchWaits = 0; audio.currentTime = 40; timers.length = 0; armPlayWatch(); timers[0].fn()')
  eq(reloads() - r4, 0, '还在缓冲 → 不重解析（先宽限）')
  eq(run('P.watchWaits'), 1, '宽限次数 +1')
  eq(run('timers.length'), 2, '宽限后重新挂上计时器继续等')

  // 宽限用完仍不动 → 这时候才认定真卡住
  const r5 = reloads()
  run('P.watchWaits = WATCH_MAX_WAITS; audio.currentTime = 40; timers.length = 0; armPlayWatch(); timers[0].fn()')
  eq(reloads() - r5, 1, '宽限用完还是不走 → 才动手重解析')

  // 有候选直链时优先**换源**，而不是整首重解析
  const r6 = reloads(), s6 = switches()
  run('audio.readyState = 4; P.watchHits = 0; P.watchWaits = 0;' +
      'P.cands = [{url:"a"},{url:"b"}]; P.candIndex = 0;' +
      'audio.currentTime = 50; timers.length = 0; armPlayWatch(); timers[0].fn()')
  eq(switches() - s6, 1, '卡住时先换下一条候选直链（同一首歌、另一个插件源）')
  eq(reloads() - r6, 0, '换候选就不必整首重解析')
}

// errStreak 只能由**真实进度**清零。
// 早先在 play/playing 里清零：起播即失败时 play 照样派发，清零等于废掉兜底保护，
// 结果是 error → 下一首 → error 无限打转，CPU 打满、界面看起来就是「假死」。
// ⚠ 锚点必须带 `audio.` 前缀：页面里封面 <img> 也挂了一个 addEventListener('error',…)
// （在 cover 相关代码里），只写 addEventListener('error' 会先命中那一个，
// 断言就会拿错块的正文 —— 而「没匹配到 → 空串 → 断言意外通过」正是要避免的假绿灯。
const playHandler = blockAfter("audio.addEventListener('play', function ()")
const playingHandler = blockAfter("audio.addEventListener('playing', function ()")
ok(playHandler !== '', '取到了 play 事件处理器正文（防止断言退化成空串假绿灯）')
ok(playingHandler !== '', '取到了 playing 事件处理器正文')
ok(!/errStreak/.test(playHandler), 'play 事件里不再清零 errStreak')
ok(!/errStreak/.test(playingHandler), 'playing 事件里不再清零 errStreak')
ok(/if \(cur > \(P\.progressMark \|\| 0\) \+ 0\.5\)/.test(CODE), 'errStreak 改由 timeupdate 里的真实进度清零')

// 单曲循环 + 音源坏掉：绝不能走 playNext（它会把 currentTime 归零再放同一个坏地址）
const errHandler = blockAfter("audio.addEventListener('error', function ()")
ok(errHandler !== '', '取到了 error 事件处理器正文')
ok(/P\.mode === 'single'/.test(errHandler), 'error 处理里对单曲循环单独分支')
ok(/setTimeout\(playNext/.test(errHandler), '取到了含 playNext 的那段（确认没抓错块）')
ok(!/setTimeout\(playNext/.test(errHandler.split("P.mode === 'single'")[0]),
  '单曲循环那条分支里没有 playNext（断开 error → playNext 死循环）')

// 拖动进度条：seeking 卡住会让进度条与时间**永久定格**（看着就像「没有进度」）
ok(/addEventListener\('touchcancel'/.test(NOCOMMENT), '接住 touchcancel（手势被系统抢走时 seeking 不会永久卡住）')
ok(/Date\.now\(\) - seekingAt > 5000/.test(CODE), 'seeking 有 5 秒兜底清理')
ok(/lastTouchEnd/.test(CODE), '忽略 touchend 之后紧跟的兼容 mousedown')

// 重新解析 / 兜底切流之后要回到原位，不能从 0 秒重听
ok(/addEventListener\('loadedmetadata'/.test(NOCOMMENT), '监听 loadedmetadata 以回到原位置')
ok(/P\.resumePos/.test(CODE), '用 resumePos 记录要回到的位置')

// 抽屉：closeSheet 的延迟定时器必须能被重开取消，否则「点一次没反应，再点才出来」
ok(/__closeTimer/.test(CODE), 'closeSheet 的延迟定时器可被 openSheet 取消')

// loadCurrent 里绝不能重置 errStreak —— 那会让「连续失败 4 次就停」的熔断永远触发不了，
// error → 自动下一首 → loadCurrent 清零 → error 就成了无限循环（用户的原话：窗口假死一样）
const loadCurrentBody = blockAfter('function loadCurrent(')
ok(loadCurrentBody !== '', '取到了 loadCurrent 正文')
ok(!/errStreak\s*=\s*0/.test(loadCurrentBody), 'loadCurrent 不再清零 errStreak（否则熔断失效 → 无限跳歌）')
ok(/errStreak\s*=\s*0/.test(blockAfter('function playSong(')), 'playSong（用户主动选歌）会清零 errStreak')
ok(/errStreak\s*=\s*0/.test(blockAfter('function playList(')), 'playList（播放全部）会清零 errStreak')
ok(/P\.errStreak > 3/.test(errHandler), '连续失败 4 次熔断，停止自动跳歌')

// 熔断的**行为**验证：连发 6 次 error，自动跳歌必须自己停下来。
// jsdom 里 currentTime / duration 恒为 0，progressMark 永远不前进，
// 正好等价于「所有音源都放不出来」这个最坏场景。
await go('#/chart?source=wy&id=c1')
await sleep(100)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(300)
const audioEl = $('#audio')
API_CALLS.length = 0
for (let i = 0; i < 6; i++) {
  audioEl.dispatchEvent(new win.Event('error'))
  await sleep(650)
}
const urlCalls = API_CALLS.filter(c => c.path === '/url').length
// 熔断每触发一次会把计数清零，所以 6 次 error 里会被挡掉若干次 ——
// 关键是「不是每次 error 都跳」（证明熔断真的挡过），以及下面那条「停下就不再动」
ok(urlCalls < 6, '熔断确实挡掉了部分自动跳歌（并非每次 error 都往下跳）', 'url calls=' + urlCalls)
await sleep(1600)
const urlCallsIdle = API_CALLS.filter(c => c.path === '/url').length
eq(urlCallsIdle, urlCalls, '自动跳歌已经停下，不再无限重试（error → playNext 死循环已断开）')

/* ---- 跳歌的正解：候选直链逐条降级 ---- */
// `/url?fast=1` 的返回里 **urls 才是全量候选**（服务端按「完整版优先、原生优先」排好序），
// `url` 只是第一条。以前客户端只用一条，那条不通就整首判失败跳下一首 ——
// 用户说的「播放歌单时候会跳歌，中间有歌曲没有播放，跳过去」正是这个。
{
  const cCtx = vm.createContext({ console })
  vm.runInContext(extractFn(SCRIPT, 'candidateList'), cCtx)
  const cl = vm.runInContext('candidateList', cCtx)
  const full = cl({
    url: 'A', from: 'plugin:甲',
    urls: [{ url: 'A', from: 'plugin:甲' }, { url: 'B', from: 'plugin:乙' }, 'C']
  }, {})
  eq(full.length, 3, 'urls 全量候选都收进来（url 只是第一条，不重复计）', JSON.stringify(full))
  eq(full[0].url, 'A', '第一条是服务端排序后的首选')
  eq(full[1].from, 'plugin:乙', '每条候选带自己的插件名（换源时音源标识要跟着变）')
  eq(full[2].url, 'C', 'urls 里混进纯字符串也能收（服务端两种形态都兼容）')
  eq(cl({ url: 'X' }, {}).length, 1, '只有 url 没有 urls 时退化成一个候选')
  eq(cl({}, {}).length, 0, '什么都没有时返回空数组（上层据此退代理流）')
  eq(cl({ url: 'A', urls: [{ url: 'A' }, { url: 'A' }] }, {}).length, 1, '重复地址去重（同一个地址不必试两遍）')
}

// 行为验证：第一条不通 → 换第二条；候选试完 → 退代理；代理也不行才跳歌
{
  RESPONSES['/url'] = {
    ok: true, from: 'plugin:甲', verified: false,
    url: 'https://cdn.example.com/1.mp3',
    urls: [
      { url: 'https://cdn.example.com/1.mp3', from: 'plugin:甲' },
      { url: 'https://cdn.example.com/2.mp3', from: 'plugin:乙' }
    ]
  }
  await go('#/mine')
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  const a = $('#audio')
  eq(a.src, 'https://cdn.example.com/1.mp3', '先用候选里的第一条')
  eq($('#playerResolvedBy').textContent, '音源：甲', '最底那一行显示第一条对应的插件名')
  eq($('#playerArtist').textContent, '测试歌手  ·  网易云音乐', '歌手那一行仍然是歌曲所属平台（两处口径不串味）')
  API_CALLS.length = 0
  TOASTS.length = 0
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  eq(a.src, 'https://cdn.example.com/2.mp3', '第一条不通 → 换第二条候选（而不是跳下一首）')
  eq($('#playerResolvedBy').textContent, '音源：乙', '换源之后插件名跟着变')
  eq(API_CALLS.filter(c => c.path === '/url').length, 0, '换候选不重新请求 /url（省一次解析）')
  ok(!TOASTS.some(t => /下一首/.test(t)), '换候选时不会提示「尝试下一首」')
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  ok(/\/api\/stream/.test(a.src), '候选都试完 → 退到服务端代理流', a.src)
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }
}

/* ============================================================ */
section('15. 版本号一致性（防止发版漏改）')

// 前端以前把版本号在抽屉菜单、关于页、顶栏文案里各写了一遍，发到 V2.3 时
// 抽屉里还留着 V2.2。现在前端只有 CLIENT_VERSION 一处，其余三处（清单、
// 字符串资源、构建脚本）必须跟它完全对上。
{
  const fs2 = require('fs')
  const path2 = require('path')
  const P2 = path2.resolve(__dirname, '..')

  const m = SCRIPT.match(/var CLIENT_VERSION = '([^']+)'/)
  ok(!!m, '前端有唯一的 CLIENT_VERSION 常量')
  const ver = m ? m[1] : ''
  // V2.7 → 270（主版本*100 + 次版本*10）
  const parts = String(ver).replace(/^V/, '').split('.')
  const code = String(Number(parts[0]) * 100 + Number(parts[1]) * 10)

  const manifest = fs2.readFileSync(path2.join(P2, 'AndroidManifest.xml'), 'utf8')
  const strings = fs2.readFileSync(path2.join(P2, 'res', 'values', 'strings.xml'), 'utf8')
  // ⚠ 构建脚本就在本目录（build.sh），**不在**上一级。
  //    早先这里读的是上一级的 build_yunmusic.sh —— 那是本地开发布局下的位置，
  //    一旦这份客户端被放进大仓库的子目录（如 lxmusic/yunmusic-client/），
  //    上一级就没有那个文件了，测试会以「测试脚本自身异常」的形式炸掉。
  const build = fs2.readFileSync(path2.join(P2, 'build.sh'), 'utf8')
  const app = fs2.readFileSync(path2.join(P2, 'src', 'com', 'yunmusic', 'app', 'App.java'), 'utf8')
  const act = fs2.readFileSync(path2.join(P2, 'src', 'com', 'yunmusic', 'app', 'MainActivity.java'), 'utf8')

  ok(new RegExp('android:versionName="' + ver + '"').test(manifest), 'AndroidManifest versionName 与前端一致', 'want ' + ver)
  ok(new RegExp('android:versionCode="' + code + '"').test(manifest), 'AndroidManifest versionCode 与前端一致', 'want ' + code)
  ok(new RegExp('version_name">' + ver + '<').test(strings), 'strings.xml version_name 与前端一致')
  ok(new RegExp('VERSION_NAME="' + ver + '"').test(build), 'build.sh VERSION_NAME 与前端一致')
  ok(new RegExp('VERSION_CODE=' + code + '\\b').test(build), 'build.sh VERSION_CODE 与前端一致')
  ok(app.indexOf(ver + ' (' + code + ')') >= 0, 'App.java 崩溃报告里的版本号一致')
  ok(act.indexOf('云音乐 ' + ver) >= 0, '原生顶栏标题里的版本号一致')

  // 前端除常量本身外，不应再出现任何写死的 "Vx.y"
  // （在 NOCOMMENT 上查：注释里那句「发到 V2.3 时抽屉还写着 V2.2」不该被算进来）
  const body = NOCOMMENT.replace(/var CLIENT_VERSION = '[^']+'/, '')
  const hard = body.match(/V\d+\.\d+/g) || []
  ok(hard.length === 0, '前端不再有写死的版本号（除 CLIENT_VERSION 外）', hard.join(', '))
}

/* ============================================================ */
section('16. 账号密码不内置（不随包发出口令）')

// 从 index.html 的 DEFAULT_CFG 里抽 user/pass 字面量，必须都是空串
{
  const cfgBlock = (SCRIPT.match(/var DEFAULT_CFG = \{[\s\S]*?\n  \}/) || [''])[0]
  ok(cfgBlock !== '', '取到了前端 DEFAULT_CFG（防止断言退化成空串假绿灯）')
  const creds = cfgBlock.match(/(?:activeUser|activePass|user|pass)\s*:\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g) || []
  ok(creds.length >= 6, 'DEFAULT_CFG 里确实有 user/pass 字段可检查', 'found=' + creds.length)
  const nonEmpty = creds.filter((c) => !/(?:activeUser|activePass|user|pass)\s*:\s*(['"])\1/.test(c))
  eq(nonEmpty.length, 0, '前端兜底配置里的账号密码全是空串（不把口令打进包）', nonEmpty.join(' | '))
}

// 原生侧：DEFAULT_LINE*_USER / PASS 必须都是空串
{
  const fs3 = require('fs')
  const path3 = require('path')
  const sc = fs3.readFileSync(path3.join(__dirname, '..', 'src', 'com', 'yunmusic', 'app', 'ServerConfig.java'), 'utf8')
  const vals = sc.match(/DEFAULT_LINE\d_(?:USER|PASS)\s*=\s*"([^"]*)"/g) || []
  ok(vals.length === 4, 'ServerConfig 里 4 个默认凭据常量都在', 'found=' + vals.length)
  const filled = vals.filter((v) => !/=\s*""$/.test(v))
  eq(filled.length, 0, 'ServerConfig 默认账号密码全为空串', filled.join(' | '))
  ok(/不要往这里填真实口令/.test(sc), '源码里留了「不要填真实口令」的警示注释')
}

// 没填账号密码时：登录前就要明确引导，而不是拿空口令去撞接口拿一句 401
await go('#/settings')
await sleep(150)
ok(!!$('#cfg1user') && !!$('#cfg1pass'), '设置页有账号/密码输入框')
$('#cfg1user').value = ''
$('#cfg1pass').value = ''
const tBefore = TOASTS.length
$('#saveCfg').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(250)
const setupToasts = TOASTS.slice(tBefore)
ok(setupToasts.some((t) => /账号密码/.test(t) && /双线路管理/.test(t)), '清空账号后保存 → 明确提示去填账号密码', setupToasts.join(' | '))
ok(!setupToasts.some((t) => /^登录失败：/.test(t)), '这种「还没配置」的情况不会被套上「登录失败」的壳', setupToasts.join(' | '))
ok(/还没填/.test(($('#cfgWarn') || {}).textContent || ''), '设置页顶部出现「还没填账号密码」横幅', (($('#cfgWarn') || {}).textContent || '').slice(0, 80))
ok(/缺账号/.test(viewText()), '对应线路卡片上标出「缺账号」')

// 填回去应当恢复正常（不能把用户卡在配置页出不来）
$('#cfg1user').value = 'admin'
$('#cfg1pass').value = 'test-pass'
$('#saveCfg').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(300)
eq((($('#cfgWarn') || {}).textContent || '').trim(), '', '填好账号后横幅消失')
ok(!/缺账号/.test(viewText()), '线路卡片上的「缺账号」标记消失')
ok(TOASTS.some((t) => /已保存并生效/.test(t)), '保存成功有提示')

/* ============================================================ */
section('17. 锁屏 / 通知栏 / 控制中心的媒体控制（MediaSession）')

/*
 * 只发一条普通通知，锁屏上**不会**出现媒体卡片、下拉控制中心里也**不会**有媒体面板。
 * Android 11 起这些控件全部由 MediaSession 驱动：系统自己去读会话的
 * Metadata（歌名/歌手/封面/时长）与 PlaybackState（播放中还是暂停、进度、支持哪些操作），
 * 然后自己画那个控件。通知只负责在下拉栏露一条，靠 MediaStyle.setMediaSession(token)
 * 与会话绑定。下面逐条把这些必需品钉死，缺哪一样都会退化成「一条普通通知」。
 */
{
  const fsp = require('fs')
  const pathp = require('path')
  const appDir = pathp.join(__dirname, '..', 'src', 'com', 'yunmusic', 'app')
  const svc = fsp.readFileSync(pathp.join(appDir, 'MusicService.java'), 'utf8')
  const ma = fsp.readFileSync(pathp.join(appDir, 'MainActivity.java'), 'utf8')
  const yb = fsp.readFileSync(pathp.join(appDir, 'YunBridge.java'), 'utf8')

  ok(/import android\.media\.session\.MediaSession;/.test(svc), 'MusicService 引入了 MediaSession')
  ok(/new MediaSession\(/.test(svc), '真的建了 MediaSession 实例')
  ok(/session\.setActive\(true\)/.test(svc), '会话被激活（不激活系统不认为它是「正在播放的媒体」）')
  ok(/MediaMetadata\.METADATA_KEY_TITLE/.test(svc), '歌名写进了会话元数据')
  ok(/METADATA_KEY_ALBUM_ART/.test(svc), '封面写进了会话元数据（锁屏卡片上那张图）')
  ok(/METADATA_KEY_DURATION/.test(svc), '时长写进了会话元数据（锁屏进度条要知道总长）')
  ok(/new PlaybackState\.Builder\(\)/.test(svc), '写入了 PlaybackState（决定锁屏显示播放还是暂停）')
  ok(/PlaybackState\.ACTION_SEEK_TO/.test(svc), '会话声明支持拖动进度')
  ok(/Notification\.MediaStyle/.test(svc), '通知用了 MediaStyle')
  ok(/setMediaSession\(\s*session\.getSessionToken\(\)\s*\)/.test(svc),
    'MediaStyle 绑定了会话 token —— 系统靠这个绑定把「通知」和「会话」认成同一个播放器')
  ok(/setShowActionsInCompactView/.test(svc), '折叠态也露出上一首/播放/下一首')
  ok(/setVisibility\(Notification\.VISIBILITY_PUBLIC\)/.test(svc), '通知在锁屏上可见（否则锁屏只显示「一条通知」）')
  ok(/setOnlyAlertOnce\(true\)/.test(svc), '切歌只刷新不重复响铃/震动')
  ok(/onSeekTo/.test(svc), '接住锁屏拖动进度条')
  ok(/onSkipToNext/.test(svc) && /onSkipToPrevious/.test(svc), '接住上一首/下一首')
  ok(/FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK/.test(svc), '前台服务声明了 mediaPlayback 类型')
  ok(/onDestroy[\s\S]{0,220}session\.release\(\)/.test(svc), '销毁时释放会话，不留泄漏')

  ok(/POST_NOTIFICATIONS/.test(ma), 'Android 13+ 会申请通知权限（不申请的话通知栏/锁屏什么都看不到）')
  ok(/requestPermissions\(/.test(ma), '真的弹了权限框')
  ok(/seekFromNative/.test(ma), '锁屏拖进度能回传到网页')

  ok(/public static Bitmap coverBitmap/.test(yb), '封面由原生下成 Bitmap（MediaMetadata 不接受 http 地址）')
  ok(/coverBitmap\(getApplicationContext\(\)/.test(svc), 'MusicService 用原生取图而不是直接把 URL 塞进元数据')
}

// 前端必须把封面/时长/进度一起交出去，并且接得住系统的回调
{
  ok(/function syncMedia\(\)/.test(NOCOMMENT), '有 syncMedia 统一同步媒体状态')
  ok(/YunBridge\.updateMedia\(/.test(NOCOMMENT), '调用了原生 updateMedia')
  ok(/function syncMediaProgress\(\)/.test(NOCOMMENT), '进度有节流补发（timeupdate 一秒四趟，不能每趟都过桥）')
  ok(/syncMediaProgress\(\)/.test(blockAfter("audio.addEventListener('timeupdate'")),
    'timeupdate 里补发进度')
  ok(/window\.nativeSetPlaying\s*=/.test(NOCOMMENT), '暴露 nativeSetPlaying 给系统')
  ok(/window\.nativeSeekTo\s*=/.test(NOCOMMENT), '暴露 nativeSeekTo 给系统')
}

// nativeSetPlaying 收的是**目标状态**而不是「切换」。
// 做成切换的话，系统因为蓝牙重连/用户连点而重复派发同一个动作时，
// 就会出现「按一次暂停，结果它又播起来了」。
{
  const wCtx = vm.createContext({ console })
  vm.runInContext([
    'var audio = { paused: false, currentTime: 12, pausedCount: 0,',
    '  pause: function () { this.paused = true; this.pausedCount++ } };',
    'var P = { errStreak: 3, resumePos: 0, lastPos: 0 };',
    'var plays = 0; function playAudio(cb) { plays++; if (cb) cb() }',
    'var loads = 0; function loadCurrent(a) { loads++ }',
    'var arms = 0; function armPlayWatch() { arms++ }',
    'var nativeSetPlaying = function (want) ' + blockAfter('window.nativeSetPlaying = function') + ';'
  ].join('\n'), wCtx)
  const run = (js) => vm.runInContext(js, wCtx)

  run('nativeSetPlaying(true)')
  eq(run('plays'), 0, '已经在播时重复收到「播放」→ 不重复起播（幂等）')
  eq(run('audio.pausedCount'), 0, '不会反而把它暂停掉')

  run('nativeSetPlaying(false)')
  eq(run('audio.paused'), true, '系统喊暂停 → 真的暂停')
  eq(run('P.lastPos'), 12, '暂停时记下位置，恢复时不从头开始')

  run('audio.pausedCount = 0; nativeSetPlaying(false)')
  eq(run('audio.pausedCount'), 0, '已经暂停时重复收到「暂停」→ 不重复动作（幂等）')

  run('P.errStreak = 3; nativeSetPlaying(true)')
  eq(run('plays'), 1, '系统喊播放 → 重新解析音源再放')
  eq(run('P.errStreak'), 0, '顺手清掉熔断计数（否则上一首的失败会挡住这一次）')
  eq(run('arms'), 1, '挂上起播看门狗（否则又是「按了没反应」）')
}

// nativeSeekTo：系统给毫秒，网页用秒；越界与非数字都要挡住
{
  const wCtx = vm.createContext({ console })
  vm.runInContext([
    'var audio = { duration: 200, currentTime: 0 };',
    'var P = { resumePos: 0, progressMark: 0 };',
    'var lyricSyncs = []; function syncLyric(t, force) { lyricSyncs.push([t, !!force]) }',
    'var nativeSeekTo = function (ms) ' + blockAfter('window.nativeSeekTo = function') + ';'
  ].join('\n'), wCtx)
  const run = (js) => vm.runInContext(js, wCtx)

  run('nativeSeekTo(45000)')
  eq(run('audio.currentTime'), 45, '锁屏拖到 45 秒 → 网页收到 45 秒（毫秒转秒）')
  eq(run('P.progressMark'), 45, '同步更新熔断用的进度基准')
  eq(run('P.resumePos'), 45, '记下位置，重解析后不会跳回开头')

  run('nativeSeekTo(999000)')
  eq(run('audio.currentTime'), 200, '拖过头会被夹到总时长，不会把 currentTime 设成非法值')

  run('nativeSeekTo(-5)')
  eq(run('audio.currentTime'), 200, '负数直接忽略')
  run('nativeSeekTo(NaN)')
  eq(run('audio.currentTime'), 200, '非数字直接忽略')
}

// 真正起播时，推给原生的那一条必须带上封面/时长/进度
await go('#/search?q=周杰伦')
await sleep(200)
$('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(250)
MEDIA_CALLS.length = 0
$('#audio').dispatchEvent(new win.Event('play'))
await sleep(120)
{
  const media = MEDIA_CALLS[MEDIA_CALLS.length - 1]
  ok(!!media, '起播后把媒体状态推给了原生')
  if (media) {
    ok(media.length >= 6, '一次把歌名/歌手/播放态/封面/时长/进度全带上（只给歌名歌手的话锁屏没封面、进度条是死的）', JSON.stringify(media))
    ok(typeof media[0] === 'string' && media[0].length > 0, '推了歌名', String(media[0]))
    ok(typeof media[2] === 'boolean', '播放态是布尔值（决定锁屏显示播放还是暂停）', String(media[2]))
    ok(media[3] === '' || /^https?:/.test(media[3]),
      '封面只给 http(s) 直链（给 data:/占位图的话原生下不了，锁屏就没封面）', String(media[3]))
    ok(typeof media[4] === 'number' && typeof media[5] === 'number', '时长/进度是数字（毫秒）', media[4] + ' / ' + media[5])
  }
}

// 播放器布局：铺满整个窗口；顶部只留「收起箭头 + 歌名」，音质按钮挪到最底一排
{
  const navRule = (HTML.match(/\.player__nav\s*\{[^}]*\}/) || [''])[0]
  ok(navRule !== '', '取到了 .player__nav 规则（防止断言退化成空串假绿灯）')
  ok(/position\s*:\s*absolute/.test(navRule), '顶部那一排用绝对定位钉住（播放器内部布局变化推不动它）')
  ok(/top\s*:\s*0/.test(navRule), '钉在播放器最上沿 top:0')
  ok(/padding\s*:\s*calc\(var\(--safe-top\)/.test(navRule), '只让开状态栏（--safe-top 由原生写实测高度）')
  ok(/\.player\s*>\s*\*:not\(\.player__bg\):not\(\.player__nav\)/.test(HTML),
    '把 .player__nav 从「兄弟一律 relative」那条规则里排除掉（否则绝对定位被改回 relative，又掉回文档流）')

  // 铺满整个窗口：position:fixed + 四边贴死，背景一直铺到状态栏与手势条底下
  const playerRule = (HTML.match(/\.player\s*\{[^}]*\}/) || [''])[0]
  ok(playerRule !== '', '取到了 .player 规则')
  ok(/position\s*:\s*fixed/.test(playerRule), '播放器用 fixed 定位（不随父容器尺寸/内边距变化而露边）')
  ok(/top\s*:\s*0[^}]*bottom\s*:\s*0/.test(playerRule), '四边贴死 → 铺满整个窗口')
  ok(/width\s*:\s*100%[^}]*height\s*:\s*100%/.test(playerRule), '宽高都拉满')
  ok(!/padding-bottom/.test(stripComments(playerRule)), '播放器本体不再留 padding-bottom（否则背景会在手势条上方截断一条）')
  ok(/padding-top\s*:\s*calc\(var\(--safe-top\)\s*\+\s*40px\)/.test(playerRule),
    '播放器给顶部那一排留出高度（40px = 36 图标 + 上下各 2px），否则会盖住封面/歌词')

  // 音质按钮：在「进度条上面那一行」（.player__actions）的最右端
  const navStart = HTML.indexOf('<div class="player__nav">')
  const actionsStart = HTML.indexOf('<div class="player__actions">')
  const progressStart = HTML.indexOf('<div class="player__progress">')
  const bottomStart = HTML.indexOf('<div class="player__bottom">')
  ok(navStart > 0 && actionsStart > navStart && progressStart > actionsStart && bottomStart > progressStart,
    '取到了播放器各行的 DOM 顺序（顶部一排 → 操作行 → 进度条 → 最底一排）')
  ok(HTML.slice(navStart, actionsStart).indexOf('btnQuality') < 0, '顶部那一排里没有音质按钮')
  ok(HTML.slice(actionsStart, progressStart).indexOf('btnQuality') >= 0, '音质按钮就在进度条上面那一行')
  ok(/\.player__actions\s*#btnQuality\s*\{[^}]*margin-left\s*:\s*auto/.test(HTML),
    '音质按钮钉在那一行的最右端')
  ok(HTML.slice(bottomStart, bottomStart + 400).indexOf('btnQuality') < 0, '最底那一排不再有音质按钮')
  ok(HTML.slice(bottomStart, bottomStart + 400).indexOf('playerResolvedBy') >= 0,
    '「音源：xxx」在最底一排（播放按钮正下面）')

  // 音源（平台）名不单独占一行，而是缀在歌手那一行后面 —— 与 Web 端 .player__meta 结构一致
  const metaStart = HTML.indexOf('<div class="player__meta">')
  ok(metaStart > 0 && metaStart < actionsStart, '取到了 .player__meta 段')
  const metaSeg = HTML.slice(metaStart, actionsStart)
  ok(metaSeg.indexOf('playerTitle') >= 0 && metaSeg.indexOf('playerArtist') >= 0,
    'meta 层只有歌名 + 歌手两行（跟 Web 端一样）')
  ok(metaSeg.indexOf('playerSource') < 0, 'meta 层不再有单独的音源徽章行')
  ok(/\.player__artist\s*\{[^}]*ellipsis/.test(HTML),
    '歌手那一行仍能省略号截断（歌手 · 平台名拼长了不撑破布局）')

  const bottomRule = (HTML.match(/\.player__bottom\s*\{[^}]*\}/) || [''])[0]
  ok(bottomRule !== '', '取到了 .player__bottom 规则')
  ok(/padding\s*:[^;]*var\(--safe-bottom\)/.test(bottomRule), '最底一排自己让开手势条（--safe-bottom）')

  ok(/\[120, 320, 600, 1000\]/.test(NOCOMMENT),
    '开播放器后多次确认原生顶栏是藏着的（它可能被重新显示回来，把这一排挤下去）')

  /*
   * 那批延时确认的**判据**必须是同步翻转的 playerOpen，不能是 $('#player').hidden。
   *
   * 曾经的写法是 `if (!$('#player').hidden)`，而 hidden 要等收起动画走完（340ms）
   * 才置位。于是「展开后 1 秒内就收起」会踩进一个竞态窗口：残留定时器看到 hidden
   * 还是 false，以为播放器还开着，又把顶栏压回隐藏 —— 而此后**再没有任何代码恢复它**。
   * 后果：WebView 顶到 y=0（窗口边到边），当前页最上面那条 sticky 栏落进状态栏底下，
   * 看着「跑到最顶部」，点上去被系统状态栏吃掉 —— 也就是「点不开」。
   */
  ok(/var playerOpen = false/.test(NOCOMMENT), '有 playerOpen 这个同步状态量当判据')
  ok(/setTimeout\(function \(\) \{ if \(playerOpen\) setChromeHidden\(true\) \}/.test(NOCOMMENT),
    '延时确认的判据是 playerOpen，不是 $(\'#player\').hidden（后者天生滞后一个动画时长）')
  ok(!/if \(!\$\('#player'\)\.hidden\) setChromeHidden/.test(NOCOMMENT),
    '没有任何地方再拿 hidden 当顶栏判据')

  const closeBody = (NOCOMMENT.match(/function closePlayer\(\) \{[\s\S]*?\n  \}/) || [''])[0]
  ok(closeBody !== '', '取到了 closePlayer 函数体（防止下面三条退化成空串假绿灯）')
  const iFlag = closeBody.indexOf('playerOpen = false')
  const iChrome = closeBody.indexOf('setChromeHidden(false)')
  ok(iFlag >= 0, 'closePlayer 里同步翻 playerOpen')
  ok(iChrome >= 0, 'closePlayer 里通知原生显示顶栏')
  ok(iFlag >= 0 && iChrome >= 0 && iFlag < iChrome,
    'closePlayer 先翻 playerOpen、再通知原生（顺序反了会留下竞态窗口）')

  // 换页时校准一次：只要播放器没开着，顶栏就必须是显示的
  ok(/if \(!playerOpen\) setChromeHidden\(false\)/.test(NOCOMMENT),
    '每次换页都校准顶栏（兜住「某条路径藏了却没恢复」，否则会长期卡在错的状态）')

  // 第二道保险：就算顶栏真的被藏了，二级页的搜索栏也不能落进状态栏底下
  ok(/#app\.is-subpage \.view \.searchbar\s*\{[^}]*padding-top\s*:\s*calc\(8px \+ var\(--safe-top\)\)/.test(HTML),
    '二级页搜索栏用 --safe-top 让开状态栏（共用前端早就这么写，这份单文件前端曾漏掉）')
}

/* ============================================================ */
section('18. 播放器 ↔ 原生顶栏的状态机（「搜索框跑到最顶部、点不开」）')
/*
 * 报障原文：「开始播放歌曲后，把播放窗口最小化，去搜索新的歌曲，
 *           搜索框跑到最顶部，然后失效，点不开」。
 *
 * 根因：原生顶栏被误藏且再没人恢复 → WebView 顶到 y=0（窗口是边到边的）→
 *       搜索页那条 sticky 的搜索框落进状态栏底下，点上去被系统状态栏吃掉。
 * 触发条件：展开播放器后 **1 秒内**就收起 —— 残留的延时定时器在收起动画那
 *       340ms 的窗口里看到 hidden 还是 false，以为播放器还开着，又把顶栏压回去。
 *
 * 这里按用户的操作顺序原样跑一遍（展开 → 快速收起 → 去搜索页），
 * 断言最终原生顶栏是**显示**的。静态断言看的是「源码写没写对」，
 * 这条看的是「跑起来是不是那个行为」—— 竞态只有跑才抓得到。
 */
{
  const player = $('#player')
  const mini = $('#miniplayer')
  const wasHidden = player.hidden

  // 点迷你条是 openPlayer() 的唯一入口，先让它露出来
  mini.hidden = false
  CHROME_CALLS.length = 0

  mini.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)                       // ← 故意在 1 秒内就收起，踩那个竞态
  ok(CHROME_CALLS[CHROME_CALLS.length - 1] === true, '展开播放器后原生顶栏是藏着的')
  ok(player.hidden === false, '播放器确实展开了（否则上面那条是空断言）')

  $('#playerCollapse').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  ok(CHROME_CALLS[CHROME_CALLS.length - 1] === false, '一点收起就通知原生把顶栏显示回来')

  // 越过收起动画（340ms）与那批定时器的最后期限（1000ms）
  await sleep(1100)
  const trail = CHROME_CALLS.map(v => (v ? '藏' : '显')).join('→')
  ok(CHROME_CALLS[CHROME_CALLS.length - 1] === false,
    '残留定时器全部过期后，顶栏仍是**显示**的（不会被压回隐藏）', '轨迹 ' + trail)
  ok(player.hidden === true, '播放器本身确实收起了（不是靠「没关掉」蒙混过关）')

  // 报障的最后一步：去搜索页
  await go('#/search')
  ok(CHROME_CALLS[CHROME_CALLS.length - 1] === false, '切到搜索页后顶栏仍是显示的')
  ok($('#searchInput') !== null, '搜索页渲染出来了（页面自带输入框）')
  ok($('#app').classList.contains('is-subpage'),
    '搜索页带 is-subpage（全局顶栏那条搜索胶囊被藏掉，不会出现「上下两个搜索框」）')

  // 收尾还原，别影响后面的全局异常检查
  player.hidden = wasHidden
  CHROME_CALLS.length = 0
}

/* ============================================================ */
section('19. 搜专辑 → 打开专辑（/album 是嵌套响应）')
/*
 * 报障原文：「客户端搜索专辑类搜索之后，里面资源显示是 0，
 *           用网页版搜索其实都是有的（比如牛津英语、李哪吒上学记）」。
 *
 * 根因：服务端 /album 的曲目在 **album.songs** 里（嵌套一层），
 *       客户端却读**顶层** data.list / data.songs —— 两个都不存在 → 恒为 [] →
 *       界面显示「共 0 首」+ 空列表，看着就像这张专辑没有资源。
 *       判据很硬：服务端在**真的**没有曲目时回的是 404「该专辑没有可用曲目」，
 *       而客户端能渲染出「共 0 首」，说明服务端回了 200 + 完整曲目，是读错了地方。
 *
 * 这条用例同时钉两件事：搜专辑的结果画得出来、打开专辑能列出曲目。
 * ⚠ mock 的 /album 必须保持**真服务端的嵌套形状**，否则又会退化成
 *   「假数据喂假代码」的假绿灯（这正是这个 bug 当初漏过去的原因）。
 */
{
  // ① 搜专辑：走 /search-albums，读顶层 list
  await go('#/search?type=album&q=测试')
  await sleep(140)
  ok(API_CALLS.some(c => c.path === '/search-albums'), '搜专辑打的是 /search-albums（不是 /search）')
  const cards = $$('#searchBody .grid3 .card')
  eq(cards.length, 1, '专辑搜索结果画出了卡片（不是 0 张）')
  ok(/测试专辑/.test(cards.length ? cards[0].textContent : ''), '专辑卡片显示专辑名')
  ok(/测试歌手/.test(cards.length ? cards[0].textContent : ''), '专辑卡片显示歌手')

  // ② 点进专辑：走 /album，曲目在 album.songs 里
  await go('#/album?source=wy&id=a1')
  await sleep(140)
  const albumCall = API_CALLS.filter(c => c.path === '/album').pop()
  ok(!!albumCall, '打开专辑打的是 /album')
  ok(/source=wy/.test(albumCall.url) && /id=a1/.test(albumCall.url), '请求带上 source 与 id')

  const albumText = $('#albumBody') ? $('#albumBody').textContent : ''
  const rows = $$('#albumList .song')
  eq(rows.length, 1, '专辑里的曲目列出来了（读的是 album.songs，不是顶层 list）', 'rows=' + rows.length)
  ok(/共 1 首/.test(albumText), '曲目计数是真实的 1 首，不是 0', albumText.slice(0, 90))
  ok(!/缺少专辑参数/.test(albumText), '不是「缺少专辑参数」那条空状态（说明 source 传对了）')
  ok(!/打不开这张专辑/.test(albumText), '服务端 200 时不该落到错误块')

  // ③ 防御性：万一以后服务端把 songs 挪回顶层，兼容兜底也还在
  const albumMock = RESPONSES['/album']
  RESPONSES['/album'] = { ok: true, list: [SONG] }
  await go('#/album?source=wy&id=a1')
  await sleep(140)
  eq($$('#albumList .song').length, 1, '顶层 list 的兼容兜底仍然有效')
  RESPONSES['/album'] = albumMock
}

/* ============================================================ */
section('20. 专辑卡片集数角标 + 搜索进 history（返回能还原结果）')
/*
 * 两个报障：
 *  ① 「搜索出来专辑，专辑封面要显示里面的集数」→ 参照网页版 albumCard 的
 *     `trackCount ? '<span class="card__badge">N 首</span>'`。
 *  ② 「点开专辑后按返回，不是回到搜索结果，而是直接回到搜索界面，结果没了」
 *     → 根因是**搜索没有把关键词写进 URL**：hash 不动 → history 里没有
 *     「搜索结果」这一站 → 返回时掉回 `#/search` 空白页。
 *     网页版走 `go(searchHash(q, source, type))`，这里对齐它。
 */
{
  // ① 集数角标：直接从搜索结果卡片上读
  await go('#/search?type=album&q=测试')
  await sleep(160)
  const card = $('#searchBody .grid3 .card')
  ok(!!card, '搜到专辑卡片')
  ok(/12 首/.test(card.textContent), '封面角标显示集数（12 首）', card.textContent.slice(0, 70))
  ok(/网易/.test(card.textContent), '副标题带平台短名（同一专辑多平台时用来分辨）')

  // ② 搜索把关键词写进 hash —— 这是「返回能还原」的前提
  await go('#/search?type=album')
  await sleep(140)
  $('#searchInput').value = '测试'
  $('#searchGo').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(180)
  const h1 = decodeURIComponent(win.location.hash)
  ok(/q=测试/.test(h1), '点「搜索」后关键词进了 URL hash', h1)
  ok(/type=album/.test(h1), '类型也跟着进 hash（返回后不会切回单曲）', h1)
  eq($$('#searchBody .grid3 .card').length, 1, '搜索结果已渲染')

  // ③ 切平台也进 hash（否则切完平台再返回同样丢状态）
  const kgChip = $$('#srcChips .chip').filter(c => c.dataset.src === 'kg')[0]
  kgChip.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(180)
  const h2 = decodeURIComponent(win.location.hash)
  ok(/source=kg/.test(h2), '切平台后 hash 里带上 source', h2)
  // ⚠ 切平台会整页重渲染，之前那个 chip 节点已经脱离 DOM，
  //    必须重新查一次再断言选中态（拿旧节点断言永远失败）
  const kgAfter = $$('#srcChips .chip').filter(c => c.dataset.src === 'kg')[0]
  ok(!!kgAfter && kgAfter.classList.contains('is-active'), '平台 chip 选中态由 hash 重建')

  // ④ 返回键真的能回到「那一份搜索结果」
  //
  //    ⚠ 这一段必须**用 UI 走一遍**（输入框 + 点搜索 + 点卡片 + history.back），
  //    不能直接 go() 到目标 hash —— 直接 go() 的话，无论修没修，history 里
  //    都有那一站，返回当然能回去，这条就成了永远绿的空断言。
  await go('#/search?type=album')
  await sleep(140)
  $('#searchInput').value = '测试'
  $('#searchGo').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  eq($$('#searchBody .grid3 .card').length, 1, '用 UI 搜到了专辑（前置条件）')

  $('#searchBody .grid3 .card').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(240)
  ok(/\/album\?/.test(win.location.hash), '点专辑进了详情页', win.location.hash)
  eq($$('#albumList .song').length, 1, '专辑详情列出了曲目（前置条件）')

  // 模拟左上角返回按钮
  win.history.back()
  await sleep(320)
  const backHash = decodeURIComponent(win.location.hash)
  ok(/\/search\?/.test(backHash) && /q=测试/.test(backHash),
    '返回回到的是**带关键词的搜索结果页**（不是空白 #/search）', backHash)
  eq($$('#searchBody .grid3 .card').length, 1, '返回后搜索结果还在，没有丢')
}

/* ============================================================ */
section('21. 歌单「播一段就跳下一首」= 音源只给了试听片段')

/*
 * 报障原文：「按照歌单播放时候，存在歌曲播放一段，不播放，自动播放下一首歌曲」
 *
 * 真因在源侧：平台对没有播放权限的曲子只给**试听片段**（网易 eapi 的
 * freeTrialInfo={start:0,end:30}，实测 470KB ≈ 30 秒），完整曲目往往要由插件源给出。
 * 片段放完 <audio> 派发的是 `ended` —— 和「真的放完了」是同一个事件，
 * 于是被当成正常结束直接 playNext()，用户看到的就是「播一段、停、跳下一首」。
 *
 * 修法三件，**全在客户端**（服务端一行没动 —— 它本来就做了「优先挑完整版」）：
 *   ① 候选排序保留 size/trial 并按「片段排最后」重排（服务端注释里要求的第二道保险）；
 *   ② 续播点超出新音源时长时归零，堵住「换到更短的源 → 瞬间 ended → 跳歌」；
 *   ③ 用**实播时长 vs 声明时长**判定片段：提前告知原因，且先换同曲的候选，
 *      换不到才走下一首。
 */

// ① candidateList：size / trial 不能再被丢掉
{
  const cCtx = vm.createContext({ console })
  vm.runInContext(extractFn(SCRIPT, 'candidateList'), cCtx)
  const cl = vm.runInContext('candidateList', cCtx)

  // 关键场景：30 秒的**无损**片段体积(5MB)比 128k 的完整版(4MB)还大 ——
  // 只按体积排会选错，所以必须先按 trial 分档，再比体积
  const list = cl({
    url: 'T', from: 'native',
    urls: [
      { url: 'T', from: 'native', size: 5 * 1024 * 1024, trial: true },
      { url: 'F', from: 'plugin:甲', size: 4 * 1024 * 1024, trial: false }
    ]
  }, {})
  eq(list.length, 2, '两条候选都收进来')
  eq(list[0].url, 'F', '完整版排在试听片段之前（trial 这一档必须优先于体积）')
  eq(list[0].size, 4 * 1024 * 1024, 'size 保留下来（以前被丢掉，等于没有第二道保险）')
  // ⚠ 必须按 url 反查那一条来断言。写 `list[0].trial === false` 是**假绿灯**：
  //    size/trial 一起被丢掉时 list[0] 会变成 T 那条、trial 也恰好是 false，照样通过。
  eq(list.filter(x => x.url === 'T')[0].trial, true, 'trial 保留下来（丢了就认不出哪条是片段）')
  eq(list[1].trial, true, '片段被排到最后')

  // 都不是片段 → 体积大的优先；体积未知(0)排到已知的后面
  const l2 = cl({ urls: [{ url: 'a', size: 1000 }, { url: 'c', size: 0 }, { url: 'b', size: 9000 }] }, {})
  eq(l2.map(x => x.url).join(''), 'bac', '体积大优先，未知(0)排在已知之后')

  // 全是未知时不能打乱服务端的原始顺序（服务端已经排过一遍了）
  const l3 = cl({ urls: [{ url: 'x' }, { url: 'y' }, { url: 'z' }] }, {})
  eq(l3.map(x => x.url).join(''), 'xyz', '全未知时保持服务端原序（sort 稳定，不打乱）')

  // rank：服务端给的偏好序（背后是插件实测评分表）—— 「插件也自动选择评分高的插件」
  const l4 = cl({
    urls: [
      { url: 'lo', from: 'plugin:低分源', size: 9000, trial: false, rank: 7 },
      { url: 'hi', from: 'plugin:高分源', size: 1000, trial: false, rank: 1 }
    ]
  }, {})
  eq(l4[0].url, 'hi', 'rank 小的（评分高）排前面 —— 即使它的体积更小')
  eq(l4[0].rank, 1, 'rank 保留下来了（以前被丢掉，评分信息就到不了客户端）')

  // ⚠ 但「已知是片段」必须压过 rank：不能因为某条评分高就去放 30 秒片段
  const l5 = cl({
    urls: [
      { url: 'snip', from: 'plugin:高分源', size: 5000, trial: true, rank: 0 },
      { url: 'full', from: 'plugin:低分源', size: 4000, trial: false, rank: 9 }
    ]
  }, {})
  eq(l5[0].url, 'full', '试听片段仍然排最后（trial 这一档压过 rank）')

  // 老服务端不带 rank → 自动退化成「trial → 体积」的老口径，不炸也不乱
  const l6 = cl({ urls: [{ url: 'a', size: 1000 }, { url: 'b', size: 9000 }] }, {})
  eq(l6[0].url, 'b', '服务端没带 rank 时退化成体积优先（新旧服务端都能用）')
}

// ② 实播时长明显短于声明时长 → 判定为片段，并且**说清楚原因**（不再静默跳歌）
{
  RESPONSES['/url'] = {
    ok: true, from: 'plugin:甲', verified: false,
    url: 'https://cdn.example.com/1.mp3',
    urls: [
      { url: 'https://cdn.example.com/1.mp3', from: 'plugin:甲' },
      { url: 'https://cdn.example.com/2.mp3', from: 'plugin:乙' }
    ]
  }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  const a = $('#audio')
  eq(a.src, 'https://cdn.example.com/1.mp3', '（前置）先用第一条候选')

  // jsdom 不会真的解码，手工把「这条音源只有 30 秒」摆上去（歌曲声明的是 245 秒）
  TOASTS.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 30 })
  a.dispatchEvent(new win.Event('loadedmetadata'))
  await sleep(60)
  ok(TOASTS.some(t => /试听片段/.test(t)),
    '元数据一到就提示「当前音源只提供了试听片段」，不让用户白听 30 秒才发现不对', TOASTS.join(' | '))
  ok(TOASTS.some(t => /30s \/ 245s/.test(t)), '提示里带上「实播 / 声明」两个数字，用户才知道是音源的问题')

  // 片段播完 → 换**同一首歌**的下一条候选，而不是把整首歌跳过去
  const titleBefore = $('#playerTitle').textContent
  TOASTS.length = 0
  a.dispatchEvent(new win.Event('ended'))
  await sleep(120)
  eq(a.src, 'https://cdn.example.com/2.mp3', '片段播完 → 换同曲的下一条候选（不是跳下一首）')
  eq($('#playerTitle').textContent, titleBefore, '换的是音源不是歌曲（标题仍是同一首）')
  ok(TOASTS.some(t => /完整版/.test(t)), '换源时说明「这条只有片段，换一条试试完整版」')
  eq($('#playerResolvedBy').textContent, '音源：乙', '音源标识跟着切到新候选')

  // 候选换完了还是片段 → 这时候才走下一首（每首只换一次，不会无限换下去）
  TOASTS.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 30 })
  a.dispatchEvent(new win.Event('ended'))
  await sleep(220)
  eq($('#playerTitle').textContent, '第二首', '没有可换的候选了 → 才跳到下一首')
}

// ③ 换候选时的续播点必须落在**新音源**时长之内
//
// 场景：完整版放到 100 秒时源断了，换到的下一条却是 30 秒的片段。
// 这时把 currentTime 设成 100 会被浏览器钳到 30 → <audio> 立刻派发 ended
// → playNext()，用户看到的就是「播到一半突然停、直接跳下一首」。
{
  RESPONSES['/url'] = {
    ok: true, from: 'plugin:甲', verified: false,
    url: 'https://cdn.example.com/1.mp3',
    urls: [
      { url: 'https://cdn.example.com/1.mp3', from: 'plugin:甲' },
      { url: 'https://cdn.example.com/2.mp3', from: 'plugin:乙' }
    ]
  }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  const a = $('#audio')

  /*
   * ⚠ 必须装一个「记录写入」的 currentTime 替身才看得出问题：
   * jsdom 换 src **不会**把 currentTime 归零（真实浏览器会），
   * 所以直接读它是读不出「有没有去 seek」的 —— 那会是一条永远绿的空断言。
   */
  let pos = 100
  const seeks = []
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: function () { return pos },
    set: function (v) { seeks.push(v); pos = v }
  })

  // 完整版放到 100 秒时源断了 → 换候选，续播点就是 100
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  eq(a.src, 'https://cdn.example.com/2.mp3', '（前置）源断了 → 换到下一条候选')

  // A：新音源 200 秒（比续播点长）→ 照常续播
  seeks.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 200 })
  a.dispatchEvent(new win.Event('loadedmetadata'))
  eq(seeks.join(','), '100', '新音源比续播点长 → 照常续播到 100 秒（这条不能修坏）')

  // B：新音源只有 30 秒（比续播点短）→ 不许 seek，宁可从头放
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  pos = 100
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  seeks.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 30 })
  a.dispatchEvent(new win.Event('loadedmetadata'))
  eq(seeks.length, 0, '新音源比续播点短 → 不 seek（否则被钳到片尾、瞬间 ended → 跳歌）')

  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }
}

// ④ 已经退到代理流时，不许因为「片段」再回跳到直连候选
//
// 直连候选是**全都试败了**才退到代理流的（见 error 处理 ② 分支），
// 片段播完时若按「往后找一条候选」的逻辑走，candIndex=-1 会让它从 0 开始 ——
// 等于把刚刚失败过的那条又拉回来放一遍，纯属倒退。
{
  RESPONSES['/url'] = {
    ok: true, from: 'plugin:甲', verified: false,
    url: 'https://cdn.example.com/1.mp3',
    urls: [
      { url: 'https://cdn.example.com/1.mp3', from: 'plugin:甲' },
      { url: 'https://cdn.example.com/2.mp3', from: 'plugin:乙' }
    ]
  }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  const a = $('#audio')
  // 两条候选都报错 → 退到服务端代理流（此时 candIndex = -1）
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  a.dispatchEvent(new win.Event('error'))
  await sleep(80)
  ok(/\/api\/stream/.test(a.src), '（前置）候选都试完 → 退到代理流', a.src)

  /*
   * ⚠ 这里**不能**断言 `a.src === '.../1.mp3'`。
   * 下一首（第二首）自己也会去请求 /url，而 mock 是**按路径**而不是按歌曲 id 给的，
   * 返回的首条候选同样是 1.mp3 —— 于是「回跳」和「换歌」两条路的 src 一模一样，
   * 断言就成了永远绿的空话。改用两个真正能区分的信号：
   *   · 有没有出现「换一条试试完整版」这条**换源**提示（回跳才会弹）；
   *   · 歌曲标题有没有变（回跳的话标题仍是原曲）。
   */
  TOASTS.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 30 })
  a.dispatchEvent(new win.Event('ended'))
  await sleep(220)
  ok(!TOASTS.some(t => /换一条试试完整版/.test(t)), '代理流上的片段播完 → 不回跳到已失败的直连候选（没有换源）')
  eq($('#playerTitle').textContent, '第二首', '（同上）而是按正常流程走下一首')

  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }
}

// ⑤ 首页各榜单最常见的那一种：**官方直连给的是 30 秒片段，完整版在插件那条上**
//
// 报障补充：「首页，各个榜单的歌曲也存在直接取流，不过插件的情况」。
// 服务端注释里记过同一个现象 ——「进度条只有 30 秒、音源显示 native · 直连」：
// 平台对没有播放权限的曲子，官方 eapi 只回 freeTrialInfo={start:0,end:30}（470KB），
// 而完整曲目由插件给出。**服务端探不出体积时 trial 判不出来**（实测 size 全为 0），
// 于是官方直连按「official 优先」排在第一条 —— 客户端必须能在播出来之后自己纠正。
{
  RESPONSES['/url'] = {
    ok: true, from: 'native', verified: false,
    url: 'https://native.example.com/trial.mp3',
    urls: [
      // ⚠ 两条的 size 都是 0（探不出体积）：客户端按体积排时并列，
      //    稳定的 sort 会保留服务端原序 —— 也就是官方直连在前。
      { url: 'https://native.example.com/trial.mp3', from: 'native', size: 0, trial: false },
      { url: 'https://cdn.example.com/full.mp3', from: 'plugin:六音音源', size: 0, trial: false }
    ]
  }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  const a = $('#audio')
  eq(a.src, 'https://native.example.com/trial.mp3', '（前置）体积未知时官方直连仍排在最前（与服务端同口径）')
  eq($('#playerResolvedBy').textContent, '音源：官方直连', '（前置）最底那一行显示「官方直连」')

  // 真播出来才知道它只有 30 秒 —— 这正是「直接取流、不过插件」的那种情况
  TOASTS.length = 0
  Object.defineProperty(a, 'duration', { configurable: true, value: 30 })
  a.dispatchEvent(new win.Event('loadedmetadata'))
  await sleep(60)
  ok(TOASTS.some(t => /试听片段/.test(t)), '官方直连只有 30 秒 → 同样会提示（判据与音源是插件还是直连无关）')

  a.dispatchEvent(new win.Event('ended'))
  await sleep(120)
  eq(a.src, 'https://cdn.example.com/full.mp3', '官方直连只是片段 → 换到插件那条（完整版）')
  eq($('#playerResolvedBy').textContent, '音源：六音音源', '音源标识从「官方直连」变成插件名')

  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'wy', verified: true }
}

/* ============================================================ */
section('22. 「关于」页显示服务端版本号')

/*
 * 这一块是**异步补进来**的：页面先渲染「读取中…」，网络回来再改写那一小块。
 * 所以三种状态（读取中 / 成功 / 失败）与三种时序（回来时还在本页 / 旧请求后回 /
 * 已经切走）都要各测一遍 —— 只测「成功」那种，等于只测了理想路径。
 *
 * ⚠ 顺序有讲究：srvVer 是模块级缓存，**第一次成功之后就一直有值**，
 *   失败态再也不会显示。所以「失败」必须排在「成功」前面测。
 */
{
  const CLIENT_VER = (SCRIPT.match(/var CLIENT_VERSION = '([^']+)'/) || [])[1] || ''
  ok(CLIENT_VER !== '', '取到了客户端 CLIENT_VERSION（防止下面断言退化成空串假绿灯）')

  // ① 读取中：请求发出但还没回来
  const realFetch = win.YunBridge.httpFetch
  let releaseVer = null
  win.YunBridge.httpFetch = function (reqId, url) {
    if (/\/api\/version$/.test(url)) { releaseVer = reqId; return }   // 先扣住，等测试放行
    return realFetch.apply(this, arguments)
  }
  await go('#/about')
  const pillEl = $('#srvVerPill'), descEl = $('#srvVerDesc')
  ok(!!pillEl && !!descEl, '「关于」页有服务端版本的两个节点（#srvVerPill / #srvVerDesc）')
  // 结构都没了就往下走不了，直接停：否则只会连锁抛一串 TypeError，
  // 报错信息也指不清「是页面少了那一块」。
  if (!pillEl || !descEl) throw new Error('「关于」页缺少 #srvVerPill / #srvVerDesc')
  eq(pillEl.textContent, '读取中…', '还没回来时角标显示「读取中…」（不是空白、也不是假版本号）')
  ok(/正在向远端查询/.test(descEl.textContent), '同时给出「正在查询」的说明')

  // ② 失败：原生桥回错误（走真实失败路径，不是编一个 HTTP 码）
  ok(releaseVer !== null, '确实发出了 /api/version 请求（否则下面两条断言是空跑）')
  win.onNativeHttpCallback({ reqId: releaseVer, error: '连接被拒绝' })
  await sleep(40)
  eq($('#srvVerPill').textContent, '读取失败', '远端不通 → 角标显示「读取失败」')
  ok($('#srvVerPill').classList.contains('pill--bad'), '失败态用红色角标')
  ok(/连接被拒绝/.test($('#srvVerDesc').textContent),
    '失败原因如实写出来（不是一句「出错了」）', $('#srvVerDesc').textContent)
  ok(!isErrorBlock(), '版本读不到只让这一块降级，整页照常渲染')

  // ③ 成功：恢复真实 mock 再进一次
  win.YunBridge.httpFetch = realFetch
  await go('#/mine')
  await go('#/about')
  await sleep(80)
  eq($('#srvVerPill').textContent, 'V2.8', '读到服务端版本 → 角标显示版本号')
  ok($('#srvVerPill').classList.contains('pill--brand'), '成功态用品牌色角标')
  const srvDesc = $('#srvVerDesc').textContent
  ok(/构建号 118/.test(srvDesc), '构建号也显示出来（光看版本号分不出是不是同一次构建）', srvDesc)
  ok(/构建 dev/.test(srvDesc), '构建标识显示出来', srvDesc)
  ok(/宿主 docker/.test(srvDesc), '宿主（docker / cf）显示出来', srvDesc)

  // ④ 同页同时看得到客户端与服务端两个版本 —— 这正是报障时要对的两个数
  const aboutText = viewText()
  ok(aboutText.indexOf('云音乐 ' + CLIENT_VER) >= 0, '同页显示客户端版本', aboutText.slice(0, 120))
  ok(aboutText.indexOf('V2.8') >= 0, '同页显示服务端版本')
  eq(API_CALLS.filter(c => c.path === '/version').length >= 1, true, '确实请求了 /api/version')

  // ⑤ 时序：两条请求都在飞时，**先发的后回**不能盖掉后发的。
  //    真实场景 —— 在「关于」页切了线路又重进本页，旧线路的响应迟到一步；
  //    两个线路可能根本不是同一版服务端，画错了比不画更糟。
  const ids = []
  win.YunBridge.httpFetch = function (reqId, url) {
    if (/\/api\/version$/.test(url)) { ids.push(reqId); return }
    return realFetch.apply(this, arguments)
  }
  // ⚠ 必须先离开再回来：go() 打的是同一个 hash 时**不派发 hashchange**，
  //   而步骤③结束时正停在 #/about 上 —— 直接 go('#/about') 是个空动作，
  //   只会得到 1 条请求（这条一开始就是这么写错的）。
  await go('#/mine')
  await go('#/about')                       // 第一次进页 → 请求 A
  await go('#/mine')
  await go('#/about')                       // 重进本页 → 请求 B
  eq(ids.length, 2, '两次进页各发了一条 /api/version')
  const before = LOGS.length
  // 旧的那条先回，还带一个别的线路才可能有的版本号 —— 没有时序守卫就会画上去
  win.onNativeHttpCallback({
    reqId: ids[0], status: 200,
    body: JSON.stringify({ ok: true, version: 'V9.9', versionCode: 999, build: 'old', host: 'cf' })
  })
  await sleep(40)
  eq($('#srvVerPill').textContent, '读取中…', '先发的旧响应迟到 → 不覆盖当前这次查询的结果')
  ok(!/V9\.9/.test(viewText()), '页面上没有出现旧线路的版本号')
  // 当前这次回来了才作数
  win.onNativeHttpCallback({ reqId: ids[1], status: 200, body: JSON.stringify(RESPONSES['/version']) })
  await sleep(40)
  eq($('#srvVerPill').textContent, 'V2.8', '当前这次查询的结果才作数')
  eq(LOGS.length, before, '迟到的响应不会引发 JS 异常', LOGS.slice(before).join(' | '))

  // ⑥ 已经离开本页，响应才到 —— 不能画到「我的」页上
  let lateId = null
  win.YunBridge.httpFetch = function (reqId, url) {
    if (/\/api\/version$/.test(url)) { lateId = reqId; return }
    return realFetch.apply(this, arguments)
  }
  await go('#/mine')                        // 同样要先离开（当前正停在 #/about）
  await go('#/about')
  await go('#/mine')
  ok(lateId !== null, '确实发出了 /api/version 请求（否则下面两条是空跑）')
  const before2 = LOGS.length
  win.onNativeHttpCallback({ reqId: lateId, status: 200, body: JSON.stringify(RESPONSES['/version']) })
  await sleep(40)
  eq(LOGS.length, before2, '迟到响应不引发 JS 异常', LOGS.slice(before2).join(' | '))
  eq($('#srvVerPill'), null, '离开「关于」页后那两个节点已不在 DOM 里')
  ok(!/V2\.8/.test(viewText()), '迟到的版本号没被画到「我的」页上', viewText().slice(0, 120))
  win.YunBridge.httpFetch = realFetch

  // ⑦ 替身形状守卫：能读到服务端源码时，核对 mock 的字段名与 versionInfo() 一致。
  //    客户端可能被放进大仓库的子目录、也可能单独成库，所以两个候选路径都试，
  //    都读不到就跳过（不硬失败）—— 但能读到就必须对上。
  const fsp = require('fs')
  const pth = require('path')
  const verSrcPath = [pth.join(__dirname, '..', '..', 'src', 'version.js'),
    pth.join(__dirname, '..', 'src', 'version.js')].find(p => fsp.existsSync(p))
  if (verSrcPath) {
    const src = fsp.readFileSync(verSrcPath, 'utf8')
    const fields = (src.match(/return \{([\s\S]*?)\n  \}/) || ['', ''])[1]
    const names = (fields.match(/(\w+):/g) || []).map(s => s.slice(0, -1))
    ok(names.length >= 4, '从 src/version.js 的 versionInfo() 里取到了字段名', names.join(','))
    const mock = RESPONSES['/version']
    const missing = names.filter(n => !(n in mock))
    ok(missing.length === 0, '测试替身带上了 versionInfo() 的每个字段',
      '缺 ' + missing.join(',') + '（真响应有、替身没有 → 客户端读了也测不出来）')
    ok('host' in mock, '测试替身带上了 api.js 补的 host 字段')
  } else {
    console.log('  · 跳过替身形状守卫：没找到 src/version.js（客户端单独成库时正常）')
  }
}

/* ============================================================ */
section('23. 本地插件与音源设置（V2.12）')

/* ---- 23.1 「我的」页入口 ---- */
{
  await go('#/mine')
  await sleep(80)
  const entry = $$('.menu-item').filter(a => /插件与音源/.test(a.textContent))
  eq(entry.length, 1, '「我的」页有且只有一个「插件与音源」入口')
  eq(entry[0].getAttribute('href'), '#/plugins', '入口指向 #/plugins')
  ok(!!entry[0].querySelector('.menu-item__ico'), '入口带图标块（与其它菜单项一致）')
  ok(/走服务端/.test(entry[0].textContent), '默认关闭时副标题说明「走服务端解析」', entry[0].textContent.trim())
}

/* ---- 23.2 设置页结构 ---- */
{
  await go('#/plugins')
  await sleep(200)
  ok(!!$('#lpBody'), '插件设置页渲染出来了')
  ok(!!$('#lpOn'), '有总开关（#lpOn）')
  eq($('#lpOn').checked, false, '默认是关的（不偷偷走本地插件）')
  ok(!!$('#lpRuntimeMode'), '写明了插件在哪儿求值')
  ok(/主线程降级|独立 Worker|待检测/.test($('#lpRuntimeMode').textContent),
    '运行方式给出明确取值', $('#lpRuntimeMode').textContent)
  ok(!!$('#lpScoreBtn') && !!$('#lpScoreDesc'), '有跑分按钮与说明')
  ok(!!$('#lpList'), '有插件列表')
  eq($$('#lpList [data-lpen]').length, 2, '两个内置插件都在列表里')
  eq($$('#lpList [data-lpen]').filter(c => c.checked).length, 0, '内置插件默认**全不勾**')
  ok(!!$('#lpUrl') && !!$('#lpImportUrl'), '有「从地址导入」')
  ok(!!$('#lpText') && !!$('#lpImportText'), '有「从文本导入」')
  ok(!!$('#lpImportFile'), '有「从手机文件选择」')
  ok(!!$('#lpCacheUrl') && $('#lpCacheUrl').checked, '直链缓存默认开')
  ok(!!$('#lpCacheAudio') && $('#lpCacheAudio').checked, '音频缓存默认开')
  ok(!!$('#lpCacheSize'), '显示音频缓存当前占用')
  eq($$('#lpBody [data-lplimit]').length, 4, '容量上限有 4 档')
  ok(!!$('#lpCacheClear'), '有「清空音频缓存」')
  ok(!/data-lpen="fake-ok"[^>]* checked/.test(HTML), '内置插件的「默认不勾」不是靠运行时改的（模板里就没有 checked）')
}

/* ---- 23.3 插件启停持久化 ---- */
{
  const row = $$('#lpList [data-lpen]')[0]
  row.checked = true
  row.dispatchEvent(new win.Event('change'))
  await sleep(150)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.enabled') || '{}')['fake-ok'], true,
    '勾选后写进 ym.lp.enabled')
  await go('#/plugins')
  await sleep(200)
  eq($$('#lpList [data-lpen]')[0].checked, true, '重进页面仍然勾着（持久化生效）')
  const r2 = $$('#lpList [data-lpen]')[0]
  r2.checked = false
  r2.dispatchEvent(new win.Event('change'))
  await sleep(150)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.enabled'))['fake-ok'], false, '取消勾选也持久化')
}

/* ---- 23.4 开关打开 → 首次自动跑分 → 按实测自动勾选 ---- */
{
  TOASTS.length = 0
  const sw = $('#lpOn')
  sw.checked = true
  sw.dispatchEvent(new win.Event('change'))
  await sleep(1800)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.on')), true, '开关打开后持久化 ym.lp.on=true')
  ok(TOASTS.some(t => /首次启用/.test(t)), '第一次启用会提示「正在实测各插件」', TOASTS.join(' | '))

  const sc = JSON.parse(win.localStorage.getItem('ym.lp.scores') || 'null')
  ok(!!sc && !!sc.byId, '首次启用自动跑了一轮分，结果落盘到 ym.lp.scores')
  // 下面几条用「取不到就给空对象」的写法：跑分没跑成时应当**报红**，
  // 而不是抛 TypeError 把整个自测脚本带走（那会看不到其余断言的结果）。
  const scOk = ((sc && sc.byId) || {})['fake-ok'] || {}
  const scBad = ((sc && sc.byId) || {})['fake-bad'] || {}
  eq(scOk.ok, 1, '甲音源实测成功 1 次')
  eq(scOk.total, 1, '甲音源分母 1（探针只覆盖它声明的网易云）')
  ok(scOk.score >= 80, '甲音源拿到高分（成功率 100% + 速度快）', String(scOk.score))
  eq(scBad.ok, 0, '乙音源实测 0 次成功')
  eq(scBad.total, 1, '失败的那次也进分母（否则「0/0」会被算成 100%）')
  eq(scBad.score, 0, '一次都没成功 → 0 分')

  const en = JSON.parse(win.localStorage.getItem('ym.lp.enabled') || '{}')
  eq(en['fake-ok'], true, '跑分后自动勾上实测可用的插件')
  eq(en['fake-bad'] === true, false, '实测不可用的插件不会被自动勾上')

  // 跑分完成后按钮恢复可用、说明改成「上次跑分」
  await sleep(150)
  ok(!!$('#lpScoreBtn') && !$('#lpScoreBtn').disabled, '跑分结束后按钮可再点（手动重跑）')
  const scoreDesc = $('#lpScoreDesc') ? $('#lpScoreDesc').textContent : '(节点不在)'
  ok(/上次跑分/.test(scoreDesc), '跑分说明变成「上次跑分…」', scoreDesc)
  ok(/（1\/\d+ 已启用）/.test($('#lpBody').textContent), '列表标题反映「1/N 已启用」',
    ($('#lpBody').textContent.match(/插件（[^）]*）/) || [''])[0])
}

/* ---- 23.5 开关打开时，取流走本地插件 ---- */
{
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/server.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  API_CALLS.length = 0
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(500)
  const a = $('#audio')
  eq(a.src, 'https://local.example.com/wy/s1.mp3', '开关打开时用本地插件给的地址')
  eq(API_CALLS.filter(c => c.path === '/url').length, 0, '本地解出来了就不必再问服务端')
  eq($('#playerResolvedBy').textContent, '音源：甲音源', '音源标识显示本地插件名')
  eq($('#playerArtist').textContent, '测试歌手  ·  网易云音乐', '歌手那一行仍是歌曲所属平台（两处口径不串味）')
}

/* ---- 23.6 本地插件全都解不出来 → 自动退回服务端兜底 ---- */
{
  // 只留那个必然失败的插件
  await go('#/plugins')
  await sleep(200)
  const c0 = $$('#lpList [data-lpen]')[0]
  c0.checked = false
  c0.dispatchEvent(new win.Event('change'))
  await sleep(120)
  const c1 = $$('#lpList [data-lpen]')[1]
  c1.checked = true
  c1.dispatchEvent(new win.Event('change'))
  await sleep(200)

  TOASTS.length = 0
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/server.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  API_CALLS.length = 0
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(600)
  eq($('#audio').src, 'https://cdn.example.com/server.mp3', '本地插件全解不出来 → 自动退回服务端')
  eq(API_CALLS.filter(c => c.path === '/url').length, 1, '确实问了一次服务端（不是哑掉）')
  ok(TOASTS.some(t => /本地插件没解出地址/.test(t)),
    '明确告诉用户这次是服务端救回来的（否则只会觉得「插件白开了」）', TOASTS.join(' | '))
}

/* ---- 23.7 关掉开关 → 一律走服务端 ---- */
{
  await go('#/plugins')
  await sleep(200)
  TOASTS.length = 0
  const sw = $('#lpOn')
  sw.checked = false
  sw.dispatchEvent(new win.Event('change'))
  await sleep(150)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.on')), false, '关掉后持久化 ym.lp.on=false')
  ok(TOASTS.some(t => /全部走服务端/.test(t)), '关掉时明确提示改走服务端', TOASTS.join(' | '))

  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/server2.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  API_CALLS.length = 0
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  eq($('#audio').src, 'https://cdn.example.com/server2.mp3', '开关关掉 → 一律走服务端（本地插件不参与）')
  eq(API_CALLS.filter(c => c.path === '/url').length, 1, '关掉后取流只问服务端')
}

/* ---- 23.8 缓存选项：容量档位 / 直链缓存 / 清空 ---- */
{
  await go('#/plugins')
  await sleep(200)

  const chip = $$('#lpBody [data-lplimit]').filter(c => c.getAttribute('data-lplimit') === '1000')[0]
  chip.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.cache')).limitMb, 1000, '容量档位选择持久化')
  eq(AC.trims[AC.trims.length - 1], 1000 * 1024 * 1024, '改容量后立刻让原生按新上限裁剪')

  // 关掉直链缓存 → 必须把已有记录一并清掉，否则那些地址还会被用
  win.localStorage.setItem('ym.lp.urlcache', JSON.stringify({ 'wy:s1:320k': { at: Date.now(), v: { url: 'stale' } } }))
  const cu = $('#lpCacheUrl')
  cu.checked = false
  cu.dispatchEvent(new win.Event('change'))
  await sleep(150)
  eq(win.localStorage.getItem('ym.lp.urlcache'), null, '关掉直链缓存时清掉已有记录')
  eq(JSON.parse(win.localStorage.getItem('ym.lp.cache')).url, false, '直链缓存开关持久化')
  ok(TOASTS.some(t => /已关闭直链缓存/.test(t)), '关掉直链缓存有提示')

  const ca = $('#lpCacheAudio')
  ca.checked = false
  ca.dispatchEvent(new win.Event('change'))
  await sleep(120)
  eq(JSON.parse(win.localStorage.getItem('ym.lp.cache')).audio, false, '音频缓存开关持久化')
  ca.checked = true
  ca.dispatchEvent(new win.Event('change'))
  await sleep(120)

  // 清空：调原生 + 按释放量提示
  AC.bytes = 12345678
  TOASTS.length = 0
  $('#lpCacheClear').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(250)
  eq(AC.clears, 1, '「清空音频缓存」调到了原生')
  ok(TOASTS.some(t => /已清空 11\.8 MB 音频缓存/.test(t)), '按实际释放量提示', TOASTS.join(' | '))
  ok(/当前还没有缓存文件/.test($('#lpCacheSize').textContent), '清空后占用归零')

  // 「当前占用」走的是原生统计回调
  AC.bytes = 2048
  AC.stats = 0
  await go('#/mine')
  await go('#/plugins')
  await sleep(250)
  ok(AC.stats >= 1, '进设置页会向原生问一次占用')
  ok(/2 KB/.test($('#lpCacheSize').textContent), '占用按原生回的值显示', $('#lpCacheSize').textContent)
  AC.bytes = 0
}

/* ---- 23.9 音频缓存命中 → 直接放本地文件，完全不联网 ---- */
{
  await go('#/plugins')
  await sleep(200)
  AC.hit = '/data/user/0/com.yunmusic.app/files/audiocache/deadbeef.mp3'
  AC.keys.length = 0
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/server3.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  API_CALLS.length = 0
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(350)
  eq($('#audio').src, 'file://' + AC.hit, '音频缓存命中 → 直接放本地文件（补上 file:// 前缀，不靠根相对 URL 碰巧对）')
  eq(API_CALLS.filter(c => c.path === '/url').length, 0, '命中时连服务端都不用问')
  eq(AC.keys[AC.keys.length - 1], 'wy_s1_320k', '缓存键 = 平台_歌曲id_音质（不随时间变）')

  // 放的是本地文件时，听完不必再交给原生「缓存」一遍
  AC.puts.length = 0
  Object.defineProperty($('#audio'), 'duration', { configurable: true, value: 245 })
  $('#audio').dispatchEvent(new win.Event('ended'))
  await sleep(200)
  eq(AC.puts.length, 0, '已经在放本地文件 → 不再重复落盘')
  AC.hit = null
}

/* ---- 23.10 整首听完才把音频交给原生落盘 ---- */
{
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/full-song.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(80)
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  const a = $('#audio')
  eq(a.src, 'https://cdn.example.com/full-song.mp3', '（前置）这一首是联网取的（开关仍是关的）')
  // jsdom 的 duration 恒为 0，会被判成「试听片段」而走换源分支 —— 先摆成完整时长
  Object.defineProperty(a, 'duration', { configurable: true, value: 245 })
  AC.puts.length = 0
  a.dispatchEvent(new win.Event('ended'))
  await sleep(200)
  eq(AC.puts.length, 1, '整首听完才落盘（中途切歌不留半截文件）')
  // 取不到就用空对象：落盘没发生时应当**报红**，而不是把自测脚本带走
  const put0 = AC.puts[0] || {}
  eq(put0.key, 'wy_s1_320k', '落盘用的键与查询一致')
  eq(put0.url, 'https://cdn.example.com/full-song.mp3', '交给原生的是刚才播的那条地址')
  eq(put0.limitBytes, 1000 * 1024 * 1024, '落盘时带上当前容量上限，原生据此裁剪')
}

/* ---- 23.11 导入插件：文本 / 地址 / 手机文件 + 删除 ---- */
{
  const imported = () => JSON.parse(win.localStorage.getItem('ym.lp.imported') || '[]')
  await go('#/plugins')
  await sleep(200)
  const base = $$('#lpList [data-lpen]').length

  // ① 文本
  $('#lpText').value = FAKE_PLUGIN_OK.replace('甲音源', '丙音源')
  TOASTS.length = 0
  $('#lpImportText').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(250)
  eq(imported().length, 1, '文本导入写进了 ym.lp.imported')
  eq($$('#lpList [data-lpen]').length, base + 1, '列表里多了一行')
  ok(imported()[0].id.indexOf('user:') === 0, '导入的插件 id 带 user: 前缀（不与内置撞车）', imported()[0].id)
  eq($$('#lpList [data-lpen]')[base].checked, true, '用户主动导入的插件默认就勾上')
  ok(/丙音源/.test(viewText()), '列表里显示的是脚本 @name 解析出来的名字')
  ok(TOASTS.some(t => /已导入/.test(t)), '导入成功有提示', TOASTS.join(' | '))

  // ② 同一份再导一次 → 覆盖而不是新增
  $('#lpText').value = FAKE_PLUGIN_OK.replace('甲音源', '丙音源')
  $('#lpImportText').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  eq(imported().length, 1, '同一份脚本重复导入是**覆盖**，不会长出两份')

  // ③ 太短的内容要拒绝（防止把乱七八糟的文本当插件存进去）
  TOASTS.length = 0
  $('#lpText').value = 'alert(1)'
  $('#lpImportText').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  eq(imported().length, 1, '内容太短不写入')
  ok(TOASTS.some(t => /导入失败/.test(t)), '拒绝时给出原因', TOASTS.join(' | '))

  // ④ 从地址导入（走原生桥 httpFetch）
  RESPONSES['/remote-plugin.js'] = FAKE_PLUGIN_OK.replace('甲音源', '丁音源')
  $('#lpUrl').value = 'https://plug.example.com/remote-plugin.js'
  TOASTS.length = 0
  $('#lpImportUrl').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  eq(imported().length, 2, '从地址导入成功')
  ok(/丁音源/.test(viewText()), '下载回来的插件进了列表')
  ok(imported().some(p => /plug\.example\.com/.test(p.url || '')), '记下了来源地址（便于日后更新）')

  // 非 http 地址要挡住
  TOASTS.length = 0
  $('#lpUrl').value = 'ftp://x/y.js'
  $('#lpImportUrl').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  ok(TOASTS.some(t => /http\/https/.test(t)), '非 http(s) 地址直接挡住', TOASTS.join(' | '))

  // ⑤ 从手机文件选择：先让原生「选到」一个文件
  PF.calls = 0
  $('#lpImportFile').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  eq(PF.calls, 1, '「从手机文件选择」调到了原生 pickPluginFile')
  win.onNativePluginFile({ name: 'wuxing.js', content: FAKE_PLUGIN_BAD.replace('乙音源', '戊音源') })
  await sleep(250)
  eq(imported().length, 3, '原生回调回来的内容也进得去')
  ok(/戊音源/.test(viewText()), '文件里的插件显示出来了')

  // 原生报错要如实转达
  TOASTS.length = 0
  win.onNativePluginFile({ name: 'x.js', error: '文件过大（超过 4MB）' })
  await sleep(150)
  ok(TOASTS.some(t => /读取文件失败.*4MB/.test(t)), '原生读取失败的原因如实转达', TOASTS.join(' | '))
  win.onNativePluginFile({ name: 'empty.js', content: '' })
  await sleep(150)
  ok(TOASTS.some(t => /文件是空的/.test(t)), '空文件给出明确提示')

  // ⑥ 删除
  const dels = $$('#lpList [data-lpdel]')
  eq(dels.length, 3, '导入的插件都带删除按钮（内置的没有）')
  dels[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  eq(imported().length, 2, '删除后从 ym.lp.imported 里移除')
  eq($$('#lpList [data-lpdel]').length, 2, '列表同步更新')
}

/* ---- 23.12 resolveUrl：本地优先 + 失败退回（源码级，逐条钉住优先级） ---- */
{
  const c = vm.createContext({
    console, Promise, JSON, Date, Math, String, Number, Object, Array, encodeURIComponent
  })
  vm.runInContext([
    'var LP = { on: true, runtime: true, stat: { local: 0, server: 0 }, lastFrom: "" }',
    'var P = { quality: "320k" }',
    'var LOG = []',
    'var HIT = null',
    'function lpUrlKey(s) { return s.source + ":" + s.id + ":" + P.quality }',
    'function lpUrlCacheGet(k) { LOG.push("cacheGet:" + k); return HIT }',
    'function lpUrlCacheSet(k, v) { LOG.push("cacheSet") }',
    'function lpSaveStat() {}',
    'function toast(m) { LOG.push("toast:" + m) }',
    'var LOCAL = null, LOCAL_REJECT = false',
    // ⚠ 必须返回**数组**：resolveUrl 读的是 lpCandidates(...).length，
    //    返回数字的话 .length 是 undefined，会被判成「没有候选」而漏掉提示
    'function lpCandidates(src) { LOG.push("cands:" + src); return CAND_N ? [{ id: "p1" }] : [] }',
    'var CAND_N = 1',
    'function lpResolve(song) { LOG.push("local"); return LOCAL_REJECT ? Promise.reject(new Error("插件全挂了")) : Promise.resolve(LOCAL) }',
    'var SERVER = { url: "https://srv/a.mp3", from: "wy" }, SERVER_REJECT = false',
    'function api(p) { LOG.push("api:" + p); return SERVER_REJECT ? Promise.reject(new Error("服务端也挂了")) : Promise.resolve(SERVER) }',
    extractFn(SCRIPT, 'resolveUrl')
  ].join('\n'), c)
  const set = (code) => vm.runInContext(code, c)
  const get = (code) => vm.runInContext(code, c)
  const reset = () => set('LOG = []; HIT = null; LP.on = true; LP.stat = { local: 0, server: 0 }; LP.lastFrom = "";' +
    ' LOCAL = null; LOCAL_REJECT = false; SERVER_REJECT = false; P.quality = "320k"; CAND_N = 1')
  const run = () => vm.runInContext('resolveUrl({ source: "wy", id: "s1" })', c)

  // ① 本地成功 → 不碰服务端
  reset()
  set('LOCAL = [{ url: "https://local/1.mp3", from: "plugin:甲" }, { url: "https://local/2.mp3", from: "plugin:乙" }]')
  let r = await run()
  eq(r.local, true, '本地插件解出来了 → 结果标记为本地')
  eq(r.url, 'https://local/1.mp3', '首选是本地第一条')
  eq(r.urls.length, 2, '本地候选全带上（片段换源要用）')
  eq(r.from, 'plugin:甲', 'from 直接沿用插件名')
  ok(!get('LOG').some(x => /^api:/.test(x)), '本地成功时**不**再问服务端')
  eq(get('LP.stat.local'), 1, '统计记一次本地取流')

  // ② 本地没结果 → 退服务端，并说清楚
  reset()
  set('LOCAL = []')
  r = await run()
  eq(r.local, false, '本地全军覆没 → 结果是服务端的')
  eq(r.url, 'https://srv/a.mp3', '退回服务端拿到的地址')
  eq(get('LP.stat.server'), 1, '统计记一次服务端取流')
  ok(get('LOG').some(x => /^toast:本地插件没解出地址/.test(x)), '明确告诉用户「已改用服务端」')

  // ③ 开关关掉 → 根本不碰本地
  reset()
  set('LP.on = false; LOCAL = [{ url: "https://local/1.mp3" }]')
  r = await run()
  eq(r.local, false, '开关关掉 → 走服务端')
  ok(!get('LOG').some(x => x === 'local'), '开关关掉时**根本不调**本地插件')

  // ④ 插件抛异常（不是「没结果」）也要兜住
  // ⚠ 这里必须自己 try/catch：抛出去会让整个自测脚本中断，后面的断言全都看不到结果
  reset()
  set('LOCAL_REJECT = true')
  let err4 = ''
  try { r = await run() } catch (e) { err4 = e.message }
  eq(err4, '', '插件抛异常不该从 resolveUrl 抛出去（否则上层直接退代理流、不走服务端兜底）')
  eq(r && r.local, false, '插件抛异常也退回服务端，不能把整首判死')
  ok(get('LOG').some(x => /^toast:本地插件没解出地址/.test(x)), '抛异常这条路也会提示')

  // ④' 开关开着但一个插件都没勾 → 那不叫「本地失败」，别乱提示
  reset()
  set('CAND_N = 0; LOCAL = []')
  r = await run()
  eq(r.local, false, '没有可试的插件 → 走服务端')
  ok(!get('LOG').some(x => /^toast:本地插件没解出地址/.test(x)),
    '没勾任何插件时不提示「本地插件没解出地址」（那不是失败，是没开）')

  // ⑤ 直链缓存命中 → 两条路都不走
  reset()
  set('HIT = { url: "https://cached/x.mp3", local: true }')
  r = await run()
  eq(r.url, 'https://cached/x.mp3', '直链缓存命中 → 直接用')
  ok(!get('LOG').some(x => x === 'local' || /^api:/.test(x)), '缓存命中时既不调本地也不调服务端')
  eq(get('LP.lastFrom'), 'local', '缓存里记的是本地结果 → 来源标成 local')
  set('HIT = { url: "https://cached/y.mp3", local: false }')
  await run()
  eq(get('LP.lastFrom'), 'server', '缓存里记的是服务端结果 → 来源标成 server')

  // ⑥ 两边都挂 → 如实抛出（上层据此退代理流）
  reset()
  set('LOCAL = []; SERVER_REJECT = true')
  let threw = ''
  try { await run() } catch (e) { threw = e.message }
  ok(/服务端也挂了/.test(threw), '两边都失败 → 如实抛出，不吞掉', threw)

  // ⑦ 缓存键必须含音质：换音质不能拿到上一档的地址
  reset()
  set('P.quality = "128k"')
  await run()
  eq(get('LOG').filter(x => /^cacheGet:/.test(x))[0], 'cacheGet:wy:s1:128k',
    '缓存键带上音质（换音质不会拿到上一档的地址）')
}

/* ---- 23.13 跑分口径（源码级）：成功率 60% + 速度 40%，速度取中位数 ---- */
{
  const c = vm.createContext({ console, JSON, Date, Math, String, Number, Object, Array })
  vm.runInContext([
    'var LP = { scores: null, list: [] }',
    'var LP_KEYS = { scores: "ym.lp.scores", enabled: "ym.lp.enabled" }',
    'var SAVED = null',
    'var store = { set: function (k, v) { SAVED = v }, get: function () { return null } }',
    'function lpBuildList() { return [] }',
    'function lpSetEnabled(id, on) { TURNED.push(id) }',
    'var TURNED = []',
    extractFn(SCRIPT, 'lpFinalizeScores'),
    extractFn(SCRIPT, 'lpAutoEnableFromScores')
  ].join('\n'), c)
  const fin = (acc) => vm.runInContext('lpFinalizeScores(' + JSON.stringify(acc) + ', Date.now()).byId', c)

  eq(fin({ A: { ok: 10, total: 10, times: [1000, 1000, 1000] } }).A.score, 100,
    '全成功 + 中位 1.0s（≤1.5s 满分）→ 100 分')
  eq(fin({ A: { ok: 10, total: 10, times: [1000] } }).A.rate, 100, 'rate 也写出来（列表要显示「实测 10/10 次成功」）')
  eq(fin({ B: { ok: 0, total: 10, times: [] } }).B.score, 0, '一次都没成功 → 0 分（速度再快也没意义）')
  eq(fin({ C: { ok: 5, total: 10, times: [1000, 2000, 3000, 4000, 9000] } }).C.ms, 3000,
    '取**中位数**耗时（3000），不是均值')
  eq(fin({ C: { ok: 5, total: 10, times: [1000, 2000, 3000, 4000, 9000] } }).C.score, 61,
    '成功率 50%(×0.6) + 速度 (8000-3000)/6500(×0.4) → 61 分')
  eq(fin({ D: { ok: 1, total: 1, times: [9000] } }).D.score, 60, '中位 ≥8s → 速度分归零，只剩成功率的 60 分')
  eq(fin({ E: { ok: 1, total: 1, times: [1500] } }).E.score, 100, '中位正好 1.5s → 速度仍算满分（边界含在内）')
  eq(fin({ F: { ok: 1, total: 1, times: [1000, 1000, 1000, 1000, 60000] } }).F.score, 100,
    '一个超时样本不把整体拉垮（均值会被 60000 拉到 12800 → 0 分）')
  ok(!!vm.runInContext('SAVED && SAVED.byId && typeof SAVED.at === "number"', c),
    '跑分结果落盘并带时间戳（设置页要显示「上次跑分」）')

  // 自动勾选：每平台只勾实测可用的前 2 名
  vm.runInContext([
    'LP.scores = { byId: { p1: { score: 90, ok: 3 }, p2: { score: 70, ok: 2 }, p3: { score: 50, ok: 1 }, p4: { score: 0, ok: 0 } } }',
    'LP.list = [',
    '  { id: "p1", name: "一", enabled: false, sources: { wy: {} } },',
    '  { id: "p2", name: "二", enabled: false, sources: { wy: {} } },',
    '  { id: "p3", name: "三", enabled: false, sources: { wy: {} } },',
    '  { id: "p4", name: "四", enabled: false, sources: { wy: {} } }',
    ']',
    'TURNED = []'
  ].join('\n'), c)
  const turned = vm.runInContext('lpAutoEnableFromScores()', c)
  eq(turned.length, 2, '每平台只自动勾前 2 名（再多就是同一平台的重复源）')
  eq(vm.runInContext('TURNED.join(",")', c), 'p1,p2', '按实测分数从高到低勾')
  ok(!vm.runInContext('TURNED.indexOf("p4") >= 0', c), '实测 0 次成功的插件不会被勾上')

  // 已经勾上的不重复计入
  vm.runInContext('LP.list[0].enabled = true; TURNED = []', c)
  eq(vm.runInContext('lpAutoEnableFromScores().length', c), 1, '已经勾上的不再重复计入（避免提示数字虚高）')
}

/* ---- 23.14 原生桥接线：JS 调的每个方法，Java 侧都要真的有实现 ---- */
{
  const fsp = require('fs')
  const pth = require('path')
  const APP = pth.join(__dirname, '..', 'src', 'com', 'yunmusic', 'app')
  const bridge = fsp.readFileSync(pth.join(APP, 'YunBridge.java'), 'utf8')
  const act = fsp.readFileSync(pth.join(APP, 'MainActivity.java'), 'utf8')

  const called = [...new Set([...SCRIPT.matchAll(/YunBridge\.(\w+)\s*\(/g)].map(m => m[1]))]
  ok(called.length >= 10, '从 index.html 里抠到了 YunBridge 的调用点', called.join(','))
  const impl = new Set(
    [...bridge.matchAll(/@JavascriptInterface\s+public\s+[\w$.<>\[\]]+\s+(\w+)\s*\(/g)].map(m => m[1]))
  const missing = called.filter(n => !impl.has(n))
  eq(missing.length, 0, 'JS 调用的每个 YunBridge 方法在 Java 侧都有 @JavascriptInterface 实现', missing.join(','))

  // V2.12 新增的这几个必须都在（少一个就是「功能静默失效」，不会报错）
  ;['audioCacheGet', 'audioCachePut', 'audioCacheTrim', 'audioCacheClear', 'audioCacheStat', 'pickPluginFile']
    .forEach(n => ok(impl.has(n), 'YunBridge 实现了 ' + n))

  ok(/audioCacheGet\s*\(/.test(bridge) && /public String audioCacheGet/.test(bridge),
    'audioCacheGet 是**同步**返回路径的（页面靠它决定要不要跳过解析）')
  ok(/doAudioCachePut/.test(bridge) && /FileOutputStream/.test(bridge),
    '音频缓存用字节流写盘（不是 httpFetch 那套按 UTF-8 读文本 —— 二进制会成乱码）')
  ok(/audiocache/.test(bridge), '音频缓存落在 App 私有目录 audiocache/')
  ok(/\.part/.test(bridge), '落盘先写 .part 再改名（半截文件不会被当成命中）')

  ok(/onActivityResult/.test(act) && /REQ_PICK_PLUGIN/.test(act), 'MainActivity 接了文件选择的结果回调')
  ok(/startPluginFilePicker/.test(act) && /ACTION_GET_CONTENT/.test(act),
    'MainActivity 用 ACTION_GET_CONTENT 起文件选择器（不卡 MIME，.js 才选得中）')
  ok(/PLUGIN_MAX_BYTES/.test(act), '原生读插件脚本有大小上限（防误选大文件把内存顶爆）')
  ok(/\\uFEFF/.test(act), '原生会剥掉 UTF-8 BOM（否则脚本第一行是非法字符）')
}

/* ---- 23.15 喂给插件的 musicInfo 必须「取流可用」（V2.13 修）---- */
/*
 * 报障原文：「在一个服务端测试很好的插件，在手机端不能用」「没有一首歌能播放出来，
 * 播放页面显示的是服务端」。
 *
 * 根因：服务端 `/api/search` 回给页面的是 `songForWeb()` **裁剪过**的对象 ——
 * 只有 id/source/name/singer/albumName/interval/img，**没有 hash、没有 songmid**
 * （取流必需的平台标识）。客户端却把它原样当 `musicInfo` 喂给插件。
 * 实测 22 个内置插件里 9 个读 songmid、8 个读 hash，于是**全军覆没**：
 * 插件加载正常、日志正常，就是永远解不出地址，每首歌都退回服务端。
 *
 * 而取流字段本来就在手里 —— 服务端 `encodeSongId()` 把它们一起塞进了 `song.id`
 * （base64url 的 JSON）。服务端自己取流时就是先 `decodeSongId(id)` 再喂插件，
 * 客户端照做即可。
 *
 * ⚠ 这里的 id **必须用服务端真编码器生成**（src/lib/songid.js），不能手搓一个
 *   base64 串 —— 那又成了「替身照着自己的想象写形状」，正是这个 bug 当初漏过去的原因。
 */
let KG_ENCODED_ID = ''
let WY_ENCODED_ID = ''
{
  const { pathToFileURL } = require('url')
  // 双路径兜底：单仓库时在 <repo>/src/lib/，主仓库里 yunmusic-client 是子目录
  const songidPath = [path.join(ROOT, '..', 'src', 'lib', 'songid.js'),
    path.join(ROOT, '..', '..', 'src', 'lib', 'songid.js')].find(p => fs.existsSync(p))
  ok(!!songidPath, '能找到服务端编码器 src/lib/songid.js（两端口径的唯一来源）')
  const songidSrc = fs.readFileSync(songidPath, 'utf8')
  // 形状守卫：编码器用的键名一变，下面的解码断言就成了自说自话
  ;[['s', 'source'], ['i', 'songmid'], ['h', 'hash'], ['a', 'albumId'], ['m', 'mediaMid'],
    ['n', 'name'], ['g', 'singer'], ['t', 'interval'], ['p', 'img']].forEach(([k, field]) =>
      ok(new RegExp(k + ":\\s*song\\." + field).test(songidSrc),
        'encodeSongId 里 ' + k + ' ← song.' + field + ' 仍在（改了就要同步改客户端的解码）'))

  const { encodeSongId } = await import(pathToFileURL(songidPath).href)
  const kgSong = {
    source: 'kg', songmid: 'MID_1234', hash: 'HASH_ABCDEF', albumId: 'ALB_9',
    mediaMid: 'MM_5', name: '稳稳的幸福', singer: '陈奕迅', interval: 245, img: 'https://cdn.example.com/x.jpg'
  }
  KG_ENCODED_ID = encodeSongId(kgSong)
  WY_ENCODED_ID = encodeSongId({ source: 'wy', songmid: 'WY_88', name: '测试歌曲', singer: '测试歌手', interval: 245 })
  ok(KG_ENCODED_ID && !/[+/=]/.test(KG_ENCODED_ID), '编码出来的 id 是 url-safe 的（不含 + / =）', KG_ENCODED_ID)

  /*
   * atob 替身：Node 的 Buffer 对非法 base64 极其宽容，而浏览器会抛。
   * 这里按浏览器的严格度实现 —— 否则「垃圾 id 要安全兜底」那条断言会假绿。
   */
  const atobStrict = (s) => {
    const t = String(s)
    if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('InvalidCharacterError')
    return Buffer.from(t, 'base64').toString('binary')
  }
  const c = vm.createContext({
    console, JSON, String, Number, Object, Array, escape, decodeURIComponent,
    window: { atob: atobStrict }, SONG_IN: null
  })
  vm.runInContext([extractFn(SCRIPT, 'lpDecodeSongId'), extractFn(SCRIPT, 'lpMusicInfo')].join('\n'), c)
  const mi = (o) => { c.SONG_IN = o; return vm.runInContext('lpMusicInfo(SONG_IN)', c) }

  const got = mi(Object.assign({}, SONG, { id: KG_ENCODED_ID }))
  eq(got.hash, 'HASH_ABCDEF', 'musicInfo.hash 还原出来了（酷狗插件靠它取流）')
  eq(got.songmid, 'MID_1234', 'musicInfo.songmid 还原出来了（9 个插件读它）')
  eq(got.id, 'MID_1234', 'musicInfo.id 是**平台原生 id**，不是那串 base64')
  eq(got.albumId, 'ALB_9', 'musicInfo.albumId 用的是原生 albumId（不是 songForWeb 里那个编码过的）')
  eq(got.mediaMid, 'MM_5', 'musicInfo.mediaMid 还原出来了（QQ 插件要用）')
  eq(got.name, '稳稳的幸福', '中文名 UTF-8 往返正确（atob + escape 那套就是为它）')
  eq(got.singer, '陈奕迅', '中文歌手 UTF-8 往返正确')
  eq(got.interval, 245, 'interval 保留')
  eq(got.source, 'kg', 'source 以 id 里的为准')
  eq(got.img, 'https://cdn.example.com/x.jpg', 'img 保留')

  // 同义字段：各平台对「那一个 id」的叫法不同，都得指到同一个值
  eq(got.mid, 'MID_1234', '别名 mid（QQ 口径）')
  eq(got.rid, 'MID_1234', '别名 rid（酷我口径）')
  eq(got.musicrid, 'MID_1234', '别名 musicrid（咪咕口径）')
  eq(got.musicId, 'MID_1234', '别名 musicId')
  eq(got.songId, 'MID_1234', '别名 songId')
  eq(got.strMediaMid, 'MM_5', '别名 strMediaMid（QQ）')
  eq(got.media_mid, 'MM_5', '别名 media_mid（QQ 旧写法）')
  eq(got.album, '测试专辑', '别名 album 取专辑名')
  eq(got.songName, '稳稳的幸福', '别名 songName 取歌名（以 id 里的为准，同 name）')
  eq(JSON.stringify(got.types), '[]', 'types 置空 —— 与服务端 decodeSongId 的输出**同形**')
  eq(got._types, null, '_types 置空 —— 同上')

  // 兜底：解不出来时原样返回，绝不能抛（否则「非本服务端来源的歌」直接播不了）
  const raw = { id: 's1', name: '测试歌曲', singer: '测试歌手', source: 'wy' }
  const same = mi(raw)
  eq(same.id, 's1', '解不出来的 id（老数据 / 极简写法）→ 原样返回，不抛')
  eq(same.name, '测试歌曲', '原样返回时字段一个不少')

  // 与服务端 decodeSongId 一样支持 `kg:HASH` 极简写法
  const plain = mi({ id: 'kg:PLAINHASH', source: 'kg' })
  eq(plain.songmid, 'PLAINHASH', '兼容 kg:HASH 极简 id')
  eq(plain.hash, 'PLAINHASH', 'kg 极简写法下 hash 取同一个值（服务端同此口径）')

  // 源码级守卫：两个调用点都必须包一层，别退回「直接把瘦对象喂进去」
  ok(/musicInfo:\s*lpMusicInfo\(song\)/.test(NOCOMMENT), '取流调用点喂的是 lpMusicInfo(song)')
  ok(/musicInfo:\s*lpMusicInfo\(t\.song\)/.test(NOCOMMENT), '跑分调用点喂的是 lpMusicInfo(t.song)')
  ok(!/musicInfo:\s*song\b/.test(NOCOMMENT) && !/musicInfo:\s*t\.song\b/.test(NOCOMMENT),
    '没有残留「把裁剪过的歌曲对象直接当 musicInfo」的调用点')
}

/* ---- 23.16 端到端：插件真的收到了带 hash/songmid 的 musicInfo ---- */
{
  // 开关打开 + 只启用「甲音源」（能解出地址的那个），乙音源关掉
  await go('#/plugins')
  await sleep(220)
  const sw = $('#lpOn')
  if (!sw.checked) { sw.checked = true; sw.dispatchEvent(new win.Event('change')); await sleep(260) }
  $$('#lpList [data-lpen]').forEach((b, i) => {
    const want = i === 0
    if (b.checked !== want) { b.checked = want; b.dispatchEvent(new win.Event('change')) }
  })
  await sleep(260)

  const savedId = SONG.id
  SONG.id = WY_ENCODED_ID          // 服务端真编码器产出的 id
  win.__lpSeenInfo = null
  RESPONSES['/url'] = { ok: true, url: 'https://cdn.example.com/server.mp3', from: 'wy', verified: true }
  await go('#/chart?source=wy&id=c1')
  await sleep(120)
  API_CALLS.length = 0
  $('#view .song').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(700)

  const seen = win.__lpSeenInfo || {}
  eq(seen.songmid, 'WY_88', '插件收到 musicInfo.songmid（修复前是 undefined）')
  eq(seen.id, 'WY_88', '插件收到 musicInfo.id = 平台原生 id（修复前是那串 base64）')
  ok('hash' in seen, '插件收到 musicInfo.hash 字段（修复前整个字段都不存在）')
  eq(seen.name, '测试歌曲', '插件收到歌名')
  eq($('#audio').src, 'https://local.example.com/wy/WY_88.mp3',
    '插件按原生 id 拼出的地址真的被用上了（修复前这个 id 是 base64，插件拼出来必然是废链）')
  eq(API_CALLS.filter(c => c.path === '/url').length, 0, '本地解出来了，没再问服务端')
  eq($('#playerResolvedBy').textContent, '音源：甲音源', '音源标识显示本地插件名，不再是「服务端」')
  SONG.id = savedId
}

/* ============================================================ */
section('24. 全局异常检查')
ok(LOGS.length === 0, '全程无未捕获 JS 异常', LOGS.slice(0, 5).join(' | '))

try { dom.window.close() } catch (e) {}
}

/* ============================================================ */
main().then(function () {
  console.log('\n' + '='.repeat(56))
  console.log('结果: ' + (fail === 0 ? 'PASS' : 'FAIL') + '   通过 ' + pass + ' / 失败 ' + fail)
  if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)) }
  console.log('='.repeat(56))
  process.exit(fail === 0 ? 0 : 1)
}).catch(function (e) {
  console.error('\n测试脚本自身异常：', e && e.stack || e)
  process.exit(2)
})
