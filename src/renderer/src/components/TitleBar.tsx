import React from 'react'
import {
  FolderOpen,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  SquareTerminal,
  TextQuote
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useUiStore } from '../store/ui'
import { useSessionsStore, activeSession as activeSessionSelector } from '../store/sessions'

/**
 * The window's own title bar.
 *
 * The window is `titleBarStyle: "Overlay"` with `hiddenTitle`, so the traffic
 * lights float over the web content and this strip has to leave room for them.
 * It replaces the old fixed `.drag-region` overlay and the three independent
 * `pt-[46px]` offsets that Sidebar, Chat and RightPanel each hardcoded to clear
 * it — the same magic number written down in three places.
 *
 * Dragging is explicit. `-webkit-app-region: drag` is a Chromium extension that
 * WKWebView does not implement, so the CSS the Electron build relied on did
 * nothing here — the bar asks the window to move instead, and ignores presses
 * that landed on a control.
 */

/** True for a press on the bar itself rather than on something interactive. */
function isBareTitleBar(target: EventTarget | null): boolean {
  return !(target instanceof Element) || !target.closest('button, a, input, [role="button"]')
}
function TitleBarButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        aria-pressed={active}
        aria-label={label}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          active
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function TitleBar(): React.JSX.Element {
  const projectsPanelOpen = useUiStore((s) => s.projectsPanelOpen)
  const toggleProjectsPanel = useUiStore((s) => s.toggleProjectsPanel)
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel)
  const summaryOpen = useUiStore((s) => s.summaryOpen)
  const toggleSummary = useUiStore((s) => s.toggleSummary)
  const terminalOpen = useUiStore((s) => s.bottomPanelOpen)
  const toggleBottomPanel = useUiStore((s) => s.toggleBottomPanel)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const openPalette = useUiStore((s) => s.openPalette)
  const session = useSessionsStore(activeSessionSelector)

  return (
    <header
      onMouseDown={(e) => {
        if (e.button !== 0 || !isBareTitleBar(e.target)) return
        void window.api.appWindow.startDragging()
      }}
      onDoubleClick={(e) => {
        if (!isBareTitleBar(e.target)) return
        void window.api.appWindow.toggleMaximize()
      }}
      className="flex h-[38px] shrink-0 select-none items-center gap-1 border-b border-border/55 bg-sidebar pr-2 pl-[78px]"
      data-testid="title-bar"
    >
      <TitleBarButton
        label={projectsPanelOpen ? 'Hide projects' : 'Show projects'}
        active={projectsPanelOpen}
        onClick={toggleProjectsPanel}
      >
        <PanelLeft className="size-4" />
      </TitleBarButton>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-3">
        {session && (
          <>
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-medium text-foreground">{session.title}</span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <TitleBarButton label="Search (⌘K)" onClick={() => openPalette('all')}>
          <Search className="size-4" />
        </TitleBarButton>
        <TitleBarButton label="Terminal (⌘J)" active={terminalOpen} onClick={toggleBottomPanel}>
          <SquareTerminal className="size-4" />
        </TitleBarButton>
        <TitleBarButton label="Summary" active={summaryOpen} onClick={toggleSummary}>
          <TextQuote className="size-4" />
        </TitleBarButton>
        <TitleBarButton label="Workspace panel" active={rightPanelOpen} onClick={toggleRightPanel}>
          <PanelRight className="size-4" />
        </TitleBarButton>
        <TitleBarButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="size-4" />
        </TitleBarButton>
      </div>
    </header>
  )
}
