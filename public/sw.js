/**
 * Service Worker
 *  - 静态资源：stale-while-revalidate，保证二次打开秒开
 *  - /api 与 /rest：一律直连网络（音频流、搜索、Subsonic 都不允许缓存）
 *  - 导航请求：网络优先，离线时回退到缓存的壳
 *  - **管理后台：完全不接管**（下面 ADMIN_PATHS，原因写在那里）
 *
 * 每次发版记得把 VERSION 往上抬一格，否则用户手机上会一直吃旧缓存。
 *
 * v28：通用客户端（client/）接入所需的两处前端改动 —— brand.js 支持客户端注入的
 *      同步品牌判据（LX_CLIENT_HOST_HINT），app.js 的版本一致性比较改为比
 *      「客户端期望的服务端版本」而不是客户端自己的版本号（客户端已有独立版本线）。
 *      两者都是运行时才生效的判定，不抬 VERSION 的话老缓存会一直赢。
 *
 * v41：`js/backend.bundle.js` 变了（`src/lib/ai.js` 的 AI 生成上限 180s → 90s）。
 *      它不在 PRECACHE 里，但 `index.html` 每次都会 `<script src>` 它 ——
 *      于是它落在下面那条「同源静态资源 stale-while-revalidate」分支上：
 *      先给缓存里的旧版、后台再更新。不抬 VERSION 的话，用户手机上会先跑一版
 *      旧后端（AI 上限还是 180s），要再刷一次才生效。
 *
 * v42：`js/backend.bundle.js` 又变了 —— `src/lib/stream.js` 不再在**试听片段**上收工，
 *      `src/providers/{index,wy}.js` 开始标记试听，`js/player.js` 拿到 metadata 就提示。
 *      同 v41 的道理：它走「同源静态资源 SWR」分支，不抬 VERSION 用户会先跑一版
 *      旧后端（还会把 30 秒片段当完整曲目交出去），要再刷一次才生效。
 *
 * v43：`js/backend.bundle.js` 又变了 —— 这一版给插件**专有源**开了通道：插件自己注册的源
 *      （汽水 `qsvip`）现在能被列出 / 勾选 / 搜索取流；`js/admin.js` 与 `js/app.js` 也跟着改
 *      （管理页把插件源并进「默认搜索源」那一列、搜索页给插件源单独一行 chip、
 *      「导入歌单」下拉仍只用内置平台）。同 v41/v42 的道理：bundle 走「同源静态资源 SWR」
 *      分支、admin/app 在 PRECACHE 里，不抬 VERSION 用户会先吃到一整轮旧前端。
 *
 * v44：`js/backend.bundle.js` 又变了 —— 这一版修「CF 版每日推荐点『换一批』报
 *      『搜索源无返回』」：`src/server/daily.js` 的 AI 解析改成**单源分轮 + 子请求预算**
 *      （旧版 24 首 × 6 源 = 144 个子请求，撞上 Cloudflare 单次请求的 fetch 上限
 *      —— 本账号实测约 50 —— 超出的请求全被静默吞掉，连兜底那一发也发不出去）。
 *      同 v41~v43 的道理：bundle 走「同源静态资源 SWR」分支，不抬 VERSION 用户会先跑旧后端。
 *      ⚠ 顺带修一个发版事故：本文件顶部这段说明在 v43 处**提前写了一个块注释结束标记**
 *        （星号加斜杠），把 v43 的说明变成了裸代码 —— 整个 sw.js 语法错误、
 *        Service Worker 根本注册不上（自 2.6 起，2026-10-10 才发现）。
 *        护栏：test/home-cache.test.mjs 里用 node --check 校验本文件可被解析。
 */
const VERSION = 'v44'
const STATIC_CACHE = 'lxmusic-static-' + VERSION
const SHELL_CACHE = 'lxmusic-shell-' + VERSION

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/util.js',
  '/js/brand.js',
  '/js/api.js',
  '/js/player.js',
  '/js/tone.js',
  '/js/lxplugin.js',
  '/js/lxworker.js',
  // lxworker.js 是 module worker，它 import 这两个文件。
  // 不预缓存的话离线时 Worker 起不来，插件取流整级失效。
  '/js/lib/crypto.js',
  '/js/lib/util.js',
  '/js/tone.js',
  '/js/audiocache.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting()
})

/**
 * 管理后台的文件：**永不进 SW 缓存**。
 *
 * admin.html 自己不注册 SW，但只要在浏览器里打开过一次 App，SW 的 scope 就是整站
 * —— /admin 的导航、以及它引的 admin.js，都会被下面的「同源静态资源 stale-while-
 * revalidate」接管。SWR 的语义是「先给缓存里的旧版，后台再去更新」：
 *
 *   - 第一次发版后打开管理后台 → 看到旧页面
 *   - 必须再刷新一次 → 才是新页面
 *
 * 表现出来就是「明明改了也部署了，用户那边还是老样子」，而且很难查 —— 全新 profile
 * 打开一切正常，只有已经装着 PWA 的设备复现。管理后台本来就用不到离线（离线连管理
 * 接口都调不通），这里唯一正确的取舍是放弃缓存、保证看到的永远是最新的。
 */
const ADMIN_PATHS = [
  '/admin',
  '/admin.html',
  '/js/admin.js',
]
const isAdminPath = (pathname) =>
  ADMIN_PATHS.includes(pathname) || pathname.startsWith('/admin/')

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // 动态接口 / 音频流：不走缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest')) return
  if (req.headers.has('range')) return

  // 管理后台：直接不介入，交给浏览器的 HTTP 缓存（这些路径的 _headers 配了
  // no-cache，带 ETag 每次校验，拿不到新的宁可报错也不要旧的）
  if (url.origin === self.location.origin && isAdminPath(url.pathname)) return

  // 导航请求：网络优先，失败回退壳
  if (req.mode === 'navigate') {
    // 只把「用户端首屏」存进壳缓存。
    // 之前是无条件把任何导航响应写到 '/index.html' 这个键上 —— 访问一次 /admin
    // 就会把管理页的 HTML 存成离线壳，之后断网打开 App 会看到管理后台。
    const isShell = url.pathname === '/' || url.pathname === '/index.html'
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (isShell && res && res.ok) {
            const copy = res.clone()
            caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(isShell ? '/index.html' : req)
          .then((r) => r || new Response('离线', { status: 503 })))
    )
    return
  }

  // 同源静态资源：stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') {
              const copy = res.clone()
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {})
            }
            return res
          })
          .catch(() => cached)
        return cached || network
      })
    )
  }
})
