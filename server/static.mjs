/**
 * 静态资源（Docker 版的「Static Assets」）。
 *
 * Cloudflare 那边静态资源是平台能力（public/ 目录 + public/_headers）；
 * 换到 Node 就得自己发。这里是它的等价物，并且**读同一份 public/_headers** ——
 * 迁移最容易出的岔子就是「加了响应头但只在某一端生效」，
 * 所以宁愿多写 20 行解析，也不把 /admin 的 noindex 在两边各写一遍。
 */
import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
}

/**
 * 缓存策略：
 *   html 与 sw.js 一律 no-cache —— 这两样最怕「改了但用户还是旧的」；
 *   Service Worker 尤其致命，它管着整个壳缓存。
 *   其余静态资源给 5 分钟，重打产物后不至于长期吃旧版，又不至于每次都回源。
 */
function cacheControlFor(rel) {
  if (/\.html?$/i.test(rel)) return 'no-cache'
  if (rel === 'sw.js') return 'no-cache'
  return 'public, max-age=300'
}

/**
 * 解析 public/_headers。格式就是 Cloudflare 的那份：
 *   /path
 *     Header-Name: value
 * 空行与 # 注释忽略。
 */
function parseHeadersFile(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const rules = []
  let cur = null
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    if (/^\s/.test(rawLine)) {
      if (!cur) continue
      const i = rawLine.indexOf(':')
      if (i < 0) continue
      cur.headers.push([rawLine.slice(0, i).trim(), rawLine.slice(i + 1).trim()])
    } else {
      cur = { pattern: rawLine.trim(), headers: [] }
      rules.push(cur)
    }
  }
  return rules
}

export function createStaticServer(root) {
  const ROOT = path.resolve(root)
  const headerRules = parseHeadersFile(path.join(ROOT, '_headers'))

  /**
   * 路径 → 磁盘文件。
   * `/` 与无扩展名的深链接都回 index.html（前端是 hash 路由，正常不会走到）；
   * `/admin` 映射到 admin.html —— 与 Cloudflare 静态资源的行为一致。
   */
  function resolveFile(pathname) {
    let p = decodeURIComponent(pathname)
    if (p.includes('\0')) return null
    // _headers 是配置不是资源（Cloudflare 那边也不会把它发出去），别当成静态文件吐出来
    if (p === '/_headers') return null
    if (p === '/' || p === '') p = '/index.html'
    else if (p === '/admin') p = '/admin.html'

    let abs = path.join(ROOT, p)
    // 目录逃逸防护：解析后必须还在 ROOT 里
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null

    let st = null
    try { st = fs.statSync(abs) } catch { /* 不存在 */ }
    if (st && st.isDirectory()) {
      abs = path.join(abs, 'index.html')
      try { st = fs.statSync(abs) } catch { st = null }
    }
    if (!st) {
      // 没有扩展名 = 前端路由的深链接 → 回 index.html
      if (!path.extname(p)) {
        abs = path.join(ROOT, 'index.html')
        try { st = fs.statSync(abs) } catch { return null }
      } else {
        return null
      }
    }
    return { abs, st, rel: path.relative(ROOT, abs).split(path.sep).join('/') }
  }

  function extraHeaders(rel, urlPath) {
    const out = {}
    for (const rule of headerRules) {
      // 规则既可能写 `/admin`，也可能写 `/admin.html`，两个都认
      if (rule.pattern !== urlPath && rule.pattern !== '/' + rel) continue
      for (const [k, v] of rule.headers) out[k.toLowerCase()] = v
    }
    return out
  }

  /**
   * 命中返回 {status, headers, stream?, body?}，没命中返回 null（交给上层 404 / API）。
   */
  function serve(method, pathname, reqHeaders) {
    const hit = resolveFile(pathname)
    if (!hit) return null

    const etag = `W/"${hit.st.size}-${Math.floor(hit.st.mtimeMs)}"`
    const headers = {
      'content-type': MIME[path.extname(hit.abs).slice(1).toLowerCase()] || 'application/octet-stream',
      'cache-control': cacheControlFor(hit.rel),
      etag,
      'last-modified': hit.st.mtime.toUTCString(),
      ...extraHeaders(hit.rel, pathname),
    }

    if (reqHeaders['if-none-match'] === etag) {
      return { status: 304, headers: { etag, 'cache-control': headers['cache-control'] }, body: null }
    }

    if (method === 'HEAD') {
      return { status: 200, headers: { ...headers, 'content-length': String(hit.st.size) }, body: null }
    }

    return {
      status: 200,
      headers: { ...headers, 'content-length': String(hit.st.size) },
      stream: fs.createReadStream(hit.abs),
    }
  }

  return { serve, root: ROOT, headerRules }
}
