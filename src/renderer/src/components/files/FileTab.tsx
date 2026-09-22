/**
 * One file tab: the file on the left, the tree on the right.
 *
 * The tree's open state and width are per chat rather than per tab — two file
 * tabs in one conversation disagreeing about whether the tree is open would
 * read as a bug, not a feature.
 */
import React from 'react'
import { PanelRight } from 'lucide-react'
import FileBreadcrumb from './FileBreadcrumb'
import FilePreviewPane from './FilePreviewPane'
import FileTree from './FileTree'
import { clampTreeWidth, TREE_DEFAULT_WIDTH, treeFits } from './treeWidth'

import ResizeHandle from '../ResizeHandle'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useChordLabel } from '../ui/kbd'
import { usePanelLayoutStore } from '../../store/panelLayout'
import { cwdForSession, useSessionsStore } from '../../store/sessions'
import { useWorkspaceStore, workspaceFor, type FileWorkspaceTab } from '../../store/workspace'

export default function FileTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: FileWorkspaceTab
}): React.JSX.Element {
  // The chat's directory, which for a worktree chat is the worktree — not the
  // project it was cut from, whose files are a different checkout.
  const root = useSessionsStore((s) => cwdForSession(s, sessionId))
  const ws = useWorkspaceStore((s) => workspaceFor(s, sessionId))
  const panelWidth = usePanelLayoutStore((s) => s.rightPanelWidth)
  const treeKeys = useChordLabel('panel.right.tree')

  const fits = treeFits(panelWidth)
  const showTree = ws.treeOpen && fits
  const treeWidth = clampTreeWidth(ws.treeWidth ?? TREE_DEFAULT_WIDTH, panelWidth)

  const openFile = (path: string, sameTab = true): void => {
    const store = useWorkspaceStore.getState()
    if (sameTab) store.setFilePath(sessionId, tab.id, path)
    else store.openFileTab(sessionId, path)
  }

  /** A folder picked from a breadcrumb: open it in the tree rather than in the
   *  preview, which is the only thing a folder can mean here. */
  const revealDir = (dir: string): void => {
    const store = useWorkspaceStore.getState()
    if (!workspaceFor(store, sessionId).treeExpanded.includes(dir)) {
      store.toggleTreeDir(sessionId, dir)
    }
    if (!ws.treeOpen) store.setTreeOpen(sessionId, true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/55">
        <div className="min-w-0 flex-1">
          {tab.path ? (
            <FileBreadcrumb
              root={root}
              path={tab.path}
              onOpenFile={openFile}
              onRevealDir={revealDir}
            />
          ) : (
            <p className="truncate px-2 py-1 text-[11px] text-muted-foreground">No file open</p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            aria-label="Toggle file tree"
            aria-pressed={showTree}
            disabled={!fits}
            onClick={() => useWorkspaceStore.getState().setTreeOpen(sessionId, !ws.treeOpen)}
            className={`mr-1.5 shrink-0 rounded p-1 transition-colors disabled:opacity-30 ${
              showTree
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`}
          >
            <PanelRight className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            {fits
              ? treeKeys
                ? `Toggle file tree (${treeKeys})`
                : 'Toggle file tree'
              : 'The panel is too narrow for the tree'}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <FilePreviewPane path={tab.path} />
        </div>
        {showTree && (
          <>
            <ResizeHandle
              side="right"
              label="Resize file tree"
              getSize={() =>
                clampTreeWidth(
                  workspaceFor(useWorkspaceStore.getState(), sessionId).treeWidth ??
                    TREE_DEFAULT_WIDTH,
                  usePanelLayoutStore.getState().rightPanelWidth
                )
              }
              clamp={(candidate) =>
                clampTreeWidth(candidate, usePanelLayoutStore.getState().rightPanelWidth)
              }
              onSize={(px) => useWorkspaceStore.getState().setTreeWidth(sessionId, px)}
              onReset={() => useWorkspaceStore.getState().setTreeWidth(sessionId, null)}
            />
            <aside
              style={{ width: treeWidth }}
              className="shrink-0 border-l border-border/55 bg-card"
            >
              <FileTree
                sessionId={sessionId}
                root={root}
                selectedPath={tab.path}
                expanded={ws.treeExpanded}
                onOpen={(path) => openFile(path)}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

