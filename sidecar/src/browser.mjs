// The Chromium that Nyra's browser panel shows and the agent drives.
//
// One process for the whole app, one BrowserContext per chat. Contexts share
// the browser's ~120 MB of fixed cost and still get their own cookies, storage
// and cache, which is what "one browser per chat" actually has to mean. A
// process per chat would be honest too, and three times the memory.
//
// Headless, and deliberately the *new* headless: since Playwright 1.49 a plain
// `headless: true` runs chromium-headless-shell instead. The shell screencasts
// perfectly well — that was measured, not assumed — so this is a choice about
// fidelity rather than capability. `channel: 'chromium'` is the real browser, so
// rendering, fonts and WebGL match what the user's own Chrome would show, which
// is the entire point of a tool for looking at your web app.

import fs from 'node:fs'
import net from 'node:net'
import { chromium } from 'playwright-core'

/** Where the webview's CDP socket connects from. Chrome rejects a WebSocket
 *  whose Origin isn't listed, and `*` would let any page the browser visits
 *  drive its own debugger — including other chats' contexts. */
const ALLOWED_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420']

/** Decoupled from the panel on purpose. Codex sizes its browser to the side
 *  panel, so pages render at tablet breakpoints and the agent validates a
 *  layout nobody will ever see. The canvas scales this down instead. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

/** How long a chat can go untouched before its context is closed, and how often
 *  we look. Ten minutes is long enough that stepping away from a chat and coming
 *  back does not lose the page, short enough that a forgotten chat does not hold
 *  a third of the budget all afternoon. */
const IDLE_EVICTION_MS = 10 * 60 * 1000
const IDLE_SWEEP_MS = 60 * 1000

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

export class BrowserHost {
  /** @param {(event: object) => void} emit */
  constructor(emit) {
    this.emit = emit
    this.browser = null
    this.cdpPort = null
    this.cdpEndpoint = null
    this.contexts = new Map() // chatId -> { context, browserContextId, touchedAt }
    this.starting = null
    this.sweeper = null
    this.executablePath = null
  }

  /** Lazily launch. Everything funnels through here so a chat that never
   *  browses never costs a Chromium. */
  async ensureBrowser(options = {}) {
    if (this.browser?.isConnected()) return
    if (this.starting) return this.starting
    this.starting = this.#launch(options).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #launch({ channel, executablePath } = {}) {
    const port = await freePort()
    const launchOptions = {
      headless: true,
      args: [
        `--remote-debugging-port=${port}`,
        `--remote-allow-origins=${ALLOWED_ORIGINS.join(',')}`,
        // Nothing here is a real window, so nothing should be treated as one
        // that fell behind another.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
      ]
    }
    this.executablePath = executablePath ?? null
    if (executablePath) launchOptions.executablePath = executablePath
    else launchOptions.channel = channel || 'chromium'

    this.browser = await chromium.launch(launchOptions)
    this.cdpPort = port

    // Ask Chromium for its own endpoint rather than building the URL: the host
    // it echoes back is the one we asked with, and the webview's CSP allows
    // `localhost` — so this is also what keeps the frontend off a CSP edit.
    const res = await fetch(`http://localhost:${port}/json/version`)
    this.cdpEndpoint = (await res.json()).webSocketDebuggerUrl

    this.browser.on('disconnected', () => {
      this.browser = null
      this.cdpEndpoint = null
      this.contexts.clear()
      this.emit({ type: 'browser-gone' })
    })

    this.emit({
      type: 'browser-ready',
      cdpEndpoint: this.cdpEndpoint,
      version: this.browser.version()
    })
  }

  async ensureContext(chatId, options = {}) {
    await this.ensureBrowser(options)
    const existing = this.contexts.get(chatId)
    if (existing) {
      existing.touchedAt = Date.now()
      return this.#describe(chatId, existing)
    }

    const context = await this.browser.newContext({ viewport: DEFAULT_VIEWPORT })
    // Playwright does not expose the context's CDP id, and the renderer needs
    // it: every target in the browser arrives on one socket, and this is the
    // only thing that says which chat a tab belongs to.
    const browserContextId = await this.#browserContextId(context)

    const entry = { context, browserContextId, touchedAt: Date.now() }
    this.contexts.set(chatId, entry)
    this.#startSweeper()
    context.on('close', () => {
      if (this.contexts.get(chatId) === entry) this.contexts.delete(chatId)
    })
    return this.#describe(chatId, entry)
  }

  /** Playwright keeps the CDP browserContextId to itself, so read it off a
   *  throwaway page's target info rather than reaching into internals. */
  async #browserContextId(context) {
    const page = await context.newPage()
    const session = await context.newCDPSession(page)
    const { targetInfo } = await session.send('Target.getTargetInfo')
    await session.detach()
    await page.close()
    return targetInfo.browserContextId
  }

  #describe(chatId, entry) {
    return {
      chatId,
      browserContextId: entry.browserContextId,
      cdpEndpoint: this.cdpEndpoint,
      viewport: DEFAULT_VIEWPORT
    }
  }

  /** Is there actually a Chromium on disk to launch?
   *
   *  Playwright resolves `channel: 'chromium'` against its own registry under
   *  ~/Library/Caches/ms-playwright, which is a download and not part of the
   *  app bundle. The panel needs to tell a first run apart from a failure. */
  static chromiumStatus(executablePath) {
    if (executablePath) {
      return { installed: fs.existsSync(executablePath), executablePath, source: 'custom' }
    }
    try {
      const path = chromium.executablePath({ channel: 'chromium' })
      return { installed: fs.existsSync(path), executablePath: path, source: 'playwright' }
    } catch (err) {
      return { installed: false, executablePath: null, source: 'playwright', error: String(err?.message ?? err) }
    }
  }

  /** A context with a real page in it costs 220–490 MB — measured, and far more
   *  than a BrowserContext sounds like it should. Three or four chats browsing
   *  at once is the whole budget, so a chat nobody is looking at does not get to
   *  keep one. The tab list lives in the renderer, so reopening the panel builds
   *  it back; this only reclaims the memory. */
  #startSweeper() {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - IDLE_EVICTION_MS
      for (const [chatId, entry] of [...this.contexts]) {
        if (entry.touchedAt > cutoff) continue
        this.emit({ type: 'context-evicted', chatId })
        void this.releaseChat(chatId)
      }
      if (this.contexts.size === 0) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
    }, IDLE_SWEEP_MS)
    this.sweeper.unref?.()
  }

  /** The renderer pings this while a surface for the chat is on screen. */
  touch(chatId) {
    const entry = this.contexts.get(chatId)
    if (entry) entry.touchedAt = Date.now()
    return { ok: Boolean(entry) }
  }

  contextFor(chatId) {
    return this.contexts.get(chatId)?.context ?? null
  }

  async openTab(chatId, url) {
    const entry = this.contexts.get(chatId)
    if (!entry) throw new Error(`no browser for chat ${chatId}`)
    const page = await entry.context.newPage()
    if (url) await page.goto(url, { waitUntil: 'commit' }).catch(() => {})
    return { ok: true }
  }

  async releaseChat(chatId) {
    const entry = this.contexts.get(chatId)
    if (!entry) return { ok: true }
    this.contexts.delete(chatId)
    await entry.context.close().catch(() => {})
    // The last chat to let go turns the lights off; an idle Chromium is
    // ~120 MB of nothing.
    if (this.contexts.size === 0) {
      if (this.sweeper) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
      await this.shutdown()
    }
    return { ok: true }
  }

  state() {
    return {
      running: Boolean(this.browser?.isConnected()),
      chromium: BrowserHost.chromiumStatus(this.executablePath),
      cdpEndpoint: this.cdpEndpoint,
      chats: Object.fromEntries(
        [...this.contexts.entries()].map(([id, e]) => [id, e.browserContextId])
      )
    }
  }

  async shutdown() {
    const browser = this.browser
    this.browser = null
    this.cdpEndpoint = null
    this.contexts.clear()
    await browser?.close().catch(() => {})
  }
}
