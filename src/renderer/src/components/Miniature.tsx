import React from 'react'
import BrowserPip, { usePipVisible } from './browser/BrowserPip'
import DesktopPip from './desktop/DesktopPip'
import { EMPTY_DESKTOP, useDesktopStore } from '../store/desktop'
import { EMPTY_BROWSER, useBrowserStore } from '../store/browser'
import { useSessionsStore } from '../store/sessions'
import { useSettingsStore } from '../store/settings'

export type MiniatureKind = 'browser' | 'desktop'

/**
 * Which of the two floats over the conversation, if either.
 *
 * Whichever surface the chat touched last wins: a chat that browsed and then
 * opened Mail should show Mail. The browser keeps every rule it had in
 * `pipVisible`. The desktop one shares the switch and the dismissal, but not
 * "the panel is open" — the side panel shows the browser, never another app,
 * so having it open is no reason to hide a picture of Mail.
 */
export function pickMiniature(state: {
  browserVisible: boolean
  enabled: boolean
  hasSession: boolean
  dismissed: boolean
  seenAt: number | null
  browserAt: number
}): MiniatureKind | null {
  const desktopVisible =
    state.enabled && state.hasSession && !state.dismissed && state.seenAt !== null
  if (state.browserVisible && desktopVisible) {
    return (state.seenAt ?? 0) > state.browserAt ? 'desktop' : 'browser'
  }
  if (desktopVisible) return 'desktop'
  if (state.browserVisible) return 'browser'
  return null
}

export function useMiniature(): MiniatureKind | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const browserVisible = usePipVisible()
  const enabled = useSettingsStore((s) => s.browserPip)
  const dismissed = useBrowserStore(
    (s) => ((sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER).pipDismissed
  )
  const desktop = useDesktopStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_DESKTOP)
  return pickMiniature({
    browserVisible,
    enabled,
    hasSession: Boolean(sessionId),
    dismissed,
    seenAt: desktop.seen?.at ?? null,
    browserAt: desktop.browserAt
  })
}

export default function Miniature(): React.JSX.Element | null {
  const kind = useMiniature()
  if (kind === 'browser') return <BrowserPip />
  if (kind === 'desktop') return <DesktopPip />
  return null
}
