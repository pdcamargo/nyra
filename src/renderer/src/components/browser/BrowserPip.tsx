import React from 'react'
import { Globe, X } from 'lucide-react'
import BrowserCanvas from './BrowserCanvas'
import { EMPTY_BROWSER, useBrowserStore, type BrowserPhase } from '../../store/browser'
import { useSessionsStore } from '../../store/sessions'
import { useSettingsStore } from '../../store/settings'
import { useUiStore, type RightPanelMode } from '../../store/ui'

/** Roughly the summary's width, so the two stack as one column. */
const MINIATURE_WIDTH = 300

/**
 * Should a miniature be floating over the conversation right now?
 *
 * Three things have to be true at once, and all three are about *this* chat:
 * it has a browser, that browser is not already on screen in the panel, and
 * you have not waved it away. A background chat never gets one — its browser is
 * still running, and the sidebar says so, but a miniature of a page you are not
 * looking at is just something covering the conversation you are.
 */
export function pipVisible(state: {
  enabled: boolean
  hasSession: boolean
  phase: BrowserPhase
  tabCount: number
  dismissed: boolean
  rightPanelOpen: boolean
  rightPanelMode: RightPanelMode
}): boolean {
  // Showing it in the panel is the whole reason not to show it here. Note this
  // reads the *active* chat only: a background chat's browser is still running
  // and still says so in the sidebar, but it never floats a preview over a
  // conversation it does not belong to.
  const alreadyOnScreen = state.rightPanelOpen && state.rightPanelMode === 'browser'
  return (
    state.enabled &&
    state.hasSession &&
    state.phase === 'ready' &&
    state.tabCount > 0 &&
    !state.dismissed &&
    !alreadyOnScreen
  )
}

export function usePipVisible(): boolean {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const chat = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const rightPanelMode = useUiStore((s) => s.rightPanelMode)
  const enabled = useSettingsStore((s) => s.browserPip)

  return pipVisible({
    enabled,
    hasSession: Boolean(sessionId),
    phase: chat.phase,
    tabCount: chat.tabs.length,
    dismissed: chat.pipDismissed,
    rightPanelOpen,
    rightPanelMode
  })
}

export default function BrowserPip(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const chat = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER)
  const setActiveTab = useBrowserStore((s) => s.setActiveTab)
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const toggleBrowserPanel = useUiStore((s) => s.toggleBrowserPanel)
  const visible = usePipVisible()

  if (!visible || !sessionId) return null

  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-secondary/80 shadow-xl backdrop-blur-xl backdrop-saturate-150">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Globe className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
          Browser
        </span>
        <button
          // Codex ships a preview that cannot be reliably dismissed, and it is
          // the single loudest complaint about their browser. This one closes.
          aria-label="Hide browser preview"
          title="Hide — bring it back from the Summary"
          onClick={() => dismissPip(sessionId, true)}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>

      {/* One per tab, as asked — but bounded, so eight tabs cannot bury the
          conversation they are meant to sit beside. */}
      <div className="max-h-[46vh] space-y-px overflow-y-auto">
        {chat.tabs.map((tab) => (
          <button
            key={tab.tabId}
            onClick={() => {
              setActiveTab(sessionId, tab.tabId)
              toggleBrowserPanel()
            }}
            title={`${tab.title || tab.url}\nClick to open in the panel`}
            className="block w-full cursor-default text-left transition-opacity hover:opacity-90"
          >
            <BrowserCanvas
              targetId={tab.targetId}
              width={MINIATURE_WIDTH}
              // Five of these measured at 0.09 MB/s all told, so the limit is
              // the screen rather than the wire — but a preview does not need
              // sixty frames a second to read as live.
              everyNthFrame={4}
            />
            <span className="block truncate border-b border-border/40 px-2.5 py-1 text-[10px] text-muted-foreground">
              {tab.title || tab.url}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
