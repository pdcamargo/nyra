/**
 * The side panel's file tree, one directory at a time.
 *
 * Lazy because a repo is not a thing you can list: the eager alternative is
 * `git ls-files` for the whole checkout on every chat switch, which is tens of
 * thousands of paths in a monorepo. Expanding a folder is a click, and a click
 * can afford a round trip.
 *
 * A project with linked folders gets one root per folder, the chat's own first.
 * Without any the tree is what it always was: the chat's folder, unheaded.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderRoot,
  FolderSearch,
  FolderX,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Search,
  Unlink
} from 'lucide-react'
import { ancestorsWithin, joinPath, relativeTo } from './paths'
import { usePanelTabsStore } from '../../store/panelTabs'
import { projectForSession, useSessionsStore } from '../../store/sessions'
import FileRowMenu from './FileRowMenu'
import { basenameOf } from './paths'
import type { DirEntryInfo, DirListing } from '../../lib/api-types'
import { rootOf, type FolderRoot as Root } from '../../lib/folderRoots'
import { linkProblem, saveLinkedFolder, unlinkFolder } from '../../lib/linkedFolders'
import { platform } from '../../lib/platform'
import { samePath } from '../../lib/paths'
import { LinkedFolderForm, MainChip } from '../ProjectFolders'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

type Listings = Record<string, DirListing | 'loading'>

/** One root's matches; null while its search is still out. */
type RootResults = { root: Root; paths: string[] | null; truncated: boolean }

/**
 * Which roots each chat has folded away. Module state rather than the panel
 * store: it is a view preference for the session of the app, and outliving a
 * remount — switching tabs and back — is all it needs.
 */
const collapsedBySession = new Map<string, Set<string>>()

export default function FileTree({
  sessionId,
  roots,
  selectedPath,
  expanded,
  onOpen
}: {
  sessionId: string
  /** The chat's directory — a worktree path for a worktree chat — then its
   *  project's linked folders. */
  roots: Root[]
  selectedPath: string | null
  expanded: string[]
  /** A click lands in this chat's replaceable preview slot; `pin`, which a
   *  double click sets, asks for a tab of its own instead. */
  onOpen: (absolutePath: string, pin?: boolean) => void
}): React.JSX.Element {
  const [listings, setListings] = useState<Listings>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RootResults[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedBySession.get(sessionId) ?? new Set())
  const multi = roots.length > 1
  // A stable key for effects: the roots array is rebuilt whenever its inputs
  // change, but only a change of folders should reload anything.
  const rootsKey = roots.map((r) => r.path).join('\0')

  // Two characters, because one matches most of a repo and the round trip is
  // real work. Below that the pane is the tree again.
  const searching = query.trim().length >= 2

  useEffect(() => {
    if (!searching || roots.length === 0) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setResults(roots.map((root) => ({ root, paths: null, truncated: false })))
      roots.forEach((root, i) => {
        void window.api.fs.searchTree(root.path, query.trim()).then((found) => {
          if (cancelled) return
          setResults((prev) =>
            prev?.map((r, j) => (j === i ? { root, paths: found.paths, truncated: found.truncated } : r)) ?? prev
          )
        })
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, rootsKey, searching])

  const load = useCallback(async (dir: string) => {
    setListings((prev) => (prev[dir] ? prev : { ...prev, [dir]: 'loading' }))
    const listing = await window.api.fs.listDir(dir)
    setListings((prev) => ({ ...prev, [dir]: listing }))
  }, [])

  // The roots, and anything the chat had open. Re-runs when the chat's directory
  // changes — a pending worktree materialising is exactly that.
  useEffect(() => {
    setListings({})
    for (const root of roots) void load(root.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, load])

  useEffect(() => {
    for (const dir of expanded) if (!listings[dir]) void load(dir)
    // Only when the set of open folders changes; `listings` is the thing being
    // filled and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, rootsKey, load])

  const setRootCollapsed = useCallback(
    (paths: string[], fold: boolean): void => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        for (const path of paths) {
          if (fold) next.add(path)
          else next.delete(path)
        }
        collapsedBySession.set(sessionId, next)
        return next
      })
    },
    [sessionId]
  )

  // Follow the open file: whatever opened it — a path in the chat, quick open,
  // a breadcrumb — the tree opens the folders down to it and brings its row
  // into view. Only on a change of file, so a folder the reader collapses
  // afterwards stays collapsed.
  const scrollRef = useRef<HTMLDivElement>(null)
  const revealRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedPath) return
    const root = rootOf(roots, selectedPath)
    if (!root) return
    usePanelTabsStore.getState().expandTreeDirs(sessionId, ancestorsWithin(root.path, selectedPath))
    setRootCollapsed([root.path], false)
    revealRef.current = selectedPath
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, rootsKey, sessionId, setRootCollapsed])

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
  }, [listings, expanded, selectedPath, searching, collapsed])

  const toggle = (dir: string): void => {
    usePanelTabsStore.getState().toggleTreeDir(sessionId, dir)
  }

  const refresh = (): void => {
    setListings({})
    for (const root of roots) void load(root.path)
    for (const dir of expanded) void load(dir)
  }

  if (roots.length === 0) {
    return <p className="p-3 text-[11px] text-muted-foreground">This chat has no folder.</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <span className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          Files
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {multi && (
            <HeaderButton label="Collapse folders" onClick={() => setRootCollapsed(roots.map((r) => r.path), true)}>
              <ChevronsDownUp className="size-3" />
            </HeaderButton>
          )}
          <HeaderButton label="Refresh" ariaLabel="Refresh tree" onClick={refresh}>
            <RefreshCw className="size-3" />
          </HeaderButton>
        </div>
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
            placeholder={multi ? `Filter ${roots.length} folders…` : 'Filter files…'}
            aria-label="Filter files"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pb-2">
        {searching ? (
          multi ? (
            results?.map((r) => (
              <div key={r.root.path} className="pb-1">
                <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">
                  <FolderRoot className="size-3 shrink-0" />
                  <span className="truncate font-medium">{r.root.name}</span>
                  {r.paths !== null && <span>{r.paths.length === 0 ? 'No matches' : r.paths.length}</span>}
                </div>
                <SearchResults
                  root={r.root.path}
                  paths={r.paths}
                  truncated={r.truncated}
                  selectedPath={selectedPath}
                  onOpen={onOpen}
                  indent
                  quietWhenEmpty
                />
              </div>
            ))
          ) : (
            <SearchResults
              root={roots[0].path}
              paths={results?.[0]?.paths ?? null}
              truncated={results?.[0]?.truncated ?? false}
              selectedPath={selectedPath}
              onOpen={onOpen}
            />
          )
        ) : multi ? (
          roots.map((root, i) => {
            const open = !collapsed.has(root.path)
            const listing = listings[root.path]
            const missing = typeof listing === 'object' && !!listing.error
            return (
              <div key={root.path} className={i > 0 ? 'mt-1 border-t border-border/55 pt-1' : undefined}>
                <RootHeader
                  sessionId={sessionId}
                  root={root}
                  open={open}
                  missing={missing}
                  onToggle={() => setRootCollapsed([root.path], open)}
                />
                {open &&
                  (missing ? (
                    <MissingRoot sessionId={sessionId} root={root} />
                  ) : (
                    <Level
                      dir={root.path}
                      root={root.path}
                      linked={!root.main}
                      depth={1}
                      listings={listings}
                      expanded={expanded}
                      selectedPath={selectedPath}
                      onToggle={toggle}
                      onOpen={onOpen}
                    />
                  ))}
              </div>
            )
          })
        ) : (
          <Level
            dir={roots[0].path}
            root={roots[0].path}
            linked={false}
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

function HeaderButton({
  label,
  ariaLabel,
  onClick,
  children
}: {
  label: string
  ariaLabel?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? label}
          onClick={onClick}
          className="shrink-0 rounded-at-4 p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The top row of one folder. A linked one carries a menu — its path and note,
 * and the things you do to a link — and editing the note opens the same form
 * Project settings uses, anchored here.
 */
function RootHeader({
  sessionId,
  root,
  open,
  missing,
  onToggle
}: {
  sessionId: string
  root: Root
  open: boolean
  missing: boolean
  onToggle: () => void
}): React.JSX.Element {
  const project = useSessionsStore((s) => projectForSession(s, sessionId))
  const [editing, setEditing] = useState(false)
  const Icon = missing ? FolderX : FolderRoot

  return (
    <Popover open={editing} onOpenChange={setEditing}>
      <PopoverAnchor asChild>
        <div className="group/root flex items-center gap-1 pr-1 hover:bg-accent/50">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            title={root.path}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left text-[11px]"
          >
            <ChevronRight
              className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
            />
            <Icon className={`size-3.5 shrink-0 ${missing ? 'text-warning' : 'text-muted-foreground'}`} />
            <span className={`truncate font-semibold ${missing ? 'text-muted-foreground' : 'text-foreground'}`}>
              {root.name}
            </span>
            {root.main && <MainChip />}
            {!root.main && root.note && <MessageSquareText className="size-3 shrink-0 text-muted-foreground" />}
            <span className="flex-1" />
            {missing && <span className="shrink-0 text-[10px] text-warning">Folder not found</span>}
          </button>
          {!root.main && project && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger
                    aria-label={`${root.name} actions`}
                    className="shrink-0 rounded-at-4 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/root:opacity-100 aria-expanded:opacity-100"
                  >
                    <Ellipsis className="size-3.5" />
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Folder actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
                  <span className="truncate font-mono text-foreground" title={root.path}>
                    {root.path}
                  </span>
                  {root.note && (
                    <>
                      <span className="text-[0.9em] text-muted-foreground">Note for the agent</span>
                      <span className="whitespace-pre-wrap text-muted-foreground">{root.note}</span>
                    </>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* After the menu has closed and handed focus back, or the
                    popover opens only to be dismissed by that focus move. */}
                <DropdownMenuItem onSelect={() => setTimeout(() => setEditing(true), 0)}>
                  <Pencil />
                  {root.note ? 'Edit note…' : 'Add a note…'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void window.api.fs.reveal(root.path)}>
                  <FolderSearch />
                  {platform().revealLabel}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(root.path)}>
                  <ClipboardCopy />
                  Copy path
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => unlinkFolder(project.id, root.path)}>
                  <Unlink />
                  Unlink from project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </PopoverAnchor>
      {project && (
        <PopoverContent side="left" align="start" sideOffset={8} className="w-[316px] p-0">
          <LinkedFolderForm
            project={project}
            path={root.path}
            note={root.note ?? ''}
            mode="edit"
            onDone={() => setEditing(false)}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

/** A linked folder that is not where it was linked: find it, or let it go. */
function MissingRoot({ sessionId, root }: { sessionId: string; root: Root }): React.JSX.Element {
  const project = useSessionsStore((s) => projectForSession(s, sessionId))
  const [problem, setProblem] = useState<string | null>(null)
  if (root.main || !project) return <Note depth={1}>This folder could not be read.</Note>

  const locate = (): void => {
    void window.api.dialog.pickFolder().then((folder) => {
      if (!folder || samePath(folder, root.path)) return
      const why = linkProblem(project, folder, root.path)
      setProblem(why)
      if (!why) saveLinkedFolder(project.id, folder, root.note ?? '', root.path)
    })
  }

  return (
    <div className="flex flex-col gap-1.5 pb-2 pl-[38px] pr-2 pt-0.5 text-[11px] text-muted-foreground">
      <p>
        <span className="font-mono">{root.path}</span> isn't there any more. New chats won't be given it until
        it's back.
      </p>
      {problem && <p className="text-warning">{problem}</p>}
      <div className="flex gap-1.5">
        <Button variant="outline" size="xs" onClick={locate}>
          Locate…
        </Button>
        <Button variant="ghost" size="xs" onClick={() => unlinkFolder(project.id, root.path)}>
          Unlink
        </Button>
      </div>
    </div>
  )
}

function Level({
  dir,
  root,
  linked,
  depth,
  listings,
  expanded,
  selectedPath,
  onToggle,
  onOpen
}: {
  dir: string
  root: string
  /** A linked folder's, not the chat's own: its paths go to the chat whole. */
  linked: boolean
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
          linked={linked}
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
  linked,
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
  linked: boolean
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
      <FileRowMenu root={root} path={path} isDir={isDir} linked={linked} className="block">
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
          linked={linked}
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
  onOpen,
  indent = false,
  quietWhenEmpty = false
}: {
  root: string
  paths: string[] | null
  truncated: boolean
  selectedPath: string | null
  onOpen: (path: string, pin?: boolean) => void
  /** Under a root's heading, when there is more than one root. */
  indent?: boolean
  /** The heading already says so. */
  quietWhenEmpty?: boolean
}): React.JSX.Element | null {
  const depth = indent ? 1 : 0
  if (paths === null) return <Note depth={depth}>Searching…</Note>
  if (paths.length === 0) return quietWhenEmpty ? null : <Note depth={depth}>No files match.</Note>

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
            style={indent ? { paddingLeft: 26 } : undefined}
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
      {truncated && <Note depth={depth}>More matches than shown — narrow the filter.</Note>}
    </>
  )
}
