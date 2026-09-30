import React from 'react'
import { cn } from 'cn'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import WorkspaceAvatar from './WorkspaceAvatar'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { IconButton } from './ui/icon-button'
import { CommandKbd } from './ui/kbd'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore, type Workspace } from '../store/workspaces'
import { WORKSPACE_RAIL_WIDTH } from '../store/panelSizes'
import { useUiStore } from '../store/ui'
import { switchWorkspace } from '../lib/workspaces'
import type { CommandId } from '../commands/registry'

/**
 * The column of workspaces down the sidebar's left edge — one Claude account
 * each. Part of the sidebar: `App` mounts it beside the list and hides the two
 * together, and its width is its own rather than a slice of the list's. Sized
 * in `em` against the same UI font size the list is.
 */
export default function WorkspaceRail(): React.JSX.Element {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeId = useWorkspacesStore((s) => s.activeId)
  const openDialog = useUiStore((s) => s.setWorkspaceDialog)

  return (
    <nav
      aria-label="Workspaces"
      style={{ width: WORKSPACE_RAIL_WIDTH, fontSize: 'var(--ui-font-size, 13px)' }}
      className="scroll-auto-hide flex h-full shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border/55 bg-workspace-rail py-2"
    >
      {workspaces.map((workspace, index) => (
        <RailItem
          key={workspace.id}
          workspace={workspace}
          active={workspace.id === activeId}
          command={index < 9 ? (`workspace.switch.${index + 1}` as CommandId) : undefined}
        />
      ))}
      <IconButton
        label="New workspace"
        command="workspace.new"
        onClick={() => openDialog({ mode: 'create' })}
        className="flex size-10 shrink-0 items-center justify-center"
      >
        <span className="flex size-8 items-center justify-center rounded-[8px] border border-dashed border-border-strong">
          <Plus className="size-4" />
        </span>
      </IconButton>
    </nav>
  )
}

/**
 * One workspace. Selected is a 2px ring in the text colour, held 2px off the
 * tile so it reads over a picture as well as over initials, plus a step up in
 * the tile's text — and, in dark, its fill. A picture that is not selected sits
 * back a step, so selecting one is a change you can see in the picture too.
 *
 * The two corners are concentric: the ring's radius is the tile's plus the 4px
 * between their edges (2px gap, 2px ring). Pixels rather than the theme's
 * `rounded-lg`, which is 13.4px — rounder than the ring around it on a 32px tile.
 */
function RailItem({
  workspace,
  active,
  command
}: {
  workspace: Workspace
  active: boolean
  command?: CommandId
}): React.JSX.Element {
  const openDialog = useUiStore((s) => s.setWorkspaceDialog)
  const confirmDelete = useUiStore((s) => s.setWorkspaceDeleteId)

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={workspace.name}
              aria-current={active ? 'true' : undefined}
              onClick={() => switchWorkspace(workspace.id)}
              className={cn(
                'group flex size-10 shrink-0 items-center justify-center rounded-[12px] border-2 p-[2px] outline-none transition-colors focus-visible:border-ring',
                active ? 'border-foreground' : 'border-transparent'
              )}
            >
              <WorkspaceAvatar
                workspace={workspace}
                className={cn(
                  'size-8 rounded-[8px] text-[0.92em] transition-[background-color,color,opacity]',
                  workspace.image
                    ? active
                      ? 'opacity-100'
                      : 'opacity-70 group-hover:opacity-100'
                    : active
                      ? 'bg-workspace-tile-active text-foreground'
                      : 'bg-workspace-tile text-muted-foreground group-hover:bg-workspace-tile-active group-hover:text-foreground'
                )}
              />
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right">
          {workspace.name}
          {command && <CommandKbd id={command} />}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openDialog({ mode: 'edit', workspaceId: workspace.id })}>
          <Pencil />
          Edit workspace…
        </ContextMenuItem>
        {/* Default is ~/.claude. There is no deleting it, here or in Rust. */}
        {workspace.id !== DEFAULT_WORKSPACE_ID && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => confirmDelete(workspace.id)}>
              <Trash2 />
              Delete workspace…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
