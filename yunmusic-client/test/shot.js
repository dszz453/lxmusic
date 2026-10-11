/*
 * 用 CDP（Chrome DevTools Protocol）截图。
 *
 * 为什么不用 `--headless --screenshot --virtual-time-budget=N`：
 * 那条路要求页面进入「静默」状态才会收工，而音乐播放器页面天然静不下来
 * （rAF 歌词循环、看门狗定时器、播放重试……），实测直接挂死到超时。
 * 虚拟时间还会让 `--window-size` 失真。
 *
 * 这里改成：真起一个 headless Chrome，连上 CDP，显式设置视口、真实等待若干毫秒，
 * 再 Page.captureScreenshot。稳定、可控，视口也是真的。
 *
 * 用法：
 *   node test/shot.js "名称|URL|等待毫秒|宽|高" ["名称|URL|..."]
 * 例：
 *   node test/shot.js "player|file:///.../preview-player.html#/chart?source=wy&id=c1|2600|512|1000"
 * 产物：build/shots/shot-<名称>.png
 */
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'build', 'shots')
const CHROME = process.env.CHROME
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9333)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简 CDP 客户端：只实现「发一条命令、等它的 result」 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (e) { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败')))
  })
  return {
    ready,
    send(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params: params || {} }))
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')) }
        }, 30000)
      })
    },
    close() { try { ws.close() } catch (e) { } }
  }
}

async function waitForCDP() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await r.json()
      if (list && list.length) return list
    } catch (e) { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 端口没起来（' + PORT + '）')
}

async function main() {
  const specs = process.argv.slice(2)
  if (!specs.length) {
    console.error('用法: node test/shot.js "名称|URL|等待毫秒|宽|高"')
    process.exit(1)
  }
  const parsed = specs.map((s) => {
    const [name, url, wait, w, h] = s.split('|')
    return { name, url, wait: Number(wait) || 1500, w: Number(w) || 512, h: Number(h) || 1000 }
  })

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const profile = path.join(ROOT, 'build', 'chrome-profile')

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' })

  let cdp = null
  try {
    const list = await waitForCDP()
    const page = list.find((t) => t.type === 'page') || list[0]
    cdp = connect(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    for (const sp of parsed) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: sp.w, height: sp.h, deviceScaleFactor: 2, mobile: true
      })
      await cdp.send('Page.navigate', { url: sp.url })
      // 真实等待：等页面把假数据渲染完、把注入动作跑完
      await sleep(sp.wait)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const file = path.join(OUT_DIR, 'shot-' + sp.name + '.png')
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      console.log('✓ ' + path.relative(ROOT, file) + '  ' + (fs.statSync(file).size) + ' bytes  ' + sp.url)
    }
  } finally {
    if (cdp) cdp.close()
    try { chrome.kill() } catch (e) { }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('截图失败：', e && e.message || e)
  process.exit(1)
})
