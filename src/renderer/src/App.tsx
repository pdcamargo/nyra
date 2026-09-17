import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import Chat from './components/Chat'
import RightPanel from './components/RightPanel'
import CommandPalette from './components/CommandPalette'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useResolvedTheme } from './hooks/useResolvedTheme'
import { applyThemeClass } from './lib/theme'
import { useSessionsStore, activeProject, activeProjectCwd } from './store/sessions'
import { attachWorktreeSessions } from './store/attachWorktrees'
import { primeHomedir } from './lib/homedir'
import { useWorkflowStore } from './store/workflow'
import { useProcessesStore, type BgProcess } from './store/processes'
import { useUiStore } from './store/ui'

// Lazy-load heavy components — BottomPanel (xterm ~6.1 MB), modals with Monaco, WorkflowCanvas with React Flow
const BottomPanel = React.lazy(() => import('./components/BottomPanel'))
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
  const terminalOpen = useUiStore((s) => s.bottomPanelOpen)
  const toggleBottomPanel = useUiStore((s) => s.toggleBottomPanel)
  const [terminalHeight, setTerminalHeight] = useState(250)
  const resizingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(250)
  const isCanvasOpen = useWorkflowStore((s) => s.isCanvasOpen)
  const resolvedTheme = useResolvedTheme()
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

  // Terminal resize drag handling
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    startYRef.current = e.clientY
    startHeightRef.current = terminalHeight

    const onMove = (ev: MouseEvent): void => {
      if (!resizingRef.current) return
      const delta = startYRef.current - ev.clientY
      const newHeight = Math.max(120, Math.min(window.innerHeight - 200, startHeightRef.current + delta))
      setTerminalHeight(newHeight)
    }
    const onUp = (): void => {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [terminalHeight])

  // Terminals are project-scoped: a worktree chat's shell still belongs to the
  // project, and switching chats within a project must not swap the shells out.
  const project = useSessionsStore(activeProject)
  const terminalCwd = useSessionsStore(activeProjectCwd)

  return (
    <TooltipProvider delayDuration={400}>
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <TitleBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left Sidebar */}
      {projectsPanelOpen && <Sidebar />}

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
        {terminalOpen && (
          <>
            <div
              onMouseDown={onResizeStart}
              className="h-[3px] cursor-row-resize hover:bg-info/30 transition-colors"
            />
            <div style={{ height: terminalHeight }} className="min-h-0 shrink-0">
              <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground/70 text-xs">Loading bottom panel…</div>}>
                <BottomPanel cwd={terminalCwd} projectId={project?.id ?? null} />
              </Suspense>
            </div>
          </>
        )}
      </main>

      {/* Right Panel */}
      {rightPanelOpen && <RightPanel />}
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
