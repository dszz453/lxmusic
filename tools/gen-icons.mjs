/**
 * 零依赖生成 PWA 图标（PNG）
 * 用纯 JS 光栅化 + zlib 手写 PNG，避免引入 sharp/canvas 等原生依赖。
 * 图形：品牌红圆角方块 + 白色双八分音符（对齐网易云 App 图标观感）
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- 几何 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a, b, t) => a + (b - a) * t

/** 圆角矩形内外判定（传入归一化坐标 -1..1，半径已按半宽折算） */
function inRoundedRect(x, y, half, radius) {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  if (ax > half || ay > half) return false
  const dx = ax - (half - radius)
  const dy = ay - (half - radius)
  if (dx <= 0 || dy <= 0) return true
  return dx * dx + dy * dy <= radius * radius
}

/** 旋转椭圆内外判定 */
function inEllipse(x, y, cx, cy, rx, ry, rot) {
  const c = Math.cos(-rot)
  const s = Math.sin(-rot)
  const px = (x - cx) * c - (y - cy) * s
  const py = (x - cx) * s + (y - cy) * c
  return (px * px) / (rx * rx) + (py * py) / (ry * ry) <= 1
}

/** 凸多边形内外判定（射线法，足够用于梯形横梁） */
function inPoly(x, y, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 音符路径在归一化坐标系（-1..1）内的判定 */
function inNote(x, y) {
  // 两个符头
  if (inEllipse(x, y, -0.30, 0.44, 0.245, 0.190, -0.34)) return true
  if (inEllipse(x, y, 0.34, 0.32, 0.245, 0.190, -0.34)) return true
  // 两根符干
  if (x >= -0.10 && x <= 0.06 && y >= -0.56 && y <= 0.46) return true
  if (x >= 0.54 && x <= 0.70 && y >= -0.68 && y <= 0.34) return true
  // 顶部横梁
  if (inPoly(x, y, [
    [-0.10, -0.56],
    [0.70, -0.68],
    [0.70, -0.40],
    [-0.10, -0.28],
  ])) return true
  return false
}

/* ---------------- 光栅化 ---------------- */

/**
 * @param size 输出边长
 * @param opts.bleed  true = 满幅（maskable，内容缩到安全区）；false = 圆角方块
 * @param opts.scale  音符缩放系数
 */
function render(size, opts = {}) {
  const SS = 3 // 3× 超采样抗锯齿
  const S = size * SS
  const acc = new Float32Array(size * size * 4)
  const bg = opts.bleed ? [0xec, 0x41, 0x41] : null

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const nx = (px + 0.5) / S * 2 - 1
      const ny = (py + 0.5) / S * 2 - 1
      let r = 0, g = 0, b = 0, a = 0

      const inPlate = opts.bleed
        ? true
        : inRoundedRect(nx, ny, 1, 0.46) // 圆角方块（半径 23%）
      if (inPlate) {
        if (bg) {
          r = bg[0]; g = bg[1]; b = bg[2]; a = 255
        } else {
          // 左上→右下的品牌红渐变
          const t = clamp01((nx + ny + 1.4) / 2.8)
          r = mix(0xff, 0xd0, t)
          g = mix(0x74, 0x33, t)
          b = mix(0x6b, 0x33, t)
          a = 255
        }
        const k = opts.scale || 0.62
        if (inNote(nx / k, ny / k)) { r = 255; g = 255; b = 255 }
      }

      const ox = Math.floor(px / SS)
      const oy = Math.floor(py / SS)
      const o = (oy * size + ox) * 4
      acc[o] += r
      acc[o + 1] += g
      acc[o + 2] += b
      acc[o + 3] += a
    }
  }

  const out = Buffer.alloc(size * size * 4)
  const n = SS * SS
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / n)
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n)
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n)
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n)
  }
  return encodePng(size, size, out)
}

/* ---------------- 输出 ---------------- */

const outDir = path.resolve('public/icons')
fs.mkdirSync(outDir, { recursive: true })

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { bleed: true, scale: 0.46 }],
  ['apple-touch-icon.png', 180, { bleed: true, scale: 0.56 }],
  ['favicon-32.png', 32, {}],
]

for (const [name, size, opts] of jobs) {
  const buf = render(size, opts)
  fs.writeFileSync(path.join(outDir, name), buf)
  console.log('生成', name, size + 'x' + size, buf.length + 'B')
}
console.log('图标输出目录：' + outDir)
