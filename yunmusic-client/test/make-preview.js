/*
 * 生成「可直接在浏览器里打开」的预览副本。
 *
 * index.html 依赖原生桥 YunBridge 才能取数据，直接开浏览器会是一屏「加载失败」。
 * 这里在页面主脚本**之前**插一段桩，把桥和几组假数据补上，
 * 再按变体注入一小段「加载后动作」（点歌、模拟下载完成等），
 * 就能用无头 Chrome 截图肉眼验收 UI。
 *
 * 用法：node test/make-preview.js
 * 产物：build/preview/preview-*.html
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'build', 'preview')
const HTML = fs.readFileSync(path.join(ROOT, 'assets', 'web', 'index.html'), 'utf8')

const CFG = {
  active: 0,
  activeUrl: 'https://music.zyplnn.dpdns.org',
  activeName: '线路一 · CF',
  line1: { url: 'https://music.zyplnn.dpdns.org', user: 'admin', pass: 'test-pass' },
  line2: { url: 'https://lxmusic.19860819.xyz:8616', user: 'admin', pass: 'test-pass' }
}

// 封面用内联 SVG data-URI：离线也能渲染，避免走占位图让截图失真
function cover(c1, c2, note) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/>' +
    '</linearGradient></defs>' +
    '<rect width="300" height="300" fill="url(#g)"/>' +
    '<text x="150" y="186" font-size="96" text-anchor="middle" fill="rgba(255,255,255,.85)" font-family="sans-serif">' + note + '</text>' +
    '</svg>'
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

const SONGS = [
  { id: 's1', name: '夜曲', singer: '周杰伦', img: cover('#3a4a8c', '#8f6ad6', '♪'), albumName: '十一月的萧邦', interval: 227, source: 'wy', sourceName: '网易云音乐' },
  { id: 's2', name: '晴天', singer: '周杰伦', img: cover('#2f7d8c', '#7fd0c8', '♫'), albumName: '叶惠美', interval: 269, source: 'wy', sourceName: '网易云音乐' },
  { id: 's3', name: '稻香', singer: '周杰伦', img: cover('#b4622a', '#f0b45c', '♪'), albumName: '魔杰座', interval: 223, source: 'kg', sourceName: '酷狗音乐' },
  { id: 's4', name: '花海', singer: '周杰伦', img: cover('#7d2f5e', '#e07ba8', '♬'), albumName: '魔杰座', interval: 254, source: 'kg', sourceName: '酷狗音乐' }
]

const LRC = '[00:00.50]云音乐 · 界面预览\n[00:04.20]这一行正在播放，字号会明显放大\n[00:08.60]上一句和下一句保持较小的灰字\n[00:13.00]歌词逐帧跟随进度，不靠 timeupdate\n[00:17.40]高亮行始终停在可视区正中\n[00:21.80]右侧可以微调歌词偏移\n[00:26.20]下载会把文件存进系统音乐库'

const RESPONSES = {
  '/me': { user: { username: 'admin', isAdmin: true } },
  '/login': { token: 'tk', user: { username: 'admin', isAdmin: true } },
  '/favorites': { list: [SONGS[0], SONGS[1]] },
  '/search': { list: SONGS },
  '/charts': {
    list: [
      { id: 'c1', name: '飙升榜', img: cover('#c0392b', '#f07a5a', '1') },
      { id: 'c2', name: '热歌榜', img: cover('#2c6fb5', '#6fb7e8', '2') },
      { id: 'c3', name: '新歌榜', img: cover('#2f8f6a', '#84d6ac', '3') }
    ]
  },
  '/chart': { name: '飙升榜', img: cover('#c0392b', '#f07a5a', '1'), list: SONGS },
  '/album': { name: '十一月的萧邦', singer: '周杰伦', img: cover('#3a4a8c', '#8f6ad6', '♪'), list: SONGS },
  '/playlists': { list: [{ id: 'p1', name: '我喜欢的音乐' }, { id: 'p2', name: '通勤循环' }] },
  '/playlist': { name: '我喜欢的音乐', list: SONGS },
  '/history': { list: SONGS },
  '/home': {
    keyword: '每日推荐',
    generator: '在线',
    daily: { generator: '在线' },
    hot: SONGS,
    recommend: SONGS,
    playlists: [
      { id: 'p1', name: '我喜欢的音乐', cover: cover('#8e2f4a', '#e0809c', '♥'), count: 42 },
      { id: 'p2', name: '通勤循环', cover: cover('#2b5f8e', '#79b6e0', '↻'), count: 18 }
    ],
    // chartCard 读的是 cover 字段（不是 img）
    charts: [
      { id: 'c1', source: 'wy', name: '飙升榜', cover: cover('#c0392b', '#f07a5a', '1'), playCount: 1280000 },
      { id: 'c2', source: 'wy', name: '热歌榜', cover: cover('#2c6fb5', '#6fb7e8', '2'), playCount: 864000 },
      { id: 'c3', source: 'wy', name: '新歌榜', cover: cover('#2f8f6a', '#84d6ac', '3'), playCount: 512000 }
    ]
  },
  '/lyric': { ok: true, lyric: { lyric: LRC, tlyric: '[00:04.20]Now playing, this line is highlighted' } },
  // 故意用 plugin:xxx：真实环境里插件优先，from 就是这个形态。
  // 版式对齐 Web 端：歌手那一行显示「周杰伦 · 网易云音乐」（平台名），
  // 最底那一行显示「音源：lx-source」（插件名）。两边都不能出现 "plugin:" 原始前缀。
  '/url': { ok: true, url: 'https://cdn.example.com/a.mp3', from: 'plugin:lx-source' },
  '/playlist/add': { ok: true, added: 1 },
  '/daily': {
    ok: true, ready: true, title: '每日推荐', generator: '在线',
    generatedAt: '2026-10-11T08:00:00Z', date: '2026-10-11', stale: false,
    songs: SONGS
  },
  '/daily/refresh': {
    ok: true, ready: true, title: '每日推荐', generator: '在线',
    date: '2026-10-11', songs: [SONGS[2], SONGS[0], SONGS[3]]
  },
  '/ai-playlist': {
    // 真实返回：只有歌名 + 歌手，没有 id / 封面
    ok: true, title: '适合深夜写代码的歌', requested: 20,
    songs: [
      { name: '夜曲', singer: '周杰伦' },
      { name: '晴天', singer: '周杰伦' },
      { name: '稻香', singer: '周杰伦' }
    ]
  }
}

const STUB = `
<script>
(function () {
  var CFG = ${JSON.stringify(CFG)};
  var RES = ${JSON.stringify(RESPONSES)};
  window.__cov = ${JSON.stringify(cover('#4a6bd6', '#8fb0f0', '♪'))};
  // 真机上原生顶栏是 WebView 的兄弟节点，隐藏后 WebView 顶到 y=0，
  // 原生再把状态栏高度写进 --safe-top。预览里必须照做，
  // 否则 --safe-top 永远是 0，截出来的播放器比真机「高」一截，看走眼。
  window.__STATUS_BAR = ${Number(process.env.SAFE_TOP || 24)};
  window.YunBridge = {
    showToast: function (m) {},
    updateMedia: function () {},
    setChromeHidden: function (hidden) {
      document.documentElement.style.setProperty('--safe-top', (hidden ? window.__STATUS_BAR : 0) + 'px');
    },
    getServerConfig: function () { return JSON.stringify(CFG); },
    switchLine: function (i) { return JSON.stringify(CFG); },
    saveDualConfig: function () { return JSON.stringify(CFG); },
    downloadSong: function (id, url, name) { window.__dl = { id: id, url: url, name: name }; },
    cancelDownload: function () {},
    httpFetch: function (reqId, url, method, headers, body) {
      var p = url.replace(/^https?:\\/\\/[^/]+/, '').replace(/^\\/api/, '').split('?')[0];
      var payload;
      if (p === '/suggest') {
        // 关键词是「歌名 歌手」拼的，这里拆回去，截图才和真实服务端一致
        var qs = decodeURIComponent(url.split('?')[1] || '');
        var km = qs.match(/q=([^&]*)/);
        var parts = (km ? km[1] : '').split(' ');
        payload = {
          ok: true,
          list: [{ id: 'sg-' + parts[0], name: parts[0], singer: parts[1] || '群星', img: window.__cov || '', source: 'wy', sourceName: '网易云音乐' }]
        };
      } else {
        payload = RES[p] === undefined ? { ok: true, list: [] } : RES[p];
      }
      setTimeout(function () {
        window.onNativeHttpCallback({ reqId: reqId, status: 200, body: JSON.stringify(payload) });
      }, 0);
    }
  };
})();
</script>
`

// 各变体：注入一小段「加载后动作」，让截图停在想看的那一屏
const VARIANTS = {
  'home': { hash: '#/', after: '' },
  'mine': { hash: '#/mine', after: '' },
  'search': { hash: '#/search?q=周杰伦', after: '' },
  'player': {
    hash: '#/chart?source=wy&id=c1',
    after: `
      function tap(sel) { var el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      setTimeout(function () { tap('#view .song') }, 500);          // 点第一首歌
      setTimeout(function () { tap('#miniplayer') }, 1100);         // 展开全屏播放器
      setTimeout(function () {
        tap('#playerDisc');                                        // 切到歌词视图
        // 关掉过渡：无头截图的虚拟时间不一定驱动 CSS transition，
        // 不关会截到「唱片淡出到一半」的中间态
        ['#playerDisc', '#playerLyric'].forEach(function (s) {
          var el = document.querySelector(s);
          if (el) el.style.transition = 'none';
        });
      }, 1600);
      setTimeout(function () { var a = document.getElementById('audio'); if (a) { try { a.currentTime = 5.2 } catch (e) {} } }, 2000);
    `
  },
  'sheet': {
    hash: '#/search?q=周杰伦',
    after: `
      setTimeout(function () {
        var b = document.querySelector('#view .song [data-act="more"]');
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, 700);
    `
  },
  'downloads': {
    hash: '#/search?q=周杰伦',
    after: `
      setTimeout(function () {
        var b = document.querySelector('#view .song [data-act="more"]');
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, 700);
      setTimeout(function () {
        var d = document.querySelector('#drawerBody [data-sact="download"]');
        if (d) d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, 1100);
      setTimeout(function () {
        if (window.__dl && window.onNativeDownload) {
          window.onNativeDownload({ reqId: window.__dl.id, state: 'done', path: '/storage/emulated/0/Music/云音乐/夜曲 - 周杰伦.mp3', bytes: 9437184 });
        }
      }, 1600);
      setTimeout(function () { location.hash = '#/downloads' }, 2100);
    `
  },
  'daily': { hash: '#/daily', after: '' },
  'ai': {
    hash: '#/ai',
    after: `
      setTimeout(function () {
        var i = document.getElementById('aiPrompt');
        if (i) i.value = '适合深夜写代码的歌';
        var b = document.getElementById('aiGo');
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, 700);
    `
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })

Object.keys(VARIANTS).forEach(function (name) {
  const v = VARIANTS[name]
  const after = v.after
    ? '\n<script>window.addEventListener("load", function () { setTimeout(function () {' + v.after + '}, 400) })</script>\n'
    : ''
  // 桩必须插在主脚本之前：页面启动时会立刻 readNativeConfig()
  const out = HTML.replace('<body>', '<body>' + STUB + after)
  const file = path.join(OUT_DIR, 'preview-' + name + '.html')
  fs.writeFileSync(file, out, 'utf8')
  console.log('生成 ' + path.relative(ROOT, file) + '  ->  ' + v.hash)
})
