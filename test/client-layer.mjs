/**
 * 跨端业务层行为测试 —— 在 node 里跑，不需要浏览器、不需要安卓运行时。
 *
 * ── 为什么值得单独写一份「替身 DOM」 ────────────────────────────
 * `client/rn/` 这一层做的是「原生外壳 ↔ 跨端页面」之间的咬合，逻辑不多但**很脆**：
 *
 *   · 库存在但判据不严 → 网页端（CF / Docker 网页版）也被它接管，界面被改坏；
 *   · 路由归属算错     → 底栏高亮跑到别的 tab 上，用户以为自己进了别的地方；
 *   · 桥调用没保护     → 原生侧一抛异常就把**整个页面**打断（白屏）。
 *
 * 这三类都不难写对，但都**很容易在后续改动里被改坏**，而且真机排查成本极高。
 * 开发机上没有安卓运行时（同 test/app-bundle.mjs 的处境），所以这里用一个
 * 手写的极小 DOM 替身把它跑起来 —— 只实现这一层真正用到的那几个 API
 * （getElementById / createElement / addEventListener / location.hash / …）。
 *
 * 手写替身而不是上 jsdom：jsdom 是几十个包的重依赖，而这里要验证的是**这一层的逻辑**，
 * 不是浏览器的实现。依赖越少，「测试红了到底是我不对还是替身不对」越容易判断。
 *
 * 跑法：node test/client-layer.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BUNDLE = path.join(ROOT, 'client/rn/build/client-layer.js')
const SRC_DIR = path.join(ROOT, 'client/rn/src')

/**
 * 产物缺失 / 落后于源码时先重打一遍。
 *
 * 为什么要在这里判「落后」而不是简单的一句「请先跑 build-client-rn」：
 * 本层是拼出来的（6 个模块 → 一个 client-layer.js），改了 src 忘了打包就会
 * **静默地**测旧产物 —— 全绿，但测的是上一版代码。这正是这个项目最忌的那类
 * 假通过。比 mtime 很土，但足以挡住「改了源码没打包」这一种，而且是零成本的。
 */
function ensureBundle() {
  const srcs = fs.existsSync(SRC_DIR)
    ? fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'))
    : []
  const bundle = fs.existsSync(BUNDLE) ? fs.statSync(BUNDLE).mtimeMs : -1
  const stale = srcs.filter((f) => fs.statSync(path.join(SRC_DIR, f)).mtimeMs > bundle)
  if (bundle >= 0 && stale.length === 0) return
  console.log(bundle < 0
    ? '（还没有跨端层产物，先打包一遍）'
    : '（源文件比产物新：' + stale.join(', ') + '　先重打一遍）')
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-client-rn.mjs')], { stdio: 'inherit' })
  if (!fs.existsSync(BUNDLE)) {
    console.error('❌ 打包跑完仍没有产物，tools/build-client-rn.mjs 有问题')
    process.exit(1)
  }
}

ensureBundle()
const CODE = fs.readFileSync(BUNDLE, 'utf8')

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

/* ══════════════ 极简 DOM 替身 ══════════════ */

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.className = ''
    this.id = ''
    this.attrs = {}
    this.textContent = ''
    this.innerHTML = ''
    this._listeners = {}
  }
  appendChild(c) {
    c.parentNode = this
    this.children.push(c)
    return c
  }
  insertBefore(c, ref) {
    c.parentNode = this
    const i = ref ? this.children.indexOf(ref) : -1
    if (i >= 0) this.children.splice(i, 0, c)
    else this.children.push(c)
    return c
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null
  }
  addEventListener(type, fn) {
    ;(this._listeners[type] = this._listeners[type] || []).push(fn)
  }
  removeEventListener() {}
  /** 只支持 /^\.class$/ 形式的查询（这一层就用了这一种） */
  querySelector(sel) {
    const want = String(sel).replace(/^\./, '')
    const walk = (n) => {
      for (const c of n.children) {
        if (c.className === want) return c
        const r = walk(c)
        if (r) return r
      }
      return null
    }
    return walk(this)
  }
  fire(type, ev) {
    const list = this._listeners[type] || []
    for (const fn of list) fn(ev)
  }
}

function makeEnv(opts) {
  const handlers = { doc: {}, win: {} }
  const byId = {}

  const document = new El('#document')
  document.readyState = 'complete'
  document.body = new El('body')
  document.documentElement = new El('html')
  document.getElementById = (id) => byId[id] || null
  document.addEventListener = (type, fn) => {
    ;(handlers.doc[type] = handlers.doc[type] || []).push(fn)
  }
  document.createElement = (tag) => new El(tag)
  document.querySelector = () => null

  const window = {
    location: { hash: opts.hash || '' },
    _native: opts.native || null,
    addEventListener: (type, fn) => {
      ;(handlers.win[type] = handlers.win[type] || []).push(fn)
    },
    // 同步执行：让启动路径里的「延迟重试」不会把测试变成异步等待
    setTimeout: (fn) => {
      fn()
      return 0
    },
    dispatchEvent: () => {},
    CustomEvent: function () {},
  }
  Object.defineProperty(window, 'LXNative', {
    get() {
      return window._native
    },
  })

  function setHash(h) {
    window.location.hash = h
    for (const fn of handlers.win.hashchange || []) fn({ type: 'hashchange' })
    for (const fn of handlers.win.popstate || []) fn({ type: 'popstate' })
  }

  function register(id, el) {
    byId[id] = el
    document.body.appendChild(el)
    return el
  }

  function run() {
    // 不往 bundle 里塞 return（那会插到 IIFE 内部去，外层拿到的还是 undefined）：
    // 直接执行，然后从替身 window 上把这一层的句柄读回来 —— bundle 自己就是挂在
    // window.LXClientLayer 上的，这也顺便验证了它对外的暴露面没变。
    const fn = new Function(
      'window', 'document', 'MutationObserver', 'Event', 'HashChangeEvent', 'console',
      '"use strict";' + CODE,
    )
    fn(window, document, (opts.MutationObserver || function () { this.observe = () => {} }),
      function Event(t) { this.type = t }, function HashChangeEvent(t) { this.type = t }, console)
    return window.LXClientLayer
  }

  return { window, document, register, setHash, run, handlers, byId }
}

/**
 * 最小可用桥。
 *
 * 为什么不直接用「什么都不传」来测纯函数：本层的守卫是**硬退出** ——
 * 没桥（或桥缺 info/setRoute）时连 LX.nav 都不会导出，因为它的设计目标就是
 * 「不在客户端里就一个字都不动」。所以想验证路由归属表，必须先让这一层真正装上。
 */
function minimalNative() {
  return { info: () => '{}', setRoute: () => {} }
}

/* ══════════════ A. 纯函数：路由归属 ══════════════ */

console.log('\n== A. 路由 → 底栏归属（纯函数，直接调） ==')
{
  const env = makeEnv({ hash: '#/', native: minimalNative() })
  const LX = env.run()

  const cases = [
    ['', '#/'],                 // 空 hash（首次打开）
    ['#', '#/'],
    ['#/', '#/'],
    ['#/search', '#/'],         // 搜索归属「发现」
    ['#/search?q=周杰伦', '#/'],  // 带查询串
    ['#/album/123', '#/'],      // 专辑详情
    ['#/charts', '#/'],
    ['#/library', '#/library'],
    ['#/playlist/abc', '#/library'],   // 歌单详情归属「我的歌单」
    ['#/playlist-add/xx', '#/library'],
    ['#/favorite', '#/favorite'],
    ['#/mine', '#/mine'],
    ['#/settings', '#/mine'],   // 设置归属「我的」
    ['#/about', '#/mine'],
    ['#/history', '#/mine'],
    ['#/login', ''],            // 整屏状态：不高亮任何 tab
    ['#/setup', ''],
  ]
  let bad = 0
  for (const [hash, want] of cases) {
    const got = LX.nav.resolve(hash)
    if (got !== want) {
      bad++
      console.log(`         ${hash || '(空)'} → ${got || '(空)'}，期望 ${want || '(空)'}`)
    }
  }
  ok('路由归属表 ' + cases.length + ' 个用例全部正确', bad === 0, bad + ' 个不符')

  const full = LX.nav.isFullscreen('#/login')
  const notFull = LX.nav.isFullscreen('#/mine')
  ok('整屏状态判据正确（登录页算、我的页不算）', full === true && notFull === false)

  ok('归属表与主 tab 表都是导出的（便于排查）',
    Array.isArray(LX.nav.BELONG) && LX.nav.MAIN.length === 4)
}

/* ══════════════ B. 守卫：不在客户端里就不介入 ══════════════ */

console.log('\n== B. 没桥时不介入（网页端 / 老壳里一个字都不能动） ==')
{
  const env = makeEnv({ hash: '#/mine' })
  const verLine = env.register('verLine', new El('div'))
  const LX = env.run()

  ok('没有 window.LXNative 时 active=false', LX && LX.active === false, JSON.stringify(LX))
  ok('没有注册任何 window 事件监听', !env.handlers.win.hashchange && !env.handlers.win.popstate)
  ok('没有注册任何 document 事件监听', !env.handlers.doc.click)
  ok('没有动 DOM（版本行没被写入）', verLine.children.length === 0)

  // 半残的桥（对象在、但缺关键方法）也必须整个不介入 —— 半接管比不接管糟得多
  const env2 = makeEnv({ hash: '#/mine', native: { info: () => '{}' } })
  const LX2 = env2.run()
  ok('桥不完整（缺 setRoute）时同样不介入', LX2.active === false, String(LX2.reason))
}

/* ══════════════ C. 行为：启动、路由同步、外壳切换、入口接管 ══════════════ */

console.log('\n== C. 有桥时的完整行为 ==')
{
  const calls = []
  // 原生侧「当前底栏状态」——断言看它，而不是看调用次数。
  // 本层对 setRoute / setChrome 都做了**变化才上报**的去重（原生每收到一次就要
  // 重绘一遍底栏），所以「没有调用」和「归属正确」是两件事，混在一起断言必然写错。
  const state = { route: null, chrome: null }
  const native = {
    info: () => JSON.stringify({
      client: 'LX-MUSIC', version: '1.1', versionLine: 'V1.1',
      build: 'dev', serviceExpect: 'V1.4',
      profileId: 'cf', profileName: 'Cloudflare 部署', kind: 'cf',
      base: 'https://music.example.com', user: '', builtin: false,
      brandKey: 'cf', brandName: 'music-edge', serverVersion: 'V1.4',
      serverBuild: 'abc', connected: true, onboarded: true,
    }),
    profiles: () => '[]',
    openPage: (p) => calls.push(['openPage', p]),
    selectProfile: () => true,
    setRoute: (h) => { state.route = h; calls.push(['setRoute', h]) },
    setChrome: (v) => { state.chrome = v; calls.push(['setChrome', v]) },
    toast: (m) => calls.push(['toast', m]),
    copy: () => true,
    reload: () => calls.push(['reload']),
    diag: () => '{}',
  }

  const env = makeEnv({ hash: '#/', native })
  const verLine = env.register('verLine', new El('div'))
  const serverBlock = env.register('serverBlock', new El('div'))
  const openBtn = new El('span')
  openBtn.setAttribute('data-act', 'open-server')

  const LX = env.run()
  ok('桥齐备时 active=true', LX.active === true)

  const routes = calls.filter((c) => c[0] === 'setRoute').map((c) => c[1])
  ok('启动即上报当前路由（底栏不会停在「全灭」）',
    routes.length >= 1 && routes[0] === '#/', JSON.stringify(routes))

  const chromes = calls.filter((c) => c[0] === 'setChrome').map((c) => c[1])
  ok('启动即把外壳置为显示（主 tab 上底栏要在）',
    chromes.length >= 1 && chromes[0] === true, JSON.stringify(chromes))

  // 路由变化 → 归属跟着走
  calls.length = 0
  env.setHash('#/search')
  ok('进搜索页（归属仍是「发现」）→ 不重复上报（底栏不必重绘）',
    calls.length === 0, JSON.stringify(calls))
  ok('而且归属确实还停在「发现」', state.route === '#/', String(state.route))

  // 换到另一个主 tab → 必须上报
  calls.length = 0
  env.setHash('#/library')
  ok('进「我的歌单」→ 归属跟着切过去',
    state.route === '#/library' && calls.some((c) => c[0] === 'setRoute'), JSON.stringify(calls))

  // 登录页 → 收起底栏
  calls.length = 0
  env.setHash('#/login')
  ok('进登录页 → 收起原生底栏（整屏状态）',
    state.chrome === false && calls.some((c) => c[0] === 'setChrome' && c[1] === false),
    JSON.stringify(calls))
  ok('登录页不高亮任何 tab',
    state.route === '' && calls.some((c) => c[0] === 'setRoute' && c[1] === ''),
    JSON.stringify([state.route, calls]))

  calls.length = 0
  env.setHash('#/mine')
  ok('回到我的页 → 重新显示底栏并高亮「我的」',
    state.chrome === true && state.route === '#/mine',
    JSON.stringify([state.route, state.chrome, calls]))

  // 带参数的详情页 → 按前缀归属到对应主 tab
  env.setHash('#/playlist/abc')
  ok('歌单详情页（#/playlist/abc）→ 归属「我的歌单」',
    state.route === '#/library', String(state.route))

  // 设置页的版本行 —— 只补**客户端自己**的版本 + 真实构建号。
  // 服务端版本**不许**再挂在这条尾巴上：它有自己的专用行（网页端 #verHost），
  // 挂两处就是同一页里同一件事写两遍（老板 2026-10-08 定的规矩）。
  // 所以这里连**负向**一起断言 —— 少了后半条，日后有人「顺手补上」也测不出来。
  env.setHash('#/settings')
  const mark = verLine.querySelector('.lx-client-ver')
  ok('进设置页 → 版本行补出客户端版本，且尾巴上不带服务端版本',
    !!mark && /客户端 1\.1/.test(mark.textContent) && !/服务端/.test(mark.textContent),
    mark ? mark.textContent : '(没补上)')

  // 网页设置页里的服务端卡片要被压掉（改由原生页管理）
  ok('网页自带的「服务端」卡片被隐藏（避免两个入口各存一份地址）',
    serverBlock.style.display === 'none', String(serverBlock.style.display))

  // 登录页的服务器入口 → 转成原生页
  calls.length = 0
  let prevented = false
  let stopped = false
  for (const fn of env.handlers.doc.click || []) {
    fn({
      target: openBtn,
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
  }
  ok('点网页端的「服务器设置」→ 打开原生服务器页',
    calls.some((c) => c[0] === 'openPage' && c[1] === 'server'), JSON.stringify(calls))
  ok('并且拦住了默认行为与冒泡（否则会顺便跳一个网页路由）', prevented && stopped)
}

/* ══════════════ D. 桥抛异常不能拖垮页面 ══════════════ */

console.log('\n== D. 桥调用抛异常时页面必须还能活 ==')
{
  let thrown = 0
  const boom = (name) => function () {
    thrown++
    throw new Error('native side exploded: ' + name)
  }
  const native = {
    info: boom('info'),
    profiles: boom('profiles'),
    openPage: boom('openPage'),
    selectProfile: boom('selectProfile'),
    setRoute: boom('setRoute'),
    setChrome: boom('setChrome'),
    toast: boom('toast'),
    copy: boom('copy'),
    reload: boom('reload'),
    diag: boom('diag'),
  }

  let crashed = null
  let LX = null
  try {
    const env = makeEnv({ hash: '#/', native })
    env.register('verLine', new El('div'))
    env.register('serverBlock', new El('div'))
    LX = env.run()
    // 路由变化、点击入口都再走一遍（这些路径上也有桥调用）
    env.setHash('#/login')
    env.setHash('#/mine')
    for (const fn of env.handlers.doc.click || []) {
      fn({ target: new El('span'), preventDefault: () => {}, stopPropagation: () => {} })
    }
  } catch (e) {
    crashed = e
  }

  ok('桥全部抛异常时，跨端层初始化不崩（页面不会白屏）', crashed === null,
    crashed ? crashed.message : '')
  ok('并且确实调用过桥（不是「因为没调用所以没崩」）', thrown > 0, String(thrown))
  ok('桥全崩时 LXClientLayer 仍然挂上去了（业务层可以据此降级）', !!LX && LX.active === true)
}

/* ══════════════ 收尾 ══════════════ */

console.log('\n' + '='.repeat(62))
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
} else {
  console.log('全部 ' + pass + ' 项通过')
}
