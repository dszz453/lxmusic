/* eslint-disable no-console */
/**
 * 音频魔数识别的单元测试。
 *
 * 这条判据是「假音源」的唯一闸门（见 stream.js 的 looksLikeAudioBytes）：
 * 探错一个方向就是「真音频被丢掉 → 明明有源却放不出来」，
 * 探松一个方向就是「JSON 错误页混进候选 → Format error 白等一轮」。
 * 两个方向都必须有用例。
 *
 * 用法: node test/stream-magic.mjs
 */
import { looksLikeAudioBytes } from '../src/lib/stream.js'

let pass = 0
let fail = 0
const bytes = (...arr) => new Uint8Array(arr)
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

function ok(name, got, want) {
  if (got === want) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + '  期望 ' + want + '，实际 ' + got) }
}

console.log('\n--- 应该认成音频 ---')
ok('ID3v2 标签（MP3）', looksLikeAudioBytes(bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03, 0x54, 0x49)), true)
ok('裸 MPEG 帧同步 FF FB', looksLikeAudioBytes(bytes(0xFF, 0xFB, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)), true)
ok('ADTS AAC FF F1', looksLikeAudioBytes(bytes(0xFF, 0xF1, 0x50, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)), true)
ok('Ogg（Vorbis/Opus）', looksLikeAudioBytes(ascii('OggS\u0000\u0002\u0000\u0000\u0000\u0000\u0000\u0000')), true)
ok('FLAC', looksLikeAudioBytes(ascii('fLaC\u0000\u0000\u0000"')), true)
ok('WAV（RIFF....WAVE）', looksLikeAudioBytes(ascii('RIFF\u0024\u0008\u0000\u0000WAVEfmt ')), true)
ok('M4A/MP4（偏移 4 处 ftyp）', looksLikeAudioBytes(ascii('\u0000\u0000\u0000 ftypmp42')), true)
ok('APE（MAC ）', looksLikeAudioBytes(ascii('MAC \u0096\u000f')), true)

console.log('\n--- 绝不能认成音频（中转站/错误页/脚本） ---')
ok('JSON 错误体 {"code":201}', looksLikeAudioBytes(ascii('{"code":201,"msg":"error"}')), false)
ok('JSON 数组', looksLikeAudioBytes(ascii('[{"url":"x"}]')), false)
ok('HTML 错误页', looksLikeAudioBytes(ascii('<!DOCTYPE html><html>')), false)
ok('纯文本', looksLikeAudioBytes(ascii('not found')), false)
ok('空响应', looksLikeAudioBytes(new Uint8Array(0)), false)
ok('太短（3 字节）', looksLikeAudioBytes(bytes(0x49, 0x44, 0x33)), false)
ok('M3U 播放列表', looksLikeAudioBytes(ascii('#EXTM3U\n#EXTINF')), false)
ok('PNG 图片', looksLikeAudioBytes(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0)), false)
ok('ZIP', looksLikeAudioBytes(bytes(0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0)), false)

console.log('\n--- 边界：真实文件头被截断到 12 字节仍然认得出 ---')
// 真 MP3 的 ID3 头只要前 3 字节
ok('只有 4 字节的 ID3', looksLikeAudioBytes(bytes(0x49, 0x44, 0x33, 0x03)), true)

console.log('\n================ ' + pass + ' 通过 / ' + fail + ' 失败 ================\n')
process.exit(fail ? 1 : 0)
