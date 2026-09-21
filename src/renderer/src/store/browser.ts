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
 *
 * This is a mirror of what the sidecar says, and only that. Which tab is on
 * screen is not something the sidecar knows, so it lives in `workspace.ts`
 * alongside the file tabs the sidecar has never heard of.
 */
import { create } from 'zustand'
import type { BrowserTab, DevicePreset } from '../lib/api-types'
import { connectCdp, type CdpConnection } from '../lib/browser/cdp'
import { createScreencastHub, type ScreencastHub } from '../lib/browser/screencast'
import type { EmulatedViewport } from '../lib/browser/viewport'

export type BrowserPhase = 'off' | 'starting' | 'ready' | 'needs-chromium' | 'error'

/** Where the agent's pointer last landed, and when. The panel draws a ghost
 *  there, which is the only thing that distinguishes a page being driven from a
 *  page moving on its own. `down` separates a press from a glide, so the two
 *  can be drawn differently. */
export type AgentCursor = { tabId: string; x: number; y: number; at: number; down: boolean }

export type ChatBrowser = {
  phase: BrowserPhase
  cursor: AgentCursor | null
  /**
   * The tab the agent currently has the wheel on, or null.
   *
   * Separate from `cursor` because having control is a state and moving the
   * pointer is an event: a turn that types, scrolls and navigates is still the
   * agent driving, and the ghost should stay put rather than blink out. Cleared
   * when the person takes over, and ignored once the turn is no longer running.
   */
  driving: string | null
  error: string | null
  tabs: BrowserTab[]
  /** Per chat, and deliberately not persisted: dismissing the miniature hides
   *  a browser that will not be there after a restart anyway. */
  pipDismissed: boolean
}

export const EMPTY_BROWSER: ChatBrowser = {
  phase: 'off',
  cursor: null,
  driving: null,
  error: null,
  tabs: [],
  pipDismissed: false
}

type BrowserStore = {
  bySession: Record<string, ChatBrowser>
  /** One Chromium for the app, so one endpoint for every chat. */
  cdpUrl: string | null
  /** What a tab renders at until its first broadcast says otherwise. Only a
   *  fallback now — the real size is per target, below. */
  viewport: { width: number; height: number }
  /**
   * The size each target is actually rendered at, mirrored from the sidecar.
   *
   * Keyed by CDP target rather than by tab because that is what the canvas, the
   * screencast hub and the click mapping all address, and it lets a preview of
   * one tab coexist with the panel showing another.
   */
  viewportByTarget: Record<string, EmulatedViewport>
  /** The sizes offered in the menu, straight from the sidecar so the list and
   *  the agent's tool cannot disagree. */
  devices: DevicePreset[]
  /** Chromium is a download, not part of the bundle. */
  install: { percent: number; totalMb: number } | null
  setPhase: (sessionId: string, phase: BrowserPhase, error?: string | null) => void
  setTabs: (sessionId: string, tabs: BrowserTab[]) => void
  setEndpoint: (cdpUrl: string | null, viewport?: { width: number; height: number }) => void
  setDevices: (devices: DevicePreset[]) => void
  setCursor: (sessionId: string, cursor: AgentCursor) => void
  setDriving: (sessionId: string, tabId: string) => void
  /** The person took the wheel back, so stop drawing a hand on it. */
  releaseDriving: (sessionId: string) => void
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
  viewportByTarget: {},
  devices: [],
  install: null,
  setPhase: (sessionId, phase, error = null) =>
    set((s) => patch(s, sessionId, { phase, error })),
  // A mirror write and nothing more. Selection used to be computed here, which
  // made the sidecar's list the only thing that could decide what you were
  // looking at — see `workspace.ts`, which owns that now.
  setTabs: (sessionId, tabs) =>
    set((s) => {
      // Sizes ride along with the tabs, so there is no second channel to keep
      // in step and an agent-driven resize lands the same way a navigation
      // does. Targets are only ever added here; a closed tab's entry is dropped
      // by `forget`/`browserGone` along with everything else about it.
      const viewportByTarget = { ...s.viewportByTarget }
      const moved: string[] = []
      for (const tab of tabs) {
        if (!tab.device) continue
        const next: EmulatedViewport = {
          width: tab.device.width,
          height: tab.device.height,
          deviceScaleFactor: tab.device.deviceScaleFactor
        }
        const prev = viewportByTarget[tab.targetId]
        if (prev && prev.width === next.width && prev.height === next.height) continue
        viewportByTarget[tab.targetId] = next
        moved.push(tab.targetId)
      }
      // The stream is running at the old aspect until it is told. Deferred so a
      // socket call never happens inside a store update.
      if (moved.length > 0) queueMicrotask(() => moved.forEach(notifyViewportChanged))
      return { ...patch(s, sessionId, { tabs }), viewportByTarget }
    }),
  setEndpoint: (cdpUrl, viewport) =>
    set((s) => ({ cdpUrl, viewport: viewport ?? s.viewport })),
  setDevices: (devices) => set({ devices }),
  setCursor: (sessionId, cursor) =>
    set((s) => patch(s, sessionId, { cursor, driving: cursor.tabId })),
  setDriving: (sessionId, tabId) => set((s) => patch(s, sessionId, { driving: tabId })),
  releaseDriving: (sessionId) => set((s) => patch(s, sessionId, { driving: null })),
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
          { ...chat, phase: 'off' as const, tabs: [] }
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

/**
 * The socket, and the one hub on it.
 *
 * Takes no viewport: it used to, and because a matching URL returned the cached
 * connection unchanged, a resize after the first call was silently dropped. The
 * hub reads sizes through a getter instead, so it can never hold a stale one.
 */
export async function browserHub(url: string): Promise<Live> {
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
    const hub = createScreencastHub(conn, {
      viewportFor: (targetId) => useBrowserStore.getState().viewportByTarget[targetId],
      fallback: { ...useBrowserStore.getState().viewport, deviceScaleFactor: 1 }
    })
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

/** A target is being rendered at a new size, so its stream needs restarting at
 *  the new aspect. Chromium has no resize call, so this is a stop and a start. */
export function notifyViewportChanged(targetId: string): void {
  live?.hub.invalidate(targetId)
}

/** Drop the socket — the browser went away, or Nyra is closing. */
export function dropBrowserHub(): void {
  live?.hub.dispose()
  live?.conn.close()
  live = null
  connecting = null
}
