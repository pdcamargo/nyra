import React from 'react'
import Modal from './Modal'
import WorkspaceAvatar from './WorkspaceAvatar'
import { useUiStore } from '../store/ui'
import { findProject, useSessionsStore } from '../store/sessions'
import { useWorkspacesStore } from '../store/workspaces'
import { moveProjectToWorkspace } from '../lib/workspaces'

/**
 * The palette's way to move a project: the same choice the project menu's
 * "Move to workspace" submenu offers, for someone who got there by typing.
 */
export default function MoveProjectDialog(): React.JSX.Element | null {
  const projectId = useUiStore((s) => s.moveProjectId)
  const close = useUiStore((s) => s.setMoveProjectId)
  const project = useSessionsStore((s) => findProject(s, projectId))
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  if (!project) return null

  const others = workspaces.filter((w) => w.id !== project.workspaceId)

  return (
    <Modal onClose={() => close(null)} title={`Move ${project.name} to a workspace`} className="w-[340px] max-w-[92vw]">
      <div className="border-b border-border/55 px-4 py-3">
        <h2 className="truncate text-[14px] font-semibold text-foreground">Move “{project.name}”</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Its chats carry on under that account, with their history.
        </p>
      </div>
      <div className="flex flex-col p-1.5">
        {others.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              moveProjectToWorkspace(project.id, w.id)
              close(null)
            }}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent/50"
          >
            <WorkspaceAvatar workspace={w} className="size-6 rounded-md text-[10px]" />
            <span className="min-w-0 truncate">{w.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
