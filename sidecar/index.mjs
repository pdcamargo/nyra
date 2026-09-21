// The browser sidecar. See README.md for the protocol.
//
// Nothing but protocol lines may go to stdout — diagnostics go to stderr, which
// Nyra logs. Pixels never come through here: the renderer holds its own CDP
// socket to Chromium and screencasts on its own sessions. This process launches
// the browser, owns one BrowserContext per chat, and keeps the tab registry.

import { chromium } from 'playwright-core'
import { ChatMcp } from './mcp.mjs'
import { DEVICES, DEVICE_TOOL, resolveDevice } from './devices.mjs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

/**
 * Leaving is not optional.
 *
 * When Nyra goes away its ends of these pipes close, and the next write fails
 * with EPIPE. Node surfaces that as an unhandled stream error, which becomes an
 * uncaughtException — and the handler for that used to `log()`, writing to the
 * same broken pipe and throwing again. That is an unbounded loop of Error
 * construction and stack formatting: four of these were found pinning a core
 * each, the oldest fifteen hours old, long after the app that started them had
 * quit.
 *
 * So: writes can never throw, a broken pipe means the parent is gone, and going
 * is immediate. Chromium is not closed on the way out — it is a child of this
 * process and loses its pipe when we go, and waiting on it is exactly the tidy
 * shutdown that failed to finish last time.
 */
let leaving = false

function leave(code = 0) {
  if (leaving) return
  leaving = true
  try {
    process.exit(code)
  } catch {
    // An 'exit' listener threw. There is nothing left worth saving.
  }
  // `process.exit` runs listeners first, so this is the floor if one of them
  // hangs or the event loop refuses to give up.
  process.kill(process.pid, 'SIGKILL')
}

function writeTo(stream, text) {
  if (leaving) return
  try {
    stream.write(text)
  } catch (err) {
    // EPIPE, EBADF, ERR_STREAM_DESTROYED — every one of them means the other
    // end is gone, and there is nobody left to tell.
    leave(0)
  }
}

const write = (obj) => writeTo(process.stdout, JSON.stringify(obj) + '\n')
const emit = (event, params) => write({ event, params })
const log = (...parts) => writeTo(process.stderr, `[sidecar] ${parts.join(' ')}\n`)

// The async half: a failed write reports through the stream's error event
// rather than by throwing, so it needs catching here too.
process.stdout.on('error', () => leave(0))
process.stderr.on('error', () => leave(0))

/** Config Nyra pushes down before anything is launched. */
let config = {
  /**
   * `auto` prefers the Chrome the user already has and falls back to
   * Playwright's own build. Most developers on a machine like this have Chrome,
   * and using it means no 182 MB download on first run and a page that renders
   * exactly the way it will for them. `chromium` and `chrome` pin it.
   */
  channel: 'auto',
  executablePath: null,
  viewport: { width: 1280, height: 800 },
  /** What a page should believe its `devicePixelRatio` is. Seeded from the
   *  renderer's own screen at `chat.open`, because it is a context option in
   *  Playwright and there is no per-page setter. */
  deviceScaleFactor: 1,
  allowedOrigins: ['tauri://localhost']
}

let browser = null
let cdpPort = null
let cdpUrl = null
let launching = null

/** chatId -> { context, tabs: Map<tabId, Tab>, touchedAt } */
const chats = new Map()

/** chatId -> ChatMcp. Outlives the context: Claude's connection is per session,
 *  and an evicted context is rebuilt by the tool call that needs it. */
const mcpByChat = new Map()

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
  else options.channel = resolvedChannel ?? config.channel
  return options
}

/** What probeExecutable settled on, so the launch and the status agree. */
let resolvedChannel = null

async function ensureBrowser() {
  if (browser?.isConnected()) return cdpUrl
  if (launching) return launching
  launching = (async () => {
    const probe = await probeExecutable()
    if (!probe.ok) throw new Error(probe.error)
    resolvedChannel = probe.channel
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
  if (config.executablePath) return { ok: true, path: config.executablePath, channel: null }

  const { access } = await import('node:fs/promises')
  const exists = async (path) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  // `channel: 'chrome'` launches the Chrome the user installed, but
  // `executablePath({ channel: 'chrome' })` answers with Playwright's own build
  // either way — it reports the registry, not what a launch would pick. So
  // Chrome gets located the honest way.
  const SYSTEM_CHROME = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  ]

  const usable = async (channel) => {
    if (channel === 'chrome') {
      for (const path of SYSTEM_CHROME) {
        if (await exists(path)) return { ok: true, path, channel }
      }
      return { ok: false, error: 'Google Chrome is not installed.', channel }
    }
    try {
      const path = chromium.executablePath({ channel })
      if (await exists(path)) return { ok: true, path, channel }
      return { ok: false, error: `No Chromium at ${path}`, channel }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err), channel }
    }
  }

  if (config.channel !== 'auto') return usable(config.channel)

  // The user's own Chrome first: nothing to download, and what it renders is
  // literally what their users will see. Playwright's build is the fallback for
  // a machine without one.
  const chrome = await usable('chrome')
  return chrome.ok ? chrome : usable('chromium')
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
    canGoForward,
    // The renderer scales the canvas by this and maps clicks through it, so it
    // travels with the tab rather than being asked for separately.
    device: tab.device ? { ...tab.device } : null
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

/**
 * Put a size on a tab, and make it stick.
 *
 * Order matters. Playwright caches the metrics override it last sent and
 * re-sends it from its own session whenever a cross-process navigation builds a
 * new FrameSession — `FrameSession._updateViewport` reads width and height from
 * the page's emulated size but `deviceScaleFactor` and `isMobile` from the
 * *context* options. Calling `setViewportSize` first is what keeps its cache
 * agreeing with ours about the size; the pixel ratio and the mobile flag it
 * will still stomp, which is what the re-assert on `framenavigated` is for.
 *
 * `mobile` is not cosmetic: it is what makes Chromium honour
 * `<meta name="viewport">`. Without it a phone preset lays a desktop page out
 * narrow instead of serving the mobile one, which is the opposite of the point.
 */
async function applyDevice(tab, device) {
  await tab.page.setViewportSize({ width: device.width, height: device.height }).catch(() => {})
  await tab.cdp
    .send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      screenWidth: device.width,
      screenHeight: device.height
    })
    .catch(() => {})
  await tab.cdp
    .send('Emulation.setTouchEmulationEnabled', {
      enabled: device.hasTouch,
      // The protocol rejects 0 even when disabling.
      maxTouchPoints: device.hasTouch ? 5 : 1
    })
    .catch(() => {})
  // The first thing to drop if clicking in the panel starts misbehaving: this
  // turns the user's mouse into taps, which hover-driven pages can read badly.
  await tab.cdp
    .send('Emulation.setEmitTouchEventsForMouse', {
      enabled: device.hasTouch,
      configuration: device.mobile ? 'mobile' : 'desktop'
    })
    .catch(() => {})
  tab.device = device
}

/** Only the parts Playwright takes from context options can be stomped, so only
 *  those are worth a round trip on every navigation. */
function divergesFromContext(device, entry) {
  return device.deviceScaleFactor !== entry.contextDpr || device.mobile || device.hasTouch
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
  const tab = { tabId, page, cdp, targetId: targetInfo.targetId, loading: false, device: entry.device }
  entry.tabs.set(tabId, tab)
  // Before the first broadcast, so the panel never sees a frame at the context
  // size and then a second one at the real size.
  await applyDevice(tab, entry.device)

  const mark = (loading) => {
    tab.loading = loading
    broadcastTabs(chatId)
  }
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    mark(true)
    // A cross-process navigation builds a new FrameSession, and Playwright
    // re-applies the context's pixel ratio and mobile flag from it. Anything
    // that differs from the context has to be put back or the page quietly
    // reverts mid-session.
    if (tab.device && divergesFromContext(tab.device, entry)) void applyDevice(tab, tab.device)
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

/**
 * The tools Nyra answers itself, bound to one chat.
 *
 * The shape every future one of these should copy: the model asks, the owner of
 * the state changes it, and the UI learns through the broadcast it already
 * listens to. Nothing here is reported back through the tool result except
 * words for the model — the panel finds out the same way it finds out about a
 * navigation.
 */
function localToolsFor(chatId) {
  return {
    [DEVICE_TOOL.name]: {
      schema: DEVICE_TOOL,
      async handle({ device: id, width, height }) {
        const entry = chatEntry(chatId)
        // Newest first, the order `readPointer` already resolves in: the agent
        // means the tab it has been working in. A tabId argument would only
        // invite a stale one, since the ids it sees come from a different list.
        const tab = [...entry.tabs.values()].pop()
        if (!tab) throw new Error('This chat has no open browser tab to size.')
        const device = resolveDevice({ id, width, height, hostDpr: entry.hostDpr, by: 'agent' })
        await applyDevice(tab, device)
        broadcastTabs(chatId)
        const touch = device.mobile ? ', mobile layout with touch' : ''
        return (
          `Rendering at ${device.label} \u2014 ${device.width}x${device.height} ` +
          `at ${device.deviceScaleFactor}x${touch}. The user can see the panel reframe, ` +
          `and the size is labelled in their address bar.`
        )
      }
    }
  }
}

/** Where the pointer last went on any of this chat's tabs, newest first. */
async function readPointer(chatId) {
  const entry = chats.get(chatId)
  if (!entry) return null
  for (const tab of [...entry.tabs.values()].reverse()) {
    try {
      const seen = await tab.page.evaluate(() => window.__nyraPointer ?? null)
      if (seen) return { ...seen, tabId: tab.tabId }
    } catch {
      // Mid-navigation, or the tab went away.
    }
  }
  return null
}

/** Tell the panel where the agent's cursor ended up, if it moved at all. */
async function reportPointer(chatId, before) {
  const after = await readPointer(chatId)
  if (!after) return
  // Only a move that happened during the tool call was the agent's.
  if (before && before.seq === after.seq && before.tabId === after.tabId) return
  emit('cursor', { chatId, tabId: after.tabId, x: after.x, y: after.y, down: Boolean(after.down) })
}

/**
 * Let the ghost reach the target before the click lands.
 *
 * Nyra used to learn where the agent clicked by reading the page afterwards,
 * which meant the panel showed the click and *then* the travel — backwards, and
 * it read as teleporting. Resolving the target first turns it the right way
 * round: the cursor sets off, arrives, and only then does the input fire.
 *
 * The wait is a fixed budget rather than an acknowledgement from the panel.
 * Codex does ack, capped at 1500 ms, but it has a renderer that already talks
 * back on that channel; here it would mean a new renderer-to-sidecar round trip
 * to time an animation whose duration we already know. The cost of guessing is
 * one frame of overlap, and the cost of being wrong is cosmetic.
 *
 * Nothing is spent when nobody is watching, which is the case that would
 * otherwise turn a headless agent run into one that pauses a third of a second
 * per click for an animation on a closed panel.
 */
const GLIDE_MS = 320
const WATCHED_MS = 90_000

/** Upstream's own shape for "which element": a snapshot ref like `e7` or
 *  `f2e7`, or anything else, which is a selector. Only refs are worth
 *  resolving here — they are what a snapshot produces and what the model
 *  actually sends, and a selector expression needs upstream's own parser. */
const REF_PATTERN = /^(f\d+)?e\d+$/

/** Every tool that moves the pointer names its target the same way, so keying
 *  off that covers them all without a list of tool names to keep in step. */
function targetOf(args) {
  if (!args || typeof args !== 'object') return null
  if (typeof args.target === 'string') return args.target
  const first = Array.isArray(args.fields) ? args.fields[0] : null
  return typeof first?.target === 'string' ? first.target : null
}

async function glideTo(chatId, params) {
  const entry = chats.get(chatId)
  if (!entry || Date.now() - (entry.watchedAt ?? 0) > WATCHED_MS) return
  const target = targetOf(params?.arguments)
  if (!target || !REF_PATTERN.test(target)) return
  const tab = [...entry.tabs.values()].pop()
  if (!tab) return
  try {
    // `aria-ref` is the selector engine those refs belong to, which is how
    // upstream resolves them too — so this lands on exactly the element the
    // tool is about to act on.
    const box = await tab.page.locator(`aria-ref=${target}`).boundingBox({ timeout: 500 })
    if (!box) return
    emit('cursor', {
      chatId,
      tabId: tab.tabId,
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      down: false
    })
    await sleep(GLIDE_MS)
  } catch {
    // A stale ref, a detached element, a page mid-navigation. Upstream will
    // report that properly; a missing flourish is not worth failing a call for.
  }
}

/**
 * Which tab the agent is working in, whether or not it moved the pointer.
 *
 * The ghost used to appear only when a click or a hover happened to move the
 * pointer, which meant it flashed for four seconds a few times a turn and was
 * missable to the point of never having been seen. Having the wheel is a state,
 * not an event: this says who has it, and the panel keeps the cursor on screen
 * for as long as that holds. A tool call that types, scrolls or navigates still
 * counts as driving, and still has nowhere to put a pointer — so the panel
 * parks one rather than showing nothing.
 */
function reportDriving(chatId) {
  const entry = chats.get(chatId)
  if (!entry) return
  const tab = [...entry.tabs.values()].pop()
  if (!tab) return
  emit('driving', { chatId, tabId: tab.tabId })
}

async function openChat(chatId, { hostDpr } = {}) {
  await ensureBrowser()
  let entry = chats.get(chatId)
  if (!entry) {
    // The pixel ratio has to be decided here and nowhere else: Playwright takes
    // it from context options, so there is no way to set it per page, and a
    // page on a Retina machine should see the ratio its owner's real browser
    // would. Tabs that want a different one get a CDP override on top.
    const dpr = Number.isFinite(hostDpr) && hostDpr > 0 ? hostDpr : config.deviceScaleFactor
    // A context per chat, not a process per chat: contexts isolate cookies and
    // storage for a fraction of the memory. Verified isolated in the spike.
    const context = await browser.newContext({
      viewport: { ...config.viewport },
      deviceScaleFactor: dpr
    })
    // Codex shows a cursor while its agent drives, and it is the thing that
    // makes the browser feel co-driven rather than haunted. Nothing at the CDP
    // layer can tell the agent's synthetic click from the user's — they are the
    // same kind of event — so the page records where the pointer went and the
    // MCP handler reads it either side of a tool call. What moved during the
    // call was the agent.
    await context.addInitScript(() => {
      const record = (event, down) => {
        window.__nyraPointer = {
          x: event.clientX,
          y: event.clientY,
          // A press is worth drawing differently from a glide, and the page is
          // the only place the difference is visible.
          down,
          seq: (window.__nyraPointer?.seq ?? 0) + 1
        }
      }
      addEventListener('pointerdown', (e) => record(e, true), true)
      addEventListener('pointermove', (e) => record(e, false), true)
    })
    entry = {
      context,
      tabs: new Map(),
      touchedAt: Date.now(),
      /** What the context was built with, and therefore what Playwright will
       *  put back on a cross-process navigation. */
      contextDpr: dpr,
      hostDpr: dpr,
      /** When a surface last said it was on screen. See `chat.touch`. */
      watchedAt: 0,
      /** What a tab opened from now on starts at. Each tab then owns its own
       *  copy and can diverge from it. */
      device: resolveDevice({
        id: 'responsive',
        width: config.viewport.width,
        height: config.viewport.height,
        hostDpr: dpr
      })
    }
    chats.set(chatId, entry)
    startSweeper()
    context.on('page', (page) => {
      void adoptPage(chatId, entry, page)
    })
  }
  entry.touchedAt = Date.now()
  return {
    cdpUrl,
    chatId,
    viewport: { ...config.viewport },
    device: { ...entry.device },
    // The menu is built from the same array the agent's tool validates against,
    // so the two cannot drift.
    devices: DEVICES
  }
}

function startSweeper() {
  if (sweeper) return
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_EVICTION_MS
    for (const [chatId, entry] of [...chats]) {
      if (entry.touchedAt > cutoff) continue
      emit('evicted', { chatId })
      // The chat still exists and Claude still holds a connection to its
      // tools; only the memory goes.
      void closeChat(chatId, { keepMcp: true })
    }
    if (chats.size === 0) {
      clearInterval(sweeper)
      sweeper = null
    }
  }, 60_000)
  sweeper.unref?.()
}

async function closeChat(chatId, { keepMcp = false } = {}) {
  if (!keepMcp) {
    await mcpByChat.get(chatId)?.close()
    mcpByChat.delete(chatId)
  }
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
      channel: probe.channel ?? null,
      executablePath: probe.path ?? null,
      error: probe.error ?? null,
      running: Boolean(browser?.isConnected()),
      cdpUrl,
      viewport: { ...config.viewport },
      devices: DEVICES,
      chats: [...chats.keys()]
    }
  },

  install: () => installChromium(),

  'chat.open': ({ chatId, hostDpr }) => openChat(chatId, { hostDpr }),

  /** The renderer pings this while a surface for the chat is on screen, which
   *  is the only thing that can distinguish "idle" from "being watched" — the
   *  renderer's CDP traffic never reaches this process. */
  'chat.touch'({ chatId }) {
    const entry = chats.get(chatId)
    if (entry) {
      entry.touchedAt = Date.now()
      // Separate from `touchedAt`, which a tool call also bumps. This one only
      // moves when a surface says it is on screen, which is the only honest
      // answer to "is anyone actually looking at this?".
      entry.watchedAt = Date.now()
    }
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

  /**
   * Render a tab at a size.
   *
   * One method for both callers on purpose — the panel's menu and the agent's
   * tool land here alike, which is what makes an agent-driven resize show up in
   * the UI without a second code path to keep in step. `by` is the only thing
   * that distinguishes them, and it exists so the panel can say who did it.
   */
  async 'tab.setViewport'({ chatId, tabId, id, width, height, by }) {
    const entry = chatEntry(chatId)
    const tab = entry.tabs.get(tabId)
    if (!tab) throw new Error(`no tab ${tabId}`)
    const device = resolveDevice({ id, width, height, hostDpr: entry.hostDpr, by: by ?? 'user' })
    await applyDevice(tab, device)
    broadcastTabs(chatId)
    return { device }
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

  /**
   * One MCP JSON-RPC message, for the chat named in the URL Rust served.
   *
   * The server is created on the first message rather than with the chat: a
   * chat that never browses should not build a tool surface, and Claude sends
   * `initialize` before anything else, so the first message is always the one
   * that can afford to wait.
   */
  async 'mcp.message'({ chatId, message }) {
    let mcp = mcpByChat.get(chatId)
    if (!mcp) {
      mcp = await ChatMcp.open(async () => {
        await openChat(chatId)
        return chatEntry(chatId).context
      }, localToolsFor(chatId))
      mcpByChat.set(chatId, mcp)
    }
    // Two different nulls: "this was not a tool call" and "the pointer had not
    // moved yet". Conflating them means the agent's very first click never
    // reports, which is the one you most want to see.
    const isToolCall = message.method === 'tools/call'
    if (isToolCall) {
      reportDriving(chatId)
      await glideTo(chatId, message.params)
    }
    const before = isToolCall ? await readPointer(chatId) : null
    const response = await mcp.handle(message)
    if (isToolCall) void reportPointer(chatId, before)
    // The agent using this chat's browser is exactly the thing the idle
    // sweeper must not read as idle.
    const entry = chats.get(chatId)
    if (entry) entry.touchedAt = Date.now()
    return { message: response }
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
  // On a deadline. A tidy shutdown that never finishes is worse than an abrupt
  // one: the process stays resident with nothing to talk to.
  await Promise.race([
    methods.shutdown().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
  leave(0)
})

/**
 * The parent is gone and nothing told us.
 *
 * stdin closing covers a clean quit, but not a crash, a force-quit or a SIGKILL
 * — and in those cases the app never gets to run its own cleanup either, so this
 * is the only thing standing between a hard quit and a process that outlives it
 * by fifteen hours. Being reparented to init is the signal, and it is unmissable.
 */
const parentPid = process.ppid
const orphanWatch = setInterval(() => {
  if (process.ppid !== parentPid || process.ppid === 1) leave(0)
}, 5000)
orphanWatch.unref?.()

process.on('SIGTERM', () => leave(0))
process.on('SIGINT', () => leave(0))
process.on('SIGHUP', () => leave(0))

process.on('uncaughtException', (err) => {
  // Never re-enter: this handler writing to a broken pipe is what made the
  // original loop unbounded.
  if (leaving) return
  const broken = err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED'
  if (broken) return leave(0)
  log('uncaught:', err?.stack ?? String(err))
})
process.on('unhandledRejection', (err) => {
  if (leaving) return
  log('unhandled:', String(err))
})

emit('ready', { pid: process.pid, node: process.version })
