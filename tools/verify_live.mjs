// 公开站验收：对着线上 URL 跑 headless Chrome（走本机系统代理），
// 读 DOM 事实 + 拍亮/暗/手机三张图。判据挂主题自己的 data-* 锚点。
// 用法：node tools/verify_live.mjs <baseUrl> <输出目录>
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
  '--proxy-server=http://127.0.0.1:2080',
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
  return { ok: (c + r) >= 3 && p > 0 && document.fonts.status === 'loaded', c, r, p }
})()`

const FACTS = `(() => {
  const q = (s) => document.querySelector(s)
  const tools = [...document.querySelectorAll('.header-tools > *')].map((el) => el.getAttribute('title') || el.textContent.trim())
  const credit = q('.dg-credit')
  const footer = q('footer')
  const blog = q('a[data-komari-blog]')
  const js = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/assets\\/.*\\.js/.test(n))
  const meta = q('meta[name="theme-color"]')
  return {
    title: document.title,
    dark: document.documentElement.classList.contains('dark'),
    cards: document.querySelectorAll('[data-card]').length,
    rows: document.querySelectorAll('.dg-row').length,
    pins: document.querySelectorAll('.dg-pin').length,
    headerTools: tools,
    creditDisplay: credit ? getComputedStyle(credit).display : '(no .dg-credit)',
    footerVisible: footer ? !!(footer.offsetParent || footer.getClientRects().length) : '(no footer)',
    blogHref: blog ? blog.getAttribute('href') : null,
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

chrome.kill()
console.log('完成 →', OUT)
