/**
 * One browser tab, on screen.
 *
 * Split out of the old `BrowserPanel` when the panel stopped being the browser.
 * What stayed behind is routing; what came here is the page: the address bar,
 * the canvas, and the states a page can be in before it is one.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, Globe, RotateCw } from 'lucide-react'
import AgentCursor from './AgentCursor'
import BrowserCanvas from './BrowserCanvas'
import BrowserMenu, { isEmulating, type DeviceSpec } from './BrowserMenu'
import DeviceBar from './DeviceBar'
import { displayUrl, toUrl } from './url'
import Empty from '../workspace/Empty'
import { EMPTY_BROWSER, useBrowserStore, type BrowserPhase } from '../../store/browser'
import { fitScale } from '../../lib/browser/viewport'
import {
  forgetResponsiveViewport,
  requestResponsiveViewport
} from '../../lib/browser/viewportController'
import { useRunningStore } from '../../store/running'
import { useSettingsStore } from '../../store/settings'
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
  // This tab's own size, not the app-wide fallback — two tabs can be rendered
  // at different ones. Primitives rather than the record, so a `tabs` broadcast
  // on every navigation does not hand back a fresh object.
  const targetId = tab?.targetId ?? null
  const vpWidth = useBrowserStore(
    (s) => (targetId ? s.viewportByTarget[targetId]?.width : undefined) ?? s.viewport.width
  )
  const vpHeight = useBrowserStore(
    (s) => (targetId ? s.viewportByTarget[targetId]?.height : undefined) ?? s.viewport.height
  )
  const viewport = useMemo(() => ({ width: vpWidth, height: vpHeight }), [vpWidth, vpHeight])
  const [busy, setBusy] = useState(false)

  // The box the page is drawn into, measured rather than derived. The old
  // `panelWidth - 16` had to know about the wrapper's padding and still got the
  // border, the scrollbar and the app's zoom wrong.
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<number | 'fit'>('fit')

  const device = tab?.device ?? null
  const tabId = tab?.tabId ?? null
  const responsive = !device || device.id === 'responsive'

  // Read through a ref: the device record arrives fresh on every `tabs`
  // broadcast, so depending on it would re-run this per navigation.
  const deviceRef = useRef(device)
  deviceRef.current = device

  useEffect(() => {
    const node = boxRef.current
    if (!node || !tabId) return
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      cancelAnimationFrame(frame)
      // Through a frame rather than straight out of the callback: the observer
      // fires during layout, and setting state from there is what produces
      // "ResizeObserver loop completed with undelivered notifications".
      frame = requestAnimationFrame(() => setBox({ width: rect.width, height: rect.height }))
    })
    observer.observe(node)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      forgetResponsiveViewport(sessionId, tabId)
    }
  }, [sessionId, tabId])

  // Responsive mode's whole behaviour: the box is the viewport, so tell the
  // sidecar whenever it moves. Throttled in the controller, and never from a
  // preview — a miniature pushing its own 300px would re-emulate the tab the
  // agent is working in.
  useEffect(() => {
    if (!tabId || !responsive) return
    requestResponsiveViewport(sessionId, tabId, box.width, box.height, deviceRef.current)
  }, [sessionId, tabId, responsive, box.width, box.height])

  // Having the wheel is a state, and it ends when the turn does. Deriving it
  // here rather than storing a third flag means a turn that dies without a
  // tidy ending cannot leave a ghost hand on the page forever.
  const turnRunning = useRunningStore((s) => Boolean(s.running[sessionId]))
  const driving = turnRunning && tabId !== null && chat.driving === tabId

  const devices = useBrowserStore((s) => s.devices)
  const remembered = useSettingsStore((s) => s.browserDevice)

  /**
   * Both the menu and the bar land here, and here goes to the sidecar — the
   * same method the agent's tool uses. That is what makes an agent-chosen size
   * appear in this bar with no second code path to keep in step.
   */
  const applyDevice = useCallback(
    (spec: DeviceSpec) => {
      if (!tabId) return
      // Remember a real preset, so switching device mode back on returns to the
      // phone you were working against rather than to a hardcoded default.
      if (spec.id !== 'responsive' && spec.id !== 'custom') {
        useSettingsStore.getState().updateSettings({ browserDevice: spec.id })
      }
      void window.api.browser.tabSetViewport(sessionId, tabId, spec)
    },
    [sessionId, tabId]
  )

  const scale = responsive ? 1 : zoom === 'fit' ? fitScale(box, viewport) : zoom
  const drawWidth = Math.max(1, Math.round(viewport.width * scale))
  const drawHeight = Math.max(1, Math.round(viewport.height * scale))

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
        menu={
          <BrowserMenu device={tab.device} remembered={remembered} onPick={applyDevice} />
        }
      />

      {isEmulating(tab.device) && (
        <DeviceBar
          device={tab.device!}
          devices={devices}
          zoom={zoom}
          fitPercent={Math.round(fitScale(box, viewport) * 100)}
          onZoom={setZoom}
          onDevice={applyDevice}
        />
      )}

      {/* `overflow-hidden` while responsive is the fix for a feedback loop, not
          a style choice: following the box's height means a one-pixel overshoot
          spawns a scrollbar, which narrows the box, which changes the viewport,
          which changes the height. Device mode can overflow, so it scrolls. */}
      <div
        ref={boxRef}
        className={`grid min-h-0 flex-1 place-items-center p-2 ${
          responsive ? 'overflow-hidden' : 'overflow-auto'
        }`}
      >
        {/* Sized explicitly, and the canvas fills it exactly. That invariant is
            what keeps `pageFromCanvas` a single multiply under any scale, and
            what lets AgentCursor go on positioning in percentages. */}
        <div className="relative" style={{ width: drawWidth, height: drawHeight }}>
          <BrowserCanvas
            targetId={tab.targetId}
            width={drawWidth}
            interactive
            onUserInput={() => useBrowserStore.getState().releaseDriving(sessionId)}
            className="absolute inset-0 h-full w-full rounded-md border border-border/55"
          />
          <AgentCursor
            cursor={chat.cursor}
            tabId={tab.tabId}
            viewport={viewport}
            driving={driving}
          />
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
        <Globe className="mb-3 size-6 text-muted-foreground" />
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
  onHistory,
  menu
}: {
  tab: { url: string; canGoBack: boolean; canGoForward: boolean }
  busy: boolean
  onNavigate: (url: string) => void
  onHistory: (action: 'back' | 'forward' | 'reload') => void
  /** Sits after the address, where a browser's overflow menu lives. */
  menu?: React.ReactNode
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
        className="min-w-0 flex-1 rounded-md bg-secondary/60 px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:bg-secondary"
      />
      {menu}
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
