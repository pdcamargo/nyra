/**
 * Where the open file sits, and a way sideways from every step of it.
 *
 * Each crumb opens its siblings, which is pure reuse of `fs_list_dir` on the
 * crumb's parent — the tree already pays for that call, and this needs no
 * backend of its own.
 */
import React, { useEffect, useState } from 'react'
import { ChevronRight, File, Folder } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { breadcrumbs, dirnameOf, joinPath, type Crumb } from './paths'
import type { DirEntryInfo } from '../../lib/api-types'

export default function FileBreadcrumb({
  root,
  path,
  onOpenFile,
  onRevealDir
}: {
  root: string
  path: string
  /** A file was picked. `sameTab` is false when it came from a folder crumb,
   *  where the user was navigating rather than swapping what they are reading. */
  onOpenFile: (absolutePath: string, sameTab: boolean) => void
  onRevealDir: (absolutePath: string) => void
}): React.JSX.Element {
  const crumbs = breadcrumbs(root, path)

  return (
    <nav
      aria-label="File path"
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto px-2 py-1 text-[11px]"
    >
      {crumbs.map((crumb, i) => (
        <React.Fragment key={crumb.path}>
          {i > 0 && (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <CrumbMenu
            crumb={crumb}
            isLast={i === crumbs.length - 1}
            onOpenFile={onOpenFile}
            onRevealDir={onRevealDir}
          />
        </React.Fragment>
      ))}
    </nav>
  )
}

function CrumbMenu({
  crumb,
  isLast,
  onOpenFile,
  onRevealDir
}: {
  crumb: Crumb
  isLast: boolean
  onOpenFile: (absolutePath: string, sameTab: boolean) => void
  onRevealDir: (absolutePath: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null)

  // The last crumb is the file itself, so its siblings live in its parent.
  const listDir = isLast ? dirnameOf(crumb.path) : crumb.path

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setEntries(null)
    void window.api.fs.listDir(listDir).then((listing) => {
      if (!cancelled) setEntries(listing.entries)
    })
    return () => {
      cancelled = true
    }
  }, [open, listDir])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={`shrink-0 truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/50 aria-expanded:bg-accent/50 ${
          isLast ? 'text-foreground' : 'text-muted-foreground'
        }`}
      >
        {crumb.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
        {entries === null ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Nothing here</p>
        ) : (
          entries.map((entry) => {
            const target = joinPath(listDir, entry.name)
            const isDir = entry.type === 'dir'
            return (
              <DropdownMenuItem
                key={entry.name}
                onSelect={() =>
                  isDir ? onRevealDir(target) : onOpenFile(target, isLast)
                }
              >
                {isDir ? <Folder /> : <File />}
                <span className="truncate">{entry.name}</span>
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
