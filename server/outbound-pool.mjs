/**
 * Node 宿主（Docker / 自托管）的出站连接复用 —— **只由 server/index.mjs 引入**。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────
 * `src/lib/http.js` 是三个宿主（Cloudflare Worker / 浏览器 / Node）共用的，
 * 里面**不能**出现 `import('undici')` 这种 Node 专属语句 —— Worker 打包时会炸。
 * 所以「给 Node 装连接池」这件事只能从 Node 自己的入口去做，这个文件就是那个动作。
 *
 * ── 为什么需要 ─────────────────────────────────────────────────────
 * Node 的全局 `fetch`（undici）默认在请求结束后**不复用连接**：每个 TCP 连接只用一次。
 * 而本项目的取流链路一次点歌会并发发十几个出站请求（多插件 × 多候选的探测），
 * 音乐源站基本都在同一个域上 —— 每次都要 DNS + TCP + TLS 三件套，开销全摊在首跳上。
 *
 * 换成带连接池的 Agent 之后，同一 host 的后续请求直接复用已有连接，
 * 省掉握手往返。这是「Docker 版更快速」里改动最小、收益最直接的一刀。
 *
 * ── 为什么不写进 package.json 依赖 ───────────────────────────────────
 * Node ≥ 18 内置了 undici（全局 fetch 就是它），但**它不暴露给用户代码的 import**：
 * 实测 node:22 上 `import('undici')` / `node:undici` / `node:internal/deps/undici/undici`
 * 三条路在干净容器里全部失败。开发机上能 import 成功，是因为 wrangler 把它装在
 * node_modules 里了 —— 那是个假象，进容器就没了。
 * 所以 Dockerfile 里显式 `npm install undici`（零依赖、纯 JS、约 2.1MB）把它坐实。
 * 这里仍然全部包在 try/catch 里：拿不到就退回原生 fetch，功能不受影响，只是没提速。
 * detail 里会写清楚原因，`/healthz` 的 outbound 字段一眼可查 —— 别让它静默失效。
 *
 * ── 为什么不设并发上限 ───────────────────────────────────────────────
 * 取流链路本来就自己控并发（resolveMusicUrlFast 的候选数、tryCandidates 的串行拉取），
 * 这里再卡一道反而会把「本来能并发的探测」排成队列，得不偿失。
 */

let state = { ok: false, detail: '未探测' }

/**
 * 给全局 fetch 装上 keep-alive 连接池。**幂等**，重复调用只探测一次。
 *
 * 只在 Node 里生效，其余宿主会自然跳过：
 *  · Cloudflare Worker —— 不 import 这个文件；workerd 里 fetch 实现不同，装了也无处生效；
 *  · 安卓壳 —— 出站走 `globalThis.__lxFetch` 原生桥，压根不经这里的 fetch；
 *  · 浏览器 —— 没有 undici，import 失败，静默跳过（浏览器自己就有连接池）。
 *
 * @returns {Promise<{ok: boolean, detail: string}>} 供启动日志与 /healthz 展示
 */
export function installOutboundPool() {
  return Promise.resolve().then(async () => {
    // 安卓壳 / 浏览器：出站不走这里的 fetch，装了也没用
    if (typeof globalThis.__lxFetch === 'function') {
      state = { ok: false, detail: '已跳过（该宿主出站走原生桥）' }
      return state
    }

    /**
     * 两条路都试，按「先正规、后兜底」排：
     *   1. `undici` —— 正常解析到 node_modules（镜像里由 Dockerfile 拷进去）；
     *   2. 仓库内 vendored 副本 —— 万一有人的部署方式让 node_modules 解析不到
     *      （比如把源码放到别处、或用了只读文件系统），这条路仍然可用。
     * 用绝对 file:// URL 而不是相对路径：相对路径是相对**本模块**解析的，
     * 虽然结果一样，但写绝对路径能避免「打包后位置变了」这类意外。
     */
    const candidates = [
      'undici',
      new URL('../vendor/undici/index.js', import.meta.url).href,
    ]

    let undici = null
    let lastErr = ''
    for (const spec of candidates) {
      try {
        undici = await import(spec)
        if (undici && typeof undici.Agent === 'function') {
          state = { ok: true, detail: '' }   // 占位，下面赋真正文案
          break
        }
        undici = null
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 70)
      }
    }

    if (!undici) {
      // 最容易在容器里踩到。写清楚是「包没找到」而不是「Node 不支持」，
      // 否则看到的人会去怀疑 Node 版本，白绕一圈。
      state = {
        ok: false,
        detail: '已跳过（找不到 undici 包，退回原生 fetch）：' + lastErr,
      }
      return state
    }

    if (typeof undici.setGlobalDispatcher !== 'function') {
      state = { ok: false, detail: '已跳过（当前 undici 未暴露 setGlobalDispatcher）' }
      return state
    }

    /**
     * keepAliveTimeout 给 30 秒：音乐源站的出站请求是「一阵一阵」的 ——
     * 用户点歌时集中爆发，然后静默几十秒。默认 4 秒的 keep-alive 会在下一首
     * 点歌前刚好把连接放走，等于白装；30 秒能覆盖「连着听几首」的间隔。
     * 它只是**本地**保持空闲连接，不产生任何心跳流量。
     */
    undici.setGlobalDispatcher(new undici.Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    }))

    state = { ok: true, detail: '已启用 keep-alive 连接池（空闲保持 30s）' }
    return state
  }).catch((e) => {
    state = { ok: false, detail: '已跳过（' + String((e && e.message) || e).slice(0, 60) + '）' }
    return state
  })
}

/** 给 /healthz 与启动日志用的一句话描述（未探测时返回占位文案） */
export function poolDetail() {
  return state.detail
}
