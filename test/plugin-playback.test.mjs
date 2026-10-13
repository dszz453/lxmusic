import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { musicUrlCandidateList, PROVIDERS } from '../src/providers/index.js'
import { openAudioStream, resolveMusicUrlFast, resolvePlayableUrl } from '../src/lib/stream.js'

test('所有播放解析路径只调用 musicUrl 插件，不调用 provider 官方取流接口', async () => {
  const sourceKeys = Object.keys(PROVIDERS)
  const saved = {}
  let nativeCalls = 0
  let failWyPlugin = false
  for (const source of sourceKeys) {
    const provider = PROVIDERS[source]
    saved[source] = {
      search: provider.search,
      getMusicUrl: provider.getMusicUrl,
      getMusicUrlCandidates: provider.getMusicUrlCandidates,
    }
    provider.search = async () => ({
      list: source === 'kg'
        ? [{ source: 'kg', id: 'kg-track-1', name: '黄昏（R&B版）', singer: '周传雄', interval: 240 }]
        : [],
    })
    provider.getMusicUrl = async () => {
      nativeCalls++
      return 'https://native.example/audio.mp3'
    }
    provider.getMusicUrlCandidates = async () => {
      nativeCalls++
      return ['https://native.example/audio.mp3']
    }
  }

  const oldFetch = globalThis.__lxFetch
  globalThis.__lxFetch = async (_url, opts = {}) => {
    const headers = opts.headers || {}
    const range = headers.Range || headers.range
    return new Response(new Uint8Array([1, 2]), {
      status: range ? 206 : 200,
      headers: {
        'content-type': 'audio/mpeg',
        ...(range ? { 'content-range': 'bytes 0-1/9000000' } : {}),
      },
    })
  }

  try {
    const song = {
      source: 'wy', id: 'wy-track-1', songmid: 'wy-track-1',
      name: '黄昏（R&B版）', singer: '周传雄', interval: 240,
    }
    const pluginPool = {
      musicUrlPlugins(source) {
        return [{ id: `${source}-plugin`, meta: { name: `${source}-plugin` } }]
      },
      async invokePlugin(plugin, source) {
        if (source === 'wy' && failWyPlugin) return { ok: false, plugin: plugin.meta.name }
        return {
          ok: true,
          value: `https://plugin.example/${source}.mp3`,
          plugin: plugin.meta.name,
        }
      },
      supports() { return false },
    }

    const thunks = musicUrlCandidateList(song, '320k', pluginPool)
    assert.equal(thunks.length, 1, '候选列表只应包含插件 thunk')
    assert.equal((await thunks[0]()).from, 'plugin:wy-plugin', '候选解析必须来自插件')

    const fast = await resolveMusicUrlFast(song, '320k', pluginPool, {
      maxTries: 2, deadline: 250, probeDeadline: 250, totalBudget: 300,
    })
    assert.equal(fast.from, 'plugin:wy-plugin', 'fast URL 应来自本源插件')
    assert.equal(fast.url, 'https://plugin.example/wy.mp3')

    const playable = await resolvePlayableUrl(song, '320k', pluginPool, { maxProbe: 1 })
    assert.equal(playable.from, 'plugin:wy-plugin', '已验证 URL 应来自本源插件')

    failWyPlugin = true
    const proxied = await openAudioStream(song, '320k', pluginPool)
    assert.equal(proxied.ok, true)
    assert.equal(proxied.from, '跨源(酷狗音乐) plugin:kg-plugin', '跨源兜底也必须调用目标源插件')

    const emptyPool = { musicUrlPlugins: () => [], supports: () => false }
    const fastMissing = await resolveMusicUrlFast(song, '320k', emptyPool)
    assert.equal(fastMissing.url, null)
    assert.match(fastMissing.error, /没有启用取流插件/)

    const directMissing = await resolvePlayableUrl(song, '320k', emptyPool)
    assert.equal(directMissing.url, null)
    assert.match(directMissing.error, /没有启用取流插件/)

    const streamMissing = await openAudioStream(song, '320k', emptyPool, { allowCrossSource: false })
    assert.equal(streamMissing.ok, false)
    assert.match(streamMissing.error, /没有启用取流插件/)
    assert.equal(nativeCalls, 0, '本源、跨源、fast、探测和代理失败都不得调用 provider 原生取流接口')
  } finally {
    globalThis.__lxFetch = oldFetch
    for (const source of sourceKeys) {
      const provider = PROVIDERS[source]
      provider.search = saved[source].search
      if (saved[source].getMusicUrl === undefined) delete provider.getMusicUrl
      else provider.getMusicUrl = saved[source].getMusicUrl
      if (saved[source].getMusicUrlCandidates === undefined) delete provider.getMusicUrlCandidates
      else provider.getMusicUrlCandidates = saved[source].getMusicUrlCandidates
    }
  }
})

test('HTTP 与 Subsonic 播放路由只委派插件专用解析器', () => {
  const api = fs.readFileSync(new URL('../src/server/api.js', import.meta.url), 'utf8')
  const subsonic = fs.readFileSync(new URL('../src/server/subsonic.js', import.meta.url), 'utf8')
  const urlRoute = api.match(/if \(path === '\/url'\) \{([\s\S]*?)\n    \}/)?.[1]
  const streamRoute = api.match(/if \(path === '\/stream'\) \{([\s\S]*?)\n    \}/)?.[1]
  const subsonicStream = subsonic.match(/async function stream\(env, params, ctx, method\) \{([\s\S]*?)\n\}/)?.[1]

  assert.ok(urlRoute, '/api/url 路由必须存在')
  assert.match(urlRoute, /resolveMusicUrlFast\(song, quality, env\.PLUGIN_POOL\)/)
  assert.match(urlRoute, /resolvePlayableUrl\(song, quality, env\.PLUGIN_POOL\)/)
  assert.ok(streamRoute, '/api/stream 路由必须存在')
  assert.match(streamRoute, /resolveMusicUrlFast\(song, quality, env\.PLUGIN_POOL\)/)
  assert.match(streamRoute, /openAudioStream\(song, quality, env\.PLUGIN_POOL/)
  assert.ok(subsonicStream, 'Subsonic stream handler 必须存在')
  assert.match(subsonicStream, /openAudioStream\(song, quality, env\.PLUGIN_POOL/)
  for (const route of [urlRoute, streamRoute, subsonicStream]) {
    assert.doesNotMatch(route, /getMusicUrlCandidates|getMusicUrl\s*\(/,
      '播放路由不得直接调用 provider 原生取流接口')
  }
})

test('内置后端 bundle 的播放候选只调用 musicUrl 插件', () => {
  const bundle = fs.readFileSync(new URL('../public/js/backend.bundle.js', import.meta.url), 'utf8')
  const start = bundle.indexOf("function musicUrlCandidateList(song, quality = '320k', pluginPool = null) {")
  assert.notEqual(start, -1, 'bundle 必须包含当前插件专用候选构造器')
  const end = bundle.indexOf('\n}', start)
  assert.notEqual(end, -1, 'bundle 候选构造器必须完整')
  const candidateBuilder = bundle.slice(start, end)
  assert.match(candidateBuilder, /pluginPool\.musicUrlPlugins/)
  assert.doesNotMatch(candidateBuilder, /getMusicUrlCandidates|getMusicUrl\s*\(/,
    'bundle 候选构造器不得调用 provider 原生取流接口')
  assert.doesNotMatch(bundle, /musicUrlCandidateList\([^\n]*prefer:\s*['"]native['"]/,
    'bundle 的播放调用不得偏向 provider 原生候选')
})
