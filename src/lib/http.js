/**
 * 出站 HTTP 封装：统一 UA / 超时 / JSON 容错 / 重试 / JSONP
 */

export const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
export const UA_ANDROID_APP = 'NeteaseMusic/9.1.28.240206163722(140);Dalvik/2.1.0 (Linux; U; Android 12; EBG-AN10 Build/HUAWEIEBG-AN10)'

export class HttpError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/**
 * 出站请求的实际执行者 —— 全项目唯一的出口，所有网络调用都必须经过它。
 *
 * 默认就是原生 fetch（Cloudflare Worker / 浏览器都走这条）。
 * 但在安卓壳里，网页发出的跨域请求会被同源策略挡下（各音乐源站基本不回
 * Access-Control-Allow-Origin），所以壳内在页面启动阶段会把 globalThis.__lxFetch
 * 换成「走原生桥」的实现：由 Java 侧发请求、把响应回投给页面，天然不受同源策略约束。
 *
 * 这里只做一层转发，不改语义 —— Worker 侧的线上行为与改动前完全一致。
 */
export function outboundFetch(url, opts) {
  const impl = globalThis.__lxFetch
  return impl ? impl(url, opts) : fetch(url, opts)
}

/**
 * 当前宿主能不能播放 http 音频。
 *
 * 在网页里不能：https 页面加载 http 音频属于混合内容，浏览器会直接拦掉，
 * 所以直链候选里的 http 地址必须丢弃或走代理（这也是 /api/stream 存在的理由）。
 * 安卓壳里可以：WebView 已开 MIXED_CONTENT_ALWAYS_ALLOW，<audio> 加载 http 一样播，
 * 而且 <audio> 加载跨域地址本就豁免 CORS，连代都不需要代。
 *
 * 壳启动时会把 globalThis.LX_ALLOW_HTTP_AUDIO 置为 true（见 public/js/native.js，
 * player.js 读的是同一个标志）。因此这里问的是「宿主能力」，而不是「我们想不想」——
 * 判错的代价是两个平台之一出问题：网页里放行 http 会静音，壳里禁止 http 会白等降级。
 */
export function allowHttpAudio() {
  return globalThis.LX_ALLOW_HTTP_AUDIO === true
}

/**
 * 取址阶段的预算（毫秒）。两个宿主给不同的值，理由不同：
 *
 *   · 网页（Worker / 浏览器）用默认值 1600 / 1200 / 1800 —— 用户在等一个
 *     Worker 请求，拖久了既慢又可能撞平台限制。
 *   · 安卓壳放宽到 3500 / 1500 / 3800 —— 候选是本地并发发起的，没有平台上限；
 *     而「首个点歌」要等插件 Worker 冷启动建链（实测冷解析 ≈2.9s 才出候选，
 *     热态 0.66~0.76s）。沿用网页那套预算会让第一首歌白掉一级：
 *     direct 直接 404，客户端再走一遍 plugin 级才拿到地址。
 *
 *   deadline / totalBudget 必须都盖过冷解析，因为「候选一个都没解析出来」才是 404 的
 *   唯一成因（只要解析出了候选，哪怕没探通也会带着 unverified 交出去）。
 *   probeDeadline 反而要收紧：探不通不影响能不能播，让客户端拿地址自己试更划算。
 *
 * 判据用 LX_NATIVE（由 native.js 置位），而不是复用 allowHttpAudio ——
 * 那是「能不能播 http」，这是「能不能慢慢等」，两件事不该共用一个开关。
 */
export function resolveBudget() {
  return globalThis.LX_NATIVE === true
    ? { deadline: 3500, probeDeadline: 1500, totalBudget: 3800 }
    : {}
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {object} [opts.headers]
 * @param {string|object} [opts.body]
 * @param {object} [opts.form]  以 x-www-form-urlencoded 发送
 * @param {number} [opts.timeout] 毫秒
 * @param {number} [opts.retry]  失败重试次数
 * @param {boolean} [opts.raw] 为 true 时返回 Response 本体（用于流式/批量下载）
 * @returns {Promise<{status:number, headers:object, text:string, json:any, url:string}>}
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, form, timeout = 15000, retry = 1, raw = false, redirect = 'follow',
  } = opts

  let lastErr
  for (let attempt = 0; attempt <= retry; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const finalHeaders = { 'User-Agent': UA_PC, ...headers }
      let payload
      if (form) {
        payload = new URLSearchParams(form).toString()
        if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
      } else if (body !== undefined && body !== null) {
        payload = typeof body === 'string' ? body : JSON.stringify(body)
        if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['Content-Type'] = 'application/json'
      }
      const res = await outboundFetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal, redirect })
      if (raw) return res
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 平台常返回非严格 JSON，交给调用方 parseLooseJson */ }
      return { status: res.status, headers: Object.fromEntries(res.headers), text, json, url: res.url }
    } catch (e) {
      lastErr = e
      if (attempt < retry) await sleep(200 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new HttpError(`请求失败: ${url} :: ${lastErr && lastErr.message}`, 0, null)
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers).some(k => k.toLowerCase() === lower)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 按「内容是否合格」重试的取数器。
 *
 * 有些上游失败得很「礼貌」：HTTP 200、JSON 合法，但内容是空的 ——
 * 酷我歌词接口就有一半概率返回 `{"data":null,"msg":"音乐查询失败"}`。
 * `request()` 的 retry 只在**抛异常**时重试，抓不住这种「成功但空手」，
 * 于是调用方必须自己按内容重试。抽成通用件，免得每个 provider 各写一遍。
 *
 * @template T
 * @param {() => Promise<T>} fn        取一次（抛异常视为一次失败，不外抛）
 * @param {(v: T) => boolean} accept   判定「这次算拿到了」
 * @param {{attempts?: number, wait?: (ms: number) => Promise<any>}} [opts]
 * @returns {Promise<T|null>}  始终不合格时返回 null
 */
export async function retryUntil(fn, accept, { attempts = 4, wait = sleep } = {}) {
  const times = Math.max(1, Number(attempts) || 1)
  for (let i = 0; i < times; i++) {
    let value = null
    try { value = await fn() } catch { value = null }
    if (accept(value)) return value
    if (i < times - 1) await wait(150 + i * 120)     // 150 / 270 / 390…
  }
  return null
}

/** JSONP 解析：把 `cb({...})` 抠成对象 */
export function parseJsonp(text) {
  const m = String(text).match(/^[^(]*\((.*)\)[;\s]*$/s)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/** 直接把 Response 转成可透传给客户端的响应（保留状态码与关键头） */
export function passthrough(response, extraHeaders = {}) {
  const headers = new Headers(extraHeaders)
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
    const v = response.headers.get(k)
    if (v) headers.set(k, v)
  }
  return new Response(response.body, { status: response.status, headers })
}
