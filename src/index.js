/**
 * Worker 入口
 *  - /rest/*  Subsonic API（供 音流 / Feishin / DSub 等客户端）
 *  - /api/*   PWA 自有接口
 *  - 其余      静态资源（PWA 前端）
 */
import { pluginPool } from './plugins.js'
import { handleSubsonic } from './server/subsonic.js'
import { handleApi, songForWeb } from './server/api.js'
import { generateDaily, pickPrimaryUser } from './server/daily.js'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,range',
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // 把插件池挂到 env 上，供各层使用
    env.PLUGIN_POOL = pluginPool
    // 宿主体征：本宿主是 CF Worker。前端据此把客户端名显示成 music-edge
    // （Docker 那边是 server/index.mjs 挂 'docker' → LX-MUSIC）。
    // 见 public/js/brand.js 与 src/server/api.js 的 /version。
    env.LX_HOST_KIND = 'cf'
    // waitUntil 挂到 env 上：/api/home 发现当天每日推荐还没生成时，
    // 用它把「后台生成」挂到请求生命周期上（响应先回，生成继续跑）。
    env.waitUntil = (p) => ctx.waitUntil(p)

    try {
      if (path === '/rest' || path.startsWith('/rest/')) {
        const res = await handleSubsonic(request, env, url)
        return withCors(res)
      }

      if (path.startsWith('/api/') || path === '/api') {
        const res = await handleApi(request, env, url)
        return withCors(res)
      }

      if (path === '/healthz') {
        return Response.json({
          ok: true,
          plugins: pluginPool.summary().map(p => ({ name: p.name, ok: p.ok, sources: p.sources, error: p.error })),
          ts: new Date().toISOString(),
        })
      }

      // 注意：/admin 不在这里处理。
      //
      // 静态资源是**在 Worker 之前**匹配的（`[assets]` 没配 run_worker_first 时的默认行为），
      // 请求 /admin 会被资源层直接解析成 /admin.html 返回 200，Worker 根本不会被执行。
      // 之前在这里写了一段「显式返回 admin.html」的分支，看着像在干活，其实是死代码 ——
      // 实测响应带的是资源层的 ETag 与 CF-Cache-Status，一个我们自己加的响应头都没有。
      // 需要给管理页加响应头（X-Robots-Tag）应该用 public/_headers，那是资源层的配置。

      // 静态资源
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request)
        if (assetRes.status !== 404) return assetRes
        // SPA 回退
        if (!path.includes('.')) {
          const indexRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
          if (indexRes.status === 200) {
            return new Response(indexRes.body, {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
            })
          }
        }
        return assetRes
      }

      return new Response('Not Found', { status: 404 })
    } catch (e) {
      console.error('[worker] 未捕获异常:', e && e.stack || e)
      return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 500, headers: CORS })
    }
  },

  /**
   * cron 触发：每天北京时间 06:00（UTC 22:00，见 wrangler.toml [triggers]）生成当日推荐。
   * 口味来源取「播放记录最多的用户」—— 单用户产品实际上就是老板自己；
   * 一个播放记录都没有（全新库）时 userId 为 null，prompt 退化为大众口味推荐。
   */
  async scheduled(controller, env, ctx) {
    env.PLUGIN_POOL = pluginPool
    try {
      const userId = await pickPrimaryUser(env.DB)
      const rec = await generateDaily(env, env.DB, { userId, force: false, toWeb: songForWeb })
      console.log('[daily] cron 生成完成:', rec.date, rec.title, rec.songs.length + '首', rec.generator)
    } catch (e) {
      console.error('[daily] cron 生成失败:', e && e.stack || e)
    }
  },
}

function withCors(res) {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
