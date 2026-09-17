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
import { useSessionsStore } from './store/sessions'
import { attachWorktreeSessions } from './store/attachWorktrees'
import { primeHomedir } from './lib/homedir'
import { useWorkflowStore } from './store/workflow'
import { useProcessesStore, type BgProcess } from './store/processes'
import { useUiStore } from './store/ui'
import { handleBinding, usePanelLayoutStore } from './store/panelLayout'
import { usePanelSizesStore } from './store/panelSizes'

// Lazy-load heavy components — modals with Monaco, WorkflowCanvas with React Flow
const WorkflowCanvas = React.lazy(() => import('./components/WorkflowCanvas'))
const FilePreviewModal = React.lazy(() => import('./components/FilePreviewModal'))
const SkillEditorModal = React.lazy(() => import('./components/SkillEditorModal'))
const HookEditorModal = React.lazy(() => import('./components/HookEditorModal'))
const WelcomeModal = React.lazy(() => import('./components/WelcomeModal'))
const LoginModal = React.lazy(() => import('./components/LoginModal'))

export default function App(): React.JSX.Element {
  // Both side panels live in the ui store now, next to bottomPanelOpen — the
  // summary toggle in the chat header needs to reach one of them from there.
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen)
  const projectsPanelOpen = useUiStore((s) => s.projectsPanelOpen)
  const toggleBottomPanel = useUiStore((s) => s.toggleBottomPanel)
  const isCanvasOpen = useWorkflowStore((s) => s.isCanvasOpen)
  const resolvedTheme = useResolvedTheme()
  const shellRef = useRef<HTMLDivElement>(null)
  useKeyboardShortcuts()

  useEffect(() => {
    // Rehydrate first: the synchronous half of the projects backfill runs inside
    // the store's merge, and the git-dependent half has to follow it.
    void Promise.resolve(useSessionsStore.persist.rehydrate()).then(attachWorktreeSessions)
    void primeHomedir()
  }, [])

  useEffect(() => {
    applyThemeClass(resolvedTheme)
  }, [resolvedTheme])

  // Publish --rail: how much of the window sits to the left of the conversation.
  //
  // Chat centres its column on the window rather than on its own container, so
  // this is the one part of the geometry CSS cannot work out for itself. Written
  // from a subscription rather than rendered, so dragging the rail does not
  // reconcile the whole conversation sixty times a second — Chat just inherits it.
  //
  // Layout effect, not effect: this has to land before the first paint, or the
  // column is briefly centred as though no rail were open and visibly jumps.
  useLayoutEffect(() => {
    const publish = (width: number): void => {
      shellRef.current?.style.setProperty('--rail', `${width}px`)
    }
    publish(usePanelLayoutStore.getState().sidebarWidth)
    return usePanelLayoutStore.subscribe((state, prev) => {
      if (state.sidebarWidth !== prev.sidebarWidth) publish(state.sidebarWidth)
    })
  }, [])

  // Subscribe to background-process updates from main
  useEffect(() => {
    const unsub = window.api.processes.onUpdate(({ nyraSessionId, processes }) => {
      useProcessesStore.getState().setForSession(nyraSessionId, processes as BgProcess[])
    })
    return unsub
  }, [])

  // Toggle bottom panel with Cmd+J
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'j' && e.metaKey && !e.shiftKey) {
        e.preventDefault()
        toggleBottomPanel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleBottomPanel])

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
            onSize={(px) => usePanelSizesStore.getState().setSize('rightPanelWidth', px)}
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
        <FilePreviewModal />
        <SkillEditorModal />
        <HookEditorModal />
        <WelcomeModal />
        <LoginModal />
      </Suspense>
    </div>
    </TooltipProvider>
  )
}
