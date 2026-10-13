/**
 * 回归：插件返回的 **http 直链**不得因为「域名不在 https 升级白名单里」被整批丢弃。
 *
 * 背景（2026-10-13 老板报障）：客户端里「网易的歌能放，酷狗的歌放不出来」。
 * 实测酷狗《黄昏》的 13 个候选里**只有 3 条** `http://*.bdycdn.cn/...` 真能出声，
 * 而 `bdycdn.cn` 不是 kugou.com（kugou.com 只出现在 URL 路径里）→ 不在旧的
 * HTTPS_UPGRADE_HOSTS 白名单里 → 三条全被丢弃 → `/url` 直接 404 →
 * 只能退到服务端代理（音源标识显示「服务端」）。QQ 的 `http://175.27.166.236/...`
 * 同样被丢。
 *
 * 修法：upgradeToHttps 改为**一律乐观升级**，能不能真用交给 Range 探测判定；
 * 升上去探不通、且本机允许 http 音频（安卓壳）时，退回原 http 链。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeToHttps, resolveMusicUrlFast } from '../src/lib/stream.js'

test('upgradeToHttps 对任意域名都升级（不再只认官方 CDN 白名单）', () => {
  // 曾经被漏掉的第三方中转（域名里没有 kugou.com，kugou.com 只在路径里）
  assert.equal(
    upgradeToHttps('http://v3-32-yp-qqmusic.a.bdycdn.cn/fsdg360.hw.kugou.com/a.mp3'),
    'https://v3-32-yp-qqmusic.a.bdycdn.cn/fsdg360.hw.kugou.com/a.mp3'
  )
  // 纯 http 的 IP 中转（升 https 会失败，但「升级」这一步本身必须发生）
  assert.equal(
    upgradeToHttps('http://175.27.166.236/kgqq/qq.php?type=mp3'),
    'https://175.27.166.236/kgqq/qq.php?type=mp3'
  )
  // 已是 https / 非 http：原样返回
  assert.equal(upgradeToHttps('https://m701.music.126.net/a.mp3'), 'https://m701.music.126.net/a.mp3')
  assert.equal(upgradeToHttps('data:audio/mp3;base64,AAAA'), 'data:audio/mp3;base64,AAAA')
  assert.equal(upgradeToHttps(''), '')
  assert.equal(upgradeToHttps(null), '')
})

/** 造一个只返回固定地址的插件池 */
function poolReturning(url) {
  return {
    musicUrlPlugins: () => [{ id: 'p1', meta: { name: '酷狗聚合' } }],
    async invokePlugin() { return { ok: true, value: url, plugin: '酷狗聚合' } },
    supports: () => false,
  }
}

/** 让「https 变体」探不通、「http 原链」能探通，模拟纯 http 的中转源 */
function mockFetchHttpsDeadHttpAlive() {
  return async (url, opts = {}) => {
    const headers = opts.headers || {}
    const range = headers.Range || headers.range
    if (/^https:\/\//i.test(String(url))) {
      // 该源不支持 https —— 回一个非音频错误页
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } })
    }
    return new Response(new Uint8Array([1, 2]), {
      status: range ? 206 : 200,
      headers: {
        'content-type': 'audio/mpeg',
        ...(range ? { 'content-range': 'bytes 0-1/8405805' } : {}),
      },
    })
  }
}

test('非白名单域名的 http 候选：https 可用时升级后交出去（不再被丢）', async () => {
  const oldFetch = globalThis.__lxFetch
  const oldAllow = globalThis.LX_ALLOW_HTTP_AUDIO
  globalThis.__lxFetch = async (url, opts = {}) => {
    const headers = opts.headers || {}
    const range = headers.Range || headers.range
    return new Response(new Uint8Array([1, 2]), {
      status: range ? 206 : 200,
      headers: {
        'content-type': 'audio/mpeg',
        ...(range ? { 'content-range': 'bytes 0-1/8405805' } : {}),
      },
    })
  }
  try {
    const song = { source: 'kg', id: 'kg-1', songmid: 'HASH', hash: 'HASH', name: '黄昏', singer: '周传雄', interval: 344 }
    const pluginPool = poolReturning('http://v3-32-yp-qqmusic.a.bdycdn.cn/fsdg360.hw.kugou.com/a.mp3')
    const fast = await resolveMusicUrlFast(song, '320k', pluginPool, {
      maxTries: 2, deadline: 400, probeDeadline: 400, totalBudget: 600,
    })
    assert.equal(fast.url, 'https://v3-32-yp-qqmusic.a.bdycdn.cn/fsdg360.hw.kugou.com/a.mp3',
      '应把 http 候选升级成 https 后交出，而不是丢弃')
    assert.equal(fast.from, 'plugin:酷狗聚合')
  } finally {
    globalThis.__lxFetch = oldFetch
    if (oldAllow === undefined) delete globalThis.LX_ALLOW_HTTP_AUDIO
    else globalThis.LX_ALLOW_HTTP_AUDIO = oldAllow
  }
})

test('https 升级探不通时：安卓壳（允许 http）退回原 http 链，网页端才丢弃', async () => {
  const oldFetch = globalThis.__lxFetch
  const oldAllow = globalThis.LX_ALLOW_HTTP_AUDIO
  globalThis.__lxFetch = mockFetchHttpsDeadHttpAlive()
  const song = { source: 'tx', id: 'tx-1', songmid: 'MID', name: '黄昏', singer: '周传雄', interval: 344 }
  const pluginPool = poolReturning('http://175.27.166.236/kgqq/qq.php?type=mp3&id=MID')
  try {
    // ① 安卓壳：允许 http 音频 → 退回原链，仍能取到地址
    globalThis.LX_ALLOW_HTTP_AUDIO = true
    const shell = await resolveMusicUrlFast(song, '320k', pluginPool, {
      maxTries: 2, deadline: 400, probeDeadline: 400, totalBudget: 600,
    })
    assert.equal(shell.url, 'http://175.27.166.236/kgqq/qq.php?type=mp3&id=MID',
      '升级探不通时，安卓壳应退回原 http 链，不能白丢一条能播的候选')

    // ② 网页端：不允许 http → 绝不能把 http 地址交出去（会被混合内容拦掉）。
    //    服务端允许把「未探通」的候选以 unverified 形式交出（这是既有设计：
    //    服务端出口探不通不代表浏览器侧不通，见 player.js 对 CF 出口的说明），
    //    所以这里只断言「不得是 http」，不要求一定为 null。
    globalThis.LX_ALLOW_HTTP_AUDIO = false
    const web = await resolveMusicUrlFast(song, '320k', pluginPool, {
      maxTries: 2, deadline: 400, probeDeadline: 400, totalBudget: 600,
    })
    assert.doesNotMatch(String(web.url || ''), /^http:\/\//i,
      '网页端不得交出 http 地址（会被混合内容拦掉）')
  } finally {
    globalThis.__lxFetch = oldFetch
    if (oldAllow === undefined) delete globalThis.LX_ALLOW_HTTP_AUDIO
    else globalThis.LX_ALLOW_HTTP_AUDIO = oldAllow
  }
})

test('内置 bundle 与网页端播放器都采用「一律升级」口径', async () => {
  const fs = await import('node:fs')
  const bundle = fs.readFileSync(new URL('../public/js/backend.bundle.js', import.meta.url), 'utf8')
  const player = fs.readFileSync(new URL('../public/js/player.js', import.meta.url), 'utf8')
  // bundle 里的 upgradeToHttps 不得再引用白名单
  assert.doesNotMatch(bundle, /HTTPS_UPGRADE_HOSTS/, 'bundle 不应再残留 https 升级白名单')
  assert.doesNotMatch(player, /UPGRADE_HOSTS/, '网页端播放器不应再残留 https 升级白名单')
  assert.match(player, /raw\.replace\(\/\^http:\/i, 'https:'\)/, '网页端 upgradeHttps 必须一律升级')
})
