/**
 * The side panel.
 *
 * Routing, and nothing else: which tab is on screen decides what the body is,
 * and each kind of tab owns its own surface. The one piece of judgement here is
 * the boot gate — a chat with only file tabs must never start a Chromium, which
 * is what mounting this used to mean.
 */
import React from 'react'
import WorkspaceTabStrip from './WorkspaceTabStrip'
import WorkspaceEmpty from './WorkspaceEmpty'
import Empty from './Empty'
import type { NewTabKind } from './tabs'
import BrowserSurface, { BrowserPhaseState } from '../browser/BrowserSurface'
import { useBrowserSession, startBrowserTab } from '../browser/useBrowserSession'
import FileTab from '../files/FileTab'
import { useBrowserStore } from '../../store/browser'
import type { BrowserTab } from '../../lib/api-types'
import { useSessionsStore } from '../../store/sessions'
import { activeTab, useWorkspaceStore, wantsBrowser, workspaceFor } from '../../store/workspace'

/** Hoisted: a fresh `[]` from the selector is a new identity every call, which
 *  zustand reads as a change and re-renders into forever. */
const NO_BROWSER_TABS: BrowserTab[] = []

export default function WorkspacePanel(): React.JSX.Element {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const ws = useWorkspaceStore((s) => workspaceFor(s, sessionId))
  const browserTabs = useBrowserStore(
    (s) => (sessionId ? s.bySession[sessionId] : null)?.tabs ?? NO_BROWSER_TABS
  )
  const phase = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null)?.phase ?? 'off')

  // The gate. Null means "this chat does not want a browser", and the hook does
  // nothing at all — no status probe, no openChat, no heartbeat.
  useBrowserSession(wantsBrowser(ws) && sessionId ? sessionId : null)

  if (!sessionId) return <Empty>Open a chat to give it a workspace.</Empty>

  const newTab = (kind: NewTabKind): void => {
    if (kind === 'browser') void startBrowserTab(sessionId)
    else useWorkspaceStore.getState().openFileTab(sessionId)
  }

  const active = activeTab(ws)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceTabStrip
        tabs={ws.tabs}
        activeKey={ws.activeKey}
        browserTabs={browserTabs}
        onSelect={(key) => useWorkspaceStore.getState().selectTab(sessionId, key)}
        onClose={(key) => {
          const tab = ws.tabs.find((t) => (t.kind === 'browser' ? `browser:${t.tabId}` : `file:${t.id}`) === key)
          // A browser tab's removal is the sidecar's to report. Splicing it out
          // here would let the broadcast already in flight put it back, at the
          // far end of the strip rather than where it was.
          if (tab?.kind === 'browser') void window.api.browser.tabClose(sessionId, tab.tabId)
          else useWorkspaceStore.getState().closeTab(sessionId, key)
        }}
        onNew={newTab}
      />

      <div className="min-h-0 flex-1">
        {active?.kind === 'browser' ? (
          <BrowserSurface
            sessionId={sessionId}
            tab={browserTabs.find((t) => t.tabId === active.tabId) ?? null}
          />
        ) : active?.kind === 'file' ? (
          <FileTab sessionId={sessionId} tab={active} />
        ) : phase !== 'off' ? (
          // No tab, but somebody asked for a browser and it has not produced one
          // — the download prompt lives here rather than taking the whole panel.
          <BrowserPhaseState sessionId={sessionId} />
        ) : (
          <WorkspaceEmpty onPick={newTab} />
        )}
      </div>
    </div>
  )
}
