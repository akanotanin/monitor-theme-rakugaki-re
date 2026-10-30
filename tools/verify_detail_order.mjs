// 详情页「信息格次序 + 资源面板次序」的护栏（rakugaki-re；2026-10-30 与 rakugaki 同步）。
//
// 改动（与 rakugaki / jikasei / kanso 同一口径）：
//   · 信息格：系统 → 架构 → TCP / UDP 连接 → CPU → 内存 / 硬盘 → 今日流量 → 在线时间 → 计费 → 到期
//     （连接数两格合成**一格**，写法照「内存 / 硬盘」，值 `17 / 3`）；
//   · 资源面板：网络速率 → TCP / UDP 连接 → CPU → 内存 · X → 硬盘 · Y
//     （新增的「TCP / UDP 连接」图两条线，TCP 蓝 / UDP 粉；计数面板的轴顶补到 4 的倍数）。
//
// 判据：
//   ① 信息格的标签次序与上面一致（计费填了价格才在，到期缺省隐身 —— 这里夹具两项都填）；
//   ② 资源面板的标题次序与上面一致；
//   ③ 「TCP / UDP 连接」那张图画了两条线（主笔 2.25px），Y 轴四格全是整数、轴顶是 4 的倍数；
//      hub 桶里没 `tcp / udp` 两列（老 hub）时：面板仍在、线一条都不画、不抛异常。
//   ④ 规格区三组小标题 = 身份 / 用量 / 时长与续费（只切视觉、不动上面那条次序）；
//   ⑤ 用量格各带一条细条 + 百分比（CPU / 内存 / 硬盘 / 本期），条宽按百分比铺；
//   ⑥ 节点识别色：data-accent 与「这台在列表里的位置」取模一致，面板硬影子就是那个色；
//   ⑦ 页签 chip 与列表页那排分组 chip 同尺寸（默认 `.dg-chip` 的 4px 11px，不许再压矮）。
// 用法：node tools/verify_detail_order.mjs [端口]   （dist 默认取 ./dist；DIST_DIR=... 可指别处）
//   ★对照纪律：拿**改动前的 dist** 跑这一份，①②③ 必须 FAIL（旧的次序是 系统→CPU→内存/硬盘→架构→
//   两格连接数…，资源面板以 CPU 打头、没有 TCP/UDP 那张图）。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5330)
const CDP_PORT = PORT + 4000
const ROOT = process.env.DIST_DIR || 'dist'

let passed = 0
let failed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}

/* ------------------------------------------------------------------ 桩数据 */

const GB = 1024 ** 3, MB = 1024 ** 2
const metrics = (o) => ({
  uptime: 1966200, cpu: 1.0, load: [0.03, 0.01, 0.0], mem_total: 960 * MB, mem_used: 430 * MB,
  swap_total: 0, swap_used: 0, disk_total: 10 * GB, disk_used: 1.4 * GB,
  net_rx: 1517, net_tx: 530, total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB,
  tcp: 16, udp: 3, procs: 76, ...o,
})
const base = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, last_seen_ago: 5,
  metrics: metrics({}), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm',
  cpu_name: 'EPYC', cpu_cores: 1, mem_total: 960 * MB, swap_total: 0, disk_total: 10 * GB,
  agent_version: '1.4.0', price: 30, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: '2026-12-01', expires_in: 32, traffic_limit: 500 * GB, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, month_start: '2026-10-01',
  day_rx: 6.06 * GB, day_tx: 2.5 * GB, ...o,
})
const NODES = { nodes: [base(1, 'Alpha', {}), base(2, 'Bravo', { metrics: metrics({ tcp: undefined, udp: undefined }) })] }

// 历史桶：12 个点，tcp / udp 随点起伏（老 hub 那份没有这两列 → 两条线都不画）。
const now = Math.floor(Date.now() / 1000)
const HISTORY = Array.from({ length: 12 }, (_, i) => ({
  ts: now - (12 - i) * 300,
  cpu: 1 + (i % 3), mem_used: 400 * MB, disk_used: 1.4 * GB,
  net_rx: 1200 + i * 30, net_tx: 400 + i * 10,
  tcp: 16 + (i % 4), udp: 3 + (i % 2), procs: 70 + (i % 5),
}))
const HISTORY_OLD = HISTORY.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'tcp' && k !== 'udp')))

/* ------------------------------------------------------------------ 伺服 */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '次序校验', history_days: 30 }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = {}
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      const id = Number(path.match(/^\/api\/nodes\/(\d+)\/metrics/)[1])
      const rows = id === 1 ? HISTORY : HISTORY_OLD
      body = url.searchParams.get('series') === 'ping'
        ? { metrics: [], ping: [], probes: {}, loss: {} }
        : { metrics: rows, ping: [], probes: {}, loss: {} }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync(join(ROOT, 'index.html')))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

/* ------------------------------------------------------------------ 浏览器 */

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server', '--window-size=1400,1300',
  `--user-data-dir=${join(tmpdir(), `rorder${CDP_PORT}`)}`,
  '--no-sandbox',
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || '异常')
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1300, deviceScaleFactor: 1, mobile: false })

const BASE = `http://127.0.0.1:${PORT}`

/* 面板标题：`Panel` 渲染成 h4.dg-hand（图表的「资源」页签）；信息格标签：`.dg-fact dt`。 */
const FACTS = `JSON.stringify([...document.querySelectorAll('.dg-fact dt')].map((d) => d.textContent.trim()))`
const PANELS = `JSON.stringify([...document.querySelectorAll('[data-detail] h4.dg-hand')].map((h) => h.textContent.trim()))`
/* 每张图的读数：标题 → { 轴刻度, 主笔线数 }。图挂在 Panel 里，用 h4 的 nextElementSibling 找。 */
const CHARTS = `JSON.stringify([...document.querySelectorAll('[data-detail] h4.dg-hand')].map((h) => {
  const box = h.nextElementSibling
  const svg = box ? box.querySelector('svg[role="img"]') : null
  if (!svg) return { title: h.textContent.trim(), lines: 0, ticks: [] }
  return {
    title: h.textContent.trim(),
    lines: [...svg.querySelectorAll('path[stroke-width="2.25"]')].filter((p) => (p.getAttribute('d') || '').trim().length > 4).length,
    ticks: [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent.trim()),
  }
}))`

async function openDetail(nodeId, expectPanels) {
  await send('Page.navigate', { url: `${BASE}/node/${nodeId}` })
  await sleep(1200)
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const n = await js(`document.querySelectorAll('[data-detail] h4.dg-hand').length`)
    if (typeof n === 'number' && n >= expectPanels) { await sleep(500); return true }
  }
  return false
}

/* ------------------------------------------------------------------ ① 信息格 / ② 面板次序 */

const ok1 = await openDetail(1, 6)
const facts = JSON.parse(await js(FACTS) ?? '[]')
const panels = JSON.parse(await js(PANELS) ?? '[]')
const charts = JSON.parse(await js(CHARTS) ?? '[]')
console.log(`    信息格：${facts.join(' → ')}`)
console.log(`    资源面板：${panels.join(' → ')}`)
check('详情页（资源页签）渲染出来了', ok1)

const WANT_FACTS = ['系统', '架构', 'TCP / UDP 连接', 'CPU', '内存 / 硬盘', '今日流量', '在线时间', '计费', '到期']
check('① 信息格次序 = 系统 → 架构 → TCP / UDP 连接 → CPU → 内存 / 硬盘 → 今日流量 → 在线时间 → 计费 → 到期',
  JSON.stringify(facts) === JSON.stringify(WANT_FACTS), `实测 ${JSON.stringify(facts)}`)

const WANT_PANELS = ['网络速率', 'TCP / UDP 连接', '进程', 'CPU', '内存 · 960 MB', '硬盘 · 10.0 GB']
check('② 资源面板次序 = 网络速率 → TCP / UDP 连接 → 进程 → CPU → 内存 → 硬盘',
  JSON.stringify(panels) === JSON.stringify(WANT_PANELS), `实测 ${JSON.stringify(panels)}`)

/* ------------------------------------------------------------------ ③ TCP/UDP 面板本身 */

const conn = charts.find((c) => c.title === 'TCP / UDP 连接')
console.log(`    TCP/UDP 面板：${JSON.stringify(conn)}`)
check('③ 「TCP / UDP 连接」画了两条线（TCP / UDP 各一）', !!conn && conn.lines === 2, `主笔 ${conn?.lines} 条`)
const ticks = (conn?.ticks ?? []).map((t) => parseFloat(t)).filter((n) => Number.isFinite(n))
const allInt = ticks.length >= 3 && ticks.every((v) => Math.abs(v - Math.round(v)) < 1e-9)
check('③b 计数面板的 Y 轴四格全是整数（四分刻度不带 x.5）', allInt, `刻度 ${JSON.stringify(conn?.ticks)}`)
const top = ticks.length ? Math.max(...ticks) : null
check('③c 计数面板的轴顶是 4 的倍数（6→8 / 10→12 / 30→32）', top !== null && top % 4 === 0, `轴顶 ${top}`)

/* ------------------------------------------------------------------ ④~⑦ 排列 / 歪头 / 进程卡 / 识别色 / chip */

const PANELGEO = `JSON.stringify([...document.querySelectorAll('[data-detail] .dg-panel')].map((p) => {
  const r = p.getBoundingClientRect()
  const m = getComputedStyle(p).transform
  let deg = null
  if (m && m !== 'none') {
    // 不用正则剥 matrix(...)：这行在模板字符串里，反斜杠要被吃掉一层（踩过一次），slice 更省心。
    const parts = m.startsWith('matrix(') ? m.slice(7, -1).split(',').map(Number) : []
    if (parts.length === 6) deg = Math.round(Math.atan2(parts[1], parts[0]) * 180 / Math.PI * 100) / 100
  }
  const tape = getComputedStyle(p, '::before')
  return { title: (p.querySelector('h4')?.textContent || '').trim(), left: Math.round(r.left), top: Math.round(r.top + scrollY), w: Math.round(r.width), deg,
    shadow: getComputedStyle(p).boxShadow,
    tape: { content: tape.content, w: tape.width, bg: tape.backgroundColor, tr: tape.transform } }
}))`
const geo = JSON.parse(await js(PANELGEO) ?? '[]')
console.log(`    六张卡：${geo.map((g) => `${g.title}@${g.left},${g.top} ${g.w}px ${g.deg}°`).join(' ｜ ')}`)
console.log('    raw transform:', JSON.stringify(geo.map((g) => g.raw)))
check('④ 六张卡排成两列三排（每排两张、两列等宽、同一行顶对齐）',
  geo.length === 6 &&
  [0, 1, 2].every((row) => {
    const a = geo[row * 2], b = geo[row * 2 + 1]
    return a && b && Math.abs(a.top - b.top) <= 2 && b.left > a.left + 100 && Math.abs(a.w - b.w) <= 2
  }),
  `共 ${geo.length} 张`)

const degs = geo.map((g) => g.deg)
check('⑤ 每张卡都歪头（±0.4~1.0°），且角度逐张轮换（不是同一个值）',
  degs.every((d) => typeof d === 'number' && Math.abs(d) >= 0.4 && Math.abs(d) <= 1.0) &&
  new Set(degs).size >= 3,
  `实测 ${JSON.stringify(degs)}`)

const ROOTCOLORS = `(() => {
  const s = getComputedStyle(document.querySelector('[data-detail]'))
  return JSON.stringify({ teal: s.getPropertyValue('--teal').trim(), red: s.getPropertyValue('--red').trim(), yellow: s.getPropertyValue('--yellow').trim() })
})()`
const rootCols = JSON.parse(await js(ROOTCOLORS) ?? '{}')
const hex2rgb = (hex) => {
  const h = String(hex || '').replace('#', '').trim()
  if (h.length !== 6) return ''
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`
}
const WANT_TONES = ['teal', 'red', 'yellow', 'teal', 'red', 'yellow'].map((k) => hex2rgb(rootCols[k]))
check('⑤b 六张卡的硬影子按 青→红→黄 轮换（与列表卡同一套顺序）',
  WANT_TONES.every((c) => c) && geo.every((g, i) => (g.shadow || '').startsWith(WANT_TONES[i])),
  geo.map((g) => (g.shadow || '').split(' px')[0]).join(' ｜ '))

check('⑤c 六张卡顶边都贴了胶带（72×18，颜色取三色板之一）',
  geo.every((g) => g.tape && g.tape.content !== 'none' && g.tape.w === '72px' && g.tape.bg !== 'rgba(0, 0, 0, 0)'),
  geo.map((g) => `${g.tape?.w}/${g.tape?.bg}`).join(' ｜ '))

check('⑤d 胶带角度不是同一个值（六张互相错开）',
  new Set(geo.map((g) => g.tape?.tr)).size >= 3,
  geo.map((g) => g.tape?.tr).join(' ｜ '))

const proc = charts.find((c) => c.title === '进程')
const procTicks = (proc?.ticks ?? []).map((t) => parseFloat(t)).filter((n) => Number.isFinite(n))
console.log(`    进程卡：${JSON.stringify(proc)}`)
check('⑥ 「进程」卡画出一条线', !!proc && proc.lines === 1, `主笔 ${proc?.lines} 条`)
check('⑥b 进程卡 Y 轴四格是整数、轴顶是 4 的倍数',
  procTicks.length >= 3 && procTicks.every((v) => Math.abs(v - Math.round(v)) < 1e-9) &&
  procTicks[procTicks.length - 1] % 4 === 0,
  `刻度 ${JSON.stringify(proc?.ticks)}`)

const ACCENT = `(() => {
  const root = document.querySelector('[data-detail]')
  const panel = document.querySelector('[data-detail] .dg-panel')
  const h2 = document.querySelector('[data-detail] h2')
  const cs = h2 ? getComputedStyle(h2, '::after') : null
  return JSON.stringify({
    accent: root ? root.getAttribute('data-accent') : null,
    shadow: panel ? getComputedStyle(panel).boxShadow : null,
    rule: cs ? cs.backgroundColor : null,
  })
})()`
const CHIPBOX = `(() => {
  const c = document.querySelector('[data-detail] .dg-chip')
  if (!c) return 'null'
  const s = getComputedStyle(c)
  const r = c.getBoundingClientRect()
  return JSON.stringify({ pad: s.padding, h: Math.round(r.height * 10) / 10, font: s.fontSize })
})()`
const teal2 = JSON.parse(await js(ACCENT) ?? 'null')
check('⑦ 节点识别色：列表第一张卡 → teal，名字下的荧光笔痕同色（图表卡影子已改按卡位轮换）',
  teal2?.accent === 'teal' && /^rgba?\(78, 205, 196/.test(teal2?.rule ?? ''),
  `accent ${teal2?.accent} / 笔痕 ${teal2?.rule}`)

const chip2 = JSON.parse(await js(CHIPBOX) ?? 'null')
check('⑦b 页签 chip 与列表分组 chip 同尺寸（padding 4px 11px、高 ≥29px、12.5px）',
  chip2?.pad === '4px 11px' && chip2.h >= 29 && chip2.font === '12.5px', `实测 ${JSON.stringify(chip2)}`)

/* ------------------------------------------------------------------ ⑧ 老 hub：桶里没有 tcp / udp */

const ok2 = await openDetail(2, 5)
// 第二张卡 → 识别色 red（列表卡的 8n 循环：1 teal / 2 red / 3 yellow）。
const red = JSON.parse(await js(ACCENT) ?? 'null')
check('⑦c 节点识别色随列表位置轮换：第二张卡 → red，荧光笔痕同色',
  red?.accent === 'red' && /^rgba?\(255, 107, 107/.test(red?.rule ?? ''),
  `accent ${red?.accent} / 笔痕 ${red?.rule}`)
const charts2 = JSON.parse(await js(CHARTS) ?? '[]')
const conn2 = charts2.find((c) => c.title === 'TCP / UDP 连接')
console.log(`    老 hub（无 tcp/udp 列）：${JSON.stringify(conn2)}`)
check('⑧ 老 hub：面板仍在、两条线一条都不画（留白，不连桥、不炸）',
  ok2 && !!conn2 && conn2.lines === 0, `主笔 ${conn2?.lines} 条`)

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)
