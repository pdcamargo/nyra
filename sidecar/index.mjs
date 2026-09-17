// The browser sidecar. See README.md for the protocol.
//
// Nothing but protocol lines may go to stdout — diagnostics go to stderr, which
// Nyra logs. Pixels never come through here: the renderer holds its own CDP
// socket to Chromium and screencasts on its own sessions. This process launches
// the browser, owns one BrowserContext per chat, and keeps the tab registry.

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import net from 'node:net'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const emit = (event, params) => write({ event, params })
const log = (...parts) => process.stderr.write(`[sidecar] ${parts.join(' ')}\n`)

/** Config Nyra pushes down before anything is launched. */
let config = {
  /** 'chromium' is Playwright's own build; 'chrome' is the user's installed one. */
  channel: 'chromium',
  executablePath: null,
  viewport: { width: 1280, height: 800 },
  allowedOrigins: ['tauri://localhost']
}

let browser = null
let cdpPort = null
let cdpUrl = null
let launching = null

/** chatId -> { context, tabs: Map<tabId, Tab>, touchedAt } */
const chats = new Map()

/** A context with a real page in it measured at 220-490 MB, so three or four
 *  chats browsing at once is the whole budget. A chat nobody has looked at in
 *  ten minutes does not get to keep one; the renderer holds the tab list and
 *  rebuilds it on demand. */
const IDLE_EVICTION_MS = 10 * 60 * 1000
let sweeper = null
let tabSeq = 0

// ---------------------------------------------------------------- utilities

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Ask the DevTools endpoint for its browser-level WebSocket.
 *
 * Addressed as `localhost` rather than `127.0.0.1` deliberately: Chromium builds
 * the returned `webSocketDebuggerUrl` from the Host header it was given, and the
 * Tauri CSP allows `ws://localhost:*`. Asking by IP would hand back a URL the
 * renderer is not allowed to open.
 */
async function readCdpUrl(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`)
      const body = await res.json()
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch {
      // The port is not up yet.
    }
    await sleep(50)
  }
  throw new Error(`DevTools endpoint never came up on port ${port}`)
}

// ------------------------------------------------------------------- browser

function launchOptions() {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    // Without this Chromium answers the renderer's WebSocket with a 403: any
    // client that sends an Origin header has to be named here. Never `*` — the
    // pages this browser visits could otherwise open a socket to its own
    // debugging port and drive every chat's context.
    `--remote-allow-origins=${config.allowedOrigins.join(',')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--hide-scrollbars'
  ]
  const options = { headless: true, args }
  if (config.executablePath) options.executablePath = config.executablePath
  else options.channel = config.channel
  return options
}

async function ensureBrowser() {
  if (browser?.isConnected()) return cdpUrl
  if (launching) return launching
  launching = (async () => {
    cdpPort = await freePort()
    emit('browser', { state: 'launching' })
    browser = await chromium.launch(launchOptions())
    cdpUrl = await readCdpUrl(cdpPort)
    browser.on('disconnected', () => {
      log('chromium disconnected')
      browser = null
      cdpPort = null
      cdpUrl = null
      chats.clear()
      emit('browser', { state: 'gone' })
    })
    log(`chromium up on ${cdpUrl}`)
    emit('browser', { state: 'ready', cdpUrl })
    return cdpUrl
  })()
  try {
    return await launching
  } finally {
    launching = null
  }
}

/**
 * Is a usable Chromium on disk? Playwright throws a long "Executable doesn't
 * exist" message rather than exposing a predicate, so this is the predicate.
 */
async function probeExecutable() {
  if (config.executablePath) return { ok: true, path: config.executablePath }
  try {
    const path = chromium.executablePath({ channel: config.channel })
    const { access } = await import('node:fs/promises')
    await access(path)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

const CLI = fileURLToPath(new URL('./node_modules/playwright-core/cli.js', import.meta.url))

/**
 * Download the Chromium build this playwright-core expects.
 *
 * Shelling out to Playwright's own CLI rather than fetching the zip ourselves:
 * it knows which revision matches, where the registry wants it, and how to
 * clear the macOS quarantine attribute off a freshly downloaded binary.
 */
function installChromium() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'install', 'chromium', '--no-shell'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const onChunk = (buf) => {
      const text = buf.toString()
      // "|■■■■   |  30% of 182.1 MiB"
      const m = /(\d+)% of ([\d.]+) MiB/.exec(text)
      if (m) emit('install', { state: 'downloading', percent: Number(m[1]), totalMb: Number(m[2]) })
      else log('install:', text.trim())
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', (err) => resolve({ ok: false, error: String(err.message) }))
    child.on('close', (code) => {
      emit('install', { state: code === 0 ? 'done' : 'failed' })
      resolve(code === 0 ? { ok: true } : { ok: false, error: `playwright install exited ${code}` })
    })
  })
}

// ---------------------------------------------------------------------- tabs

function chatEntry(chatId) {
  const entry = chats.get(chatId)
  if (!entry) throw new Error(`chat ${chatId} has no browser`)
  return entry
}

async function snapshot(tab) {
  let canGoBack = false
  let canGoForward = false
  try {
    // Playwright exposes goBack()/goForward() but not whether they would do
    // anything, and a dead back button is worse than no back button.
    const history = await tab.cdp.send('Page.getNavigationHistory')
    // A tab starts life as about:blank and is then navigated, so "there is an
    // entry behind this one" is not the same as "back goes somewhere". Going
    // back to a blank page is worse than a disabled button.
    canGoBack = history.entries
      .slice(0, history.currentIndex)
      .some((entry) => entry.url && entry.url !== 'about:blank')
    canGoForward = history.currentIndex < history.entries.length - 1
  } catch {
    // The page is mid-navigation or gone; the defaults are the safe answer.
  }
  let title = ''
  try {
    title = await tab.page.title()
  } catch {
    // Same.
  }
  return {
    tabId: tab.tabId,
    targetId: tab.targetId,
    url: tab.page.url(),
    title,
    loading: tab.loading,
    canGoBack,
    canGoForward
  }
}

const pendingBroadcasts = new Map()

/**
 * Coalesce tab updates. A single navigation fires framenavigated, load and a
 * title change in quick succession, and each one would otherwise cost a round
 * trip per tab to rebuild the same snapshot.
 */
function broadcastTabs(chatId) {
  if (pendingBroadcasts.has(chatId)) return
  pendingBroadcasts.set(
    chatId,
    setTimeout(async () => {
      pendingBroadcasts.delete(chatId)
      const entry = chats.get(chatId)
      if (!entry) return
      const tabs = await Promise.all([...entry.tabs.values()].map(snapshot))
      emit('tabs', { chatId, tabs })
    }, 60)
  )
}

/** page -> the in-flight adoption for it. See adoptPage. */
const adopting = new WeakMap()

/**
 * Claim a Page as a tab, exactly once.
 *
 * `context.newPage()` and the context's own 'page' event both race to claim the
 * same Page. Handing both of them the *same promise* is what makes that safe: a
 * plain "already claimed" flag would leave whoever lost the race with nothing to
 * wait on, and it would go on to create a second tab for the same surface — or,
 * worse, report that the tab it just asked for does not exist. The lookup and
 * the store below have no await between them, so nothing can interleave.
 */
function adoptPage(chatId, entry, page) {
  const inFlight = adopting.get(page)
  if (inFlight) return inFlight
  const promise = doAdoptPage(chatId, entry, page)
  adopting.set(page, promise)
  return promise
}

async function doAdoptPage(chatId, entry, page) {
  const tabId = `t${++tabSeq}`
  const cdp = await entry.context.newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  const tab = { tabId, page, cdp, targetId: targetInfo.targetId, loading: false }
  entry.tabs.set(tabId, tab)

  const mark = (loading) => {
    tab.loading = loading
    broadcastTabs(chatId)
  }
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mark(true)
  })
  page.on('load', () => mark(false))
  page.on('domcontentloaded', () => broadcastTabs(chatId))
  page.on('close', () => {
    entry.tabs.delete(tabId)
    broadcastTabs(chatId)
  })
  // `window.open` and target=_blank become tabs in the strip rather than
  // vanishing into a surface nobody is rendering.
  page.on('popup', (popup) => {
    void adoptPage(chatId, entry, popup)
  })
  broadcastTabs(chatId)
  return tab
}

async function openChat(chatId) {
  await ensureBrowser()
  let entry = chats.get(chatId)
  if (!entry) {
    // A context per chat, not a process per chat: contexts isolate cookies and
    // storage for a fraction of the memory. Verified isolated in the spike.
    const context = await browser.newContext({ viewport: { ...config.viewport } })
    entry = { context, tabs: new Map(), touchedAt: Date.now() }
    chats.set(chatId, entry)
    startSweeper()
    context.on('page', (page) => {
      void adoptPage(chatId, entry, page)
    })
  }
  entry.touchedAt = Date.now()
  return { cdpUrl, chatId, viewport: { ...config.viewport } }
}

function startSweeper() {
  if (sweeper) return
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_EVICTION_MS
    for (const [chatId, entry] of [...chats]) {
      if (entry.touchedAt > cutoff) continue
      emit('evicted', { chatId })
      void closeChat(chatId)
    }
    if (chats.size === 0) {
      clearInterval(sweeper)
      sweeper = null
    }
  }, 60_000)
  sweeper.unref?.()
}

async function closeChat(chatId) {
  const entry = chats.get(chatId)
  if (!entry) return { closed: false }
  chats.delete(chatId)
  await entry.context.close().catch(() => {})
  // Nothing left to show means nothing left to run. 300 MB a chat is real.
  if (chats.size === 0 && browser?.isConnected()) {
    await browser.close().catch(() => {})
  }
  return { closed: true }
}

// ------------------------------------------------------------------ methods

const methods = {
  async configure({ patch }) {
    config = { ...config, ...patch }
    return { config }
  },

  async status() {
    const probe = await probeExecutable()
    return {
      chromium: probe.ok ? 'ready' : 'missing',
      executablePath: probe.path ?? null,
      error: probe.error ?? null,
      running: Boolean(browser?.isConnected()),
      cdpUrl,
      viewport: { ...config.viewport },
      chats: [...chats.keys()]
    }
  },

  install: () => installChromium(),

  'chat.open': ({ chatId }) => openChat(chatId),

  /** The renderer pings this while a surface for the chat is on screen, which
   *  is the only thing that can distinguish "idle" from "being watched" — the
   *  renderer's CDP traffic never reaches this process. */
  'chat.touch'({ chatId }) {
    const entry = chats.get(chatId)
    if (entry) entry.touchedAt = Date.now()
    return { touched: Boolean(entry) }
  },
  'chat.close': ({ chatId }) => closeChat(chatId),

  async 'tab.create'({ chatId, url }) {
    await openChat(chatId)
    const entry = chatEntry(chatId)
    const page = await entry.context.newPage()
    // The context's 'page' event usually wins the race above, so look the tab
    // up rather than assuming we are the one who created it.
    const tab = await adoptPage(chatId, entry, page)
    if (url) {
      await page.goto(url, { waitUntil: 'commit' }).catch((e) => log('goto failed:', e.message))
    }
    return { tab: await snapshot(tab) }
  },

  async 'tab.close'({ chatId, tabId }) {
    const entry = chatEntry(chatId)
    const tab = entry.tabs.get(tabId)
    if (tab) await tab.page.close().catch(() => {})
    return { closed: Boolean(tab) }
  },

  async 'tab.navigate'({ chatId, tabId, url }) {
    const tab = chatEntry(chatId).tabs.get(tabId)
    if (!tab) throw new Error(`no tab ${tabId}`)
    await tab.page.goto(url, { waitUntil: 'commit' })
    return { url: tab.page.url() }
  },

  async 'tab.back'({ chatId, tabId }) {
    const tab = chatEntry(chatId).tabs.get(tabId)
    await tab?.page.goBack({ waitUntil: 'commit' }).catch(() => {})
    return { url: tab?.page.url() ?? null }
  },

  async 'tab.forward'({ chatId, tabId }) {
    const tab = chatEntry(chatId).tabs.get(tabId)
    await tab?.page.goForward({ waitUntil: 'commit' }).catch(() => {})
    return { url: tab?.page.url() ?? null }
  },

  async 'tab.reload'({ chatId, tabId }) {
    const tab = chatEntry(chatId).tabs.get(tabId)
    await tab?.page.reload({ waitUntil: 'commit' }).catch(() => {})
    return { url: tab?.page.url() ?? null }
  },

  async 'tab.list'({ chatId }) {
    const entry = chats.get(chatId)
    if (!entry) return { tabs: [] }
    return { tabs: await Promise.all([...entry.tabs.values()].map(snapshot)) }
  },

  async shutdown() {
    for (const chatId of [...chats.keys()]) await closeChat(chatId)
    if (browser?.isConnected()) await browser.close().catch(() => {})
    return { ok: true }
  }
}

// ------------------------------------------------------------------- the loop

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    log('unparseable line:', line.slice(0, 200))
    return
  }
  const handler = methods[request.method]
  if (!handler) {
    write({ id: request.id, error: `unknown method ${request.method}` })
    return
  }
  try {
    write({ id: request.id, result: (await handler(request.params ?? {})) ?? {} })
  } catch (err) {
    write({ id: request.id, error: String(err?.message ?? err) })
  }
})

// stdin closing is Nyra going away. Take Chromium with us rather than leaving a
// headless browser and 300 MB a chat behind with nothing to talk to it.
rl.on('close', async () => {
  await methods.shutdown().catch(() => {})
  process.exit(0)
})

process.on('uncaughtException', (err) => log('uncaught:', err?.stack ?? String(err)))
process.on('unhandledRejection', (err) => log('unhandled:', String(err)))

emit('ready', { pid: process.pid, node: process.version })
