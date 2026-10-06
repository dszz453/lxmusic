// 验证 AI 歌单模块核心逻辑（不依赖真实 API key）
import { parsePlaylist, AI_PROVIDERS } from '../src/lib/ai.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}

// 1) 标准 JSON 输出
let r = parsePlaylist('{"title":"深夜开车","songs":[{"name":"光辉岁月","singer":"Beyond"},{"name":"海阔天空","singer":"Beyond"}]}', 20)
ok('JSON 解析标题', r.title === '深夜开车', r.title)
ok('JSON 解析歌曲数', r.songs.length === 2, String(r.songs.length))
ok('JSON 歌曲字段', r.songs[0].name === '光辉岁月' && r.songs[0].singer === 'Beyond')

// 2) 带 ```json 围栏
r = parsePlaylist('```json\n{"title":"测试","songs":[{"name":"歌","singer":""}]}\n```', 20)
ok('围栏解析', r.songs.length === 1 && r.songs[0].name === '歌', JSON.stringify(r.songs))

// 3) 纯文本兜底（非 JSON）
r = parsePlaylist('光辉岁月 - Beyond\n海阔天空 - Beyond\n晴天 - 周杰伦', 20)
ok('行文本兜底条数', r.songs.length === 3, String(r.songs.length))
ok('行文本解析歌手', r.songs[0].name === '光辉岁月' && r.songs[0].singer === 'Beyond', JSON.stringify(r.songs[0]))

// 4) 数量截断
const many = { title: 'x', songs: Array.from({ length: 60 }, (_, i) => ({ name: '歌' + i, singer: '' })) }
r = parsePlaylist(JSON.stringify(many), 20)
ok('超量截断到 20', r.songs.length === 20, String(r.songs.length))

// 5) 空歌手允许
r = parsePlaylist('{"title":"x","songs":[{"name":"无歌手歌"}]}', 20)
ok('缺歌手字段容错', r.songs.length === 1 && r.songs[0].singer === '', JSON.stringify(r.songs[0]))

// 6) AI_PROVIDERS 内置
ok('千问 baseURL', AI_PROVIDERS.qwen.baseURL.includes('dashscope'), AI_PROVIDERS.qwen.baseURL)
ok('OpenAI baseURL', AI_PROVIDERS.openai.baseURL.includes('api.openai.com'), AI_PROVIDERS.openai.baseURL)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
