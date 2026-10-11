// 一次性探针：起本地伺服（静态 dist + /api/* 转上游），开 headless Chrome，
// 依次执行几段 JS 并把结果打回来。调试几何/状态用，不参与打包。
//
// 用法：node tools/probe.mjs <上游hub> <路径> "<expr1>" ["<expr2>" ...]
//   expr 里可以做任何事（点击、读 rect、切页签……），返回值原样打印。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = (process.argv[2] || '').replace(/\/$/, '')
const PATH_ = process.argv[3] || '/'
const EXPRS = process.argv.slice(4)
if (!UPSTREAM) { console.error('用法：node tools/probe.mjs <上游hub> <路径> "<expr>"…'); process.exit(2) }
const PORT = 5800 + Math.floor(Math.random() * 200)

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT), '', '', UPSTREAM], { stdio: 'ignore' })
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250)
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/nodes`)).ok } catch { /* 等 listen */ }
}
if (!up) { server.kill(); throw new Error('本地伺服没起来') }

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const DPORT = 9700 + Math.floor(Math.random() * 60)
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DPORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--disable-gpu', '--hide-scrollbars',
  '--user-data-dir=' + (process.env.LOCALAPPDATA || '/tmp') + '/Temp/rk2probe' + DPORT,
  '--window-size=1440,980', 'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 */ }
  if (!wsUrl) await sleep(300)
}
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r?.result?.exceptionDetails) return `❌ ${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`
  return r?.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${PATH_}` })
await sleep(3500)
for (const expr of EXPRS) {
  console.log('▶', expr.slice(0, 90).replace(/\n/g, ' '))
  console.log('  =', JSON.stringify(await evalJS(expr)))
  await sleep(1200)
}

chrome.kill()
server.kill()
