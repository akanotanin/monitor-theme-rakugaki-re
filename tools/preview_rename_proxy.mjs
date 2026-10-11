// 拍「各卡片形态」预览图的一体化工具：本机伺服 dist/ + /api/* 转上游（顺手给节点名脱敏）+ 逐形态截图。
// 脱敏只去掉行首的厂商/机名前缀与结尾的「Gen 2」这类编号，其余字段（数字/系统/分组）原样透传——
// 手搓夹具会让读数残缺（在线数掉 0、速率全「—」），那样的图看着像主题坏了。
//
// 用法：
//   node tools/preview_rename_proxy.mjs --dist <仓库根> --up http://127.0.0.1:<隧道端口> \
//        --prefixes <仓库外的前缀清单文件> [--sibling /chicken/] [--out-dir <目录>] [--only <形态>]
//
// 前缀清单是一个每行一个的文本文件（只在仓库外，**绝不能提交**），一行一个待抹掉的分段：
//   Vendor-A
//   Vendor-B
//   ...
//
// 形态清单取自仓库 theme.json 里 cardStyle 那一项的 options（自动跟着主题走，不用手改）。
// 视口宽度固定 1440、DPR 2；高度**按内容自适应**（量最后一张卡片/表格行的底边 + 40px 再收视口）。
// 拍摄口径：涂鸦卡片那张露着地图拍（config.mapOn=true）；清单保持纯列表、不展开行。
// 输出：doodle → preview.png、checklist → preview-checklist.png、其余 preview-<形态>.png。
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : dflt
}
const REPO = resolve(arg('dist') || '.')
const UP = arg('up')
const PREFIX_FILE = arg('prefixes')
const SIBLING = arg('sibling', '')
const OUT_DIR = resolve(arg('out-dir', join(REPO, 'shots')))
const ONLY = arg('only', '')
if (!UP || !PREFIX_FILE) {
  console.error('必填：--up <上游站> --prefixes <前缀清单文件>'); process.exit(2)
}

const prefixes = readFileSync(PREFIX_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
mkdirSync(OUT_DIR, { recursive: true })
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const VENDOR = prefixes.length ? new RegExp('^(' + prefixes.map(esc).join('|') + ')\\s+', 'i') : null
const strip = (s) => {
  let out = String(s)
  if (VENDOR) out = out.replace(VENDOR, '')
  out = out.replace(/\s+(Gen\s*\d+|\d+)$/i, '').trim()
  return out || String(s)
}

// 形态清单：直接读仓库 theme.json 的 cardStyle options
const manifest = JSON.parse(readFileSync(join(REPO, 'theme.json'), 'utf8'))
const field = (manifest.config || []).find((f) => f.key === 'cardStyle')
const STYLES = (field?.options || []).map((o) => o.value).filter((v) => !ONLY || v === ONLY)
const OUT_NAME = { doodle: 'preview.png', checklist: 'preview-checklist.png' }
const PORT = Number(process.env.PREVIEW_PORT || 5401)
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT || 9510)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
let config = {}

const proxy = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  if (p === '/__config') {
    config = JSON.parse(url.searchParams.get('c') || '{}')
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}')
  }
  // /api/* 与兄弟路径转上游；**配置接口必须自己回答**（上游没装这个主题会回 {}，桩就白设了）
  if (p.startsWith('/api/') || (SIBLING && p.startsWith(SIBLING))) {
    if (p.endsWith('/config')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(config))
    }
    try {
      const r = await fetch(UP + p + url.search, { headers: { accept: req.headers.accept || '*/*' }, signal: AbortSignal.timeout(25000) })
      let body = await r.text()
      if (p === '/api/nodes') {
        const j = JSON.parse(body)
        j.nodes = j.nodes.map((n) => ({ ...n, name: strip(n.name) }))
        body = JSON.stringify(j)
      }
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(body)
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"error":"' + String(e).replace(/"/g, '') + '"}')
    }
  }
  const file = p === '/' ? '/index.html' : p
  const full = join(REPO, 'dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync(join(REPO, 'dist/index.html')))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})
await new Promise((r) => proxy.listen(PORT, '127.0.0.1', r))
console.log(`伺服 http://127.0.0.1:${PORT}/  → 上游 ${UP}（形态：${STYLES.join('/')}）`)

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  ...(process.env.PROXY ? [`--proxy-server=${process.env.PROXY}`] : []),
  `--user-data-dir=${process.env.TEMP || '/tmp'}/chrome-prev-${Date.now()}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' })
let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(500)
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* 等 */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text)
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const waitFor = async (expr, timeout = 40000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if ((await js(expr)) === true) return true; await sleep(300) }
  return false
}
await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

// 落定条件：字体就绪 + 卡片内容出来了 + 进度条已有宽度（**别带 %**，百分比是正常内容）
const SETTLED = `(() => {
  if (!document.fonts || document.fonts.status !== 'loaded') return false;
  if (!/CPU/.test(document.body.innerText)) return false;
  const row = document.querySelector('.dg-row');
  const fills = [...document.querySelectorAll('.dg-fill')];
  return !!(row || fills.some((f) => f.getBoundingClientRect().width >= 2));
})()`

for (const style of STYLES) {
  // 拍摄口径：涂鸦卡片露着地图拍；清单保持纯列表（不展开行）。
  const SHOT_CONFIG = style === 'doodle' ? { cardStyle: style, mapOn: true } : { cardStyle: style }
  await fetch(`http://127.0.0.1:${PORT}/__config?c=${encodeURIComponent(JSON.stringify(SHOT_CONFIG))}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${style}` })
  const ok = await waitFor(SETTLED)
  await sleep(4500) // 走势线要两个采样才连线；延迟历史也要一趟往返
  const geo = JSON.parse(await js(`(() => {
    const b = [...document.querySelectorAll('[data-card]')].map((c) => Math.round(c.getBoundingClientRect().bottom))
      .concat([...document.querySelectorAll('.dg-row')].map((r) => Math.round(r.getBoundingClientRect().bottom)));
    return JSON.stringify({ card: document.querySelectorAll('[data-card]').length, row: document.querySelectorAll('.dg-row').length, last: b.length ? Math.max(...b) : null })
  })()`))
  const h = geo.last !== null ? Math.round(geo.last + 40) : 900
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 2, mobile: false })
  await sleep(500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const name = OUT_NAME[style] || `preview-${style}.png`
  const out = join(OUT_DIR, name)
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`${name.padEnd(22)} ${ok ? 'ok ' : '⚠落定超时'} 卡片 ${geo.card} / 行 ${geo.row}  内容底边 ${geo.last} → 1440×${h}  ${Math.round(statSync(out).size / 1024)}KB`)
}
console.log('页面异常', errs.length, errs.slice(0, 3).join(' | '))
console.log('★拍完必须逐字读一遍图内全部文字，确认没有机名前缀 / IP / 域名（视觉模型读图）')
ws.close(); chrome.kill(); proxy.close(); process.exit(0)
