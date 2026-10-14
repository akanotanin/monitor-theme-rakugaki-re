// 详情页「连接数」两格（TCP 连接 / UDP 连接）的护栏（2026-10-14 与 jikasei / rakugaki
// 同日同口径同步到本仓库：站长要求详情页显示 hub 实时上报的 `metrics.tcp / udp`）。
//
// 判据：
//   ① 在线机器：`dt` 里有「TCP 连接」「UDP 连接」，`dd` 等于夹具上报的 16 / 3；
//   ② 离线机器：`metrics` 是 null，两格随 `Fact` 的既有口径一起隐身（标签都不出现，
//      不许用「—」占格子）。
// 锚点：规格表 = `dl > div.dg-fact > dt + dd`。
// 用法：cd <repo> && node tools/verify_detail_conn.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5528
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3, MB = 1024 ** 2

const metrics = (o) => ({ uptime: 1966200, cpu: 1.0, load: [0.03, 0.01, 0.0], mem_total: 960 * MB, mem_used: 430 * MB, swap_total: 0, swap_used: 0, disk_total: 10 * GB, disk_used: 1.4 * GB, net_rx: 1517, net_tx: 530, total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, tcp: 16, udp: 3, procs: 76, ...o })
const base = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, last_seen_ago: 5,
  metrics: metrics({}), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC', cpu_cores: 1,
  mem_total: 960 * MB, swap_total: 0, disk_total: 10 * GB, agent_version: '1.4.0', price: 0, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: null, expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, month_start: '2026-10-01', day_rx: 6.06 * GB, day_tx: 2.5 * GB,
  ...o,
})
const nodes = [
  base(1, 'Alpha', {}),                                   // 在线：metrics.tcp = 16 / udp = 3
  base(2, 'Bravo', { online: false, metrics: null }),     // 离线：两格必须隐身
]

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '连接数', history_days: 30 })
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
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `rkrconn${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 15000) => {
  for (let i = 0; i < ms / 150; i++) {
    if (await js(expr)) return true
    await sleep(150)
  }
  return false
}
const FACTS = `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.dg-fact dt')].map((d) => [d.textContent.trim(), d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null])))`

// ① 在线机器：两格在、值等于夹具（16 / 3）。
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/1` })
const ok1 = await waitFor(`document.querySelectorAll('.dg-fact dt').length > 0`, 20000)
await sleep(500)
const f1 = JSON.parse(await js(FACTS) ?? '{}')
console.log(`    ① 在线机 ${Object.keys(f1).length} 项：${Object.entries(f1).map(([k, v]) => `${k}=${v}`).join(' | ')}`)
check('在线机器：详情页渲染出来了', ok1 && Object.keys(f1).length > 0)
check('★ 「TCP 连接」= 夹具上报值（16）', f1['TCP 连接'] === '16', `实测 ${f1['TCP 连接']}`)
check('★ 「UDP 连接」= 夹具上报值（3）', f1['UDP 连接'] === '3', `实测 ${f1['UDP 连接']}`)

// ② 离线机器：metrics 是 null —— 两格随 Fact 口径一起隐身（标签都不出现）。
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/2` })
const ok2 = await waitFor(`document.querySelectorAll('.dg-fact dt').length > 0`, 20000)
await sleep(500)
const f2 = JSON.parse(await js(FACTS) ?? '{}')
check('离线机器：详情页渲染出来了', ok2 && Object.keys(f2).length > 0)
check('★ 离线机器：两格隐身（不许用「—」占格）',
  !('TCP 连接' in f2) && !('UDP 连接' in f2), `实测 ${JSON.stringify(f2)}`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)
