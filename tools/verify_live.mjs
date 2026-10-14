// 公开站验收：对着线上 URL 跑 headless Chrome，读 DOM 事实 + 拍亮/暗/手机三张图。
// 判据挂主题自己的 data-* 锚点（换实现时先看这里）。
//
// 站点在 CDN 后面、本机要走代理时给 PROXY 环境变量（如 PROXY=http://127.0.0.1:2080）；
// 不设就按本机 Chrome 自己的策略走。
// 用法：PROXY=... node tools/verify_live.mjs <baseUrl> <输出目录>
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = (process.argv[2] || '').replace(/\/+$/, '')
if (!BASE) { console.error('用法：node tools/verify_live.mjs <baseUrl> <输出目录>'); process.exit(2) }
const OUT = process.argv[3] || 'shots/live'
mkdirSync(OUT, { recursive: true })

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'
const DPORT = 9800 + Math.floor(Math.random() * 60)
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DPORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  ...(process.env.PROXY ? [`--proxy-server=${process.env.PROXY}`] : []),
  '--user-data-dir=' + (process.env.LOCALAPPDATA || '/tmp') + '/Temp/rklive' + DPORT,
  '--window-size=1440,980', 'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等它起来 */ }
  if (!wsUrl) await sleep(300)
}
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r?.result?.exceptionDetails) return `❌ ${r.result.exceptionDetails.text}`
  return r?.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

const READY = `(() => {
  const c = document.querySelectorAll('[data-card]').length
  const r = document.querySelectorAll('.dg-row').length
  const p = document.querySelectorAll('.dg-pin').length
  // 地图默认关（设置项的默认就是关）：图钉数只带出来看，不当就绪条件。
  return { ok: (c + r) >= 3 && document.fonts.status === 'loaded', c, r, p }
})()`

const FACTS = `(() => {
  const q = (s) => document.querySelector(s)
  const tools = [...document.querySelectorAll('.header-tools > *')].map((el) => el.getAttribute('title') || el.textContent.trim())
  const js = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/assets\\/.*\\.js/.test(n))
  const meta = q('meta[name="theme-color"]')
  return {
    title: document.title,
    dark: document.documentElement.classList.contains('dark'),
    cards: document.querySelectorAll('[data-card]').length,
    rows: document.querySelectorAll('.dg-row').length,
    pins: document.querySelectorAll('.dg-pin').length,
    headerTools: tools,
    farmEntry: !!q('a[title="养鸡场"]'),
    fontShantell: document.fonts.check('16px "Shantell Sans"'),
    fontCaveat: document.fonts.check('16px "Caveat"'),
    themeColor: meta ? meta.content : null,
    chunks: js,
  }
})()`

const shots = [
  { name: 'live-desktop-light', w: 1440, h: 980, mobile: false, scheme: 'light' },
  { name: 'live-desktop-dark', w: 1440, h: 980, mobile: false, scheme: 'dark' },
  { name: 'live-mobile', w: 390, h: 844, mobile: true, scheme: 'light' },
]

for (const s of shots) {
  await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.mobile })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.scheme }] })
  await send('Page.navigate', { url: `${BASE}/` })
  let ready = { ok: false }
  for (let i = 0; i < 40; i++) {
    await sleep(700)
    const r = await evalJS(READY)
    if (r && r.ok) { ready = r; break }
    ready = r ?? ready
  }
  if (!ready.ok) console.log(`⚠ ${s.name}: 就绪条件超时`, JSON.stringify(ready))
  await sleep(600)
  const facts = await evalJS(FACTS)
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(png.result.data, 'base64'))
  console.log(`== ${s.name} ==`)
  console.log(JSON.stringify(facts, null, 1))
}

// ---- 追加断言：网速行不折行（窄宽度）+ 清单行「点行展开 / 点名进详情」----
// 都是结构断言：与具体数据无关，站点上有几台、叫什么不影响判定。
const RESULTS = []
const check = (name, ok, detail = '') => { RESULTS.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

// ① 网速行：334 / 320 两个窄档不能折行（桌面 4 列同款窄卡片的回归也由这两个档露头）
for (const w of [334, 320]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 880, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(2500)
  const rows = await evalJS(`(() => {
    const out = []
    for (const c of document.querySelectorAll('[data-card="doodle"]')) {
      const net = c.querySelector('[data-net]'); if (!net) continue
      const spans = [...net.querySelectorAll(':scope > span')]
      const ys = spans.map(s => s.getBoundingClientRect().y)
      out.push({ name: c.querySelector('h3')?.textContent, box: +net.getBoundingClientRect().width.toFixed(1), wrapped: ys.length > 1 && Math.abs(ys[0] - ys[ys.length - 1]) > 4 })
    }
    return out
  })()`)
  if (Array.isArray(rows) && rows.length) {
    const wrapped = rows.filter((r) => r.wrapped)
    check(`网速行 ${w}px：全部单行（${rows.length} 张卡）`, wrapped.length === 0, wrapped.map((r) => `${r.name}[${r.box}px]`).join('; '))
  } else {
    console.log(`（${w}px：站点默认形态不是涂鸦卡片，跳过）`)
  }
}

// ② 清单：点行展开延迟 / 点名字进详情。用访客偏好（localStorage）强制切到清单来看，
//    站点配置一个字不动；跑的是真 React 组件与真接口。
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('rakugaki-re:card_style','checklist')}catch(e){}` })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `${BASE}/` })
let hasRows = false
for (let i = 0; i < 30 && !hasRows; i++) { await sleep(500); hasRows = !!(await evalJS(`document.querySelectorAll('.dg-row').length > 0`)) }
if (hasRows) {
  await evalJS(`document.querySelectorAll('.dg-row')[0].click()`)
  let opened = false
  for (let i = 0; i < 30 && !opened; i++) { await sleep(450); opened = !!(await evalJS(`document.querySelector('[data-fold] [data-chart] path') !== null`)) }
  check('清单：点整行展开延迟面板（走势图已画出）', opened === true)
  const parts = await evalJS(`(() => {
    const fold = document.querySelector('[data-fold]')
    if (!fold) return null
    const ranges = [...fold.querySelectorAll('[aria-label="时间范围"] button')]
    const legend = [...fold.querySelectorAll('button[aria-pressed]')].filter((b) => !ranges.includes(b))
    return {
      ranges: ranges.length,
      active: ranges.filter((b) => b.getAttribute('aria-pressed') === 'true').length,
      despike: !!fold.querySelector('[role="checkbox"]'),
      fullDetail: [...fold.querySelectorAll('button')].some((b) => b.textContent.includes('完整详情')),
      legend: legend.length,
    }
  })()`)
  check('清单：展开块含范围/削峰/完整详情/图例', !!parts && parts.ranges >= 4 && parts.active === 1 && parts.despike && parts.fullDetail && parts.legend >= 1, JSON.stringify(parts))
  // 削峰勾选态：未勾选时框里不能有对勾（svg），点一下才出现（点完还原）——
  // 防「.dg-check 的未分层 color 压过 text-transparent」那类级联层静默失效回潮。
  const d0 = await evalJS(`(() => { const b = document.querySelector('[data-fold] [role=checkbox]'); return { aria: b && b.getAttribute('aria-checked'), glyph: !!(b && b.querySelector('svg')) } })()`)
  await evalJS(`document.querySelector('[data-fold] [role=checkbox]').click()`)
  await sleep(300)
  const d1 = await evalJS(`(() => { const b = document.querySelector('[data-fold] [role=checkbox]'); return { aria: b && b.getAttribute('aria-checked'), glyph: !!(b && b.querySelector('svg')) } })()`)
  await evalJS(`document.querySelector('[data-fold] [role=checkbox]').click()`)
  await sleep(300)
  check('清单：削峰未勾选不显勾、点后出现（已还原）', d0.aria === 'false' && d0.glyph === false && d1.aria === 'true' && d1.glyph === true, JSON.stringify({ d0, d1 }))
  const aria = await evalJS(`document.querySelector('.dg-row[aria-expanded="true"]') !== null`)
  check('清单：展开行 aria-expanded=true', aria === true)
  await evalJS(`(document.querySelectorAll('.dg-row')[1] || document.querySelectorAll('.dg-row')[0]).click()`)
  await sleep(600)
  const folds = await evalJS(`document.querySelectorAll('[data-fold]').length`)
  check('清单：单开手风琴（同时只开一行）', folds === 1, `folds=${folds}`)
  const href = await evalJS(`(() => { const a = document.querySelector('.dg-row a.dg-name-link'); if (!a) return null; const h = a.getAttribute('href'); a.click(); return h })()`)
  await sleep(900)
  const path = await evalJS(`location.pathname`)
  check('清单：点名字进详情页', typeof href === 'string' && href.startsWith('/node/') && path === href, `href=${href} path=${path}`)
} else {
  console.log('（清单行没出来：站点数据或形态异常，跳过）')
}

// ③ 离线沉底（live）：DOM 顺序 == 现场拉 /api/nodes 现算的期望序（在线优先、组内 sort/id）。
//    与 tools/verify_offline_last.mjs 同口径，这里跑在真站上（站点没有离线机时退化为「在线按 sort」）。
await send('Page.navigate', { url: `${BASE}/` })
let listReady = false
for (let i = 0; i < 40 && !listReady; i++) { await sleep(500); listReady = !!(await evalJS(`document.querySelectorAll('article[data-card][data-node], .dg-row[data-node]').length > 0`)) }
const O = JSON.parse(await evalJS(`(async () => {
  const api = await (await fetch('/api/nodes')).json()
  const nodes = api.nodes ?? []
  const expected = [...nodes].sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1) || a.sort - b.sort || a.id - b.id).map((n) => n.id)
  const dom = [...document.querySelectorAll('article[data-card][data-node], .dg-row[data-node]')].map((c) => +c.getAttribute('data-node'))
  return JSON.stringify({ expected, dom, offline: nodes.filter((n) => !n.online).length, total: nodes.length })
})()`) ?? '{}')
check(`★ 列表顺序 = 在线优先（离线沉底；共 ${O.total} 台 / 离线 ${O.offline} 台）`,
  listReady && Array.isArray(O.dom) && O.dom.length > 0 && JSON.stringify(O.dom) === JSON.stringify(O.expected),
  `期望 ${O.expected?.join(',')} / 实测 ${O.dom?.join(',')}`)

// ④ 详情页连接数（live）：hub 上报 `metrics.tcp / udp` 时两格必须在且是数字；没上报则两格隐身。
const nodeId = await evalJS(`(async () => {
  const api = await (await fetch('/api/nodes')).json()
  const n = (api.nodes ?? []).find((x) => x.online && x.metrics) ?? (api.nodes ?? [])[0]
  return n ? n.id : null
})()`)
if (nodeId) {
  await send('Page.navigate', { url: `${BASE}/node/${nodeId}` })
  let hasFacts = false
  for (let i = 0; i < 40 && !hasFacts; i++) { await sleep(500); hasFacts = !!(await evalJS(`document.querySelectorAll('.dg-fact dt').length > 0`)) }
  const F = JSON.parse(await evalJS(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('.dg-fact dt')].map((d) => [d.textContent.trim(), d.nextElementSibling ? d.nextElementSibling.textContent.trim() : null])))`) ?? '{}')
  const hubHas = await evalJS(`(async () => { const api = await (await fetch('/api/nodes')).json(); const n = (api.nodes ?? []).find((x) => x.id === ${nodeId}); return !!(n && n.metrics && typeof n.metrics.tcp === 'number') })()`)
  const tcpOk = hubHas ? /^\d+$/.test(F['TCP 连接'] ?? '') : !('TCP 连接' in F)
  const udpOk = hubHas ? /^\d+$/.test(F['UDP 连接'] ?? '') : !('UDP 连接' in F)
  check('★ 详情页「TCP 连接」/「UDP 连接」（hub 有上报则在且是数字；没上报则两格隐身）',
    hasFacts && tcpOk && udpOk,
    `节点 ${nodeId}：TCP=${F['TCP 连接']} UDP=${F['UDP 连接']} hub带此字段=${hubHas}`)
} else {
  console.log('（没有节点可开详情页，跳过连接数断言）')
}

const fails = RESULTS.filter((ok) => !ok).length
console.log(`\n==== live 断言: ${RESULTS.length - fails} PASS / ${fails} FAIL ====`)
if (fails) process.exitCode = 1

chrome.kill()
console.log('完成 →', OUT)
