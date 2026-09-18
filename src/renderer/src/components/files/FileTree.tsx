/**
 * The workspace tree, one directory at a time.
 *
 * Lazy because a repo is not a thing you can list: the eager alternative is
 * `git ls-files` for the whole checkout on every chat switch, which is tens of
 * thousands of paths in a monorepo. Expanding a folder is a click, and a click
 * can afford a round trip.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { joinPath, relativeTo } from './paths'
import { useWorkspaceStore } from '../../store/workspace'
import type { DirEntryInfo, DirListing } from '../../lib/api-types'

type Listings = Record<string, DirListing | 'loading'>

export default function FileTree({
  sessionId,
  root,
  selectedPath,
  expanded,
  onOpen
}: {
  sessionId: string
  /** The chat's directory — a worktree path for a worktree chat. */
  root: string
  selectedPath: string | null
  expanded: string[]
  onOpen: (absolutePath: string) => void
}): React.JSX.Element {
  const [listings, setListings] = useState<Listings>({})

  const load = useCallback(async (dir: string) => {
    setListings((prev) => (prev[dir] ? prev : { ...prev, [dir]: 'loading' }))
    const listing = await window.api.fs.listDir(dir)
    setListings((prev) => ({ ...prev, [dir]: listing }))
  }, [])

  // The root, and anything the chat had open. Re-runs when the chat's directory
  // changes — a pending worktree materialising is exactly that.
  useEffect(() => {
    setListings({})
    if (root) void load(root)
  }, [root, load])

  useEffect(() => {
    for (const dir of expanded) if (!listings[dir]) void load(dir)
    // Only when the set of open folders changes; `listings` is the thing being
    // filled and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, root, load])

  const toggle = (dir: string): void => {
    useWorkspaceStore.getState().toggleTreeDir(sessionId, dir)
  }

  const refresh = (): void => {
    setListings({})
    void load(root)
    for (const dir of expanded) void load(dir)
  }

  if (!root) {
    return <p className="p-3 text-[11px] text-muted-foreground/70">This chat has no folder.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <span className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
          Files
        </span>
        <button
          type="button"
          aria-label="Refresh tree"
          title="Refresh"
          onClick={refresh}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <RefreshCw className="size-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        <Level
          dir={root}
          root={root}
          depth={0}
          listings={listings}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onOpen={onOpen}
        />
      </div>
    </div>
  )
}

function Level({
  dir,
  root,
  depth,
  listings,
  expanded,
  selectedPath,
  onToggle,
  onOpen
}: {
  dir: string
  root: string
  depth: number
  listings: Listings
  expanded: string[]
  selectedPath: string | null
  onToggle: (dir: string) => void
  onOpen: (path: string) => void
}): React.JSX.Element | null {
  const listing = listings[dir]

  if (listing === 'loading' || listing === undefined) {
    return <Note depth={depth}>Loading…</Note>
  }
  if (listing.error) {
    return <Note depth={depth}>{listing.error}</Note>
  }
  if (listing.entries.length === 0) {
    return <Note depth={depth}>Empty</Note>
  }

  return (
    <>
      {listing.entries.map((entry) => (
        <Row
          key={entry.name}
          entry={entry}
          dir={dir}
          root={root}
          depth={depth}
          listings={listings}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
      {listing.truncated && (
        <Note depth={depth}>Too many entries to show them all.</Note>
      )}
    </>
  )
}

function Row({
  entry,
  dir,
  root,
  depth,
  listings,
  expanded,
  selectedPath,
  onToggle,
  onOpen
}: {
  entry: DirEntryInfo
  dir: string
  root: string
  depth: number
  listings: Listings
  expanded: string[]
  selectedPath: string | null
  onToggle: (dir: string) => void
  onOpen: (path: string) => void
}): React.JSX.Element {
  const path = joinPath(dir, entry.name)
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded.includes(path)
  const selected = !isDir && path === selectedPath

  return (
    <>
      <button
        type="button"
        title={relativeTo(root, path)}
        aria-expanded={isDir ? isOpen : undefined}
        onClick={() => (isDir ? onToggle(path) : onOpen(path))}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[11px] transition-colors ${
          selected
            ? 'bg-accent text-foreground'
            : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
        }`}
      >
        {isDir ? (
          <>
            <ChevronRight
              className={`size-3 shrink-0 text-muted-foreground/70 transition-transform ${
                isOpen ? 'rotate-90' : ''
              }`}
            />
            {isOpen ? (
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        {entry.symlink && <span className="shrink-0 text-muted-foreground/40">↗</span>}
      </button>
      {isOpen && (
        <Level
          dir={path}
          root={root}
          depth={depth + 1}
          listings={listings}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      )}
    </>
  )
}

function Note({ depth, children }: { depth: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      style={{ paddingLeft: 8 + depth * 12 + 18 }}
      className="py-[3px] pr-2 text-[11px] text-muted-foreground/40"
    >
      {children}
    </p>
  )
}
