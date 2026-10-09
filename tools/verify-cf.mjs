#!/usr/bin/env node
// 校验 CF 线上静态资源与本地 public/ 是否逐文件一致（sha256）。
// 口径：**只有 hash 相等才算过**，不看字节数（sw.js 曾出现改版后字节数恰好相同）。
// 每个请求都带 cache-buster，且 fetch 用 no-store —— 否则会被边缘缓存骗过。
//
// 用法：
//   node tools/verify-cf.mjs [baseUrl]
//   默认 baseUrl = https://<你的站点域名>
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUB = join(ROOT, 'public')
const BASE = (process.argv[2] || 'https://music.zyplnn.dpdns.org').replace(/\/+$/, '')

// _headers 是 CF 的响应头配置，不作为静态资源对外提供 → 跳过
const SKIP = new Set(['_headers'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchWithRetry(url, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow' })
      const buf = Buffer.from(await res.arrayBuffer())
      return { status: res.status, buf }
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw last
}

const files = walk(PUB)
  .map((p) => relative(PUB, p).split(sep).join('/'))
  .filter((p) => !SKIP.has(p))
  .sort()

console.log(`base = ${BASE}`)
console.log(`files = ${files.length}\n`)

let ok = 0
const bad = []
for (const rel of files) {
  const local = readFileSync(join(PUB, rel))
  const urlPath = rel === 'index.html'
    ? '/'
    : '/' + rel.split('/').map(encodeURIComponent).join('/')
  const url = `${BASE}${urlPath}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  let r
  try {
    r = await fetchWithRetry(url)
  } catch (e) {
    bad.push([rel, 'fetch failed'])
    console.log(`[ERR] ${rel}  ${e.message}`)
    continue
  }

  const lh = sha(local)
  const rh = sha(r.buf)
  if (r.status === 200 && lh === rh) {
    ok++
    console.log(`[OK ] ${rel}  ${lh.slice(0, 12)}`)
  } else {
    bad.push([rel, `http=${r.status}`])
    console.log(`[BAD] ${rel}  http=${r.status} local=${lh.slice(0, 12)}(${local.length}B) remote=${rh.slice(0, 12)}(${r.buf.length}B)`)
  }
}

console.log(`\n== ${ok}/${files.length} 一致 ==`)
if (bad.length) {
  console.log('不一致：')
  for (const [f, d] of bad) console.log(`  - ${f}  ${d}`)
  process.exit(1)
}
