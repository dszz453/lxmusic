/**
 * 无依赖 H5 端到端验收：Node 22 内置 WebSocket 直连 Chrome DevTools Protocol
 *  - 校验首页是否按网易云版式渲染（金刚区 / Banner / 推荐歌单三列 / 歌曲列表）
 *  - 采集控制台错误与页面异常
 *  - 点击播放，校验播放器状态与音频流真的开始拉
 *  - 逐页截图取证
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.LX_BASE || ''
const LOCAL = !!BASE
const HOST = LOCAL ? new URL(BASE).host : 'music.zyplnn.dpdns.org'
const IP = process.env.CF_IP || '104.21.10.218'
// 支持打本地：LX_BASE=http://127.0.0.1:8787 node test/ui.mjs
const ORIGIN = BASE || `https://${HOST}`
const USER = process.env.LX_USER || 'admin'
// 密码从环境变量读，避免把真实密码写进会打包分发的测试脚本
const PASS = process.env.LX_PASS || 'LxMusic@2026'
const OUT = path.resolve('shots')
fs.mkdirSync(OUT, { recursive: true })

/* ---------- 取登录 token（本机到 CF 边缘偶发 http=000 抖动，重试） ---------- */
function loginOnce() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: USER, password: PASS })
    const lib = LOCAL ? http : https
    const opts = LOCAL
      ? { host: '127.0.0.1', port: Number(new URL(BASE).port || 80), path: '/api/login', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 60000 }
      : { host: IP, port: 443, servername: HOST, path: '/api/login', method: 'POST',
          headers: { Host: HOST, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          rejectUnauthorized: false, timeout: 60000 }
    const req = lib.request(opts, (res) => {
      const c = []
      res.on('data', (d) => c.push(d))
      res.on('end', () => {
        let out = { status: res.statusCode, token: '' }
        try { out.token = JSON.parse(Buffer.concat(c).toString('utf8')).token || '' } catch {}
        resolve(out)
      })
    })
    req.on('error', (e) => resolve({ status: 0, token: '', error: String(e.message) }))
    req.write(payload); req.end()
  })
}

async function apiLogin() {
  for (let i = 0; i < 6; i++) {
    const r = await loginOnce()
    if (r.token) return r.token
    if (r.status !== 0) break      // 业务失败（密码错等）不重试
    await sleep(1000 + i * 800)
  }
  return ''
}

/* ---------- 启动 Chrome ---------- */
const PORT = 9200 + Math.floor(Math.random() * 500)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxchrome-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-proxy-server',
  '--proxy-bypass-list=<-loopback>',
  '--ignore-certificate-errors',
  // IPv6 必须带方括号。写成 `MAP host 2606:4700::1` 这条规则 Chrome 解析不了，
  // 整条被丢掉 → 于是它去走系统 DNS，拿到被污染的 IPv4，页面加载半死不活
  // （表现：外壳画出来了、#view 全空、连登录页都进不去，看着像「刚部署的版本炸了」）。
  // 上一次线上验收能过只是运气好，规则没生效也刚好走得通。
  ...(LOCAL ? [] : [`--host-resolver-rules=MAP ${HOST} ${/^[0-9.]+$/.test(IP) ? IP : '[' + IP.replace(/^\[|\]$/g, '') + ']'}`]),
  '--window-size=390,844',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

const wsUrl = await findTarget()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
const failedRequests = []
const mediaRequests = []
// 弹窗策略：默认「取消」。个别用例需要走「确认」分支时用 setDialogPolicy 临时改。
let dialogPolicy = 'dismiss'
function setDialogPolicy(p) { dialogPolicy = p }

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || a.type).join(' ').slice(0, 300))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {}
    pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown')
  }
  if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(`${msg.params.type} ${msg.params.errorText}`)
    if (msg.params.type === 'Media' || msg.params.type === 'Other') {
      mediaRequests.push(`FAIL ${msg.params.type} ${msg.params.errorText} blocked=${msg.params.blockedReason || '-'}`)
    }
  }
  if (msg.method === 'Network.responseReceived' && (msg.params.type === 'Media')) {
    const r = msg.params.response
    mediaRequests.push(`RESP ${msg.params.type} ${r.status} ${r.mimeType} len=${r.encodedDataLength} range=${r.headers && (r.headers['content-range'] || r.headers['Content-Range'] || '-')} ${String(r.url).slice(0, 70)}`)
  }
  // 自动关掉页面弹窗（confirm / prompt）。
  // 不处理的话，页面会卡在弹窗上，后面所有 evaluate 全超时 ——
  // 表现为「莫名其妙每个用例都超时」，很难定位。默认选「取消」（accept:false），
  // 也就是「用户没确认」这条分支，更接近真实用户随手关掉的情形。
  // 个别用例需要走「确认」分支（音色面板问是否改走服务端中转）时，用 setDialogPolicy 临时改。
  if (msg.method === 'Page.javascriptDialogOpening') {
    send('Page.handleJavaScriptDialog', { accept: dialogPolicy === 'accept' }).catch(() => {})
  }
}

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) }
    }, 120000)
  })
}

async function evaluate(expr, awaitPromise = true, userGesture = true) {
  // userGesture 必须为 true：否则 headless 下 audio.play() 会被自动播放策略拒绝，
  // 导致「点击播放」类断言假失败（页面本身没有问题）。
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture })
  if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

/** 轮询直到表达式返回真值或超时 */
async function waitFor(expr, { timeout = 20000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try { last = await evaluate(expr) } catch { last = null }
    if (last) return last
    await sleep(interval)
  }
  return last
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = path.join(OUT, name + '.png')
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('   截图 →', file)
}

const results = []
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra })
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? '  → ' + extra : ''))
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  })

  /* 1. 登录页（页面本身也可能因抖动首次加载失败，重试一次） */
  console.log('\n--- 1. 冷启动（未登录）')
  await send('Page.navigate', { url: `${ORIGIN}/` })
  await sleep(3500)
  let loginVisible = await evaluate(`!!document.querySelector('#loginUser') && location.hash.includes('login')`)
  if (!loginVisible) {
    await send('Page.navigate', { url: `${ORIGIN}/` })
    await sleep(4000)
    loginVisible = await evaluate(`!!document.querySelector('#loginUser') && location.hash.includes('login')`)
  }
  ok('未登录时跳转登录页', loginVisible, await evaluate('location.hash'))
  await shot('01-login')

  /* 2. 注入 token 后进入首页 */
  console.log('\n--- 2. 登录并加载首页')
  const token = await apiLogin()
  ok('拿到会话 token', !!token, token ? token.slice(0, 18) + '…' : '登录接口连续失败')
  if (!token) throw new Error('登录失败（本机到 Cloudflare 边缘抖动），后续断言无意义')
  await evaluate(`API.setToken(${JSON.stringify(token)}); location.hash = '#/'; __lx.reload(); true`)
  await sleep(1100)
  // 等首页数据回来
  for (let i = 0; i < 30; i++) {
    const n = await evaluate(`document.querySelectorAll('#view .songlist .song').length`)
    if (n > 0) break
    await sleep(800)
  }
  await sleep(700)

  /* 3. 首页版式校验（对齐网易云首页） */
  console.log('\n--- 3. 首页版式')
  const tpl = await evaluate(`(() => {
    const q = s => document.querySelector(s)
    const qa = s => Array.from(document.querySelectorAll(s))
    return {
      hash: location.hash,
      hasMenu: !!q('#btnMenu'),
      searchHint: (q('#searchHint') || {}).textContent || '',
      quickCount: qa('#view .quickbar .quick').length,
      quickLabels: qa('#view .quick .quick__label').map(e => e.textContent),
      quickWithIcon: qa('#view .quick__icon svg').length,
      // 真正可见（未被裁在视口外）的金刚区项数 —— 一行应完整显示 5 项
      quickFullyVisible: qa('#view .quickbar .quick').filter(e => e.getBoundingClientRect().right <= window.innerWidth + 1).length,
      quickFirstRowTop: (qa('#view .quickbar .quick')[0] || { getBoundingClientRect: () => ({ top: 0 }) }).getBoundingClientRect().top,
      bannerTitle: (q('#view .banner__title') || {}).textContent || '',
      bannerDesc: (q('#view .banner__desc') || {}).textContent || '',
      chartCards: qa('#view .grid3 .card').length,
      chartTitleSample: (q('#view .grid3 .card__title') || {}).textContent || '',
      chartCoversLoaded: qa('#view .grid3 .card__cover img').filter(i => i.naturalWidth > 0).length,
      chartBadges: qa('#view .grid3 .card__badge').length,
      hotSongs: qa('#view .songlist .song').length,
      hotNumbered: qa('#view .songlist .song__index').length,
      hotCoversLoaded: qa('#view .songlist .song__cover img').filter(i => i.naturalWidth > 0).length,
      sectionTitles: qa('#view .section__title').map(e => e.textContent),
      tabbar: qa('#tabbar .tabbar__item').length,
      appWidth: (q('#app') || {}).clientWidth,
      bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }
  })()`)
  console.log('   ', JSON.stringify(tpl, null, 1).replace(/\n/g, '\n    '))

  ok('顶部栏 汉堡 + 搜索框 + 我的', tpl.hasMenu && !!tpl.searchHint)
  ok('金刚区 7 项且都有图标', tpl.quickCount === 7 && tpl.quickWithIcon === 7, tpl.quickLabels.join(' / '))
  ok('金刚区一行完整显示 5 项（无右侧留白/裁切）', tpl.quickFullyVisible === 5, tpl.quickFullyVisible + ' 项完整可见')
  ok('Banner = 每日推荐', tpl.bannerTitle === '每日推荐', tpl.bannerDesc)
  ok('推荐歌单三列栅格 ≥ 4 张', tpl.chartCards >= 4, tpl.chartCards + ' 张，例：' + tpl.chartTitleSample)
  ok('歌单封面真实加载', tpl.chartCoversLoaded >= 3, tpl.chartCoversLoaded + '/' + tpl.chartCards)
  ok('歌单带播放量角标', tpl.chartBadges >= 8, tpl.chartBadges + ' 个角标')
  ok('猜你喜欢歌曲 ≥ 8 首', tpl.hotSongs >= 8, tpl.hotSongs + ' 首')
  ok('猜你喜欢为带序号列表（对齐网易云）', tpl.hotNumbered >= 8, tpl.hotNumbered + ' 行带序号')
  ok('底部四标签栏', tpl.tabbar === 4)
  ok('无横向溢出', !tpl.bodyOverflowX)
  await shot('02-home')

  /* 4. 点击播放 */
  console.log('\n--- 4. 点击歌曲播放')
  await evaluate(`document.querySelector('#view .songlist .song').click(); true`)
  await sleep(1000)
  const mini = await evaluate(`(() => {
    const m = document.querySelector('#miniplayer')
    return {
      visible: !m.hidden,
      title: (document.querySelector('#miniTitle') || {}).textContent || '',
      artist: (document.querySelector('#miniArtist') || {}).textContent || '',
      coverHasImage: (document.querySelector('#miniCover').style.backgroundImage || '').includes('url'),
    }
  })()`)
  ok('迷你播放条出现且有曲目信息', mini.visible && !!mini.title, mini.title + ' - ' + mini.artist)
  ok('迷你条封面已设置', mini.coverHasImage)
  await shot('03-miniplayer')

  // 等音频真正开始拉取（Play 状态）
  let playing = false
  let audioInfo = null
  for (let i = 0; i < 30; i++) {
    audioInfo = await evaluate(`(() => {
      const a = document.querySelector('#audio')
      let buffered = 0
      try { buffered = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0 } catch {}
      return { src: (a.getAttribute('src')||'').slice(0,90), paused: a.paused, t: +a.currentTime.toFixed(2), dur: a.duration,
               rs: a.readyState, ns: a.networkState, buf: +buffered.toFixed(2), rate: a.playbackRate,
               vis: document.visibilityState, stage: a.dataset.stage, err: a.error ? a.error.code : 0 }
    })()`)
    if (!audioInfo.paused && audioInfo.t > 0.5) { playing = true; break }
    await sleep(1000)
  }
  console.log('    audio:', JSON.stringify(audioInfo))
  console.log('    媒体请求:')
  for (const m of mediaRequests) console.log('      ', m)
  // 在页面里发一次同源 fetch，验证「服务端流本身在这个页面上下文里拿得到」
  const streamProbe = await evaluate(`(async () => {
    const url = document.querySelector('#audio').getAttribute('src')
    try {
      const r = await fetch(new URL(url, location.origin).href, { headers: { Range: 'bytes=0-1023' } })
      const b = await r.arrayBuffer()
      return { status: r.status, ct: r.headers.get('content-type'), len: b.byteLength }
    } catch (e) { return { err: e.name + ':' + e.message } }
  })()`)
  console.log('    页面内 fetch 同源流:', JSON.stringify(streamProbe))

  // 若没走起来，做一次上下文对照：在页面里新建一个 Audio 拉同一个流。
  // 用来区分「播放器内核问题」与「页面/Service Worker 上下文问题」。
  if (!playing) {
    const ctx = await evaluate(`(async () => {
      const a = document.querySelector('#audio')
      const url = a.getAttribute('src')
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      // 1) 直接 seek 试试（能否置入播放位置）
      let seekOk = false
      try { a.currentTime = 2; await wait(500); seekOk = a.currentTime > 1.5 } catch (e) { seekOk = 'err:' + e.name }
      // 2) 同一个 url 换个全新的 Audio 元素
      const b = new Audio()
      b.preload = 'auto'
      document.body.appendChild(b)
      b.src = new URL(url, location.origin).href
      let err2 = ''
      try { await b.play() } catch (e) { err2 = e.name + ':' + e.message }
      const t0 = b.currentTime
      await wait(2500)
      const res = { seekOk, freshErr: err2, freshT0: +t0.toFixed(2), freshT: +b.currentTime.toFixed(2),
                    freshRs: b.readyState, freshDur: b.duration, sw: (await navigator.serviceWorker.getRegistrations()).length }
      b.pause(); b.remove()
      return res
    })()`)
    console.log('    对照诊断:', JSON.stringify(ctx))
  }

  ok('音频真的在播放（currentTime 前进）', playing, audioInfo ? `t=${audioInfo.t}s dur=${audioInfo.dur} rs=${audioInfo.rs} ns=${audioInfo.ns} buf=${audioInfo.buf} step=${audioInfo.stage} err=${audioInfo.err}` : '')

  /* 5. 全屏播放器 */
  console.log('\n--- 5. 全屏播放器')
  await evaluate(`document.querySelector('#miniplayer').click(); true`)
  await sleep(1200)
  const playerOpen = await evaluate(`document.querySelector('#player').classList.contains('is-open')`)
  const playerTpl = await evaluate(`(() => ({
    title: (document.querySelector('#playerTitle')||{}).textContent || '',
    navTitle: (document.querySelector('#playerNavTitle')||{}).textContent || '',
    disc: !!document.querySelector('#playerDisc'),
    bg: (document.querySelector('#playerBg').style.backgroundImage || '').includes('url'),
    footer: (document.querySelector('#playerResolvedBy')||{}).textContent || '',
    controls: ['btnPlay','btnPrev','btnNext','btnMode','btnQuality','btnQueue','btnFav','btnTone'].filter(id => !!document.getElementById(id)).length,
    lyricLines: document.querySelectorAll('#lyricScroll .lyric-line').length,
  }))()`)
  ok('全屏播放器打开', playerOpen, JSON.stringify(playerTpl).slice(0, 200))
  ok('播放器控件齐全（含音质 / 音色）', playerTpl.controls === 8, playerTpl.controls + '/8')
  await shot('04-player')

  // 歌词层切换
  await evaluate(`document.querySelector('#playerStage').click(); true`)
  await sleep(900)
  const lyricOn = await evaluate(`document.querySelector('#playerStage').classList.contains('show-lyric')`)
  const lyricText = await evaluate(`Array.from(document.querySelectorAll('#lyricScroll .lyric-line')).slice(0,3).map(e=>e.textContent).join(' | ').slice(0,120)`)
  ok('点击封面切到歌词层', lyricOn, lyricText || '（无歌词）')
  await shot('05-lyric')
  await evaluate(`document.querySelector('#playerCollapse').click(); true`)
  await sleep(500)

  /* 6. 搜索页 */
  console.log('\n--- 6. 搜索')
  await evaluate(`location.hash = '#/search?q=' + encodeURIComponent('海阔天空'); true`)
  // 综合搜索要等最慢的平台（QQ 被 Cloudflare 拒时要跑到平台超时），所以轮询
  await waitFor(`document.querySelectorAll('#view .songlist .song').length`, { timeout: 40000 })
  await sleep(1200)
  const searchInfo = await evaluate(`(() => {
    const imgs = Array.from(document.querySelectorAll('#view .songlist .song__cover img'))
    return {
      input: (document.querySelector('#searchInput')||{}).value || '',
      chips: document.querySelectorAll('#view .chip').length,
      rows: document.querySelectorAll('#view .songlist .song').length,
      coversTotal: imgs.length,
      // 已开始加载且没拿到像素 = 真失败；loading=lazy 未触发的图 complete=false，不计入
      broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
      coversLoaded: imgs.filter(i => i.naturalWidth > 0).length,
      errNote: document.querySelectorAll('#view .errdetail').length,
      first: (document.querySelector('#view .songlist .song__name')||{}).textContent || '',
      sub: (document.querySelector('#view .songlist .song__sub')||{}).textContent || '',
    }
  })()`)
  ok('搜索页渲染结果', searchInfo.rows > 0, JSON.stringify(searchInfo))
  ok('搜索页封面无破图', searchInfo.coversTotal >= 20 && searchInfo.broken === 0,
    searchInfo.coversLoaded + '/' + searchInfo.coversTotal + ' 已加载，破图 ' + searchInfo.broken + ' 张')
  await shot('06-search')

  /* 6b. 全平台搜专辑（六平台聚合 → 三列栅格 → 打开专辑看曲目） */
  console.log('\n--- 6b. 专辑搜索')
  await evaluate(`location.hash = '#/search?q=' + encodeURIComponent('周杰伦') + '&type=album'; true`)
  await waitFor(`document.querySelectorAll('#searchResult .grid3 .card, #searchResult .empty').length`, { timeout: 40000 })
  await sleep(1000)
  const albums = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#searchResult .grid3 .card')]
    const srcs = cards.map(c => {
      const m = (c.getAttribute('href') || '').match(/[?&]source=([^&]+)/)
      return m ? decodeURIComponent(m[1]) : (c.dataset.source || '')
    })
    const imgs = [...document.querySelectorAll('#searchResult .grid3 .card__cover img')]
    return {
      cards: cards.length,
      // 有封面图、或者给了占位图，都算「这一格不是空的」——
      // 喜马拉雅有些专辑上游就是没有封面，硬要求有 img 会把正常数据判成缺陷
      covered: cards.filter(c => c.querySelector('.card__cover img, .card__cover .cover-ph')).length,
      withImg: imgs.length,
      broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
      brokenSrc: imgs.filter(i => i.complete && i.naturalWidth === 0).slice(0, 3)
        .map(i => String(i.currentSrc || i.src).slice(0, 90)),
      openable: cards.filter(c => (c.getAttribute('href') || '').indexOf('#/album') === 0).length,
      blocked: cards.filter(c => c.classList.contains('card--blocked')).length,
      blockedBadge: cards.filter(c => c.querySelector('.card__badge--warn')).length,
      types: document.querySelectorAll('[data-act="switch-type"]').length,
      platforms: [...new Set(srcs)].filter(Boolean).sort(),
    }
  })()`)
  ok('专辑搜索出结果', albums.cards > 0, JSON.stringify(albums))
  ok('专辑卡片都有封面或占位图、且没有破图',
    albums.cards > 0 && albums.covered === albums.cards && albums.broken === 0,
    albums.covered + '/' + albums.cards + ' 有图（其中真图 ' + albums.withImg + '），破图 ' + albums.broken)
  ok('结果覆盖多个平台', albums.platforms.length >= 2, '平台 ' + albums.platforms.join('/'))
  ok('不可播平台的卡片是角标而不是死链', albums.blocked === albums.cards - albums.openable && albums.blockedBadge === albums.blocked,
    'blocked=' + albums.blocked + ' openable=' + albums.openable + ' badge=' + albums.blockedBadge)
  ok('单曲 / 专辑两个类型 chip 都在', albums.types === 2, 'types=' + albums.types)
  await shot('06b-专辑搜索')

  // 打开一张「曲目可用」的专辑，曲目列表应真的出来
  const albumHref = await evaluate(`(() => {
    const a = [...document.querySelectorAll('#searchResult .grid3 .card')]
      .find(c => (c.getAttribute('href') || '').indexOf('#/album') === 0)
    return a ? a.getAttribute('href') : null
  })()`)
  if (albumHref) {
    await evaluate(`location.hash = ${JSON.stringify(albumHref)}; true`)
    await waitFor(`document.querySelectorAll('#view .songlist .song, #view .empty').length`, { timeout: 40000 })
    await sleep(800)
    const tracks = await evaluate(`({
      songs: document.querySelectorAll('#view .songlist .song').length,
      empty: document.querySelectorAll('#view .empty').length,
      hasPlayAll: !!document.querySelector('[data-act="play-list"]'),
    })`)
    ok('专辑详情页列出曲目并能播放全部', tracks.songs > 0 && tracks.hasPlayAll, JSON.stringify(tracks))
    await shot('06c-专辑详情')
  } else {
    console.log('    没有可打开的专辑卡片，跳过详情页用例')
  }

  /* 6b-2. 搜索页的平台 chips 必须一行装下（喜马拉雅不能掉到第三行） */
  console.log('\n--- 6b-2. 搜索页 chips 与翻页收尾')
  await evaluate(`location.hash = '#/search?q=' + encodeURIComponent('周杰伦'); true`)
  await waitFor(`document.querySelectorAll('[data-act="switch-source"]').length`, { timeout: 20000 })
  await sleep(400)
  const chips = await evaluate(`(() => {
    const list = [...document.querySelectorAll('[data-act="switch-source"]')]
    const tops = [...new Set(list.map(c => Math.round(c.getBoundingClientRect().top)))]
    const keys = list.map(c => c.dataset.source)
    return {
      count: list.length,
      rows: tops.length,
      keys,
      wrap: getComputedStyle(list[0].parentElement).flexWrap,
      // 每个 chip 都要有可见宽度（被 flex 压扁到 0 也算不可选）
      allVisible: list.every(c => c.getBoundingClientRect().width > 20),
      minW: Math.round(Math.min(...list.map(c => c.getBoundingClientRect().width))),
      xmLabel: (list.find(c => c.dataset.source === 'xm') || {}).textContent,
    }
  })()`)
  ok('平台 chips 是七个（综合 + 六平台）', chips.count === 7, 'keys=' + chips.keys.join(','))
  ok('七个 chips 排在同一行（喜马拉雅不再被甩到第三行）', chips.rows === 1 && chips.wrap === 'nowrap',
    'rows=' + chips.rows + ' wrap=' + chips.wrap)
  ok('每个 chip 都有可点面积', chips.allVisible, '最窄 ' + chips.minW + 'px')
  ok('喜马拉雅 chip 存在且文案正常', chips.xmLabel === '喜马', 'label=' + JSON.stringify(chips.xmLabel))

  // 搜索框占位文案要跟着平台走，别让人以为只能搜歌
  const ph = await evaluate(`__lx.searchPlaceholder('song', 'xm') + ' / ' + __lx.searchPlaceholder('album', 'wy')`)
  ok('搜索框占位文案随类型与平台变化', ph === '搜索单集、有声书、播客 / 搜索专辑', ph)

  // 「上拉加载更多」的收尾判据（纯函数，三个分支各钉一个）
  const doneLogic = await evaluate(`({
    fresh0: __lx.searchPageDone(0, 30, 30, 2),
    short: __lx.searchPageDone(12, 12, 30, 2),
    cap: __lx.searchPageDone(30, 30, 30, __lx.MAX_SEARCH_PAGE),
    more: __lx.searchPageDone(30, 30, 30, 2),
  })`)
  ok('翻页收尾判据：没有新内容 / 不满一页 / 到硬顶 都算到底',
    doneLogic.fresh0 && doneLogic.short && doneLogic.cap && !doneLogic.more, JSON.stringify(doneLogic))

  // 首页金刚区要有「搜专辑」入口，点了直接落到专辑搜索
  await evaluate(`location.hash = '#/'; true`)
  await waitFor(`document.querySelectorAll('[data-quick]').length`, { timeout: 20000 })
  const quickAlbum = await evaluate(`!!document.querySelector('[data-quick="album"]')`)
  ok('首页金刚区有「搜专辑」入口', quickAlbum, String(quickAlbum))
  if (quickAlbum) {
    await evaluate(`document.querySelector('[data-quick="album"]').click(); true`)
    await sleep(700)
    const albumRoute = await evaluate(`({ hash: location.hash, active: (document.querySelector('[data-act="switch-type"].is-active')||{}).textContent })`)
    ok('点「搜专辑」直接进到专辑搜索态', /type=album/.test(albumRoute.hash) && albumRoute.active === '专辑',
      JSON.stringify(albumRoute))
  }

  /* 6b-3. 歌词：播放一首歌必须真的拿到歌词（线上出过「全平台都没有歌词」） */
  console.log('\n--- 6b-3. 歌词')
  // 先回首页再进搜索页：上一步停在「专辑搜索态」，直接改 hash 容易和残留的
  // searchState 抢渲染（表现为 song 行还没画出来就去点它）
  await evaluate(`location.hash = '#/'; true`)
  await sleep(500)
  await evaluate(`location.hash = '#/search?q=' + encodeURIComponent('晴天 周杰伦'); true`)
  const songRows = await waitFor(`document.querySelectorAll('#searchResult .songlist .song').length`, { timeout: 45000 })
  ok('歌词用例：搜索结果先就位', songRows > 0, 'song 行 ' + songRows)
  if (songRows > 0) {
    await evaluate(`document.querySelector('#searchResult .songlist .song').click(); true`)
    const lyricState = await waitFor(`(() => {
      const n = document.querySelectorAll('#lyricScroll .lyric-line').length
      const first = document.querySelector('#lyricScroll .lyric-line')
      const txt = first ? first.textContent : ''
      if (n > 1) return { lines: n, first: txt.slice(0, 40) }
      if (txt.indexOf('暂无歌词') >= 0) return { lines: 0, first: txt }
      return null
    })()`, { timeout: 35000 })
    ok('播放后歌词面板真的出现多行歌词（不是「暂无歌词」）',
      !!lyricState && lyricState.lines > 1, JSON.stringify(lyricState))
    await evaluate(`document.querySelector('#playerStage').classList.add('show-lyric'); true`)
    await sleep(600)
    await shot('06b3-歌词')

    /* 6b-4. 歌词高亮必须与时间戳吻合，且可校准
     *  线上出过「歌词比声音早」：早期实现把判定写成 `line.t <= now + 0.15`，
     *  无条件提前 150ms 点亮，再叠加设备输出延迟就明显「还没唱到就亮了」。
     *  现在改为严格按时间戳，偏差交给用户用播放器里的 ± 校准。 */
    console.log('\n--- 6b-4. 歌词高亮口径与校准')
    const calUi = await evaluate(`(() => {
      const v = document.querySelector('#lyricCalVal')
      return {
        hasBar: !!document.querySelector('#lyricCal'),
        label: (document.querySelector('.lyric-cal__label') || {}).textContent || '',
        val: v ? v.textContent : null,
        btns: !!document.querySelector('#lyricCalMinus') && !!document.querySelector('#lyricCalPlus'),
        delay: Player.lyricDelay,
        stored: localStorage.getItem('lx.lyricDelay'),
      }
    })()`)
    ok('歌词页有偏移校准控件', calUi.hasBar && calUi.btns && calUi.label === '歌词偏移', JSON.stringify(calUi))
    ok('默认偏移为 0（严格按时间戳，无内置提前量）', calUi.delay === 0 && calUi.val === '同步', 'val=' + calUi.val)

    // 边界口径：取一条前后间隔足够大的行，验证「时间戳前一瞬亮上一行，到点才亮这一行」
    const boundary = await evaluate(`(() => {
      const a = document.querySelector('#audio')
      const lines = Player.state.lines
      Player.setLyricDelay(0)
      let k = -1
      for (let i = 2; i < lines.length; i++) {
        if (lines[i].t - lines[i - 1].t > 0.5) { k = i; break }
      }
      if (k < 0) return { skip: '歌词时间戳过密，找不到间隔 >0.5s 的行' }
      a.pause()
      // 以元素实际接受的位置为准：不可 seek 的音源会拒绝，那就没法做这个断言
      const pick = (want) => {
        a.currentTime = want
        const at = a.currentTime
        if (Math.abs(at - want) > 0.05) return { refused: true, at, want }
        Player.syncLyric(at)
        const el = document.querySelector('#lyricScroll .lyric-line.is-active')
        return { idx: el ? Number(el.dataset.i) : -1, at }
      }
      const T = lines[k].t
      const before = pick(Math.max(0.01, T - 0.05))
      const onTime = pick(T)
      const after = pick(T + 0.05)
      a.currentTime = 0
      return { k, T, before, onTime, after }
    })()`)
    if (boundary.skip) {
      ok('歌词行间隔足够大，可做边界断言', false, boundary.skip)
    } else if (boundary.before.refused || boundary.onTime.refused) {
      ok('音源支持定位，可做边界断言', false, 'currentTime 被拒绝：' + JSON.stringify(boundary.before))
    } else {
      ok('时间戳前一瞬仍是上一行（没有被提前点亮）', boundary.before.idx === boundary.k - 1,
        't=' + (boundary.T - 0.05).toFixed(2) + ' → 第 ' + boundary.before.idx + ' 行（期望 ' + (boundary.k - 1) + '）')
      ok('到时间戳那一刻点亮本行', boundary.onTime.idx === boundary.k,
        't=' + boundary.T.toFixed(2) + ' → 第 ' + boundary.onTime.idx + ' 行（期望 ' + boundary.k + '）')
      ok('时间戳之后仍是本行', boundary.after.idx === boundary.k, '→ 第 ' + boundary.after.idx + ' 行')
    }

    // 方向：+ 让歌词延后点亮（偏移越大点亮的行越靠前）
    const dirs = await evaluate(`(() => {
      const a = document.querySelector('#audio')
      const lines = Player.state.lines
      const T = lines[Math.min(6, lines.length - 1)].t
      const out = {}
      a.pause()
      for (const d of [0, 1, 2, -1]) {
        Player.setLyricDelay(d)
        Player.syncLyric(T)
        const el = document.querySelector('#lyricScroll .lyric-line.is-active')
        out[d] = el ? Number(el.dataset.i) : -1
      }
      Player.setLyricDelay(0)
      return out
    })()`)
    ok('偏移 +1s 时高亮不晚于基准（方向正确）', dirs['1'] <= dirs['0'], JSON.stringify(dirs))

    // 按钮与复位
    const clicked = await evaluate(`(async () => {
      for (let i = 0; i < 5; i++) document.querySelector('#lyricCalPlus').click()
      const v = document.querySelector('#lyricCalVal')
      const mid = { delay: Player.lyricDelay, text: v.textContent, off: v.dataset.off,
                    stored: localStorage.getItem('lx.lyricDelay') }
      document.querySelector('#lyricCalVal').click()
      return { mid, reset: { delay: Player.lyricDelay, text: v.textContent, off: v.dataset.off } }
    })()`)
    ok('点 5 次 + 后偏移为 +1.0s（0.2s 一档）并落盘',
      clicked.mid.delay === 1 && clicked.mid.text === '+1.0s' && clicked.mid.off === '1' &&
      clicked.mid.stored === '1', JSON.stringify(clicked.mid))
    ok('点数值复位为「同步」',
      clicked.reset.delay === 0 && clicked.reset.text === '同步' && clicked.reset.off === '',
      JSON.stringify(clicked.reset))

    const clamped = await evaluate(`(() => {
      const hi = Player.setLyricDelay(99), lo = Player.setLyricDelay(-99)
      Player.setLyricDelay(0)
      return { hi, lo, max: Player.LYRIC_DELAY_MAX }
    })()`)
    ok('偏移被夹在 ±' + clamped.max + 's 内', clamped.hi === clamped.max && clamped.lo === -clamped.max,
      JSON.stringify(clamped))
  }

  /* 7. 榜单页 */
  console.log('\n--- 7. 排行榜')
  await evaluate(`location.hash = '#/charts'; true`)
  await waitFor(`document.querySelectorAll('#view .grid3 .card').length`, { timeout: 30000 })
  await sleep(800)
  const chartInfo = await evaluate(`(() => ({
    cards: document.querySelectorAll('#view .grid3 .card').length,
    covers: document.querySelectorAll('#view .grid3 .card__cover img').length,
  }))()`)
  ok('排行榜列表渲染', chartInfo.cards >= 20, JSON.stringify(chartInfo))
  await shot('07-charts')

  /* 8. 我的 / 设置 / 播放历史 / 关于 */
  for (const [hash, name, sel] of [
    ['#/library', '我的歌单', '#view .songlist .song'],
    ['#/mine', '我的', '#view .menu-item'],
    ['#/settings', '设置', '#view .chip'],
    // 播放历史：有记录时是列表，没有时是空状态 —— 两种都算「有内容」。
    // （旧用例在这里测的是 #/sources「音源与插件」，那个页已经整体搬去 /admin 了）
    ['#/history', '播放历史', '#view .block, #view .empty'],
    // #/about 原来是「Subsonic 客户端接入」，那份接入参数已搬去 /admin 的「客户端接入」，
    // 这一页现在只讲「这是什么应用」。
    ['#/about', '关于', '#view .block'],
    ['#/favorite', '收藏', '#view .block'],
    ['#/import', '歌单导入', '#btnImport'],
  ]) {
    await evaluate(`location.hash = '${hash}'; true`)
    const n = await waitFor(`document.querySelectorAll('${sel}').length`, { timeout: 30000 })
    ok('页面 ' + name + ' 有内容', n > 0, n + ' 个 ' + sel)
    await shot('08-' + name.replace(/[^\w\u4e00-\u9fa5]/g, ''))
  }

  /* 8a2. 播放历史页的细节（续播数据就在这张表上） */
  console.log('\n--- 8a2. 播放历史页')
  await evaluate(`location.hash = '#/history'; true`)
  await waitFor(`document.querySelectorAll('#view .block, #view .empty').length`, { timeout: 20000 })
  await sleep(500)
  const hist = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#view .songlist .song')]
    return {
      rows: rows.length,
      empty: !!document.querySelector('#view .empty'),
      bars: document.querySelectorAll('#view .hist__bar').length,
      metas: document.querySelectorAll('#view .hist__meta').length,
      delBtns: document.querySelectorAll('#view [data-act="del-play-history"]').length,
      clearBtn: !!document.querySelector('[data-act="clear-play-history"]'),
      firstMeta: (document.querySelector('#view .hist__meta') || {}).textContent || '',
      firstHref: rows.length ? rows[0].dataset.list : null,
    }
  })()`)
  ok('播放历史页有清空按钮', hist.clearBtn, JSON.stringify(hist))
  if (hist.rows > 0) {
    ok('历史行有进度条与「听到哪 / 播了几次」明细',
      hist.bars === hist.rows && hist.metas === hist.rows && /播了\s*\d+\s*次/.test(hist.firstMeta),
      hist.rows + ' 行，示例：' + hist.firstMeta)
    ok('历史行可单独删除', hist.delBtns === hist.rows, hist.delBtns + ' 个删除按钮')
  } else {
    ok('无播放记录时显示空状态', hist.empty, JSON.stringify(hist))
  }
  // 点一行真的会播（历史页的行必须可播，不然只是个只读列表）
  if (hist.rows > 0) {
    const firstId = await evaluate(`(document.querySelector('#view .songlist .song') || {}).dataset.i`)
    // 点歌名区域而不是行中心 —— 行右侧有个「删除」按钮，点中心有机会落到它上面
    await evaluate(`(document.querySelector('#view .songlist .song .song__meta') || document.querySelector('#view .songlist .song')).click(); true`)
    await sleep(2500)
    const played = await evaluate(`(() => ({
      hasAudio: !!document.querySelector('#audio').getAttribute('src'),
      index: Player.index,
      queueLen: Player.queue.length,
      name: (Player.current() || {}).name || '',
    }))()`)
    // 只断言「真的开始放这首队列了」。
    // 不断言 index === 0：历史里可能有源已失效的歌，取流全挂会自动跳下一首，
    // index 往前走了是**正确行为**，拿它当失败判据会误报。
    ok('点历史里的歌能起播', played.hasAudio && played.queueLen === hist.rows && !!played.name,
      JSON.stringify(played) + ' 点了第 ' + firstId + ' 行')
  }
  await shot('08a2-播放历史')

  /* 8b. 管理后台 /admin · 插件评分与调度（系统自动评分 → 展示 → 人工/自动选择）
   *
   * 这一段原来跑在用户端的「音源与插件」页里。本次改造把它整体拆到了独立页面 /admin，
   * 测试也跟着换地方：整页导航过去。token 存在 localStorage（同源），
   * 管理页会拿它自动登录 —— 所以下面顺带验证了「已登录的管理员不会被拦在登录页」。
   * 留在用户端测，只会测到一个「页面不存在」。
   */
  console.log('\n--- 8b. 管理后台 · 插件评分与调度')
  await send('Page.navigate', { url: `${ORIGIN}/admin` })
  await sleep(2500)
  const admShell = await evaluate(`(() => ({
    shell: !!document.querySelector('.admin-shell'),
    login: !!document.querySelector('#au'),
    tabs: document.querySelectorAll('.admin-nav__item').length,
    brand: (document.querySelector('.admin-brand') || {}).textContent || '',
    root: !!document.querySelector('#adminRoot'),
  }))()`)
  ok('管理后台用已登录的管理员身份进入（不是登录页）', admShell.shell && !admShell.login, JSON.stringify(admShell))
  ok('管理后台五个页签齐全', admShell.tabs === 5, 'tabs=' + admShell.tabs)

  // 切到「音源与插件」页签（评分区块在这一页）
  //
  // 计时是这条用例的重点，不只是「等它出现」：/admin/health 要对每个平台各发一次
  // **真实搜索**（实测 6s+），曾经和 sources / plugin-scores 用 Promise.all 一起等，
  // 结果「插件调度顺序」被一个跟它毫无关系的体检接口卡住，整页停在骨架屏上 ——
  // 用户看到的就是「插件看不到了」。改成 health 后台补徽标之后，调度顺序必须在
  // 几秒内就出来。只断言「最终出现」的话，卡 30 秒也算过，那等于没测。
  const tSources0 = Date.now()
  await evaluate(`document.querySelector('.admin-nav__item[data-tab="sources"]').click(); true`)
  await waitFor(`document.querySelectorAll('#scoreBlock .rank-row').length`, { timeout: 40000 })
  const rankMs = Date.now() - tSources0
  ok('「插件调度顺序」点开页签后 8 秒内出现（不被平台体检卡住）', rankMs < 8000,
    rankMs + 'ms（改前实测 6s+，且随出口网络更慢）')
  // 前置条件：显式把调度模式复位成「自动」——上一轮测试或手工改可能留下人工顺序
  await evaluate(`(() => {
    const b = document.querySelector('#scoreBlock [data-act="score-mode"][data-mode="auto"]')
    if (b && !b.classList.contains('is-active')) b.click()
    return true
  })()`)
  await sleep(1400)
  const scoreBase = await evaluate(`(async () => {
    const host = document.querySelector('#scoreBlock')
    if (!host) return { err: '找不到 #scoreBlock' }
    const rows = host.querySelectorAll('.rank-row')
    const first = rows[0]
    // 平台数从服务端拿，不写死 —— 加一个平台（比如喜马拉雅）就要来改测试的话，
    // 这条断言迟早会变成「改了测试让它过」
    let platforms = 0
    try { platforms = ((await API.sources()).platforms || []).length } catch { /* ignore */ }
    return {
      rows: rows.length,
      platforms,
      tabs: host.querySelectorAll('[data-act="score-tab"]').length,
      modes: host.querySelectorAll('[data-act="score-mode"]').length,
      activeTab: (host.querySelector('[data-act="score-tab"].is-active') || {}).dataset
        ? host.querySelector('[data-act="score-tab"].is-active').dataset.key : null,
      firstName: first ? first.querySelector('.rank-row__name').textContent.trim() : null,
      firstScore: first ? first.querySelector('.rank-row__score').textContent.trim() : null,
      firstPills: first ? first.querySelectorAll('.rank-row__meta .pill').length : 0,
      autoActive: host.querySelector('[data-act="score-mode"][data-mode="auto"]').classList.contains('is-active'),
    }
  })()`)
  ok('评分区块渲染出插件行', scoreBase.rows > 3, JSON.stringify(scoreBase))
  ok('每个平台一个 tab（与服务端平台数一致）',
    scoreBase.platforms >= 4 && scoreBase.tabs === scoreBase.platforms,
    'tabs=' + scoreBase.tabs + ' platforms=' + scoreBase.platforms)
  ok('自动 / 人工两个模式按钮都在', scoreBase.modes === 2, 'modes=' + scoreBase.modes)
  ok('默认是自动模式', scoreBase.autoActive === true, 'autoActive=' + scoreBase.autoActive)
  ok('第 1 名带综合分与指标', !!scoreBase.firstScore && scoreBase.firstScore !== '—' && scoreBase.firstPills > 0,
    scoreBase.firstName + ' ' + scoreBase.firstScore + ' pills=' + scoreBase.firstPills)
  // 体检是后台补的：此刻平台可用性那块应该还显示「体检中…」，等它回来再变成真实结果。
  // 两条一起才完整 —— 只测前者，后台补的那段逻辑就没有回归覆盖。
  /**
   * 体检徽标是后台补的（见 renderSources：health 不进 Promise.all）。
   * 这里验证的是「补得上」，不是「补得晚」 ——
   *
   * 「此刻应该还是体检中」这条**不要**写成硬断言。它依赖「health 一定比首屏渲染慢」
   * 这个时序假设：后端预热之后 health 可能几百毫秒就回来（实测 137ms 那个平台），
   * 而断言执行前还夹着 1.4s 的 sleep，于是它会随机红。
   * 为「证明实现细节」引入 flaky 断言不划算 —— 真正对应用户问题的是上面那条
   * 「调度顺序 8 秒内出现」，它不依赖时序，也不会因为网络快就假失败。
   *
   * 判据只看**徽标 pill 自己的文本**，不能用 host.textContent：这块底部的说明
   * 文字里就写着「「接口受限」表示…」，拿 textContent 去正则会立刻命中说明文字，
   * 结果永远是「已完成」，等于没测。
   */
  const HEALTH_PILLS = `(() => {
    const host = document.querySelector('#platHealth')
    if (!host) return []
    return [...host.querySelectorAll('.pill')].map(x => x.textContent.trim())
  })()`
  const healthDone = await waitFor(`(() => ${HEALTH_PILLS}.some(t => /搜索正常|接口受限/.test(t)))()`,
    { timeout: 30000, interval: 500 })
  const healthAfter = await evaluate(`(() => {
    const pills = ${HEALTH_PILLS}
    return { done: pills.some(t => /搜索正常|接口受限/.test(t)),
             sample: pills.filter(t => /搜索正常|接口受限/.test(t)).slice(0, 6) }
  })()`)
  ok('平台体检完成后徽标自动补上（不用刷新页面）',
    healthDone === true && healthAfter.done === true, JSON.stringify(healthAfter))
  // 截图是视口截图，评分区块在页面下半部分，先滚过去再拍
  await evaluate(`document.querySelector('#scoreBlock').scrollIntoView({ block: 'start' }); true`)
  await sleep(400)
  await shot('08b-插件评分')

  // 切平台 tab：内容应换成该平台的候选
  await evaluate(`document.querySelector('#scoreBlock [data-act="score-tab"][data-key="mg"]').click(); true`)
  await sleep(400)
  const tabSwitched = await evaluate(`(() => {
    const host = document.querySelector('#scoreBlock')
    return { active: host.querySelector('[data-act="score-tab"].is-active').dataset.key,
             rows: host.querySelectorAll('.rank-row').length }
  })()`)
  ok('切到咪咕 tab 后内容跟着换', tabSwitched.active === 'mg' && tabSwitched.rows > 0, JSON.stringify(tabSwitched))

  // 切人工模式：应出现 ↑ / ↓ 调序按钮
  await evaluate(`document.querySelector('#scoreBlock [data-act="score-mode"][data-mode="manual"]').click(); true`)
  await sleep(1200)
  const manualMode = await evaluate(`(() => {
    const host = document.querySelector('#scoreBlock')
    return {
      manualActive: host.querySelector('[data-act="score-mode"][data-mode="manual"]').classList.contains('is-active'),
      arrows: host.querySelectorAll('[data-act="rank-up"], [data-act="rank-down"]').length,
    }
  })()`)
  ok('切人工模式后出现调序按钮', manualMode.manualActive && manualMode.arrows > 0, JSON.stringify(manualMode))
  await evaluate(`document.querySelector('#scoreBlock').scrollIntoView({ block: 'start' }); true`)
  await sleep(400)
  await shot('08c-插件调度_人工模式')

  // 把第 2 名上移一位：顺序应真的换过来
  const before = await evaluate(`[...document.querySelectorAll('#scoreBlock .rank-row__name')].slice(0,2).map(e => e.textContent.trim())`)
  await evaluate(`document.querySelectorAll('#scoreBlock [data-act="rank-up"]')[1].click(); true`)
  await sleep(1200)
  const after = await evaluate(`[...document.querySelectorAll('#scoreBlock .rank-row__name')].slice(0,2).map(e => e.textContent.trim())`)
  ok('上移后前两名互换', before[0] === after[1] && before[1] === after[0],
    JSON.stringify(before) + ' -> ' + JSON.stringify(after))

  // 停用第 1 名：该行应变成灰行（保留在列表里，可重新启用）
  const offRes = await evaluate(`(async () => {
    const host = document.querySelector('#scoreBlock')
    const row = host.querySelector('.rank-row')
    const id = row.querySelector('[data-act="rank-off"]').dataset.id
    row.querySelector('[data-act="rank-off"]').click()
    await new Promise(r => setTimeout(r, 1500))
    const target = [...document.querySelectorAll('#scoreBlock .rank-row')]
      .find(r => r.querySelector('[data-act="rank-off"]').dataset.id === id)
    return { id, off: !!target && target.classList.contains('is-off'),
             willReenable: !!target && target.querySelector('[data-act="rank-off"]').textContent.trim() === '↺' }
  })()`)
  ok('停用后该行变灰且可重新启用', offRes.off && offRes.willReenable, JSON.stringify(offRes))

  // 把停用撤回（点回来），再恢复自动模式，别把测试状态留给后面的用例
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('#scoreBlock .rank-row')].find(r => r.classList.contains('is-off'))
    if (t) t.querySelector('[data-act="rank-off"]').click()
    return true
  })()`)
  await sleep(900)
  await evaluate(`document.querySelector('#scoreBlock [data-act="score-mode"][data-mode="auto"]').click(); true`)
  await sleep(900)
  const restored = await evaluate(`(() => {
    const host = document.querySelector('#scoreBlock')
    return { auto: host.querySelector('[data-act="score-mode"][data-mode="auto"]').classList.contains('is-active'),
             offs: host.querySelectorAll('.rank-row.is-off').length,
             arrows: host.querySelectorAll('[data-act="rank-up"]').length }
  })()`)
  ok('切回自动模式后调序按钮消失', restored.auto && restored.arrows === 0, JSON.stringify(restored))
  ok('测试留下的停用状态已清干净', restored.offs === 0, 'is-off 行数 ' + restored.offs)

  /* 8b2. 管理后台其余四个页签：不能有任何一个是空白 */
  console.log('\n--- 8b2. 管理后台其余页签')
  for (const [key, name, sel] of [
    ['overview', '概览', '.admin-kpi'],
    ['users', '用户管理', '#nubtn'],
    ['plays', '播放记录', '#apane .admin-card'],
    ['ai', 'AI 歌单接口', '#apane .admin-card'],
  ]) {
    await evaluate(`document.querySelector('.admin-nav__item[data-tab="${key}"]').click(); true`)
    const n = await waitFor(`document.querySelectorAll('${sel}').length`, { timeout: 25000 })
    const err = await evaluate(`(document.querySelector('#apane .note[style*="d73535"]') || {}).textContent || ''`)
    ok('管理后台「' + name + '」页签有内容', n > 0 && !err, n + ' 个 ' + sel + (err ? ' 错误：' + err : ''))
    await shot('08b2-管理后台_' + name)
  }

  /* 8b3. 管理后台不许被缓存（用户反馈「评分没有了、看不到插件」的一条根因）
   *
   * 这一组不是在测功能，是在守一个**已经踩过**的坑：admin.html 自己不注册 Service
   * Worker，但 SW 的 scope 是整站 —— 只要这浏览器打开过 App，/admin 的导航和它引的
   * admin.js 就会掉进 SW 的「同源静态资源 stale-while-revalidate」分支里。SWR 的语义
   * 是先给缓存里的旧版，所以：
   *
   *   发版后第一次进管理后台 → 旧页面；必须再刷一次 → 才是新页面。
   *
   * 症状是「改了也部署了，用户那边还是旧的」，而且全新 profile 复现不出来（本文件就是
   * 全新 profile，所以下面的断言必须直接查 Cache Storage，而不是靠肉眼度页面）。
   *
   * 三条防线分别落在三个层面，缺一个就会被它绕过去：
   *   A. HTTP  —— _headers 给这些路径配了 Cache-Control: no-cache
   *   B. SW    —— sw.js 遇到管理路径直接 return，不进 SWR
   *   C. 可见性 —— 管理页左下角显示「资源 SW vN · 缓存 vN」，人力一眼能判新旧
   */
  console.log('\n--- 8b3. 管理后台不被 Service Worker 缓存')

  // 先确认这台浏览器确实建立了静态缓存 —— 否则下面「缓存里没有 admin.js」是空转，
  // 一个没缓存过的环境永远能通过，等于假通过。
  const cacheState = await evaluate(`(async () => {
    const keys = await caches.keys()
    const out = []
    for (const k of keys) {
      const c = await caches.open(k)
      const reqs = await c.keys()
      out.push({ name: k, n: reqs.length, urls: reqs.map(r => new URL(r.url).pathname) })
    }
    return out
  })()`)
  const staticCache = (cacheState || []).find(c => c.name.startsWith('lxmusic-static-'))
  ok('浏览器已建立静态缓存（本组断言的前置条件，否则下面全是空转）',
    !!staticCache && staticCache.n > 0,
    staticCache ? staticCache.name + ' 里 ' + staticCache.n + ' 项' : '没有任何静态缓存')

  if (staticCache) {
    const bad = staticCache.urls.filter(u => u === '/admin' || u === '/admin.html' || u === '/js/admin.js')
    ok('静态缓存里没有管理后台的任何文件（SW 放行了它们）', bad.length === 0,
      bad.length ? '被缓存了：' + bad.join(', ') : '干净')
  }

  // A：HTTP 层必须 no-cache。只有 SW 放行、没有这层的话，浏览器自己的缓存照样能
  // 把旧页面留下来（no-cache = 每次带 ETag 回来校验，拿到新版本才用新版本）。
  const adminHeaders = await evaluate(`(async () => {
    const pick = async (p) => {
      const r = await fetch(p, { method: 'GET' })
      return { path: p, cc: (r.headers.get('cache-control') || '').toLowerCase() }
    }
    return Promise.all([pick('/admin'), pick('/js/admin.js')])
  })()`)
  for (const h of (adminHeaders || [])) {
    ok('_headers 生效：' + h.path + ' 带 no-cache', h.cc.includes('no-cache'),
      'Cache-Control: ' + (h.cc || '(无)'))
  }

  // C：左下角那行「资源 SW vN · 缓存 vN」必须出现 —— 这是以后再出同类问题时，
  // 用户能一眼回答「是新版还是旧版」的唯一依据。
  const stamp = await evaluate(`(() => {
    const el = document.querySelector('#resStamp')
    return { present: !!el, text: (el ? el.textContent : '').trim() }
  })()`)
  ok('管理页显示资源版本标记（判断新旧页面的依据）',
    stamp.present && /SW\s*v\d+/.test(stamp.text), JSON.stringify(stamp))
  // D：页面必须能往下滚。这是用户端那两条全局 CSS（height:100% + overflow:hidden）
  // 落到管理页上的直接后果 —— 内容超过一屏就彻底拉不动，缩浏览器才看得到下半截。
  // 这条必须查 computed style：「没有滚动条」这件事肉眼是看不出来的。
  await evaluate(`document.querySelector('.admin-nav__item[data-tab="sources"]').click(); true`)
  await waitFor(`document.querySelectorAll('#scoreBlock .rank-row').length`, { timeout: 30000 })
  await sleep(1200)
  const scrollState = await evaluate(`(() => {
    const se = document.scrollingElement
    const overflow = getComputedStyle(document.body).overflow
    se.scrollTop = 0
    se.scrollTop = 99999
    const reached = se.scrollTop
    se.scrollTop = 0
    return {
      overflow, reached,
      scrollH: se.scrollHeight, innerH: window.innerHeight,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
    }
  })()`)
  ok('管理页 body 没有被 overflow:hidden 钉死',
    scrollState.overflow !== 'hidden', 'overflow: ' + scrollState.overflow)
  ok('管理页内容超出屏幕时能真正滚动到底',
    scrollState.scrollH > scrollState.innerH && scrollState.reached > 0,
    '内容 ' + scrollState.scrollH + 'px / 视口 ' + scrollState.innerH + 'px，滚到 ' + scrollState.reached + 'px')

  // 再确认「滚得到」= 「看得全」：最后那张卡片（服务端内置插件表）在旧样式下
  // 正好落在被截掉的位置，滚到底之后它必须真的出现在视口里。
  const tailVisible = await evaluate(`(() => {
    const se = document.scrollingElement
    se.scrollTop = 99999
    const host = document.querySelector('.admin-main')
    const cards = host.querySelectorAll('.admin-card')
    const last = cards[cards.length - 1]
    const r = last.getBoundingClientRect()
    return { inView: r.top < window.innerHeight && r.bottom > 0, text: (last.textContent || '').slice(0, 24) }
  })()`)
  ok('滚到底后能看到最后一张卡片（内容没被裁掉）', tailVisible.inView, tailVisible.text)
  await shot('08b3-管理后台_滚到底')
  await shot('08b3-管理后台_资源版本')

  // 回用户端：后面还有歌单封面 / PWA 的用例
  await send('Page.navigate', { url: `${ORIGIN}/` })
  await sleep(3200)

  /* 8c. 歌单封面：新建歌单必须自带封面，列表里不能出现空灰格子 */
  console.log('\n--- 8c. 歌单封面')
  const made = await evaluate(`(async () => {
    const s = await API.search('晴天', { source: 'wy', limit: 1 })
    const song = (s.list || [])[0]
    if (!song) return { skip: '搜索无结果，跳过' }
    const created = await API.createPlaylist('封面回归测试', [song])
    return { id: created.playlist.id, cover: created.playlist.cover || '', songImg: song.img || '' }
  })()`)
  if (made.skip) {
    console.log('    ' + made.skip)
  } else {
    ok('新建歌单自动带上封面', !!made.cover, 'cover=' + String(made.cover).slice(0, 60))
    await evaluate(`location.hash = '#/library'; true`)
    await waitFor(`document.querySelectorAll('#view .song--rich').length`, { timeout: 20000 })
    const covers = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#view .song--rich')]
      const mine = rows.find(r => (r.textContent || '').indexOf('封面回归测试') >= 0)
      const sub = (r) => ((r.querySelector('.song__sub') || {}).textContent || '')
      return {
        rows: rows.length,
        withImg: rows.filter(r => r.querySelector('.song__cover img')).length,
        // 空歌单（0 首）用图标占位是**设计如此**（见 playlistCoverTag），
        // 它本来就没有任何封面可取，不能算「缺封面」
        emptyRows: rows.filter(r => /^\\s*0\\s*首/.test(sub(r))).length,
        placeholders: rows.filter(r => r.querySelector('.cover-ph')).length,
        mineSrc: mine && mine.querySelector('.song__cover img')
          ? mine.querySelector('.song__cover img').getAttribute('src') : '',
        mineBroken: mine ? !mine.querySelector('.song__cover img') : true,
      }
    })()`)
    ok('每一个有歌的歌单都画出了封面图（空歌单用占位图标不算缺）',
      covers.rows > 0 && covers.withImg === covers.rows - covers.emptyRows, JSON.stringify(covers))
    ok('新建的那个歌单有封面而不是占位图标', !covers.mineBroken && !!covers.mineSrc,
      'src=' + String(covers.mineSrc).slice(0, 70))
    await shot('08d-我的歌单封面')
    // 清理，别把测试歌单留在库里
    await evaluate(`API.deletePlaylist(${JSON.stringify(made.id)}).catch(() => null)`)
  }

  /* 8e. 音质 / 音色面板 */
  console.log('\n--- 8e. 音质与音色')
  /**
   * 前置：真的把一首歌播出声。
   *
   * 不能只等 <audio> 挂上 src —— 直连失败是不报错的（连接建不上或对端不吐数据，
   * 元素停在 readyState=0），要等满 8 秒看门狗才降级到插件/代理那一级。
   * 只看 src 就会在「还没出声」的状态下做切换，量出来是「切前 0.0s → 切后 0.0s」，
   * 那是前置没成立，不是产品问题。
   *
   * 用首页「猜你喜欢」而不是播放历史：第 4 节已经验证过首页第一行能出声，
   * 而播放历史里可能全是失效的老记录（源站不再返回直链），拿它当前置是本末倒置。
   */
  await evaluate(`location.hash = '#/'; true`)
  await waitFor(`document.querySelectorAll('#view .songlist .song').length`, { timeout: 25000 })
  const homeRows = await evaluate(`document.querySelectorAll('#view .songlist .song').length`)
  let startedAt = 0
  for (let i = 0; i < Math.min(homeRows, 4) && !startedAt; i++) {
    await evaluate(`((document.querySelectorAll('#view .songlist .song .song__meta')[${i}]) || {}).click(); true`)
    const t = await waitFor(
      `(() => { const a = document.querySelector('#audio'); return (!a.paused && a.currentTime > 6) ? a.currentTime : 0 })()`,
      { timeout: 60000, interval: 700 })
    if (t) startedAt = i + 1
  }
  ok('音质/音色用例：先让一首歌真的播出声', !!startedAt,
    startedAt ? `首页第 ${startedAt} 行起播` : '首页前 4 行都没出声（源站问题，本组跳过）')
  if (!startedAt) {
    console.log('    诊断:', JSON.stringify(await evaluate(`(() => {
      const a = document.querySelector('#audio')
      return { src: (a.getAttribute('src')||'').slice(0,110), paused: a.paused, t: a.currentTime,
               rs: a.readyState, ns: a.networkState, err: a.error ? a.error.code : 0,
               step: a.dataset.stage, foot: (document.querySelector('#playerResolvedBy')||{}).textContent || '' }
    })()`)))
    for (const m of mediaRequests.slice(-10)) console.log('      ', m)
  }

  if (startedAt) {
    await evaluate(`document.querySelector('#miniplayer').click(); true`)
    await sleep(800)

    const toneUi = await evaluate(`(() => ({
      btnTone: !!document.getElementById('btnTone'),
      controls: ['btnPlay','btnPrev','btnNext','btnMode','btnQuality','btnQueue','btnFav','btnTone']
        .filter(id => !!document.getElementById(id)).length,
    }))()`)
    ok('播放器新增音色按钮，控件齐全', toneUi.btnTone && toneUi.controls === 8, JSON.stringify(toneUi))

    // 换音质会重取流、位置归零 —— 先把位置挪到一个「一眼能看出有没有归零」的地方
    const seekTo = await evaluate(`(() => {
      const a = document.querySelector('#audio')
      const d = a.duration
      const w = (isFinite(d) && d > 12) ? Math.min(37, d - 10) : 37
      a.currentTime = w
      return w
    })()`)
    await waitFor(`document.querySelector('#audio').currentTime >= ${seekTo} - 2`, { timeout: 15000, interval: 300 })

    /* 音质：面板点选（旧实现是连点循环） */
    await evaluate(`document.querySelector('#btnQuality').click(); true`)
    await sleep(500)
    const qSheet = await evaluate(`(() => ({
      open: !document.querySelector('#drawer').hidden,
      title: document.querySelector('#drawerTitle').textContent,
      chips: [...document.querySelectorAll('#drawerBody [data-act="set-quality"]')].map(b => b.dataset.key),
      active: (document.querySelector('#drawerBody [data-act="set-quality"].is-active') || { dataset: {} }).dataset.key || null,
    }))()`)
    ok('音质点开是面板（四档可直选，不用连点循环）',
      qSheet.open && qSheet.title === '音质' && qSheet.chips.length === 4, JSON.stringify(qSheet))

    const beforeT = await evaluate(`document.querySelector('#audio').currentTime || 0`)
    await evaluate(`document.querySelector('#drawerBody [data-act="set-quality"][data-key="128k"]').click(); true`)
    // load() 会同步摘掉旧 src，先等它确实换流了，再去量新流的位置，
    // 否则会量到「还没被换掉的旧流」的 currentTime，断言形同虚设。
    await waitFor(`!document.querySelector('#audio').getAttribute('src')`, { timeout: 8000, interval: 100 })
    const afterT = await waitFor(
      `(() => { const a = document.querySelector('#audio'); return (a.getAttribute('src') && !a.paused && a.currentTime > 5) ? a.currentTime : 0 })()`,
      { timeout: 60000, interval: 700 })
    const afterQ = await evaluate(`(() => ({
      q: Player.state.quality,
      active: (document.querySelector('#drawerBody [data-act="set-quality"].is-active') || { dataset: {} }).dataset.key || null,
    }))()`)
    ok('切音质后抽屉里的选中态跟着更新', afterQ.q === '128k' && afterQ.active === '128k', JSON.stringify(afterQ))
    // 换音质会把 <audio> 的 src 换掉，不接住位置就会从 0 重放（以前就是这样）。
    // 判据取「明显没有归零」：重放的话 5 秒后才刚过 5s，不可能追上切前的位置。
    ok('切音质保留播放位置（不从头开始）',
      afterT > Math.max(5, beforeT - 10),
      `切前 ${Number(beforeT).toFixed(1)}s → 切后 ${Number(afterT || 0).toFixed(1)}s`)

    /* 音色：预设面板 + Web Audio 引擎 */
    await evaluate(`document.querySelector('#btnTone').click(); true`)
    await sleep(500)
    const tSheet = await evaluate(`(() => ({
      title: document.querySelector('#drawerTitle').textContent,
      chips: [...document.querySelectorAll('#drawerBody [data-act="set-tone"]')].map(b => b.dataset.key),
      presetCount: Tone.PRESETS.length,
      hasFlat: Tone.PRESETS.some(p => p.key === 'flat'),
      supported: Tone.supported(),
      bands: Tone.BANDS.length,
      flatGains: Tone.PRESETS.filter(p => p.key === 'flat')[0].gains.every(g => g === 0),
      nonFlat: Tone.PRESETS.filter(p => p.key !== 'flat').every(p => p.gains.some(g => Math.abs(g) > 0)),
    }))()`)
    ok('音色面板列全预设（含「原声」= 关闭）',
      tSheet.title === '音色' && tSheet.chips.length === tSheet.presetCount && tSheet.hasFlat,
      tSheet.chips.join('/'))
    ok('EQ 频段为 5 段，原声全 0dB、其余预设都有效果',
      tSheet.bands === 5 && tSheet.flatGains && tSheet.nonFlat, JSON.stringify(tSheet))

    // 跨域预检是音效能不能用的唯一判据（没有 ACAO 的音源接上 Web Audio 就是静音）。
    // 这里只验证判定器本身按预期工作：同源必然可用。
    const cors = await evaluate(`(async () => ({
      sameOrigin: await Tone.canUse(location.origin + '/manifest.json'),
      empty: await Tone.canUse(''),
    }))()`)
    ok('跨域预检对同源地址判定为可用、对空地址判定为不可用',
      cors.sameOrigin === true && cors.empty === false, JSON.stringify(cors))

    // 音色必须走真实面板入口（case 'set-tone' → pickTone），不是直接喊 Tone 的 API ——
    // 否则「面板点了没反应」这类问题测不出来。这一条正是本组最该守住的东西。
    // 音源没有跨域许可时 pickTone 会问「是否改走服务端中转」，这里按「确认」处理，
    // 顺带把网页端那条降级链路也过一遍。
    const preUsable = await evaluate(`Tone.canUse(document.querySelector('#audio').getAttribute('src') || '')`)
    setDialogPolicy('accept')
    await evaluate(`document.querySelector('#drawerBody [data-act="set-tone"][data-key="bass"]').click(); true`)
    await waitFor(`Tone.isAttached() ? 1 : 0`, { timeout: 20000, interval: 400 })
    setDialogPolicy('dismiss')
    await sleep(600)
    const engaged = await evaluate(`({
      preset: Tone.preset, gains: Tone.gains, active: Tone.active(),
      attached: Tone.isAttached(), stored: U.store.get('lx.tone', null),
      state: Tone.context && Tone.context.state, preUsable: ${JSON.stringify(preUsable)},
      foot: (document.querySelector('#playerResolvedBy')||{}).textContent || '',
    })`)
    if (tSheet.supported) {
      ok('选音色后 Web Audio 图被接上、增益生效并落盘',
        engaged.preset === 'bass' && engaged.active && engaged.attached && engaged.stored === 'bass',
        JSON.stringify(engaged))
      ok('低频段增益确实被抬起来了', engaged.gains[0] > 3, '低音 ' + engaged.gains[0] + 'dB')
    } else {
      ok('环境不支持 Web Audio 时不崩、不误报可用', engaged.attached === false, JSON.stringify(engaged))
    }

    await evaluate(`Tone.reset(); true`)
    await sleep(300)
    const off = await evaluate(`({ preset: Tone.preset, gains: Tone.gains, active: Tone.active(), stored: U.store.get('lx.tone', null) })`)
    ok('关掉音效后回到 0dB（原声）', off.preset === 'flat' && !off.active && off.stored === 'flat', JSON.stringify(off))
    await shot('08e-音色面板')

    /* 8f. 歌词偏移校准：不在歌词区里（用户反馈：原来浮在歌词上，滑歌词时极易误触） */
    console.log('\n--- 8f. 歌词偏移校准的位置')
    // 8e 结束时音色抽屉还开着 —— 不关掉，截图里校准条会被抽屉挡住，等于白拍
    await evaluate(`(() => {
      const mask = document.querySelector('#drawer .sheet__mask')
      if (mask) mask.click()
      return true
    })()`)
    await sleep(400)
    // 播放页默认是唱片视图，歌词区可能整块隐藏 —— 隐藏元素量出来全是 0，
    // 那条「在校准区下方」的判据会变成假通过。所以先强制切到歌词视图，
    // 并确认歌词区真的有高度，再量。
    await evaluate(`document.querySelector('#playerStage').classList.add('show-lyric'); true`)
    await sleep(500)
    const calPos = await evaluate(`(() => {
      const cal = document.querySelector('#lyricCal')
      const lyric = document.querySelector('#playerLyric')
      const plus = document.querySelector('#lyricCalPlus')
      if (!cal || !lyric || !plus) return { err: '缺节点', cal: !!cal, lyric: !!lyric, plus: !!plus }
      const c = cal.getBoundingClientRect()
      const l = lyric.getBoundingClientRect()
      const p = plus.getBoundingClientRect()
      const player = document.querySelector('#player').getBoundingClientRect()
      // 「不再叠在歌词上」的硬判据：校准条整体在歌词区的**下边缘之下**。
      // 早先它是 .player__lyric 里的 absolute bottom:6px，c.top < l.bottom，完全重叠。
      const belowLyric = l.height > 40 && c.top >= l.bottom - 1
      return {
        belowLyric,
        lyricVisible: l.height > 40,
        lyricH: Math.round(l.height),
        gap: Math.round(c.top - l.bottom),
        calTopInPlayer: Math.round(c.top - player.top),
        lyricBottomInPlayer: Math.round(l.bottom - player.top),
        calH: Math.round(c.height),
        btnReachable: p.width >= 24 && p.height >= 24,
        playerOpen: document.querySelector('#player').classList.contains('is-open'),
      }
    })()`)
    ok('歌词视图确实打开（否则量到的是隐藏元素）', calPos.lyricVisible === true,
      'lyricH=' + calPos.lyricH + 'px')
    ok('歌词偏移校准移出歌词区（不再叠在歌词上）', calPos.belowLyric === true, JSON.stringify(calPos))
    ok('校准条与歌词区有留白、按钮尺寸可点',
      typeof calPos.gap === 'number' && calPos.gap >= 0 && calPos.btnReachable === true,
      'gap=' + calPos.gap + 'px 按钮' + (calPos.btnReachable ? '可点' : '过小'))
    await shot('08f-歌词校准位置')

    await evaluate(`document.querySelector('#playerCollapse').click(); true`)
    await sleep(400)
  } else {
    // 前置已经单独报过失败，这里不再重复计一项，免得同一个原因报两次
    console.log('    （音质/音色用例跳过：没有可播放的样本）')
  }

  /* 9. PWA 可安装性 */
  console.log('\n--- 9. PWA')
  const pwa = await evaluate(`(async () => {
    const man = await fetch('/manifest.json').then(r => r.json())
    const regs = await navigator.serviceWorker.getRegistrations()
    return { name: man.name, display: man.display, icons: man.icons.length,
             sw: regs.length, start: man.start_url }
  })()`)
  ok('manifest 可读取且 standalone', pwa.display === 'standalone' && pwa.icons >= 4, JSON.stringify(pwa))
  ok('Service Worker 已注册', pwa.sw > 0, '注册数 ' + pwa.sw)

  /* 10. 错误汇总 */
  console.log('\n--- 10. 运行期错误')
  const realErrors = consoleErrors.filter(e => !/favicon|net::ERR_|Failed to load resource/i.test(e))
  ok('无 JS 控制台错误', realErrors.length === 0, realErrors.slice(0, 4).join(' || ').slice(0, 400))
  ok('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || ').slice(0, 400))
  if (failedRequests.length) console.log('    资源加载失败（多为外部图片/CDN，可忽略）:', failedRequests.slice(0, 8).join(' | '))
} catch (e) {
  console.error('测试中断:', e)
  results.push({ name: '测试整体执行', pass: false, extra: String(e.message) })
} finally {
  try { ws.close() } catch { /* ignore */ }
  try { chrome.kill() } catch { /* ignore */ }
}

const failed = results.filter(r => !r.pass)
console.log('\n================ 浏览器验收汇总 ================')
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
for (const f of failed) console.log('  ✗ ' + f.name + '  ' + f.extra)
process.exit(failed.length ? 1 : 0)
