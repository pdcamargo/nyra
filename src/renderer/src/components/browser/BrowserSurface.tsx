/**
 * One browser tab, on screen.
 *
 * Split out of the old `BrowserPanel` when the panel stopped being the browser.
 * What stayed behind is routing; what came here is the page: the address bar,
 * the canvas, and the states a page can be in before it is one.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Globe, RotateCw } from 'lucide-react'
import AgentCursor from './AgentCursor'
import BrowserCanvas from './BrowserCanvas'
import { displayUrl, toUrl } from './url'
import Empty from '../workspace/Empty'
import { EMPTY_BROWSER, useBrowserStore, type BrowserPhase } from '../../store/browser'
import { usePanelLayoutStore } from '../../store/panelLayout'
import type { BrowserTab } from '../../lib/api-types'

export default function BrowserSurface({
  sessionId,
  tab
}: {
  sessionId: string
  /** Null while the browser is coming up, or failed to. */
  tab: BrowserTab | null
}): React.JSX.Element {
  const chat = useBrowserStore((s) => s.bySession[sessionId] ?? EMPTY_BROWSER)
  const panelWidth = usePanelLayoutStore((s) => s.rightPanelWidth)
  const viewport = useBrowserStore((s) => s.viewport)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }, [])

  if (!tab) return <BrowserPhaseState sessionId={sessionId} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <UrlBar
        key={tab.tabId}
        tab={tab}
        busy={busy}
        onNavigate={(url) =>
          void run(() => window.api.browser.tabNavigate(sessionId, tab.tabId, url))
        }
        onHistory={(action) =>
          void run(() => window.api.browser.tabHistory(sessionId, tab.tabId, action))
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="relative">
          <BrowserCanvas
            targetId={tab.targetId}
            width={Math.max(320, panelWidth - 16)}
            interactive
            className="rounded-md border border-border/55"
          />
          <AgentCursor cursor={chat.cursor} tabId={tab.tabId} viewport={viewport} />
        </div>
      </div>
    </div>
  )
}

/**
 * Is the browser on its way, or did it fail on the way?
 *
 * Deliberately not `phase !== 'off'`. A chat whose tabs have all been closed
 * keeps its context, so its phase stays `ready` — and reading that as "something
 * is coming" is what made an empty panel claim to be starting a browser nobody
 * had asked for.
 */
export function browserPending(phase: BrowserPhase): boolean {
  return phase === 'starting' || phase === 'needs-chromium' || phase === 'error'
}

/**
 * What the browser half of the panel says when it has no page to show.
 *
 * Reachable two ways: the strip is empty and something asked for a browser, or a
 * browser tab is selected but Chromium is still coming up. Either way this takes
 * the body only — never the tab strip, which used to disappear behind the
 * download prompt.
 */
export function BrowserPhaseState({ sessionId }: { sessionId: string }): React.JSX.Element {
  const chat = useBrowserStore((s) => s.bySession[sessionId] ?? EMPTY_BROWSER)
  const install = useBrowserStore((s) => s.install)
  const [busy, setBusy] = useState(false)

  if (chat.phase === 'needs-chromium') {
    return (
      <Empty>
        <Globe className="mb-3 size-6 text-muted-foreground/50" />
        <p className="mb-1 text-[12px] text-foreground">Nyra needs a browser engine</p>
        <p className="mb-4 max-w-[240px] text-[11px] leading-relaxed text-muted-foreground">
          Chromium is a one-time 182&nbsp;MB download, kept outside the app so updates stay small.
        </p>
        <button
          disabled={Boolean(install) || busy}
          onClick={() =>
            void (async () => {
              setBusy(true)
              try {
                const result = await window.api.browser.install()
                if (result.ok) useBrowserStore.getState().setPhase(sessionId, 'off')
              } finally {
                setBusy(false)
              }
            })()
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
        <p className="max-w-[260px] text-[11px] leading-relaxed text-muted-foreground">
          {chat.error}
        </p>
      </Empty>
    )
  }

  // `ready` here means the browser is up and a tab is on its way.
  return <Empty>{chat.phase === 'ready' ? 'Opening…' : 'Starting the browser…'}</Empty>
}

function UrlBar({
  tab,
  busy,
  onNavigate,
  onHistory
}: {
  tab: { url: string; canGoBack: boolean; canGoForward: boolean }
  busy: boolean
  onNavigate: (url: string) => void
  onHistory: (action: 'back' | 'forward' | 'reload') => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => displayUrl(tab.url))
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the page, but never move the text out from under someone typing it.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(displayUrl(tab.url))
  }, [tab.url])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onNavigate(toUrl(draft))
        inputRef.current?.blur()
      }}
      className="flex items-center gap-1 border-b border-border/55 px-1.5 py-1"
    >
      <NavButton label="Back" disabled={!tab.canGoBack} onClick={() => onHistory('back')}>
        <ArrowLeft className="size-3.5" />
      </NavButton>
      <NavButton label="Forward" disabled={!tab.canGoForward} onClick={() => onHistory('forward')}>
        <ArrowRight className="size-3.5" />
      </NavButton>
      <NavButton label="Reload" disabled={busy} onClick={() => onHistory('reload')}>
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
