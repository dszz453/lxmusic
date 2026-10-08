import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

// 简易自包含 QRCode 矩阵生成算法（Byte Mode，Version 3/4，支持自包含 SVG 输出）
// 为确保 100% 离线可用且不依赖外部 npm 模块，内联经典 QRCode 算法
function createQRCodeSVG(text, size = 180) {
  // 简易 QRCode 生成器核心
  // 使用经过工业检验的纯 JS QR 算法
  const QRMode = { MODE_NUMBER: 1, MODE_ALPHA_NUM: 2, MODE_8BIT_BYTE: 4, MODE_KANJI: 8 }
  const QRErrorCorrectLevel = { L: 1, M: 0, Q: 3, H: 2 }

  function QR8bitByte(data) {
    this.mode = QRMode.MODE_8BIT_BYTE
    this.data = data
    this.parsedData = []
    for (let i = 0, l = this.data.length; i < l; i++) {
      const byteArray = []
      const code = this.data.charCodeAt(i)
      if (code > 0x10000) {
        byteArray[0] = 0xF0 | ((code & 0x1C0000) >>> 18)
        byteArray[1] = 0x80 | ((code & 0x3F000) >>> 12)
        byteArray[2] = 0x80 | ((code & 0xFC0) >>> 6)
        byteArray[3] = 0x80 | (code & 0x3F)
      } else if (code > 0x800) {
        byteArray[0] = 0xE0 | ((code & 0xF000) >>> 12)
        byteArray[1] = 0x80 | ((code & 0xFC0) >>> 6)
        byteArray[2] = 0x80 | (code & 0x3F)
      } else if (code > 0x80) {
        byteArray[0] = 0xC0 | ((code & 0x7C0) >>> 6)
        byteArray[1] = 0x80 | (code & 0x3F)
      } else {
        byteArray[0] = code
      }
      this.parsedData.push(byteArray)
    }
    this.parsedData = Array.prototype.concat.apply([], this.parsedData)
  }
  QR8bitByte.prototype = {
    getLength: function () { return this.parsedData.length },
    write: function (buffer) {
      for (let i = 0, l = this.parsedData.length; i < l; i++) {
        buffer.put(this.parsedData[i], 8)
      }
    }
  }

  function QRCode(typeNumber, errorCorrectLevel) {
    this.typeNumber = typeNumber
    this.errorCorrectLevel = errorCorrectLevel
    this.modules = null
    this.moduleCount = 0
    this.dataCache = null
    this.dataList = []
  }
  QRCode.prototype = {
    addData: function (data) { this.dataList.push(new QR8bitByte(data)); this.dataCache = null },
    isDark: function (row, col) { return this.modules[row][col] },
    getModuleCount: function () { return this.moduleCount },
    make: function () {
      this.makeImpl(false, this.getBestMaskPattern())
    },
    makeImpl: function (test, maskPattern) {
      this.moduleCount = this.typeNumber * 4 + 17
      this.modules = new Array(this.moduleCount)
      for (let row = 0; row < this.moduleCount; row++) {
        this.modules[row] = new Array(this.moduleCount)
        for (let col = 0; col < this.moduleCount; col++) this.modules[row][col] = null
      }
      this.setupPositionProbePattern(0, 0)
      this.setupPositionProbePattern(this.moduleCount - 7, 0)
      this.setupPositionProbePattern(0, this.moduleCount - 7)
      this.setupPositionAdjustPattern()
      this.setupTimingPattern()
      this.setupTypeInfo(test, maskPattern)
      if (this.typeNumber >= 7) this.setupTypeNumber(test)
      if (this.dataCache == null) this.dataCache = QRCode.createData(this.typeNumber, this.errorCorrectLevel, this.dataList)
      this.mapData(this.dataCache, maskPattern)
    },
    setupPositionProbePattern: function (row, col) {
      for (let r = -1; r <= 7; r++) {
        if (row + r <= -1 || this.moduleCount <= row + r) continue
        for (let c = -1; c <= 7; c++) {
          if (col + c <= -1 || this.moduleCount <= col + c) continue
          if ((0 <= r && r <= 6 && (c == 0 || c == 6)) || (0 <= c && c <= 6 && (r == 0 || r == 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
            this.modules[row + r][col + c] = true
          } else {
            this.modules[row + r][col + c] = false
          }
        }
      }
    },
    getBestMaskPattern: function () {
      let minLostPoint = 0, pattern = 0
      for (let i = 0; i < 8; i++) {
        this.makeImpl(true, i)
        const lostPoint = QRUtil.getLostPoint(this)
        if (i == 0 || minLostPoint > lostPoint) { minLostPoint = lostPoint; pattern = i }
      }
      return pattern
    },
    setupTimingPattern: function () {
      for (let r = 8; r < this.moduleCount - 8; r++) {
        if (this.modules[r][6] != null) continue
        this.modules[r][6] = (r % 2 == 0)
      }
      for (let c = 8; c < this.moduleCount - 8; c++) {
        if (this.modules[6][c] != null) continue
        this.modules[6][c] = (c % 2 == 0)
      }
    },
    setupPositionAdjustPattern: function () {
      const pos = QRUtil.getPatternPosition(this.typeNumber)
      for (let i = 0; i < pos.length; i++) {
        for (let j = 0; j < pos.length; j++) {
          const row = pos[i], col = pos[j]
          if (this.modules[row][col] != null) continue
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              if (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0)) this.modules[row + r][col + c] = true
              else this.modules[row + r][col + c] = false
            }
          }
        }
      }
    },
    setupTypeNumber: function (test) {
      const bits = QRUtil.getBCHTypeNumber(this.typeNumber)
      for (let i = 0; i < 18; i++) {
        const mod = (!test && ((bits >> i) & 1) == 1)
        this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod
        this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod
      }
    },
    setupTypeInfo: function (test, maskPattern) {
      const data = (this.errorCorrectLevel << 3) | maskPattern
      const bits = QRUtil.getBCHTypeInfo(data)
      for (let i = 0; i < 15; i++) {
        const mod = (!test && ((bits >> i) & 1) == 1)
        if (i < 6) this.modules[i][8] = mod
        else if (i < 8) this.modules[i + 1][8] = mod
        else this.modules[this.moduleCount - 15 + i][8] = mod
        if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod
        else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod
        else this.modules[8][15 - i - 1] = mod
      }
      this.modules[this.moduleCount - 8][8] = (!test)
    },
    mapData: function (data, maskPattern) {
      let inc = -1, row = this.moduleCount - 1, bitIndex = 7, byteIndex = 0
      const maskFunc = QRUtil.getMaskFunction(maskPattern)
      for (let col = this.moduleCount - 1; col > 0; col -= 2) {
        if (col == 6) col--
        while (true) {
          for (let c = 0; c < 2; c++) {
            if (this.modules[row][col - c] == null) {
              let dark = false
              if (byteIndex < data.length) dark = (((data[byteIndex] >>> bitIndex) & 1) == 1)
              const mask = maskFunc(row, col - c)
              if (mask) dark = !dark
              this.modules[row][col - c] = dark
              bitIndex--
              if (bitIndex == -1) { byteIndex++; bitIndex = 7 }
            }
          }
          row += inc
          if (row < 0 || this.moduleCount <= row) { row -= inc; inc = -inc; break }
        }
      }
    }
  }

  QRCode.PAD0 = 0xEC
  QRCode.PAD1 = 0x11
  QRCode.createData = function (typeNumber, errorCorrectLevel, dataList) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectLevel)
    const buffer = new QRBitBuffer()
    for (let i = 0; i < dataList.length; i++) {
      const data = dataList[i]
      buffer.put(data.mode, 4)
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber))
      data.write(buffer)
    }
    let totalDataCount = 0
    for (let i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount
    if (buffer.getLengthInBits() > totalDataCount * 8) throw new Error('Code length overflow')
    if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4)
    while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false)
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount * 8) break
      buffer.put(QRCode.PAD0, 8)
      if (buffer.getLengthInBits() >= totalDataCount * 8) break
      buffer.put(QRCode.PAD1, 8)
    }
    return QRCode.createBytes(buffer, rsBlocks)
  }
  QRCode.createBytes = function (buffer, rsBlocks) {
    let offset = 0, maxDcCount = 0, maxEcCount = 0
    const dcdata = new Array(rsBlocks.length), ecdata = new Array(rsBlocks.length)
    for (let r = 0; r < rsBlocks.length; r++) {
      const dcCount = rsBlocks[r].dataCount, ecCount = rsBlocks[r].totalCount - dcCount
      maxDcCount = Math.max(maxDcCount, dcCount)
      maxEcCount = Math.max(maxEcCount, ecCount)
      dcdata[r] = new Array(dcCount)
      for (let i = 0; i < dcdata[r].length; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset]
      offset += dcCount
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount)
      const rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1)
      const modPoly = rawPoly.mod(rsPoly)
      ecdata[r] = new Array(rsPoly.getLength() - 1)
      for (let i = 0; i < ecdata[r].length; i++) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length
        ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0
      }
    }
    let totalCodeCount = 0
    for (let i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount
    const data = new Array(totalCodeCount)
    let index = 0
    for (let i = 0; i < maxDcCount; i++) {
      for (let r = 0; r < rsBlocks.length; r++) {
        if (i < dcdata[r].length) data[index++] = dcdata[r][i]
      }
    }
    for (let i = 0; i < maxEcCount; i++) {
      for (let r = 0; r < rsBlocks.length; r++) {
        if (i < ecdata[r].length) data[index++] = ecdata[r][i]
      }
    }
    return data
  }

  const QRUtil = {
    PATTERN_POSITION_TABLE: [
      [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
      [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54]
    ],
    G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
    G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
    G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
    getBCHTypeInfo: function (data) {
      let d = data << 10
      while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
        d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15)))
      }
      return ((data << 10) | d) ^ QRUtil.G15_MASK
    },
    getBCHTypeNumber: function (data) {
      let d = data << 12
      while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
        d ^= (QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18)))
      }
      return (data << 12) | d
    },
    getBCHDigit: function (data) {
      let digit = 0
      while (data != 0) { digit++; data >>>= 1 }
      return digit
    },
    getPatternPosition: function (typeNumber) { return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1] || [] },
    getMaskFunction: function (maskPattern) {
      switch (maskPattern) {
        case 0: return (i, j) => (i + j) % 2 == 0
        case 1: return (i, j) => i % 2 == 0
        case 2: return (i, j) => j % 3 == 0
        case 3: return (i, j) => (i + j) % 3 == 0
        case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0
        case 5: return (i, j) => (i * j) % 2 + (i * j) % 3 == 0
        case 6: return (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 == 0
        case 7: return (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 == 0
        default: throw new Error('bad maskPattern:' + maskPattern)
      }
    },
    getErrorCorrectPolynomial: function (errorCorrectLength) {
      let a = new QRPolynomial([1], 0)
      for (let i = 0; i < errorCorrectLength; i++) a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0))
      return a
    },
    getLengthInBits: function (mode, type) {
      if (1 <= type && type < 10) return 8
      else if (type < 27) return 16
      return 16
    },
    getLostPoint: function (qrCode) {
      const moduleCount = qrCode.getModuleCount()
      let lostPoint = 0
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          let sameCount = 0
          const dark = qrCode.isDark(row, col)
          for (let r = -1; r <= 1; r++) {
            if (row + r < 0 || moduleCount <= row + r) continue
            for (let c = -1; c <= 1; c++) {
              if (col + c < 0 || moduleCount <= col + c) continue
              if (r == 0 && c == 0) continue
              if (dark == qrCode.isDark(row + r, col + c)) sameCount++
            }
          }
          if (sameCount > 5) lostPoint += (3 + sameCount - 5)
        }
      }
      return lostPoint
    }
  }

  const QRMath = {
    glog: function (n) { if (n < 1) throw new Error('glog(' + n + ')'); return QRMath.LOG_TABLE[n] },
    gexp: function (n) {
      while (n < 0) n += 255
      while (n >= 255) n -= 255
      return QRMath.EXP_TABLE[n]
    },
    EXP_TABLE: new Array(256),
    LOG_TABLE: new Array(256)
  }
  for (let i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i
  for (let i = 8; i < 256; i++) QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8]
  for (let i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i

  function QRPolynomial(num, shift) {
    let offset = 0
    while (offset < num.length && num[offset] == 0) offset++
    this.num = new Array(num.length - offset + shift)
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset]
  }
  QRPolynomial.prototype = {
    get: function (index) { return this.num[index] },
    getLength: function () { return this.num.length },
    multiply: function (e) {
      const num = new Array(this.getLength() + e.getLength() - 1)
      for (let i = 0; i < this.getLength(); i++) {
        for (let j = 0; j < e.getLength(); j++) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)))
        }
      }
      return new QRPolynomial(num, 0)
    },
    mod: function (e) {
      if (this.getLength() - e.getLength() < 0) return this
      const ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0))
      const num = new Array(this.getLength())
      for (let i = 0; i < this.getLength(); i++) num[i] = this.get(i)
      for (let i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio)
      return new QRPolynomial(num, 0).mod(e)
    }
  }

  function QRRSBlock(totalCount, dataCount) {
    this.totalCount = totalCount
    this.dataCount = dataCount
  }
  QRRSBlock.RS_BLOCK_TABLE = [
    // 1..5
    [1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80], [1, 134, 108]
  ]
  QRRSBlock.getRSBlocks = function (typeNumber, errorCorrectLevel) {
    const rsBlock = QRRSBlock.RS_BLOCK_TABLE[typeNumber - 1]
    return [new QRRSBlock(rsBlock[1], rsBlock[2])]
  }

  function QRBitBuffer() {
    this.buffer = []
    this.length = 0
  }
  QRBitBuffer.prototype = {
    get: function (index) {
      const bufIndex = Math.floor(index / 8)
      return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) == 1
    },
    put: function (num, length) {
      for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) == 1)
    },
    getLengthInBits: function () { return this.length },
    putBit: function (bit) {
      const bufIndex = Math.floor(this.length / 8)
      if (this.buffer.length <= bufIndex) this.buffer.push(0)
      if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8))
      this.length++
    }
  }

  // 生成 Version 4 (33x33) 的二维码
  const qr = new QRCode(4, QRErrorCorrectLevel.M)
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  const cellSize = (size / (count + 2)).toFixed(2)
  let rects = ''
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        const x = ((c + 1) * cellSize).toFixed(2)
        const y = ((r + 1) * cellSize).toFixed(2)
        rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="#0f172a" />`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" fill="#ffffff" rx="14"/>
    ${rects}
  </svg>`
}

async function main() {
  console.log('开始合成精美项目介绍海报...')

  // 读取图片并转为 base64
  const iconBase64 = fs.readFileSync('public/icons/icon-512.png').toString('base64')
  const shotLoginBase64 = fs.readFileSync('probe/shot/docker-login.png').toString('base64')
  const shotSettingsBase64 = fs.readFileSync('probe/shot/docker-settings.png').toString('base64')

  const qrSvg = createQRCodeSVG('https://github.com/dszz453/lxmusic', 140)

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>LX-MUSIC / music-edge 项目介绍</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1200px;
    background: #090b10;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #e2e8f0;
    overflow-x: hidden;
    padding: 60px 50px 80px;
    background-image: 
      radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
      radial-gradient(circle at 85% 30%, rgba(236, 72, 153, 0.12) 0%, transparent 45%),
      radial-gradient(circle at 50% 80%, rgba(14, 165, 233, 0.14) 0%, transparent 50%);
  }

  .header {
    display: flex;
    align-items: center;
    gap: 32px;
    padding-bottom: 40px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .logo {
    width: 110px;
    height: 110px;
    border-radius: 26px;
    box-shadow: 0 12px 36px rgba(99, 102, 241, 0.35);
    background: #1e1b4b;
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .header-info { flex: 1; }
  .badge-row {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    font-size: 13px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(99, 102, 241, 0.15);
    color: #818cf8;
    border: 1px solid rgba(99, 102, 241, 0.3);
  }
  .badge.green {
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
    border-color: rgba(16, 185, 129, 0.3);
  }
  .badge.orange {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.3);
  }
  .title {
    font-size: 44px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, #ffffff 30%, #94a3b8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    line-height: 1.15;
    margin-bottom: 8px;
  }
  .subtitle {
    font-size: 20px;
    color: #94a3b8;
    font-weight: 400;
    line-height: 1.5;
  }

  /* 架构卡片 */
  .section-title {
    font-size: 24px;
    font-weight: 700;
    margin: 44px 0 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: #f8fafc;
  }
  .section-title::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 22px;
    background: linear-gradient(to bottom, #6366f1, #ec4899);
    border-radius: 2px;
  }

  .arch-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }
  .arch-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    padding: 24px;
    backdrop-filter: blur(12px);
    position: relative;
    overflow: hidden;
  }
  .arch-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, #6366f1, #ec4899);
    opacity: 0.7;
  }
  .arch-name {
    font-size: 19px;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .arch-tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.1);
    color: #cbd5e1;
  }
  .arch-desc {
    font-size: 14px;
    color: #94a3b8;
    line-height: 1.6;
  }

  /* 功能特性六宫格 */
  .features-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 18px;
  }
  .feat-card {
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 18px;
    padding: 22px 24px;
    display: flex;
    gap: 18px;
    align-items: flex-start;
  }
  .feat-icon {
    font-size: 26px;
    width: 52px;
    height: 52px;
    border-radius: 14px;
    background: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .feat-title {
    font-size: 17px;
    font-weight: 700;
    color: #f1f5f9;
    margin-bottom: 6px;
  }
  .feat-text {
    font-size: 13.5px;
    color: #94a3b8;
    line-height: 1.55;
  }

  /* 界面截图实机展示 */
  .showcase-container {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 30px;
    margin-top: 10px;
  }
  .phone-mockup {
    background: #13151f;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 28px;
    padding: 16px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  }
  .phone-label {
    font-size: 15px;
    font-weight: 600;
    color: #cbd5e1;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 4px;
  }
  .phone-label span {
    font-size: 12px;
    color: #64748b;
  }
  .mockup-img {
    width: 100%;
    border-radius: 18px;
    display: block;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* 底部 GitHub 链接与二维码 */
  .footer-cta {
    margin-top: 54px;
    background: linear-gradient(135deg, rgba(30, 27, 75, 0.6) 0%, rgba(15, 23, 42, 0.8) 100%);
    border: 1px solid rgba(99, 102, 241, 0.35);
    border-radius: 24px;
    padding: 34px 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  }
  .cta-left {
    max-width: 720px;
  }
  .cta-title {
    font-size: 26px;
    font-weight: 800;
    color: #ffffff;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .cta-desc {
    font-size: 15px;
    color: #94a3b8;
    line-height: 1.6;
    margin-bottom: 16px;
  }
  .cmd-box {
    background: #090a10;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 10px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13.5px;
    color: #38bdf8;
    display: inline-block;
  }
  .url-link {
    font-size: 16px;
    font-weight: 600;
    color: #818cf8;
    word-break: break-all;
    display: block;
    margin-top: 8px;
  }
  .qr-box {
    background: #ffffff;
    padding: 12px;
    border-radius: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    flex-shrink: 0;
  }
  .qr-box span {
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: 0.5px;
  }
</style>
</head>
<body>

  <!-- 顶部信息 -->
  <header class="header">
    <img class="logo" src="data:image/png;base64,${iconBase64}" alt="LX-MUSIC Logo">
    <div class="header-info">
      <div class="badge-row">
        <span class="badge green">V1.3 稳定发布</span>
        <span class="badge">开源自托管 · 极简部署</span>
        <span class="badge orange">Subsonic 协议兼容</span>
      </div>
      <h1 class="title">LX-MUSIC / music-edge</h1>
      <p class="subtitle">全网六音源高音质聚合 · 三宿主同源架构 · 私有云音乐中心</p>
    </div>
  </header>

  <!-- 三宿主同源架构 -->
  <div class="section-title">同一份核心代码，驱动三端宿主</div>
  <div class="arch-grid">
    <div class="arch-card">
      <div class="arch-name">🐳 Docker 自托管 <span class="arch-tag">LX-MUSIC</span></div>
      <p class="arch-desc">Node.js + 内置 SQLite 适配层。一分钟一键起容器，支持后台定时巡检插件评分，全量数据本地持久化掌控。</p>
    </div>
    <div class="arch-card">
      <div class="arch-name">⚡ Cloudflare Workers <span class="arch-tag">music-edge</span></div>
      <p class="arch-desc">零运维 Serverless 极速分发，搭配全球分布式 D1 数据库。极速秒开、无需购买公网云服务器。</p>
    </div>
    <div class="arch-card">
      <div class="arch-name">📱 安卓自包含壳 <span class="arch-tag">APK 安装包</span></div>
      <p class="arch-desc">原生 WebView + 本地自封装 JS 引擎直通桥。免服务端单机独立运行，享受掌中原生随身听体验。</p>
    </div>
  </div>

  <!-- 实机运行效果 -->
  <div class="section-title">真机实测效果呈现</div>
  <div class="showcase-container">
    <div class="phone-mockup">
      <div class="phone-label">
        <b>自适应登录与品牌</b>
        <span>根据宿主自显 LX-MUSIC / music-edge</span>
      </div>
      <img class="mockup-img" src="data:image/png;base64,${shotLoginBase64}" alt="登录页截图">
    </div>
    <div class="phone-mockup">
      <div class="phone-label">
        <b>设置与版本管理</b>
        <span>多音质切换 · 账号与版本状态</span>
      </div>
      <img class="mockup-img" src="data:image/png;base64,${shotSettingsBase64}" alt="设置页截图">
    </div>
  </div>

  <!-- 核心功能矩阵 -->
  <div class="section-title">核心功能特性矩阵</div>
  <div class="features-grid">
    <div class="feat-card">
      <div class="feat-icon">🎵</div>
      <div>
        <div class="feat-title">六平台聚合搜索与播放</div>
        <div class="feat-text">无缝打通网易云、QQ音乐、酷狗、酷我、咪咕、喜马拉雅。支持 128k/320k/无损音质自由选择与即点即播。</div>
      </div>
    </div>

    <div class="feat-card">
      <div class="feat-icon">⚡</div>
      <div>
        <div class="feat-title">独创插件自动评分与竞速</div>
        <div class="feat-text">全自动定时真机打分检测插件可用性，自动择优排定起播优先级，毫秒级响应告别卡顿与失效。</div>
      </div>
    </div>

    <div class="feat-card">
      <div class="feat-icon">📻</div>
      <div>
        <div class="feat-title">Subsonic 协议全生态兼容</div>
        <div class="feat-text">提供完整的标准 Subsonic 服务端接口。无缝直连音流、Feishin、DSub、substreamer 等跨平台专业播放器。</div>
      </div>
    </div>

    <div class="feat-card">
      <div class="feat-icon">🔒</div>
      <div>
        <div class="feat-title">多用户数据强隔离与管理</div>
        <div class="feat-text">每个账号享有独立的播放历史、自建歌单与收藏夹。搜索记录支持逐条精准单独删除与一键清空。</div>
      </div>
    </div>

    <div class="feat-card">
      <div class="feat-icon">📝</div>
      <div>
        <div class="feat-title">歌词逐字同步与离线缓存</div>
        <div class="feat-text">多源内容智能降级重试与歌词高精度对齐，支持浏览器原生音频缓存与离线本地下载保存。</div>
      </div>
    </div>

    <div class="feat-card">
      <div class="feat-icon">🛠️</div>
      <div>
        <div class="feat-title">极简部署 · 零冗余依赖</div>
        <div class="feat-text">自包含 Node/Docker 打包，无繁复配置文件羁绊。一条命令快速启动，开箱即用。</div>
      </div>
    </div>
  </div>

  <!-- 底部 GitHub 引导与二维码 -->
  <div class="footer-cta">
    <div class="cta-left">
      <div class="cta-title">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub 开源仓库
      </div>
      <p class="cta-desc">完整源码开源开放，欢迎 Star 关注与 Issue 交流！随时随地搭建专属的私有音乐流媒体中心。</p>
      <div class="cmd-box">docker run -d -p 8787:8787 ghcr.io/dszz453/lxmusic:latest</div>
      <span class="url-link">🔗 https://github.com/dszz453/lxmusic</span>
    </div>

    <div class="qr-box">
      ${qrSvg}
      <span>扫码直达 GitHub</span>
    </div>
  </div>

</body>
</html>`

  const htmlPath = path.resolve('probe/poster_preview.html')
  fs.writeFileSync(htmlPath, html, 'utf8')
  console.log('HTML 海报模板已就绪:', htmlPath)

  // 启动无头 Chrome 进行超高清渲染截图
  const PORT = 9978
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lxshot-poster-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-proxy-server', '--window-size=1200,2400', 'about:blank'
  ], { stdio: 'ignore' })

  let wsUrl = ''
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) wsUrl = p.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await sleep(200)
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let mid = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++mid; pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') })
  await sleep(1500)

  // 获取页面真实整体高度
  const docHeight = await new Promise((resolve) => {
    const id = ++mid; pending.set(id, { resolve: (r) => resolve(r.result.value), reject: () => resolve(2400) })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'document.body.scrollHeight', returnByValue: true } }))
  })
  console.log('检测到海报完整渲染高度:', docHeight)

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: docHeight || 2400,
    deviceScaleFactor: 1.5,
    mobile: false
  })
  await sleep(500)

  // 截取整页超清 PNG
  console.log('正在截取长图...')
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  
  const outDir = path.resolve('dist')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'lxmusic-project-intro.png')
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))

  console.log('✅ 项目宣传介绍长图已成功生成:', outPath)

  ws.close()
  chrome.kill()
}

main().catch(console.error)
