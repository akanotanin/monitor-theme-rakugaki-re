// 一条命令拍完本地这一版：起静态伺服（静态走本机 dist/，/api/* 转真 hub）→ 摆好机位 →
// 连拍几张（亮/暗桌面、手机、详情页、延迟页）→ 收伺服。
//
// 用法：
//   node tools/shot.mjs <上游hub> [输出目录] [config JSON]
//   node tools/shot.mjs http://127.0.0.1:28085 shots/rakugaki2 '{"listTop":"both"}'
//
// 上游 hub 只监听回环时先在别处起隧道：
//   ssh -f -N -L 28085:127.0.0.1:28080 <hub 所在机器>
//
// 为什么要有它：本机 Hermes 的后台进程起不了 node（任何 node 命令都会立刻退出），所以
// 「先起服务器、再拍、最后收掉」不能分三条命令跑，只能由一个前台脚本把服务器 spawn 成
// 自己的子进程——见 tools/serve.mjs 顶部那段说明。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = (process.argv[2] || '').replace(/\/$/, '')
if (!UPSTREAM) { console.error('用法：node tools/shot.mjs <上游hub> [输出目录] [config JSON] [只拍名字含它]'); process.exit(2) }
const OUT = process.argv[3] || 'shots/local'
// 第四个参数是 config JSON（以 { 开头）；顺手防一手：有人把「只拍哪些」写在第 4 位
// （`… shots/x dark`）时，别把 dark 当 JSON 扔给伺服崩掉。
let CONFIG = process.argv[4] || ''
let ONLY = process.argv[5] || ''
if (CONFIG && !CONFIG.trimStart().startsWith('{')) { ONLY = CONFIG; CONFIG = '' }
const PORT = 5300 + Math.floor(Math.random() * 300)

mkdirSync(OUT, { recursive: true })

// 上游先探一下：隧道没起来的话，后面每一张图都会拍到「加载失败」，早失败早报清楚。
try {
  const probe = await fetch(`${UPSTREAM}/api/nodes`, { signal: AbortSignal.timeout(8000) })
  const body = await probe.json()
  console.log(`上游 OK：${UPSTREAM}/api/nodes → ${body.nodes?.length ?? '?'} 个节点`)
} catch (e) {
  console.error(`上游取不到（${UPSTREAM}）：${e.message}\n  先检查隧道：ssh -f -N -L <本地端口>:127.0.0.1:28080 <hub 所在机器>`)
  process.exit(3)
}

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT), CONFIG, '', UPSTREAM], { stdio: 'inherit' })
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250)
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/nodes`)).ok } catch { /* 等它 listen */ }
}
if (!up) { server.kill(); throw new Error('本地伺服没起来') }
const BASE = `http://127.0.0.1:${PORT}`

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

const DPORT = 9600 + Math.floor(Math.random() * 60)
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DPORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--user-data-dir=' + (process.env.LOCALAPPDATA || '/tmp') + '/Temp/rk2shots' + DPORT,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''))
})

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

async function waitFor(expr, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if (await evalJS(expr)) return true } catch { /* 页面还没就绪 */ }
    await sleep(180)
  }
  console.warn(`⚠ 等超时：${expr}`)
  return false
}

// 落定判据：卡片挂上 + 字体就位 + 至少一根读数条有宽度（数字动画与地图都落定了）。
const READY = `document.querySelectorAll('[data-card]').length > 0 && document.fonts.status === 'loaded' && [...document.querySelectorAll('.dg-fill')].some(f => f.getBoundingClientRect().width > 2)`

const shots = [
  { name: 'home-light', w: 1440, h: 980, dark: false },
  { name: 'home-full', w: 1440, h: 980, dark: false, full: true },
  { name: 'home-dark', w: 1440, h: 980, dark: true },
  { name: 'home-mobile', w: 390, h: 844, dark: false, mobile: true },
  { name: 'mobile-full', w: 390, h: 844, dark: false, mobile: true, full: true },
  { name: 'detail-light', w: 1440, h: 980, dark: false, detail: true },
  { name: 'detail-dark', w: 1440, h: 980, dark: true, detail: true },
  { name: 'latency-light', w: 1440, h: 980, dark: false, detail: true, latency: true },
  { name: 'detail-mobile', w: 390, h: 844, dark: false, mobile: true, detail: true },
]

let firstNode = null
for (const shot of shots.filter((s) => !ONLY || s.name.includes(ONLY))) {
  await send('Emulation.setDeviceMetricsOverride', { width: shot.w, height: shot.h, deviceScaleFactor: shot.mobile ? 3 : 1, mobile: !!shot.mobile })
  await send('Emulation.setUserAgentOverride', shot.mobile
    ? { userAgent: MOBILE_UA, platform: 'iPhone' }
    : { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', platform: 'Windows' })
  // 明暗：访客 override（localStorage 的 theme）。每次导航前重挂，刷新才带上。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: shot.dark ? `try{localStorage.setItem('theme','dark')}catch(e){}` : `try{localStorage.removeItem('theme')}catch(e){}`,
  })
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(READY)
  // 概览便签里那条走势线要攒够两个采样（hub 每 2 秒一推）才画得出来：多等一会儿，
  // 别把「还没攒够」拍成「没有这条线」。
  if (!shot.detail) {
    await waitFor(`[...document.querySelectorAll('.dg-memo svg polyline')].some(p => (p.getAttribute('points')||'').length > 4)`, 12000)
  }
  if (shot.detail) {
    if (!firstNode) firstNode = await evalJS(`document.querySelector('[data-card]')?.getAttribute('data-node')`)
    if (firstNode) {
      await send('Page.navigate', { url: `${BASE}/node/${firstNode}` })
      await waitFor(`document.querySelector('[data-detail]') !== null`)
      if (shot.latency) {
        const clicked = await evalJS(`(() => {
          const b = [...document.querySelectorAll('[data-detail] button')].find(b => b.textContent.trim() === '网络延迟')
          if (!b) return 'no-button'
          b.click()
          return 'clicked'
        })()`)
        console.log('  latency click:', clicked)
        const ok = await waitFor(`[...document.querySelectorAll('[data-chart]')].some(c => c.querySelector('svg path'))`, 20000)
        if (!ok) console.log('  DOM:', await evalJS(`document.querySelector('[data-detail]')?.innerText.replace(/\\s+/g, ' ').slice(0, 280)`))
        await sleep(800)
      } else {
        await waitFor(`[...document.querySelectorAll('[data-chart]')].some(c => c.querySelector('svg path'))`)
      }
    }
  }
  // 多等一帧，让过渡落定。
  await sleep(400)
  let shotData
  if (shot.full) {
    // 整页长图：按文档实际尺寸截（sticky 顶栏只出现在页首，符合静态长图的读法）。
    const m = await send('Page.getLayoutMetrics')
    const size = m?.result?.cssContentSize ?? m?.result?.contentSize
    shotData = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 5000), scale: 1 },
    })
  } else {
    shotData = await send('Page.captureScreenshot', { format: 'png' })
  }
  const file = `${OUT}/${shot.name}.png`
  writeFileSync(file, Buffer.from(shotData.result.data, 'base64'))
  const facts = await evalJS(`(() => ({
    title: document.title,
    cards: document.querySelectorAll('[data-card]').length,
    rows: document.querySelectorAll('.dg-row').length,
    pins: document.querySelectorAll('.dg-pin').length,
    fills: [...document.querySelectorAll('.dg-fill')].filter(f => f.getBoundingClientRect().width > 2).length,
    charts: document.querySelectorAll('[data-chart]').length,
    themeColor: document.querySelector('meta[name="theme-color"]')?.content,
    dark: document.documentElement.classList.contains('dark'),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))()`)
  console.log(`${shot.name.padEnd(15)} ${JSON.stringify(facts)}`)
}

if (errors.length) console.log('\n页面异常：\n' + errors.slice(0, 8).join('\n'))

chrome.kill()
server.kill()
console.log(`\n完成：${shots.length} 张 → ${OUT}/`)
