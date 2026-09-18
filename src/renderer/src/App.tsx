import React, { useEffect, useLayoutEffect, useRef, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import Chat from './components/Chat'
import RightPanel from './components/RightPanel'
import ResizeHandle from './components/ResizeHandle'
import BottomDock from './components/BottomDock'
import CommandPalette from './components/CommandPalette'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useResolvedTheme } from './hooks/useResolvedTheme'
import { applyThemeClass } from './lib/theme'
import { appearanceOf, applyAppearance } from './lib/appearance'
import { applyZoom } from './lib/zoom'
import { useSettingsStore } from './store/settings'
import { useSessionsStore } from './store/sessions'
import { attachWorktreeSessions } from './store/attachWorktrees'
import { primeHomedir } from './lib/homedir'
import { useWorkflowStore } from './store/workflow'
import { useProcessesStore, type BgProcess } from './store/processes'
import { applySessionPanels, useUiStore } from './store/ui'
import { dropBrowserHub, useBrowserStore } from './store/browser'
import { syncBrowserGone, syncSidecarTabs, useWorkspaceStore } from './store/workspace'
import { handleBinding, usePanelLayoutStore } from './store/panelLayout'
import { usePanelSizesStore } from './store/panelSizes'

// Lazy-load heavy components — modals with Monaco, WorkflowCanvas with React Flow
const WorkflowCanvas = React.lazy(() => import('./components/WorkflowCanvas'))
const SkillEditorModal = React.lazy(() => import('./components/SkillEditorModal'))
const HookEditorModal = React.lazy(() => import('./components/HookEditorModal'))
const WelcomeModal = React.lazy(() => import('./components/WelcomeModal'))
const LoginModal = React.lazy(() => import('./components/LoginModal'))

/** Both stores feed the same two variables; unsubscribe from both together. */
function combineUnsubscribe(...offs: (() => void)[]): () => void {
  return () => offs.forEach((off) => off())
}

export default function App(): React.JSX.Element {
  // Both side panels live in the ui store now, next to bottomPanelOpen — the
  // summary toggle in the chat header needs to reach one of them from there.
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const projectsPanelOpen = useUiStore((s) => s.projectsPanelOpen)
  const isCanvasOpen = useWorkflowStore((s) => s.isCanvasOpen)
  const resolvedTheme = useResolvedTheme()
  const zoom = useSettingsStore((s) => s.zoom)
  const shellRef = useRef<HTMLDivElement>(null)
  useKeyboardShortcuts()

  // One look, at launch. Enough for a badge to be honest without the app
  // reaching out on a timer — and it stays a badge: nothing installs until the
  // About row is clicked.
  useEffect(() => {
    void window.api.updates
      .check()
      .then((result) => {
        if (result.available) useUiStore.getState().setUpdateAvailable(result.version)
      })
      .catch(() => {
        // Offline, or no release yet. A badge that cannot appear is the right
        // failure; the manual check in Settings says why.
      })
  }, [])

  useEffect(() => {
    // Rehydrate first: the synchronous half of the projects backfill runs inside
    // the store's merge, and the git-dependent half has to follow it.
    void Promise.resolve(useSessionsStore.persist.rehydrate())
      .then(attachWorktreeSessions)
      .then(() => {
        // The workspace store keeps file tabs per chat and hydrates on its own,
        // so it can be holding rows for chats this one no longer has. Pruned
        // here rather than on write, because only now is the session list real.
        const ids = useSessionsStore.getState().sessions.map((x) => x.id)
        useWorkspaceStore.getState().prune(ids)
      })
    void primeHomedir()
  }, [])

  useEffect(() => {
    applyThemeClass(resolvedTheme)
  }, [resolvedTheme])

  // Fonts and type size, written to <html> whenever they change. Subscribed
  // rather than rendered: nothing in the tree needs to re-render for a font
  // swap, the variables do the work.
  useEffect(() => {
    const push = (): void => applyAppearance(appearanceOf(useSettingsStore.getState()))
    push()
    return useSettingsStore.subscribe(push)
  }, [])

  useEffect(() => {
    void applyZoom(zoom)
  }, [zoom])

  // Panels follow the conversation. Switching chats loads what that one was left
  // at; a chat that has never been told inherits the current state rather than
  // snapping to a fixed default.
  useEffect(() => {
    let current = useSessionsStore.getState().activeSessionId
    applySessionPanels(current)
    return useSessionsStore.subscribe((state) => {
      if (state.activeSessionId === current) return
      current = state.activeSessionId
      applySessionPanels(current)
    })
  }, [])

  // Publish --rail and --right: how much of the window the panels take, so the
  // conversation can work out what is left for it.
  //
  // Chat centres its column on the window rather than on its own container, so
  // these are the parts of the geometry CSS cannot work out for itself. Written
  // from a subscription rather than rendered, so dragging the rail does not
  // reconcile the whole conversation sixty times a second — Chat just inherits it.
  //
  // Layout effect, not effect: this has to land before the first paint, or the
  // column is briefly centred as though no rail were open and visibly jumps.
  useLayoutEffect(() => {
    const publish = (rail: number, right: number): void => {
      shellRef.current?.style.setProperty('--rail', `${rail}px`)
      shellRef.current?.style.setProperty('--right', `${right}px`)
    }
    const read = (): [number, number] => {
      const { sidebarWidth, rightPanelWidth } = usePanelLayoutStore.getState()
      const ui = useUiStore.getState()
      return [ui.projectsPanelOpen ? sidebarWidth : 0, ui.rightPanelOpen ? rightPanelWidth : 0]
    }
    publish(...read())
    const republish = (): void => publish(...read())
    return combineUnsubscribe(
      usePanelLayoutStore.subscribe(republish),
      useUiStore.subscribe(republish)
    )
  }, [])

  // Subscribe to background-process updates from main
  useEffect(() => {
    const unsub = window.api.processes.onUpdate(({ nyraSessionId, processes }) => {
      useProcessesStore.getState().setForSession(nyraSessionId, processes as BgProcess[])
    })
    return unsub
  }, [])

  // Browser news from the sidecar. Routed here rather than in the panel because
  // a chat's browser keeps running while its panel is closed — that is the
  // whole point of it — so the tab list has to stay current with nothing
  // mounted to receive it.
  useEffect(() => {
    return window.api.browser.onEvent((event) => {
      const store = useBrowserStore.getState()
      switch (event.event) {
        case 'tabs':
          syncSidecarTabs(event.params.chatId, event.params.tabs)
          break
        case 'browser':
          if (event.params.state === 'ready' && event.params.cdpUrl) {
            store.setEndpoint(event.params.cdpUrl)
          } else if (event.params.state === 'gone') {
            dropBrowserHub()
            syncBrowserGone()
          }
          break
        case 'install':
          store.setInstall(
            event.params.state === 'downloading'
              ? { percent: event.params.percent ?? 0, totalMb: event.params.totalMb ?? 0 }
              : null
          )
          break
        case 'cursor':
          store.setCursor(event.params.chatId, {
            tabId: event.params.tabId,
            x: event.params.x,
            y: event.params.y,
            at: Date.now()
          })
          break
        case 'evicted':
          // The context is gone but the chat is not; it starts again on the
          // next look.
          store.setPhase(event.params.chatId, 'off')
          syncSidecarTabs(event.params.chatId, [])
          break
        case 'exit':
          dropBrowserHub()
          syncBrowserGone()
          break
      }
    })
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
    <div ref={shellRef} className="flex h-full w-full flex-col overflow-hidden bg-background">
      <TitleBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left Sidebar */}
      {projectsPanelOpen && (
        <>
          <Sidebar />
          <ResizeHandle
            side="left"
            label="Resize projects panel"
            {...handleBinding('sidebarWidth')}
            onSize={(px) => usePanelSizesStore.getState().setSize('sidebarWidth', px)}
            onReset={() => usePanelSizesStore.getState().resetSize('sidebarWidth')}
          />
        </>
      )}

      {/* Center: Chat/Workflow + Bottom Panel + Status bar */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {isCanvasOpen ? (
            <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground/70 text-xs">Loading workflow canvas…</div>}>
              <WorkflowCanvas />
            </Suspense>
          ) : (
            <Chat />
          )}
        </div>
        <BottomDock />
      </main>

      {/* Right Panel */}
      {rightPanelOpen && (
        <>
          <ResizeHandle
            side="right"
            label="Resize workspace panel"
            {...handleBinding('rightPanelWidth')}
            onSize={(px) => {
              usePanelSizesStore.getState().setSize('rightPanelWidth', px)
              const sid = useSessionsStore.getState().activeSessionId
              if (sid) useSessionsStore.getState().setSessionPanels(sid, { rightWidth: px })
            }}
            onReset={() => usePanelSizesStore.getState().resetSize('rightPanelWidth')}
          />
          <RightPanel />
        </>
      )}
      </div>


      {/* Chats, past prompts and actions, behind one input */}
      <CommandPalette />

      {/* Lazy-loaded modals */}
      <Suspense fallback={null}>
        <SkillEditorModal />
        <HookEditorModal />
        <WelcomeModal />
        <LoginModal />
      </Suspense>
    </div>
    </TooltipProvider>
  )
}
