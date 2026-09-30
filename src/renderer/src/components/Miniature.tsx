import React from 'react'
import BrowserPip, { usePipVisible } from './browser/BrowserPip'
import DesktopPip from './desktop/DesktopPip'
import DesignPip from './design/DesignPip'
import { EMPTY_DESKTOP, useDesktopStore } from '../store/desktop'
import { EMPTY_BROWSER, useBrowserStore } from '../store/browser'
import { designsFor, useDesignActivityStore } from '../store/designActivity'
import { activeTab, panelTabsFor, usePanelTabsStore } from '../store/panelTabs'
import { useSessionsStore } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { useDesignWatch } from '../hooks/useDesignWatch'

export type MiniatureKind = 'browser' | 'desktop' | 'design'

/**
 * Which one floats over the conversation, if any.
 *
 * Whichever surface the chat touched last wins: a chat that browsed and then
 * opened Mail should show Mail, and one that then rewrote a design should show
 * the design. The browser keeps every rule it had in `pipVisible`. The other
 * two share the switch and the dismissal, but not "the panel is open" — the
 * panel hides a design only while it is showing one (`designOnScreen`), and
 * never shows another app at all.
 */
export function pickMiniature(state: {
  browserVisible: boolean
  enabled: boolean
  hasSession: boolean
  dismissed: boolean
  seenAt: number | null
  browserAt: number
  /** When this chat last touched a design, or null if it has not. */
  designAt?: number | null
  /** The side panel is already showing a design. */
  designOnScreen?: boolean
}): MiniatureKind | null {
  const shared = state.enabled && state.hasSession && !state.dismissed
  const candidates: [MiniatureKind, number][] = []
  if (state.browserVisible) candidates.push(['browser', state.browserAt])
  if (shared && state.seenAt !== null) candidates.push(['desktop', state.seenAt])
  if (shared && state.designAt != null && !state.designOnScreen) {
    candidates.push(['design', state.designAt])
  }
  if (candidates.length === 0) return null
  // Ties go to the earlier entry, which keeps the old browser-over-desktop
  // tiebreak exactly as it was.
  return candidates.reduce((best, c) => (c[1] > best[1] ? c : best))[0]
}

export function useMiniature(): MiniatureKind | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const browserVisible = usePipVisible()
  const enabled = useSettingsStore((s) => s.browserPip)
  const dismissed = useBrowserStore(
    (s) => ((sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER).pipDismissed
  )
  const desktop = useDesktopStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_DESKTOP)
  const design = useDesignActivityStore((s) => designsFor(s, sessionId)[0] ?? null)
  // Nothing to draw until the file has compiled once.
  const drawable = useDesignActivityStore((s) => Boolean(design && s.watches[design.path]?.doc))
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const panelShowsDesign = usePanelTabsStore(
    (s) => activeTab(panelTabsFor(s, sessionId))?.kind === 'design'
  )
  return pickMiniature({
    browserVisible,
    enabled,
    hasSession: Boolean(sessionId),
    dismissed,
    seenAt: desktop.seen?.at ?? null,
    browserAt: desktop.browserAt,
    designAt: design && drawable ? design.at : null,
    designOnScreen: rightPanelOpen && panelShowsDesign
  })
}

export default function Miniature(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const design = useDesignActivityStore((s) => designsFor(s, sessionId)[0] ?? null)
  // Watched whether or not the miniature is up, so "changed" is right the
  // moment it appears — and so the Summary's row is right while it is not.
  useDesignWatch(design?.path ?? null)

  const kind = useMiniature()
  if (kind === 'browser') return <BrowserPip />
  if (kind === 'desktop') return <DesktopPip />
  if (kind === 'design') return <DesignPip />
  return null
}
