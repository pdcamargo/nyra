/**
 * Bringing a chat's Chromium up, and keeping it up.
 *
 * This used to be two effects inside the browser panel, which meant mounting the
 * panel was the same thing as wanting a browser. Now that the panel also holds
 * file tabs, that would mean opening it to read a file downloads a 182 MB
 * browser engine and leaves a blank page in the strip. So the boot is a function
 * of "this chat has a browser tab", and the panel asks that question.
 */
import { useEffect } from 'react'
import { useBrowserStore } from '../../store/browser'
import { useSettingsStore } from '../../store/settings'
import {
  activeBrowserTabId,
  browserKey,
  syncSidecarTabs,
  useWorkspaceStore
} from '../../store/workspace'
import { useSessionsStore } from '../../store/sessions'

/** Long enough to be cheap, short enough that the sidecar's ten-minute idle
 *  sweeper never evicts a context somebody is looking at. */
const TOUCH_INTERVAL_MS = 60_000

/**
 * Get the chat's context open on the sidecar. Resolves false when there is no
 * browser to be had, having left the reason in `phase`.
 */
export async function ensureBrowser(sessionId: string): Promise<boolean> {
  const store = useBrowserStore.getState()

  // Toggling back to a browser that is already up should not flash a starting
  // state at you. `gone` and `evicted` both reset the phase, so `ready` can be
  // trusted here.
  if (store.bySession[sessionId]?.phase === 'ready' && store.cdpUrl) return true

  store.setPhase(sessionId, 'starting')
  const status = await window.api.browser.status()
  if (!status.ok) {
    store.setPhase(sessionId, 'error', status.error)
    return false
  }
  if (status.chromium === 'missing') {
    store.setPhase(sessionId, 'needs-chromium')
    return false
  }

  // The context is built with this and cannot be rebuilt without throwing away
  // cookies, so it is decided once, here, from the screen the panel is on.
  const opened = await window.api.browser.openChat(
    sessionId,
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  )
  if (!opened.ok) {
    store.setPhase(sessionId, 'error', opened.error)
    return false
  }

  store.setEndpoint(opened.cdpUrl, opened.viewport)
  store.setDevices(opened.devices)
  store.setPhase(sessionId, 'ready')
  return true
}

/**
 * Open a page in this chat's browser, starting the browser if it is not up.
 *
 * The tab is selected through `selectTab`, which parks the key when the strip
 * has not heard about the tab yet — the sidecar's broadcast and this reply race,
 * and either order has to end with the new tab on screen.
 */
export async function startBrowserTab(sessionId: string, url = 'about:blank'): Promise<void> {
  if (!(await ensureBrowser(sessionId))) return
  const created = await window.api.browser.tabCreate(sessionId, url)
  if (created.ok) useWorkspaceStore.getState().selectTab(sessionId, browserKey(created.tab.tabId))
}

/**
 * Flip the tab on screen between following the panel and a fixed device.
 *
 * Lives here rather than in the menu because the command palette needs it too,
 * and both have to go through the sidecar — it owns the size, so an agent's
 * resize and a person's land the same way and show up on the same broadcast.
 *
 * Going back to responsive deliberately sends no dimensions: the panel measures
 * itself and pushes the real box a frame later, and guessing here would be a
 * size the page held for that frame and nobody asked for.
 */
export async function toggleDeviceMode(): Promise<void> {
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return
  const workspace = useWorkspaceStore.getState().bySession[sessionId]
  if (!workspace) return
  const tabId = activeBrowserTabId(workspace)
  if (!tabId) return

  const tab = useBrowserStore
    .getState()
    .bySession[sessionId]?.tabs.find((t) => t.tabId === tabId)
  const emulating = Boolean(tab?.device) && tab!.device!.id !== 'responsive'
  const id = emulating ? 'responsive' : useSettingsStore.getState().browserDevice
  await window.api.browser.tabSetViewport(sessionId, tabId, { id })
}

/**
 * Keep a chat's browser alive while it is being looked at.
 *
 * Pass null for a chat that does not want one — that is the gate, and passing
 * null rather than skipping the hook keeps the hook order stable.
 */
export function useBrowserSession(sessionId: string | null): void {
  const phase = useBrowserStore((s) => (sessionId ? s.bySession[sessionId]?.phase : null) ?? 'off')

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    void (async () => {
      if (!(await ensureBrowser(sessionId)) || cancelled) return
      const listed = await window.api.browser.tabList(sessionId)
      // The recovery path: after a relaunch the strip still holds rows for tabs
      // that no longer exist, and this is what reconciles them away. It no
      // longer creates a blank tab for an empty browser — an empty strip has
      // something to say for itself now.
      if (!cancelled && listed.ok) syncSidecarTabs(sessionId, listed.tabs)
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId])

  // The sidecar cannot see the renderer's CDP traffic, so being looked at is
  // something only this side knows.
  useEffect(() => {
    if (!sessionId || phase !== 'ready') return
    const ping = (): void => void window.api.browser.touch(sessionId)
    ping()
    const timer = setInterval(ping, TOUCH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [sessionId, phase])
}
