// 详情页延迟图「滚轮纵缩 / 拖线平移 / 双击复位 / 绘图区裁剪」的护栏
// （rakugaki-re；2026-10-30 与 rakugaki 同一口径）。
//
// 改动：图内原来那套「横向拖选一段放大」下线，换成 rakugaki 现行的手感——
//   · 滚轮收放**纵向**范围，锚点钉在光标压着的那个值上（页面不跟着滚）；
//   · 按住左键拖着线上下**平移**（只挪窗口、不改跨度）；
//   · 双击 / 右上角「重置」复位到自动量程；
//   · 绘图区加 clipPath：缩窄后越界的点画不出框外。
//
// 判据（轴的范围不是读刻度文字，是**用网格线位置线性反推**——刻度只挑范围内的整齐数，
// 它的首末值并不等于轴的上下沿）：
//   ① 初始：自动量程（夹具 20~200ms → 0~200ms）、没有「重置」按钮；
//   ② 光标贴**顶**滚轮：顶端不动（锚点）、下沿抬起来；页面 scrollY 不变；「重置」出现在图的右上角；
//   ③ 光标贴**底**滚轮：下沿不动、顶端压下来；
//   ④ 向下拖动：跨度不变（±2%）、窗口整体下移；
//   ⑤ 双击：回到 ① 的量程，「重置」消失；
//   ⑥ 滚轮后再点「重置」：同样回到 ①；
//   ⑦ 裁剪：线所在的 <g> 挂着 clipPath，且裁剪矩形与命中层矩形同几何；
//   ⑧ 缩窄后路径**确实**越界（所以裁剪不是摆设），但横向刻度一格没变（拖选缩放已下线）、
//      图里也不再有那块黄色的拖选矩形。
//
// 用法：node tools/verify_latency_zoom.mjs [端口]
//   dist 默认取 ./dist；DIST_DIR=... 指到别的构建（反向自测）。
//   ★对照纪律：拿**改动前的 dist** 跑这一份，②③④⑤⑥⑦⑧ 必须 FAIL（旧实现没有滚轮与平移、
//   没有「重置」、没有 clipPath，拖的是横向选区）。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5328)
const CDP_PORT = PORT + 4000
const ROOT = process.env.DIST_DIR || 'dist'
const SHOTS = process.env.SHOT_DIR || 'shots/latency-zoom'
mkdirSync(SHOTS, { recursive: true })
console.log(`护栏：延迟图滚轮纵缩 / 拖线平移 / 双击复位（dist = ${ROOT}，截图 ${SHOTS}）`)

let passed = 0
let failed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}
const r1 = (n) => Math.round(n * 10) / 10
const pct = (n) => `${Math.round(n * 1000) / 10}%`

/* ------------------------------------------------------------------ 桩数据 */

const GB = 1024 ** 3
const node = (id, name) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5,
  metrics: {
    uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
    net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
    tcp: 10, udp: 2, procs: 100,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.3.0',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const NODES = { nodes: [node(1, '缩放一号')] }

// 三条线路铺在 20~200ms 上（自动量程 0~200：niceScale(20,200) 的下沿就是 0）——
// 滚轮往里收时「贴顶滚 = 下沿抬、顶端不动」「贴底滚 = 下沿不动、顶端压」两头都能看出来。
const LOW = [0, 6, 12, 4, 9, 2, 8, 14]
const MID = [60, 70, 66, 74, 62, 68, 72, 64]
const HIGH = [150, 170, 160, 190, 155, 175, 165, 185]
const series = (taskId, vals) => Array.from({ length: 40 }, (_, i) => {
  const v = vals[i % vals.length]
  return { task_id: taskId, ts: Math.floor(Date.now() / 1000) - (40 - i) * 90, latency: v, band: [v - 4, v + 4], loss: 0 }
})
const PING = {
  1: {
    ping: [...series(11, LOW.map((v) => v + 20)), ...series(12, MID), ...series(13, HIGH)],
    probes: { 11: '测试低', 12: '测试中', 13: '测试高' },
    loss: { 11: 0, 12: 0, 13: 0 },
  },
}

let CONFIG = { pingLines: '' }

/* ------------------------------------------------------------------ 伺服 */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const serveFile = (res, path) => {
  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync(join(ROOT, 'index.html')))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '缩放校验', history_days: 30 }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = CONFIG
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      const id = Number(path.match(/^\/api\/nodes\/(\d+)\/metrics/)[1])
      const ping = PING[id] ?? { ping: [], probes: {}, loss: {} }
      body = url.searchParams.get('series') === 'ping'
        ? { metrics: [], ...ping }
        : { metrics: [], ping: [], probes: {}, loss: {} }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
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
  '--disable-renderer-backgrounding', '--no-proxy-server', '--window-size=1400,1200',
  `--user-data-dir=${join(tmpdir(), `rzzoom${CDP_PORT}`)}`,
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

const BASE = `http://127.0.0.1:${PORT}`
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false })

/* 读数：网格线（stroke-dasharray="2 5"）与 Y 刻度文字按 DOM 顺序一一对应（同一份 scale.ticks）。
   轴的上下沿不读刻度文字，而是拿「刻度值 ↔ y」两点线性反推：刻度只挑范围内的整齐数，
   首末那枚并不等于量程边界。 */
const READ = `(() => {
  const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
  if (!svg) return 'null'
  const grid = [...svg.querySelectorAll('line[stroke-dasharray="2 5"]')]
  const texts = [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'end')
  const pairs = grid.map((g, i) => ({ v: parseFloat((texts[i]?.textContent || '').trim()), y: parseFloat(g.getAttribute('y1')) }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.y))
  const hit = svg.querySelector('rect[fill="transparent"]')
  const hb = hit ? { y: parseFloat(hit.getAttribute('y')), h: parseFloat(hit.getAttribute('height')) } : null
  // 两点线性反推：value(y) = a + b·y
  let axis = null
  if (pairs.length >= 2) {
    const [p, q] = [pairs[0], pairs[pairs.length - 1]]
    const b = (q.v - p.v) / (q.y - p.y)
    const a = p.v - b * p.y
    if (hb) axis = { lo: Math.round((a + b * (hb.y + hb.h)) * 10) / 10, hi: Math.round((a + b * hb.y) * 10) / 10 }
  }
  const lines = [...svg.querySelectorAll('path[stroke-width="2.25"]')].map((p) => p.getAttribute('d') || '')
  // 路径里出现过的最大/最小 y（粗解析 d：只认数字对）
  let minY = Infinity, maxY = -Infinity
  for (const d of lines) {
    const nums = d.match(/-?\\d+(?:\\.\\d+)?/g) || []
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const y = Number(nums[i + 1])
      if (!Number.isFinite(y)) continue
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const clipG = svg.querySelector('g[clip-path]')
  const clipId = clipG ? (clipG.getAttribute('clip-path') || '').replace(/^url\\(#|\\)$/g, '') : ''
  const clipRect = clipId ? svg.querySelector('#' + clipId + ' rect') : null
  return JSON.stringify({
    ticks: texts.map((t) => t.textContent),
    axis,
    hit: hb,
    pathExtent: Number.isFinite(minY) ? { minY: Math.round(minY * 10) / 10, maxY: Math.round(maxY * 10) / 10 } : null,
    clip: clipRect ? {
      x: parseFloat(clipRect.getAttribute('x')), y: parseFloat(clipRect.getAttribute('y')),
      w: parseFloat(clipRect.getAttribute('width')), h: parseFloat(clipRect.getAttribute('height')),
    } : null,
    reset: !!([...document.querySelectorAll('[data-chart] button')].find((b) => (b.textContent || '').trim() === '重置')),
    brush: !!svg.querySelector('rect[fill="var(--yellow)"]'),
    xTicks: [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent).join('|'),
    scrollY: Math.round(scrollY),
  })
})()`

const read = async () => JSON.parse(await js(READ) ?? 'null')

/** 进详情页 → 点「网络延迟」→ 等曲线画出来。 */
async function openLatency() {
  await send('Page.navigate', { url: `${BASE}/node/1` })
  await sleep(1200)
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const clicked = await js(`(() => {
      const b = [...document.querySelectorAll('[data-detail] button')].find((x) => (x.textContent || '').trim() === '网络延迟')
      if (!b) return false
      b.click()
      return true
    })()`)
    if (clicked) break
  }
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    if (await js(`document.querySelectorAll('svg[aria-label="节点延迟走势"] path[stroke-width="2.25"]').length > 0`)) {
      await sleep(300)
      return true
    }
  }
  return false
}

const hitRect = async () => JSON.parse(await js(`(() => {
  const r = document.querySelector('svg[aria-label="节点延迟走势"] rect[fill="transparent"]').getBoundingClientRect()
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height })
})()`))

const wheelAt = async (x, y, deltaY) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' })
  await sleep(220)
}
const dragAt = async (x, y, dy) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + (dy * i) / 6, button: 'left', buttons: 1 })
    await sleep(30)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(220)
}
const dblclick = async () => {
  await js(`(() => {
    const el = document.querySelector('svg[aria-label="节点延迟走势"] rect[fill="transparent"]')
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  await sleep(250)
}

async function shot(name) {
  const clip = await js(`(() => {
    const el = document.querySelector('svg[aria-label="节点延迟走势"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, Math.round(r.x - 12)), y: Math.round(r.y + scrollY - 12), width: Math.round(r.width + 24), height: Math.round(r.height + 24), scale: 2 }
  })()`)
  if (!clip) return
  const r = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log(`   已拍 ${SHOTS}/${name}.png`)
}

/* ------------------------------------------------------------------ ① 初始 */

const ok = await openLatency()
check('详情页「网络延迟」页签画出来了', ok)

// 整宽延迟卡的歪头角度：资源卡是 .8° 那套，这张大卡专门压到 .2°（1200px 宽在 .8° 下两端差 17px，
// 读坐标时像「纸斜了」）。判据给一带区间：要「看得出是手贴的」又不「明显歪」。
const tilt = await js(`(() => {
  const p = document.querySelector('[data-detail] .dg-panel')
  if (!p) return null
  const m = getComputedStyle(p).transform
  if (!m || m === 'none' || !m.startsWith('matrix(')) return null
  const parts = m.slice(7, -1).split(',').map(Number)
  return Math.round(Math.atan2(parts[1], parts[0]) * 180 / Math.PI * 100) / 100
})()`)
check('⑨ 整宽延迟卡只留一点点歪（0.2~0.45°，站长定的 .3°；资源卡仍是 .8° 那套）',
  typeof tilt === 'number' && Math.abs(tilt) >= 0.2 && Math.abs(tilt) <= 0.45, `实测 ${tilt}°`)
await js(`document.querySelector('[data-chart]')?.scrollIntoView({ block: 'center' })`)
await sleep(400)
const base = await read()
console.log(`    初始轴 ${JSON.stringify(base.axis)} 刻度 ${JSON.stringify(base.ticks)}`)
check('① 初始是自动量程（夹具 20~200ms → 0~200ms，容差 3ms）',
  !!base.axis && Math.abs(base.axis.lo) <= 3 && Math.abs(base.axis.hi - 200) <= 3, `实测 ${JSON.stringify(base.axis)}`)
check('①b 初始没有「重置」按钮（没缩放过）', base.reset === false)
await shot('0-auto')

/* ------------------------------------------------------------------ ② 贴顶滚轮 */

let hb = await hitRect()
const xMid = hb.x + hb.w / 2
await wheelAt(xMid, hb.y + 2, -240)
const top = await read()
console.log(`    贴顶滚轮后 轴 ${JSON.stringify(top.axis)} 刻度 ${JSON.stringify(top.ticks)}`)
check('② 贴顶滚轮：顶端不动（锚点钉住，±3ms）', !!top.axis && Math.abs(top.axis.hi - base.axis.hi) <= 3, `${base.axis?.hi} → ${top.axis?.hi}`)
check('②b 贴顶滚轮：下沿抬起来（窗口变窄）', !!top.axis && top.axis.lo > base.axis.lo + 8, `${base.axis?.lo} → ${top.axis?.lo}`)
check('②c 滚轮不带着页面滚（preventDefault 生效）', top.scrollY === base.scrollY, `scrollY ${base.scrollY} → ${top.scrollY}`)
check('②d 缩放过才出现「重置」', top.reset === true)
// ★按钮位置单列一条：`.tap { position: relative }` 是未分层 CSS，会把绝对定位的工具类压掉，
//   按钮就掉进正常流跑到图下面去（实测过一次）。这条钉住「它真的贴在图的右上角」。
const resetPos = JSON.parse(await js(`(() => {
  const chart = document.querySelector('svg[aria-label="节点延迟走势"]').getBoundingClientRect()
  const b = [...document.querySelectorAll('[data-chart] button')].find((x) => (x.textContent || '').trim() === '重置')
  if (!b) return 'null'
  const r = b.getBoundingClientRect()
  return JSON.stringify({ rightGap: Math.round(chart.right - r.right), topGap: Math.round(r.top - chart.top), inside: r.left >= chart.left - 1 && r.right <= chart.right + 1 })
})()`) ?? 'null')
check('②d2 「重置」贴在图的右上角（没掉进正常流）',
  !!resetPos && resetPos.inside && Math.abs(resetPos.topGap) <= 4 && resetPos.rightGap >= -2 && resetPos.rightGap <= 14,
  `topGap ${resetPos?.topGap}px / rightGap ${resetPos?.rightGap}px / inside ${resetPos?.inside}`)
check('②e 滚轮收的是纵向：窗口跨度约 0.7 倍（e^-0.36）',
  !!top.axis && Math.abs((top.axis.hi - top.axis.lo) / (base.axis.hi - base.axis.lo) - 0.698) <= 0.08,
  `跨度比 ${pct((top.axis.hi - top.axis.lo) / (base.axis.hi - base.axis.lo))}`)
await shot('1-wheel-top')

/* ------------------------------------------------------------------ ⑤ 双击复位 */

await dblclick()
const back = await read()
console.log(`    双击复位后 轴 ${JSON.stringify(back.axis)}`)
check('⑤ 双击：量程回到自动档（±3ms）',
  !!back.axis && Math.abs(back.axis.lo - base.axis.lo) <= 3 && Math.abs(back.axis.hi - base.axis.hi) <= 3,
  `${JSON.stringify(back.axis)}`)
check('⑤b 双击后「重置」消失', back.reset === false)

/* ------------------------------------------------------------------ ③ 贴底滚轮 */

hb = await hitRect()
await wheelAt(xMid, hb.y + hb.h - 2, -240)
const bottom = await read()
console.log(`    贴底滚轮后 轴 ${JSON.stringify(bottom.axis)}`)
check('③ 贴底滚轮：下沿不动（锚点钉住，±3ms）', !!bottom.axis && Math.abs(bottom.axis.lo - base.axis.lo) <= 3, `${base.axis?.lo} → ${bottom.axis?.lo}`)
check('③b 贴底滚轮：顶端压下来', !!bottom.axis && bottom.axis.hi < base.axis.hi - 8, `${base.axis?.hi} → ${bottom.axis?.hi}`)

/* ------------------------------------------------------------------ ⑦/⑧ 裁剪与越界 */

check('⑦ 线所在的 <g> 挂着 clipPath，裁剪矩形与命中层同几何',
  !!bottom.clip && !!bottom.hit && Math.abs(bottom.clip.y - bottom.hit.y) <= 0.5 && Math.abs(bottom.clip.h - bottom.hit.h) <= 0.5,
  `clip ${JSON.stringify(bottom.clip)} / hit ${JSON.stringify(bottom.hit)}`)
check('⑧ 缩窄后路径确实越界（裁剪不是摆设）',
  !!bottom.pathExtent && !!bottom.hit && (bottom.pathExtent.maxY > bottom.hit.y + bottom.hit.h + 1 || bottom.pathExtent.minY < bottom.hit.y - 1),
  `路径 y ${JSON.stringify(bottom.pathExtent)}，绘图区 y ${bottom.hit?.y}~${r1(bottom.hit?.y + bottom.hit?.h)}`)
check('⑧b 横向刻度一格没变（拖选缩放已下线）', bottom.xTicks === base.xTicks, `「${base.xTicks}」→「${bottom.xTicks}」`)
await shot('2-wheel-bottom')

/* ------------------------------------------------------------------ ⑥ 「重置」按钮 */

await js(`(() => { const b = [...document.querySelectorAll('[data-chart] button')].find((x) => (x.textContent || '').trim() === '重置'); b && b.click(); return !!b })()`)
await sleep(250)
const reset = await read()
check('⑥ 点「重置」：量程回到自动档（±3ms）',
  !!reset.axis && Math.abs(reset.axis.lo - base.axis.lo) <= 3 && Math.abs(reset.axis.hi - base.axis.hi) <= 3,
  `${JSON.stringify(reset.axis)}`)
check('⑥b 点「重置」后按钮消失', reset.reset === false)

/* ------------------------------------------------------------------ ④ 拖线平移 */

hb = await hitRect()
const span0 = base.axis.hi - base.axis.lo
const shiftWanted = Math.round((40 / hb.h) * span0) // 拖 40px ⇒ 约 40/plotH·跨度
await dragAt(xMid, hb.y + hb.h / 2, 40)
const pan = await read()
console.log(`    向下拖 40px 后 轴 ${JSON.stringify(pan.axis)}`)
check('④ 拖动平移：窗口整体上移（下沿/顶端都升高）',
  !!pan.axis && pan.axis.lo > base.axis.lo + 10 && pan.axis.hi > base.axis.hi + 10,
  `${JSON.stringify(base.axis)} → ${JSON.stringify(pan.axis)}`)
check('④b 拖动不改跨度（±2%）',
  !!pan.axis && Math.abs((pan.axis.hi - pan.axis.lo) - span0) / span0 <= 0.02,
  `跨度 ${r1(span0)} → ${pan.axis ? r1(pan.axis.hi - pan.axis.lo) : '?'}`)
check('④c 位移量对得上（1px = span/plotH，±6ms）',
  !!pan.axis && Math.abs(pan.axis.lo - base.axis.lo - shiftWanted) <= 6,
  `实测位移 ${pan.axis ? r1(pan.axis.lo - base.axis.lo) : '?'}ms / 期望 ≈ ${shiftWanted}ms`)
check('⑧c 拖动没留下那块黄色拖选矩形', pan.brush === false)
await shot('3-pan')

/* ------------------------------------------------------------------ 手机视口冒烟 */

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
const okM = await openLatency()
check('手机 390：延迟图照常画出来（截图留档）', okM)
const overflow = await js(`document.documentElement.scrollWidth - window.innerWidth`)
check('手机 390：页面无横向溢出', typeof overflow === 'number' && overflow <= 1, `scrollWidth−innerWidth = ${overflow}px`)
await shot('4-mobile')

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)
