import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Globe, RotateCw } from 'lucide-react'
import BrowserCanvas from './BrowserCanvas'
import BrowserTabStrip from './BrowserTabStrip'
import { displayUrl, toUrl } from './url'
import { EMPTY_BROWSER, useBrowserStore } from '../../store/browser'
import { usePanelLayoutStore } from '../../store/panelLayout'
import { useSessionsStore } from '../../store/sessions'

/** Long enough to be cheap, short enough that the sidecar's ten-minute idle
 *  sweeper never evicts a context somebody is looking at. */
const TOUCH_INTERVAL_MS = 60_000

export default function BrowserPanel(): React.JSX.Element {
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const chat = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : null) ?? EMPTY_BROWSER)
  const install = useBrowserStore((s) => s.install)
  const panelWidth = usePanelLayoutStore((s) => s.rightPanelWidth)
  const [busy, setBusy] = useState(false)

  const activeTab = chat.tabs.find((t) => t.tabId === chat.activeTabId) ?? null

  // Start the browser for whichever chat is on screen. The sidecar launches
  // Chromium on the first chat that asks and keeps it for the rest.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const store = useBrowserStore.getState()

    void (async () => {
      // Toggling back to a browser that is already up should not flash a
      // starting state at you. `gone` and `evicted` both reset the phase, so
      // `ready` can be trusted here.
      const current = useBrowserStore.getState().bySession[sessionId]
      if (current?.phase === 'ready' && useBrowserStore.getState().cdpUrl) return
      store.setPhase(sessionId, 'starting')
      const status = await window.api.browser.status()
      if (cancelled) return
      if (!status.ok) return store.setPhase(sessionId, 'error', status.error)
      if (status.chromium === 'missing') return store.setPhase(sessionId, 'needs-chromium')

      const opened = await window.api.browser.openChat(sessionId)
      if (cancelled) return
      if (!opened.ok) return store.setPhase(sessionId, 'error', opened.error)

      store.setEndpoint(opened.cdpUrl, opened.viewport)
      store.setPhase(sessionId, 'ready')

      const listed = await window.api.browser.tabList(sessionId)
      if (cancelled || !listed.ok) return
      // A browser with no tabs has nothing to show, so give it one rather than
      // making the first thing the panel says be "there is nothing here".
      if (listed.tabs.length === 0) await window.api.browser.tabCreate(sessionId, 'about:blank')
      else store.setTabs(sessionId, listed.tabs)
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId])

  // The sidecar cannot see the renderer's CDP traffic, so being looked at is
  // something only this side knows.
  useEffect(() => {
    if (!sessionId || chat.phase !== 'ready') return
    const ping = (): void => void window.api.browser.touch(sessionId)
    ping()
    const timer = setInterval(ping, TOUCH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [sessionId, chat.phase])

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await work()
      } finally {
        setBusy(false)
      }
    },
    []
  )

  if (!sessionId) {
    return <Empty>Open a chat to give it a browser.</Empty>
  }

  if (chat.phase === 'needs-chromium') {
    return (
      <Empty>
        <Globe className="mb-3 size-6 text-muted-foreground/50" />
        <p className="mb-1 text-[12px] text-foreground">Nyra needs a browser engine</p>
        <p className="mb-4 max-w-[240px] text-[11px] leading-relaxed text-muted-foreground">
          Chromium is a one-time 182&nbsp;MB download, kept outside the app so updates stay small.
        </p>
        <button
          disabled={Boolean(install)}
          onClick={() =>
            void run(async () => {
              const result = await window.api.browser.install()
              if (result.ok && sessionId) useBrowserStore.getState().setPhase(sessionId, 'off')
            })
          }
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent/70 disabled:opacity-60"
        >
          <Download className="size-3.5" />
          {install ? `Downloading… ${install.percent}%` : 'Download Chromium'}
        </button>
      </Empty>
    )
  }

  if (chat.phase === 'error') {
    return (
      <Empty>
        <p className="mb-1 text-[12px] text-foreground">The browser could not start</p>
        <p className="max-w-[260px] text-[11px] leading-relaxed text-muted-foreground">{chat.error}</p>
      </Empty>
    )
  }

  if (chat.phase !== 'ready') {
    return <Empty>Starting the browser…</Empty>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserTabStrip
        tabs={chat.tabs}
        activeTabId={chat.activeTabId}
        onSelect={(tabId) => useBrowserStore.getState().setActiveTab(sessionId, tabId)}
        onClose={(tabId) => void window.api.browser.tabClose(sessionId, tabId)}
        onCreate={() => void window.api.browser.tabCreate(sessionId, 'about:blank')}
      />

      <UrlBar
        key={activeTab?.tabId ?? 'none'}
        tab={activeTab}
        busy={busy}
        onNavigate={(url) =>
          activeTab && void run(() => window.api.browser.tabNavigate(sessionId, activeTab.tabId, url))
        }
        onHistory={(action) =>
          activeTab &&
          void run(() => window.api.browser.tabHistory(sessionId, activeTab.tabId, action))
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {activeTab ? (
          <BrowserCanvas
            targetId={activeTab.targetId}
            width={Math.max(320, panelWidth - 16)}
            interactive
            className="rounded-md border border-border/55"
          />
        ) : (
          <Empty>No tabs open.</Empty>
        )}
      </div>
    </div>
  )
}

function UrlBar({
  tab,
  busy,
  onNavigate,
  onHistory
}: {
  tab: { url: string; canGoBack: boolean; canGoForward: boolean } | null
  busy: boolean
  onNavigate: (url: string) => void
  onHistory: (action: 'back' | 'forward' | 'reload') => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => displayUrl(tab?.url ?? ''))
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the page, but never move the text out from under someone typing it.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(displayUrl(tab?.url ?? ''))
  }, [tab?.url])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onNavigate(toUrl(draft))
        inputRef.current?.blur()
      }}
      className="flex items-center gap-1 border-b border-border/55 px-1.5 py-1"
    >
      <NavButton label="Back" disabled={!tab?.canGoBack} onClick={() => onHistory('back')}>
        <ArrowLeft className="size-3.5" />
      </NavButton>
      <NavButton label="Forward" disabled={!tab?.canGoForward} onClick={() => onHistory('forward')}>
        <ArrowRight className="size-3.5" />
      </NavButton>
      <NavButton label="Reload" disabled={!tab || busy} onClick={() => onHistory('reload')}>
        <RotateCw className="size-3.5" />
      </NavButton>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        spellCheck={false}
        placeholder="Address, or a port like :5173"
        aria-label="Address"
        className="min-w-0 flex-1 rounded-md bg-secondary/60 px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:bg-secondary"
      />
    </form>
  )
}

function NavButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  )
}
