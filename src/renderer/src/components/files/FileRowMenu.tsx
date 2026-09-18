/**
 * Right-click on a tree row.
 *
 * The "open with" list is detected rather than written down — a menu naming
 * editors this machine does not have is worse than no menu. Off macOS the list
 * comes back empty and this collapses to the system default, which works
 * everywhere.
 */
import React, { useState } from 'react'
import { ClipboardCopy, ExternalLink, FolderOpen, MessageSquare } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/context-menu'
import { relativeTo } from './paths'
import { useUiStore } from '../../store/ui'
import type { EditorApp } from '../../lib/api-types'

export default function FileRowMenu({
  root,
  path,
  isDir,
  className,
  children
}: {
  root: string
  path: string
  isDir: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [editors, setEditors] = useState<EditorApp[] | null>(null)
  const relative = relativeTo(root, path)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        // Probed when the menu opens rather than per row: a tree of 400 rows
        // should not be 400 lookups, and the Rust side memoises anyway.
        if (open && editors === null) void window.api.fs.listEditors().then(setEditors)
      }}
    >
      <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ExternalLink />
            Open with
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => void window.api.fs.openWith(path, null)}>
              System default
            </ContextMenuItem>
            {editors && editors.length > 0 && <ContextMenuSeparator />}
            {editors?.map((editor) => (
              <ContextMenuItem
                key={editor.path}
                onSelect={() => void window.api.fs.openWith(path, editor.path)}
              >
                {editor.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuItem onSelect={() => void window.api.fs.reveal(path)}>
          <FolderOpen />
          Reveal in Finder
        </ContextMenuItem>

        <ContextMenuSeparator />

        {!isDir && (
          <ContextMenuItem
            onSelect={() => {
              // The same text the @-mention autocomplete produces, so the
              // composer's existing decoration chips it with no change at all.
              useUiStore.getState().prefillInput(`@${relative}`)
            }}
          >
            <MessageSquare />
            Add to chat
          </ContextMenuItem>
        )}

        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(relative)}>
          <ClipboardCopy />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(path)}>
          <ClipboardCopy />
          Copy absolute path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
