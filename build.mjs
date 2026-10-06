/**
 * 构建脚本：从 GitHub 抓取落雪（LX Music）插件并内联进 Worker
 *
 * 为什么要内联：
 *   Cloudflare Workers 只在「启动阶段」允许 new Function/eval，
 *   请求处理阶段一律禁止动态求值 —— 所以插件必须在构建期固化进 Worker 包，
 *   部署后在模块顶层求值注册（见 src/plugins.js）。
 *
 * 本机无法直连 raw.githubusercontent.com / jsdelivr（DNS 污染），
 * 因此抓取走「已部署的 Worker 代理」，并有本地 plugins/ 缓存兜底。
 *
 * 用法：
 *   node build.mjs              正常构建（优先用缓存）
 *   node build.mjs --refresh    强制重新抓取
 *   PROXY_BASE=... node build.mjs  覆盖抓取代理地址
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, 'plugins')
const OUT_FILE = path.join(__dirname, 'src', 'generated', 'plugins.js')
const PROBE_HOST = process.env.PROBE_HOST || 'lxprobe.zyplnn.dpdns.org'
const PROXY_BASE = process.env.PROXY_BASE || `https://${PROBE_HOST}/proxy?url=`

const FALLBACK_IPS = [
  '104.21.10.218', '172.67.146.203', '104.21.10.219',
  '172.67.146.204', '104.21.10.141', '172.67.146.111',
]

/**
 * 插件清单。label 用于日志；source 决定来源仓库。
 * 以「多源冗余」为原则：同一平台会有多个插件，运行时按顺序尝试，先成功的胜出。
 */
const PLUGIN_MANIFEST = [
  // —— pdone/lx-music-source（持续维护，latest.js 指向最新版）——
  { id: 'pdone-sixyin', label: 'SixYin', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js' },
  { id: 'pdone-huibq', label: 'Huibq', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js' },
  { id: 'pdone-flower', label: 'Flower', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js' },
  { id: 'pdone-lx', label: 'LX', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js' },
  { id: 'pdone-ikun', label: 'IKun', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js' },
  { id: 'pdone-grass', label: 'Grass', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js' },
  { id: 'pdone-juhe', label: 'JuheApi', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/juhe/latest.js' },
  { id: 'pdone-changqing', label: 'ChangQing', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js' },
  { id: 'pdone-huanyin', label: 'HuanYin', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huanyin/latest.js' },
  { id: 'pdone-qdy', label: 'QDY', url: 'https://raw.githubusercontent.com/pdone/lx-music-source/main/qdy/latest.js' },
  // —— liuyunss/LX-source（落雪播放源集合）——
  // 注意：该仓库的 sixyin 与 pdone/sixyin 为同一份代码（各 ~333KB），只保留一份以控制产物体积
  { id: 'liuyun-lxmusic', label: 'LX Music 源', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/lx-music.js' },
  { id: 'liuyun-nya', label: 'Nya 源', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/nya.js' },
  { id: 'liuyun-yc', label: 'YC 源', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/yc.js' },
  { id: 'liuyun-jh', label: 'JH 源', url: 'https://raw.githubusercontent.com/liuyunss/LX-source/master/jh.js' },

  // —— 社区第三方源（2026-10 实测逐个求值通过，覆盖 kg/kw/tx/wy/mg）——
  //
  // 为什么值得加这么多：咪咕（mg）原生接口拿不到试听地址（见 src/providers/mg.js），
  // 只能靠插件取流；酷狗/QQ 在有版权限制的曲目上也只认插件。多一个独立实现就多一条路。
  //
  // 选源标准：① 实际求值能发出 inited 且声明 sources；② 内容与既有插件不重复（按 sha256 去重）；
  // ③ 体积可控。像「聚合音源 特供版」与「全豆要 v9.3」字节完全相同、「K×H」「杰翔」属于
  // 同一份代码的镜像，都只留一份。
  //
  // 注意这些仓库多为个人镜像，文件名带版本号，改名即抓不到 —— 此时 build.mjs 会退回本地
  // plugins/ 缓存，所以缓存目录必须一并提交，不要在构建脚本里清理它。
  { id: 'cloud-hyw', label: 'HYWmusic 公益测试', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/hywmusic-beta-gongyitest.js' },
  { id: 'cloud-fuguang', label: '浮光音乐', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/fuguang-music-helloworldsource-e093f5.js' },
  { id: 'cloud-kh', label: 'K×H 测试', url: 'https://raw.githubusercontent.com/moxi5445/lx-music-cloud/main/members/k-htest.js' },
  { id: 'fengs-merged', label: '聚合音源·净化版', url: 'https://raw.githubusercontent.com/fengs2021/lx-music-merged-source/main/merged-source.js' },
  { id: 'jiexiang', label: '杰翔聚合音源', url: 'https://raw.githubusercontent.com/haonanren118/jiexiang-Music-Source/main/杰翔音乐源.js' },
  { id: 'wsl-zicheng', label: '梓橙公益音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/梓橙公益音源2代.js' },
  { id: 'wsl-lxfree', label: 'LXMusic 免费源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/lx-music-source-free.js' },
  { id: 'wsl-freemusic', label: 'Free Music', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/free-music.js' },
  { id: 'wsl-quandou', label: '全豆要聚合音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/全豆要[聚合音源]v9.3.js' },
  { id: 'wsl-xinghai', label: '星海音乐源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/星海音乐源v2.3.14.js' },
  { id: 'wsl-molan', label: '墨澜聚合音源', url: 'https://raw.githubusercontent.com/wangshiyulin/LXmusic-source/main/墨澜聚合音源v2.2.0.js' },
]

/* ---------------- 网络：本机 DNS 被污染，需指定边缘 IP + SNI ---------------- */

async function resolveEdgeIps(host) {
  try {
    const body = await httpGetJson(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
      headers: { Accept: 'application/dns-json' },
    })
    const ips = (body.Answer || []).filter(a => a.type === 1).map(a => a.data)
    if (ips.length) return ips
  } catch { /* 回退到固定列表 */ }
  return FALLBACK_IPS
}

function httpGetJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: opts.headers || {}, timeout: 15000 }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

function getViaEdge(host, ip, urlPath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      servername: host,
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: { Host: host, 'User-Agent': 'lxmusic-build/1.0', Accept: '*/*' },
      timeout,
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data, upstream: res.headers['x-upstream-status'] }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

/** 通过已部署的 Worker 代理抓取远端脚本（带多次重试与多 IP 轮换） */
async function fetchRemote(targetUrl, ips) {
  const proxyUrl = PROXY_BASE + encodeURIComponent(targetUrl)
  const u = new URL(proxyUrl)
  const reqPath = u.pathname + u.search
  const attempts = []
  for (let round = 0; round < 3; round++) {
    for (const ip of ips) {
      try {
        const res = await getViaEdge(PROBE_HOST, ip, reqPath)
        if (res.status === 200 && res.body && res.body.length > 50) return res.body
        attempts.push(`${ip}->${res.status}`)
      } catch (e) {
        attempts.push(`${ip}->${e.message}`)
      }
    }
  }
  throw new Error(`抓取失败 (${attempts.slice(0, 6).join(', ')})`)
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const refresh = process.argv.includes('--refresh')
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  const ips = await resolveEdgeIps(PROBE_HOST)
  console.log(`[build] 边缘节点 IP: ${ips.join(', ')}`)

  const results = []
  for (const item of PLUGIN_MANIFEST) {
    const cacheFile = path.join(CACHE_DIR, `${item.id}.js`)
    let script = null

    if (!refresh && fs.existsSync(cacheFile)) {
      script = fs.readFileSync(cacheFile, 'utf8')
      if (script.length < 50) script = null
    }
    if (!script) {
      for (let i = 0; i < 2 && !script; i++) {
        try {
          script = await fetchRemote(item.url, ips)
          fs.writeFileSync(cacheFile, script, 'utf8')
          console.log(`[build] 抓取成功 ${item.label} (${script.length} 字节)`)
        } catch (e) {
          if (i === 1) console.warn(`[build] 跳过 ${item.label}: ${e.message}`)
        }
      }
    } else {
      console.log(`[build] 使用缓存 ${item.label} (${script.length} 字节)`)
    }

    if (script) {
      results.push({ id: item.id, label: item.label, url: item.url, script, size: script.length })
    }
  }

  if (!results.length) {
    console.warn('[build] 未获取到任何插件，将生成空插件列表（服务端取流会走原生兜底）')
  }

  const totalBytes = results.reduce((a, r) => a + r.size, 0)

  /**
   * 源摘要：插件 id + 每份脚本的 sha256 再整体摘要。
   * 刻意**不写生成时间** —— 时间戳会让每次构建的产物哈希都变，
   * 就没法用哈希核对「线上跑的是不是当前源码」（APK 侧也踩过同一个坑）。
   * 要判断产物是不是新的，比这个摘要，别比时间。
   */
  const srcDigest = crypto.createHash('sha256')
    .update(results.map(r => `${r.id}:${crypto.createHash('sha256').update(r.script).digest('hex')}`).join('\n'))
    .digest('hex').slice(0, 16)

  const banner = `// 由 build.mjs 自动生成，请勿手动修改。
// 插件数量: ${results.length}，源码总大小: ${(totalBytes / 1024).toFixed(1)} KB
// 源摘要: ${srcDigest}
`
  const body = results.map(r => {
    return `  {\n    id: ${JSON.stringify(r.id)},\n    name: ${JSON.stringify(r.label)},\n    url: ${JSON.stringify(r.url)},\n    script: ${JSON.stringify(r.script)},\n  },`
  }).join('\n')

  const content = `${banner}export const BUNDLED_PLUGINS = [\n${body}\n]\n`
  fs.writeFileSync(OUT_FILE, content, 'utf8')

  console.log(`[build] 已写入 ${path.relative(__dirname, OUT_FILE)}`)
  console.log(`[build] 插件 ${results.length} 个，源码共 ${(totalBytes / 1024).toFixed(1)} KB，产物 ${(content.length / 1024).toFixed(1)} KB`)
  console.log(`[build] 清单: ${results.map(r => r.label).join(' / ')}`)
}

main().catch(err => {
  console.error('[build] 失败:', err)
  process.exit(1)
})
