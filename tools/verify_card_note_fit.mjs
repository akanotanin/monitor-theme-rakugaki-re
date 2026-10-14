// 卡片「纸角小字」（已运行 · 价格 · 到期）不截断的护栏（2026-10-14 站长实拍桌面 1440
// 4 列卡上被截的「剩余 30…」后修）。
//
// 判据（逐宽度 × 三组夹具）：
//   ① 每张卡的 .dg-note 无截断（scrollWidth − clientWidth ≤ 1）——块级元素只在溢出时
//      才会出现这个差，所以它正是「看见省略号/被切尾」的机器判据；
//   ② 小字单行（height ≤ 1.5 行高）——设计目标：11px 降档后连最坏形状（1234 天 +
//      ¥1,299.00）在最窄的 320/640 档（行盒 252px）也一行放得下；真出现更极端的数据，
//      这条会红 —— 那时要么接受「段间整段折行」（改期望），要么再收档，别静默。
// 用法：cd <repo> && node tools/verify_card_note_fit.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5559
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3, MB = 1024 ** 2

const metrics = (o) => ({ uptime: 1966200, cpu: 1.0, load: [0.03, 0.01, 0.0], mem_total: 960 * MB, mem_used: 430 * MB, swap_total: 0, swap_used: 0, disk_total: 10 * GB, disk_used: 1.4 * GB, net_rx: 1517, net_tx: 530, total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, tcp: 16, udp: 3, procs: 76, ...o })
const base = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'DE', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, last_seen_ago: 5,
  metrics: metrics({}), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC', cpu_cores: 1,
  mem_total: 960 * MB, swap_total: 0, disk_total: 10 * GB, agent_version: '1.4.0', billing_cycle: 'yearly',
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, month_start: '2026-10-01', day_rx: 6.06 * GB, day_tx: 2.5 * GB,
  ...o,
})
// A = 站长真机形状；B = 最坏形状（长时长 + 贵价格 + 4 位数天数）；C = 只有在线时长。
const nodes = [
  base(1, 'Alpha Frankfurt', { uptime: 22 * 86400 + 21 * 3600, price: 299, currency: 'CNY', billing_cycle: 'yearly', expires_in: 303, expires_at: '2027-08-13' }),
  base(2, 'Bravo Tokyo', { uptime: 123 * 86400 + 23 * 3600, price: 1299, currency: 'CNY', billing_cycle: 'yearly', expires_in: 1234, expires_at: '2029-12-31' }),
  base(3, 'Charlie', { uptime: 5 * 86400 }),
]

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '小字', history_days: 30 })
    if (path === '/api/nodes') return json({ nodes })
    if (path.endsWith('/config')) return json({ cardStyle: 'doodle' })
    if (/\/metrics/.test(path)) return json({ metrics: [], ping: [], probes: {}, loss: {} })
    return json({})
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `notefit${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

const PROBE = `JSON.stringify([...document.querySelectorAll('article[data-card][data-node]')].map((c) => {
  const n = c.querySelector('.dg-note')
  if (!n) return { name: c.querySelector('h3')?.textContent?.trim(), missing: true }
  const cs = getComputedStyle(n)
  const lh = parseFloat(cs.lineHeight) || 18
  const r = n.getBoundingClientRect()
  return {
    name: c.querySelector('h3')?.textContent?.trim(),
    text: n.textContent.replace(/\\s+/g, ' ').trim(),
    clip: n.scrollWidth - n.clientWidth,
    lines: Math.round(r.height / lh),
    fs: cs.fontSize,
    box: Math.round(n.clientWidth),
  }
}))`

const WIDTHS = [320, 360, 390, 640, 768, 1024, 1280, 1440, 1920]
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 1, mobile: w < 640 })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) { ready = !!(await js(`document.querySelectorAll('article[data-card][data-node]').length >= 3`)); if (!ready) await sleep(120) }
  await sleep(500)
  const rows = JSON.parse(await js(PROBE) ?? '[]')
  const clipped = rows.filter((r) => r.clip === undefined || r.missing || r.clip > 1)
  check(`${w}px 纸角小字无截断`, ready && rows.length === 3 && clipped.length === 0,
    clipped.map((r) => `${r.name}: 超${r.clip} 盒${r.box} @${r.fs}`).join(' | '))
  const wrapped = rows.filter((r) => r.lines > 1)
  check(`${w}px 纸角小字单行`, wrapped.length === 0,
    wrapped.map((r) => `${r.name}: ${r.lines} 行（盒${r.box} @${r.fs}）「${(r.text || '').slice(0, 40)}」`).join(' | '))
  if (w === 1440) console.log(`    1440px 明细: ` + rows.map((r) => `${r.name}: 盒${r.box} @${r.fs} 超${r.clip} ${r.lines}行`).join(' | '))
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)
