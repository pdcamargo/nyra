/**
 * The workspace tree, one directory at a time.
 *
 * Lazy because a repo is not a thing you can list: the eager alternative is
 * `git ls-files` for the whole checkout on every chat switch, which is tens of
 * thousands of paths in a monorepo. Expanding a folder is a click, and a click
 * can afford a round trip.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, RefreshCw, Search } from 'lucide-react'
import { ancestorsWithin, joinPath, relativeTo } from './paths'
import { useWorkspaceStore } from '../../store/workspace'
import FileRowMenu from './FileRowMenu'
import { basenameOf } from './paths'
import type { DirEntryInfo, DirListing } from '../../lib/api-types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

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
  /** A click lands in this chat's replaceable preview slot; `pin`, which a
   *  double click sets, asks for a tab of its own instead. */
  onOpen: (absolutePath: string, pin?: boolean) => void
}): React.JSX.Element {
  const [listings, setListings] = useState<Listings>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)

  // Two characters, because one matches most of a repo and the round trip is
  // real work. Below that the pane is the tree again.
  const searching = query.trim().length >= 2

  useEffect(() => {
    if (!searching || !root) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.fs.searchTree(root, query.trim()).then((found) => {
        if (cancelled) return
        setResults(found.paths)
        setTruncated(found.truncated)
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, root, searching])

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

  // Follow the open file: whatever opened it — a path in the chat, quick open,
  // a breadcrumb — the tree opens the folders down to it and brings its row
  // into view. Only on a change of file, so a folder the reader collapses
  // afterwards stays collapsed.
  const scrollRef = useRef<HTMLDivElement>(null)
  const revealRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedPath || !root) return
    useWorkspaceStore.getState().expandTreeDirs(sessionId, ancestorsWithin(root, selectedPath))
    revealRef.current = selectedPath
  }, [selectedPath, root, sessionId])

  // The row exists only once every folder above it has been listed, which is
  // a round trip per level — so this runs on each listing until it lands.
  useEffect(() => {
    const target = revealRef.current
    if (!target || searching) return
    const row = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
      (el) => el.dataset.path === target
    )
    if (!row) return
    revealRef.current = null
    // A row already on screen — the one just clicked — stays put. One that is
    // not comes to the middle, rather than pinned against an edge.
    const box = scrollRef.current?.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    if (box && at.top >= box.top && at.bottom <= box.bottom) return
    row.scrollIntoView?.({ block: 'center' })
  }, [listings, expanded, selectedPath, searching])

  const toggle = (dir: string): void => {
    useWorkspaceStore.getState().toggleTreeDir(sessionId, dir)
  }

  const refresh = (): void => {
    setListings({})
    void load(root)
    for (const dir of expanded) void load(dir)
  }

  if (!root) {
    return <p className="p-3 text-[11px] text-muted-foreground">This chat has no folder.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <span className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Files
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Refresh tree"
              onClick={refresh}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <RefreshCw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      <div className="px-2 pb-1">
        <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-1.5 py-1 focus-within:bg-secondary">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            spellCheck={false}
            placeholder="Filter files…"
            aria-label="Filter files"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pb-2">
        {searching ? (
          <SearchResults
            root={root}
            paths={results}
            truncated={truncated}
            selectedPath={selectedPath}
            onOpen={onOpen}
          />
        ) : (
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
        )}
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
  onOpen: (path: string, pin?: boolean) => void
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
  onOpen: (path: string, pin?: boolean) => void
}): React.JSX.Element {
  const path = joinPath(dir, entry.name)
  const isDir = entry.type === 'dir'
  const isOpen = isDir && expanded.includes(path)
  const selected = !isDir && path === selectedPath

  return (
    <>
      <FileRowMenu root={root} path={path} isDir={isDir} className="block">
      <button
        type="button"
        title={relativeTo(root, path)}
        data-path={path}
        aria-expanded={isDir ? isOpen : undefined}
        onClick={() => (isDir ? onToggle(path) : onOpen(path))}
        // Double click keeps a tab of its own, the way every editor's file
        // list does. A folder has no second meaning, so it keeps toggling.
        onDoubleClick={() => {
          if (!isDir) onOpen(path, true)
        }}
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
              className={`size-3 shrink-0 text-muted-foreground transition-transform ${
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
        {entry.symlink && <span className="shrink-0 text-muted-foreground">↗</span>}
      </button>
      </FileRowMenu>
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
      className="py-[3px] pr-2 text-[11px] text-muted-foreground"
    >
      {children}
    </p>
  )
}

/**
 * What the filter box shows instead of the tree.
 *
 * A flat list rather than a pruned tree: the tree only holds folders you have
 * already opened, so pruning it would silently miss most of the repo.
 */
function SearchResults({
  root,
  paths,
  truncated,
  selectedPath,
  onOpen
}: {
  root: string
  paths: string[] | null
  truncated: boolean
  selectedPath: string | null
  onOpen: (path: string, pin?: boolean) => void
}): React.JSX.Element {
  if (paths === null) return <Note depth={0}>Searching…</Note>
  if (paths.length === 0) return <Note depth={0}>No files match.</Note>

  return (
    <>
      {paths.map((relative) => {
        const path = joinPath(root, relative)
        return (
          <button
            key={relative}
            type="button"
            title={relative}
            onClick={() => onOpen(path)}
            onDoubleClick={() => onOpen(path, true)}
            className={`flex w-full flex-col items-start px-2 py-[3px] text-left transition-colors ${
              path === selectedPath
                ? 'bg-accent text-foreground'
                : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
            }`}
          >
            <span className="w-full truncate text-[11px]">{basenameOf(relative)}</span>
            <span className="w-full truncate text-[10px] text-muted-foreground">{relative}</span>
          </button>
        )
      })}
      {truncated && <Note depth={0}>More matches than shown — narrow the filter.</Note>}
    </>
  )
}
