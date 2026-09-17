/**
 * The browser, per chat.
 *
 * Not persisted, for the same reason `running` is not: the Chromium behind this
 * does not survive a reload, so a restored tab list would be a description of
 * something that no longer exists. The sidecar rebuilds it when the chat asks
 * for a browser again.
 *
 * One chat, one `BrowserContext`, its own cookies and storage. Two chats
 * browsing at once are two independent browsers as far as either can tell, even
 * though there is one Chromium underneath.
 */
import { create } from 'zustand'
import type { BrowserTab } from '../lib/api-types'
import { connectCdp, type CdpConnection } from '../lib/browser/cdp'
import { createScreencastHub, type ScreencastHub } from '../lib/browser/screencast'

export type BrowserPhase = 'off' | 'starting' | 'ready' | 'needs-chromium' | 'error'

/** Where the agent's pointer last landed, and when. The panel draws a ghost
 *  there and fades it, which is the only thing that distinguishes a page being
 *  driven from a page moving on its own. */
export type AgentCursor = { tabId: string; x: number; y: number; at: number }

export type ChatBrowser = {
  phase: BrowserPhase
  cursor: AgentCursor | null
  error: string | null
  tabs: BrowserTab[]
  activeTabId: string | null
  /** Per chat, and deliberately not persisted: dismissing the miniature hides
   *  a browser that will not be there after a restart anyway. */
  pipDismissed: boolean
}

export const EMPTY_BROWSER: ChatBrowser = {
  phase: 'off',
  cursor: null,
  error: null,
  tabs: [],
  activeTabId: null,
  pipDismissed: false
}

type BrowserStore = {
  bySession: Record<string, ChatBrowser>
  /** One Chromium for the app, so one endpoint for every chat. */
  cdpUrl: string | null
  viewport: { width: number; height: number }
  /** Chromium is a download, not part of the bundle. */
  install: { percent: number; totalMb: number } | null
  setPhase: (sessionId: string, phase: BrowserPhase, error?: string | null) => void
  setTabs: (sessionId: string, tabs: BrowserTab[]) => void
  setActiveTab: (sessionId: string, tabId: string | null) => void
  setEndpoint: (cdpUrl: string | null, viewport?: { width: number; height: number }) => void
  setCursor: (sessionId: string, cursor: AgentCursor) => void
  setInstall: (install: { percent: number; totalMb: number } | null) => void
  dismissPip: (sessionId: string, dismissed: boolean) => void
  /** Everything about a chat that no longer exists. */
  forget: (sessionId: string) => void
  /** The browser went away under everyone — drop every chat back to `off`. */
  browserGone: () => void
}

const patch = (
  state: BrowserStore,
  sessionId: string,
  next: Partial<ChatBrowser>
): Pick<BrowserStore, 'bySession'> => ({
  bySession: {
    ...state.bySession,
    [sessionId]: { ...(state.bySession[sessionId] ?? EMPTY_BROWSER), ...next }
  }
})

export const useBrowserStore = create<BrowserStore>()((set) => ({
  bySession: {},
  cdpUrl: null,
  viewport: { width: 1280, height: 800 },
  install: null,
  setPhase: (sessionId, phase, error = null) =>
    set((s) => patch(s, sessionId, { phase, error })),
  setTabs: (sessionId, tabs) =>
    set((s) => {
      const current = s.bySession[sessionId] ?? EMPTY_BROWSER
      // Keep the selection pointing at something that still exists, and follow
      // the agent when it opens a tab into an empty strip.
      const activeTabId =
        tabs.find((t) => t.tabId === current.activeTabId)?.tabId ?? tabs[0]?.tabId ?? null
      return patch(s, sessionId, { tabs, activeTabId })
    }),
  setActiveTab: (sessionId, activeTabId) => set((s) => patch(s, sessionId, { activeTabId })),
  setEndpoint: (cdpUrl, viewport) =>
    set((s) => ({ cdpUrl, viewport: viewport ?? s.viewport })),
  setCursor: (sessionId, cursor) => set((s) => patch(s, sessionId, { cursor })),
  setInstall: (install) => set({ install }),
  dismissPip: (sessionId, pipDismissed) => set((s) => patch(s, sessionId, { pipDismissed })),
  forget: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession }
    }),
  browserGone: () =>
    set((s) => ({
      cdpUrl: null,
      bySession: Object.fromEntries(
        Object.entries(s.bySession).map(([id, chat]) => [
          id,
          { ...chat, phase: 'off' as const, tabs: [], activeTabId: null }
        ])
      )
    }))
}))

// ---------------------------------------------------------------------------
// The CDP connection
// ---------------------------------------------------------------------------
//
// A socket is not React state, so it lives here rather than in the store. There
// is one Chromium, so there is one connection and one screencast hub; every
// chat's surfaces share them and the hub keeps the streams apart by target.

type Live = { url: string; conn: CdpConnection; hub: ScreencastHub }

let live: Live | null = null
let connecting: Promise<Live> | null = null

export async function browserHub(
  url: string,
  viewport: { width: number; height: number }
): Promise<Live> {
  if (live && live.url === url && !live.conn.closed) return live
  if (live) {
    // A relaunched Chromium gets a new endpoint; the old sessions are gone.
    live.hub.dispose()
    live.conn.close()
    live = null
  }
  if (connecting) return connecting

  connecting = (async () => {
    const conn = await connectCdp(url)
    const hub = createScreencastHub(conn, viewport)
    live = { url, conn, hub }
    connecting = null
    return live
  })()
  try {
    return await connecting
  } catch (err) {
    connecting = null
    throw err
  }
}

/** Drop the socket — the browser went away, or Nyra is closing. */
export function dropBrowserHub(): void {
  live?.hub.dispose()
  live?.conn.close()
  live = null
  connecting = null
}
