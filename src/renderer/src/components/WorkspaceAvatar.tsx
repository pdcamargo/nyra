import React from 'react'
import { cn } from 'cn'
import { initials } from '../lib/workspaces'
import type { Workspace } from '../store/workspaces'

/**
 * A workspace's face: its picture, or its initials on a tile.
 *
 * Size, radius and type size come from the caller — the rail, the dialog's
 * preview and the sign-in header all draw it at different sizes. Colours of
 * the initials tile come from the caller too, because the rail steps them for
 * hover and selection and the others do not.
 */
export default function WorkspaceAvatar({
  workspace,
  className
}: {
  workspace: Pick<Workspace, 'name' | 'image'>
  className?: string
}): React.JSX.Element {
  if (workspace.image) {
    return (
      <img
        src={workspace.image}
        alt=""
        draggable={false}
        className={cn('shrink-0 object-cover', className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 select-none items-center justify-center bg-muted font-semibold text-muted-foreground',
        className
      )}
    >
      {initials(workspace.name)}
    </span>
  )
}
