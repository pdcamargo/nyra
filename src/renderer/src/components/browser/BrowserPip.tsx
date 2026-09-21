import React, { useState } from 'react'
import { ChevronDown, Globe, X } from 'lucide-react'
import BrowserCanvas from './BrowserCanvas'
import { EMPTY_BROWSER, useBrowserStore, type BrowserPhase } from '../../store/browser'
import {
  activeBrowserTabId,
  browserKey,
  useWorkspaceStore,
  workspaceFor
} from '../../store/workspace'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useSessionsStore } from '../../store/sessions'
import { useSettingsStore } from '../../store/settings'
import { useUiStore } from '../../store/ui'

/** Roughly the summary's width, so the two stack as one column. */
const MINIATURE_WIDTH = 300

/**
/**
 * A tab with nothing on it yet.
 *
 * A freshly opened tab sits on `about:blank` until something navigates it, and a
 * miniature of it is a grey rectangle covering the conversation — it says the
 * browser exists, which the sidebar already says, and shows nothing.
 */
export function isBlankTab(tab: { url: string }): boolean {
  const url = tab.url?.trim().toLowerCase() ?? ''
  return url === '' || url === 'about:blank' || url === 'about:newtab' || url.startsWith('chrome://newtab')
}

/**
 * Should a miniature be floating over the conversation right now?
 *
 * Several things have to be true at once, and all of them are about *this* chat:
 * it has a browser, that browser is not already on screen in the panel, and
 * you have not waved it away. A background chat never gets one — its browser is
 * still running, and the sidebar says so, but a miniature of a page you are not
 * looking at is just something covering the conversation you are.
 */
export function pipVisible(state: {
  enabled: boolean
  hasSession: boolean
  phase: BrowserPhase
  /** Tabs that would actually render something. A window full of `about:blank`
   *  is not a reason to cover the conversation. */
  liveTabCount: number
  dismissed: boolean
  rightPanelOpen: boolean
}): boolean {
  // Showing it in the panel is the whole reason not to show it here. Note this
  // reads the *active* chat only: a background chat's browser is still running
  // and still says so in the sidebar, but it never floats a preview over a
  // conversation it does not belong to.
  // The panel is the browser now, so having it open is the whole test.
  const alreadyOnScreen = state.rightPanelOpen
  return (
    state.enabled &&
    state.hasSession &&
    state.phase === 'ready' &&
    state.liveTabCount > 0 &&
    !state.dismissed &&
    !alreadyOnScreen
  )
}

export function usePipVisible(): boolean {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const chat = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const enabled = useSettingsStore((s) => s.browserPip)

  return pipVisible({
    enabled,
    hasSession: Boolean(sessionId),
    phase: chat.phase,
    liveTabCount: chat.tabs.filter((t) => !isBlankTab(t)).length,
    dismissed: chat.pipDismissed,
    rightPanelOpen
  })
}

export default function BrowserPip(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const chat = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER)
  const ws = useWorkspaceStore((s) => workspaceFor(s, sessionId))
  const dismissPip = useBrowserStore((s) => s.dismissPip)
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel)
  const visible = usePipVisible()
  const [expanded, setExpanded] = useState(false)

  if (!visible || !sessionId) return null

  // One tab at a time by default. Five live miniatures cost 0.09 MB/s, so this
  // is about the conversation underneath rather than the frame budget — the
  // stack is a click away when you want to compare two pages.
  const shownId = activeBrowserTabId(ws)
  const active = chat.tabs.find((t) => t.tabId === shownId) ?? chat.tabs[0]
  const shown = expanded ? chat.tabs : [active]
  const others = chat.tabs.length - 1

  const open = (tabId: string): void => {
    useWorkspaceStore.getState().selectTab(sessionId, browserKey(tabId))
    toggleRightPanel()
  }

  return (
    <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-secondary/80 shadow-xl backdrop-blur-xl backdrop-saturate-150">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Globe className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
          Browser
        </span>
        {others > 0 && (
          <button
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-0.5 rounded-sm bg-accent/60 px-1 py-px text-[9px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? 'Less' : `+${others}`}
            <ChevronDown className={`size-2.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              // Codex ships a preview that cannot be reliably dismissed, and it is
              // the single loudest complaint about their browser. This one closes.
              aria-label="Hide browser preview"
              onClick={() => dismissPip(sessionId, true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide — bring it back from the Summary</TooltipContent>
        </Tooltip>
      </div>

      <div className="max-h-[46vh] space-y-px overflow-y-auto">
        {shown.filter(Boolean).map((tab) => (
          <button
            key={tab.tabId}
            onClick={() => open(tab.tabId)}
            title={`${tab.title || tab.url}\nClick to open in the panel`}
            className="block w-full cursor-default text-left transition-opacity hover:opacity-90"
          >
            <BrowserCanvas
              targetId={tab.targetId}
              width={MINIATURE_WIDTH}
              // A preview does not need sixty frames a second to read as live.
              everyNthFrame={4}
              preview
              // The panel sizes its canvas explicitly; a miniature just takes
              // the column and keeps the page's aspect.
              className="h-auto w-full"
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
