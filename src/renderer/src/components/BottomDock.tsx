import React, { Suspense } from 'react'
import ResizeHandle from './ResizeHandle'
import { useUiStore } from '../store/ui'
import { useSessionsStore, activeProject, activeProjectCwd } from '../store/sessions'
import { handleBinding, usePanelLayoutStore } from '../store/panelLayout'
import { usePanelSizesStore } from '../store/panelSizes'

// xterm is ~6.1 MB, so the dock stays lazy the way it was in App.
const BottomPanel = React.lazy(() => import('./BottomPanel'))

/**
 * The terminal dock and the handle that sizes it.
 *
 * Split out of App so that dragging it re-renders this and nothing else: App
 * renders <Chat/>, so a height subscription up there would reconcile the whole
 * conversation on every mousemove.
 */
export default function BottomDock(): React.JSX.Element | null {
  const open = useUiStore((s) => s.bottomPanelOpen)
  const height = usePanelLayoutStore((s) => s.bottomPanelHeight)
  // Terminals are project-scoped: a worktree chat's shell still belongs to the
  // project, and switching chats within a project must not swap the shells out.
  const project = useSessionsStore(activeProject)
  const cwd = useSessionsStore(activeProjectCwd)

  if (!open) return null

  return (
    <>
      <ResizeHandle
        side="bottom"
        label="Resize bottom panel"
        {...handleBinding('bottomPanelHeight')}
        onSize={(px) => usePanelSizesStore.getState().setSize('bottomPanelHeight', px)}
        onReset={() => usePanelSizesStore.getState().resetSize('bottomPanelHeight')}
      />
      <div style={{ height }} className="min-h-0 shrink-0">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full text-muted-foreground/70 text-xs">
              Loading bottom panel…
            </div>
          }
        >
          <BottomPanel cwd={cwd} projectId={project?.id ?? null} />
        </Suspense>
      </div>
    </>
  )
}
