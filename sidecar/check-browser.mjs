// Throwaway. Answers two questions before anything is built:
//  1. Does Page.startScreencast produce a continuous stream in NEW headless
//     (full chromium, not chromium-headless-shell)?
//  2. Can a second, raw CDP client screencast and dispatch input on the same
//     pages while Playwright drives them?
import { chromium } from 'playwright-core'

const PORT = 9333
const PAGE = 'data:text/html,' + encodeURIComponent(`
  <body style="margin:0;background:#111">
  <canvas id=c width=600 height=400></canvas>
  <script>
    const ctx = c.getContext('2d'); let n = 0
    ;(function loop(){ n++; window.__frames = n
      ctx.fillStyle = '#111'; ctx.fillRect(0,0,600,400)
      ctx.fillStyle = 'hsl(' + (n*3 % 360) + ',80%,60%)'
      ctx.fillRect((n*7) % 560, 180, 40, 40)
      requestAnimationFrame(loop) })()
  </script></body>`)

let nextId = 0
function rpc(ws, method, params, sessionId) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    setTimeout(() => reject(new Error(method + ' timed out')), 10000)
  })
}

const browser = await chromium.launch({
  channel: 'chromium',           // the full binary => NEW headless, not the shell
  headless: true,
  args: [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=tauri://localhost,http://localhost:1420'
  ]
})
console.log('launched:', browser.version())

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
await page.goto(PAGE)

const version = await fetch(`http://localhost:${PORT}/json/version`).then((r) => r.json())
console.log('cdp endpoint host ok:', version.webSocketDebuggerUrl.includes('localhost'))

const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const { targetInfos } = await rpc(ws, 'Target.getTargets')
const target = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('data:'))
const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true })
console.log('attached a second CDP client alongside Playwright')

// Gotcha #5 from the plan: headless pages are hidden and unfocused.
await rpc(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)

let frames = 0
let firstAt = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method !== 'Page.screencastFrame') return
  frames++
  if (!firstAt) firstAt = Date.now()
  rpc(ws, 'Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId).catch(() => {})
})

await rpc(ws, 'Page.startScreencast',
  { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }, sessionId)

// Playwright drives while the raw client streams.
const t0 = Date.now()
await new Promise((r) => setTimeout(r, 4000))
await page.evaluate(() => (document.body.style.background = '#024'))
await rpc(ws, 'Input.dispatchMouseEvent',
  { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 }, sessionId)
await rpc(ws, 'Input.dispatchMouseEvent',
  { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 }, sessionId)
await new Promise((r) => setTimeout(r, 4000))
const secs = (Date.now() - t0) / 1000

const rafFrames = await page.evaluate(() => window.__frames)
const stillAlive = await page.title().then(() => true).catch(() => false)

console.log('---')
console.log(`screencast frames: ${frames} over ${secs.toFixed(1)}s  => ${(frames / secs).toFixed(1)} fps`)
console.log(`page rAF ticks:    ${rafFrames}  (headless rAF throttling check)`)
console.log(`playwright alive after a foreign client attached: ${stillAlive}`)
console.log(frames > 30 ? 'PASS: continuous stream in new headless' : 'FAIL: stream stalled')

await browser.close()
