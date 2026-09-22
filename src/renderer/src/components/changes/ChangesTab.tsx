/**
 * The repo's changes, in the side panel.
 *
 * An accordion rather than the master-detail pane Codex uses, because the panel
 * is a fraction of their window: one scrolling column of file rows, each opening
 * its own diff in place. The changed-file tree sits beside it when the panel is
 * wide enough — beside, not instead of. Codex made that a mode
 * (openai/codex#12760) and the top reply was "I can now only Review, or chat with
 * no tree".
 *
 * Read-only. Staging and reverting are a git client's job, and reverting is
 * irreversible in a way that wants a confirm flow this does not have.
 */
import React, { useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, File, FileDiff, PanelLeft, RotateCw, Settings2 } from 'lucide-react'
import ResizeHandle from '../ResizeHandle'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { IconButton } from '../ui/icon-button'
import { useSettingsStore } from '../../store/settings'
import type { DiffViewMode } from '@shared/types'
import { clampTreeWidth, TREE_DEFAULT_WIDTH, treeFits } from '../files/treeWidth'
import { usePanelLayoutStore } from '../../store/panelLayout'
import { cwdForSession, useSessionsStore } from '../../store/sessions'
import { useWorkspaceStore, workspaceFor } from '../../store/workspace'
import {
  changesFor,
  scopeLabel,
  totals,
  useChangesStore,
  type ChangeScope,
  type ChatChanges
} from '../../store/changes'
import type { ChangedFile } from '../../lib/api-types'
import { openFileInPanel } from '../../lib/openFile'

/** Split needs room for two gutters and two columns of code; below this it is
 *  narrower per side than unified is in total. */
const SPLIT_MIN_WIDTH = 720

const LazyPatchView = React.lazy(() => import('./PatchView'))

function Stat({ file }: { file: ChangedFile }): React.JSX.Element {
  if (file.binary) return <span className="text-[10px] text-muted-foreground">binary</span>
  return (
    <>
      {file.insertions > 0 && (
        <span className="text-[10px] font-mono text-success/80">+{file.insertions}</span>
      )}
      {file.deletions > 0 && (
        <span className="text-[10px] font-mono text-danger/80">−{file.deletions}</span>
      )}
      {file.insertions === 0 && file.deletions === 0 && (
        <span className="text-[10px] text-muted-foreground">—</span>
      )}
    </>
  )
}

/** Changed paths only, grouped by directory. Not the whole repo — this answers
 *  "where did the work happen", which a full tree buries. */
function ChangedTree({
  files,
  onPick
}: {
  files: ChangedFile[]
  onPick: (path: string) => void
}): React.JSX.Element {
  const groups = useMemo(() => {
    const byDir = new Map<string, ChangedFile[]>()
    for (const f of files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
      const list = byDir.get(dir)
      if (list) list.push(f)
      else byDir.set(dir, [f])
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [files])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto py-1.5">
      {groups.map(([dir, entries]) => (
        <div key={dir || '.'}>
          <p className="truncate px-2 py-1 text-[10px] text-muted-foreground" title={dir}>
            {dir || 'repo root'}
          </p>
          {entries.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onPick(f.path)}
              title={f.path}
              className="flex w-full items-center gap-1.5 overflow-hidden px-2 py-1 pl-4 text-left transition-colors hover:bg-accent/50"
            >
              <File className="size-2.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[10px] text-foreground/80">
                {f.path.split('/').pop()}
              </span>
              <span className="ml-auto shrink-0 text-[9px] font-mono text-success/80">
                {f.insertions > 0 ? `+${f.insertions}` : ''}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function ScopePicker({
  scope,
  branch,
  onPick
}: {
  scope: ChangeScope
  branch: string
  onPick: (scope: ChangeScope) => void
}): React.JSX.Element {
  const options: ChangeScope[] = [
    { kind: 'worktree' },
    ...(branch ? [{ kind: 'branch' as const, base: branch }] : []),
    ...(scope.kind === 'since' ? [scope] : [])
  ]

  return (
    <select
      value={scope.kind === 'since' ? `since:${scope.base}` : scope.kind}
      onChange={(e) => {
        const v = e.target.value
        if (v === 'worktree') return onPick({ kind: 'worktree' })
        if (v.startsWith('since:')) return onPick({ kind: 'since', base: v.slice(6) })
        onPick({ kind: 'branch', base: branch })
      }}
      className="cursor-default rounded-md bg-transparent py-0.5 text-[11px] text-foreground/80 outline-none hover:bg-accent/50"
    >
      {options.map((o) => (
        <option key={o.kind === 'since' ? `since:${o.base}` : o.kind} value={o.kind === 'since' ? `since:${o.base}` : o.kind}>
          {scopeLabel(o)}
        </option>
      ))}
    </select>
  )
}

/**
 * How a patch is drawn.
 *
 * Settings rather than per-chat state: someone who reads diffs unified reads
 * every diff unified. Whitespace sits here with the other two because that is
 * where you look for it, even though it is the odd one out — it re-runs git
 * rather than re-rendering.
 */
function ViewOptions(): React.JSX.Element {
  const diffView = useSettingsStore((s) => s.diffView)
  const diffWrap = useSettingsStore((s) => s.diffWrap)
  const diffIgnoreWhitespace = useSettingsStore((s) => s.diffIgnoreWhitespace)
  const update = useSettingsStore((s) => s.updateSettings)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label="Diff view options"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground/80 aria-expanded:text-foreground/80"
          >
            <Settings2 className="size-3" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Diff view options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={diffView}
          onValueChange={(v) => update({ diffView: v as DiffViewMode })}
        >
          <DropdownMenuRadioItem value="auto">Fit the panel</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={diffWrap}
          onCheckedChange={(v) => update({ diffWrap: v })}
        >
          Wrap long lines
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={diffIgnoreWhitespace}
          onCheckedChange={(v) => update({ diffIgnoreWhitespace: v })}
        >
          Ignore whitespace
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FileRow({
  file,
  state,
  wide,
  wrap,
  split,
  rowRef,
  onToggle,
  onOpenFile
}: {
  file: ChangedFile
  state: ChatChanges['byFile'][string] | undefined
  wide: boolean
  wrap: boolean
  split: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onToggle: () => void
  onOpenFile: () => void
}): React.JSX.Element {
  const open = state?.expanded ?? false
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
  const name = file.path.split('/').pop() ?? file.path

  return (
    <div ref={rowRef} className="scroll-mt-0 border-b border-border/55 last:border-b-0">
      <div
        className={`flex w-full items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-accent/50 ${
          open ? 'bg-accent/30' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 truncate text-[11px] font-mono text-foreground/80">{name}</span>
          {/* Only where there is room: at panel width the basename is the part
              that identifies the file, and the directory is what gets cut. */}
          {wide && dir && (
            <span className="min-w-0 flex-1 truncate text-[10px] font-mono text-muted-foreground">
              {dir}
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          <Stat file={file} />
        </span>
        <Tooltip>
          <TooltipTrigger
            onClick={onOpenFile}
            aria-label={`Open ${name}`}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground/80"
          >
            <File className="size-3" />
          </TooltipTrigger>
          <TooltipContent>Open the file</TooltipContent>
        </Tooltip>
      </div>

      {open && (
        <div className="overflow-x-auto border-t border-border/55 bg-background/40">
          {state?.loading ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">Reading the diff…</p>
          ) : state?.error ? (
            <p className="px-3 py-2 text-[10px] text-danger/80">{state.error}</p>
          ) : state?.patch ? (
            <React.Suspense
              fallback={<p className="px-3 py-2 text-[10px] text-muted-foreground">Loading…</p>}
            >
              <LazyPatchView
                path={file.path}
                patch={state.patch}
                mode={split ? 'split' : 'unified'}
                wrap={wrap}
              />
            </React.Suspense>
          ) : (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              Nothing to show for this file.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function ChangesTab({ sessionId }: { sessionId: string }): React.JSX.Element {
  const cwd = useSessionsStore((s) => cwdForSession(s, sessionId))
  const changes = useChangesStore((s) => changesFor(s, sessionId))
  const ws = useWorkspaceStore((s) => workspaceFor(s, sessionId))
  const panelWidth = usePanelLayoutStore((s) => s.rightPanelWidth)
  const diffView = useSettingsStore((s) => s.diffView)
  const diffWrap = useSettingsStore((s) => s.diffWrap)
  const diffIgnoreWhitespace = useSettingsStore((s) => s.diffIgnoreWhitespace)
  const [branch, setBranch] = React.useState('')

  const showTree = ws.treeOpen && treeFits(panelWidth) && changes.files.length > 0
  const treeWidth = clampTreeWidth(ws.treeWidth ?? TREE_DEFAULT_WIDTH, panelWidth)
  const bodyWidth = showTree ? panelWidth - treeWidth : panelWidth
  const wide = bodyWidth >= SPLIT_MIN_WIDTH
  // `auto` is the default because the panel is resizable: a fixed "split" would
  // be unreadable the moment someone dragged it narrow.
  const split = diffView === 'auto' ? wide : diffView === 'split'

  const scroller = React.useRef<HTMLDivElement | null>(null)
  const rows = React.useRef(new Map<string, HTMLDivElement>())

  // The branch this chat would be measured against. Only meaningful in a
  // worktree; a chat in the main checkout has nothing to diverge from.
  useEffect(() => {
    let cancelled = false
    if (!cwd) return
    void window.api.git.branch(cwd).then((b) => {
      if (!cancelled) setBranch(b)
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  useEffect(() => {
    void useChangesStore.getState().refresh(sessionId, cwd)
  }, [sessionId, cwd, changes.scope])

  // A card row was clicked: open that file as soon as the list has it, and bring
  // it into view — a focus that only expands looks like nothing happened when the
  // row is below the fold.
  useEffect(() => {
    if (!changes.pendingFocus) return
    if (!changes.files.some((f) => f.path === changes.pendingFocus)) return
    const path = changes.pendingFocus
    void useChangesStore.getState().toggleFile(sessionId, cwd, path)
    useChangesStore.getState().revealFile(sessionId, path)
  }, [changes.pendingFocus, changes.files, sessionId, cwd])

  // Toggling whitespace changes what git computes, not how it is drawn, so every
  // patch already in hand answers the other question.
  useEffect(() => {
    useChangesStore.getState().invalidatePatches(sessionId)
  }, [diffIgnoreWhitespace, sessionId])

  // Scroll a row into view. Keyed on the nonce rather than the path so picking
  // the same file twice scrolls twice, and deferred a frame so an expanding row
  // has laid out before we measure it.
  const scrollNonce = changes.scrollTo?.nonce
  const scrollPath = changes.scrollTo?.path
  useEffect(() => {
    if (!scrollPath) return
    const id = requestAnimationFrame(() => {
      const row = rows.current.get(scrollPath)
      const box = scroller.current
      if (!row || !box) return
      box.scrollTo({ top: row.offsetTop - box.offsetTop - 4, behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [scrollNonce, scrollPath])

  const sum = totals(changes.files)

  const body = !changes.baseResolved ? (
    <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
      {scopeLabel(changes.scope)} is no longer in this repo — it may have been rebased away.
    </p>
  ) : changes.loading && changes.files.length === 0 ? (
    <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">Reading changes…</p>
  ) : changes.files.length === 0 ? (
    <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
      Nothing has changed.
    </p>
  ) : (
    changes.files.map((f) => (
      <FileRow
        key={f.path}
        file={f}
        state={changes.byFile[f.path]}
        wide={wide}
        wrap={diffWrap}
        split={split}
        rowRef={(el) => {
          if (el) rows.current.set(f.path, el)
          else rows.current.delete(f.path)
        }}
        onToggle={() => void useChangesStore.getState().toggleFile(sessionId, cwd, f.path)}
        onOpenFile={() => openFileInPanel(f.path)}
      />
    ))
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/55 px-2 py-1">
        <ScopePicker
          scope={changes.scope}
          branch={branch}
          onPick={(scope) => useChangesStore.getState().setScope(sessionId, scope)}
        />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {changes.files.length > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground">
                {changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}
              </span>
              <span className="text-[10px] font-mono text-success/80">+{sum.insertions}</span>
              <span className="text-[10px] font-mono text-danger/80">−{sum.deletions}</span>
            </>
          )}
          <ViewOptions />
          <IconButton
            label="Refresh changes"
            command="panel.right.changes.refresh"
            onClick={() => void useChangesStore.getState().refresh(sessionId, cwd)}
          >
            <RotateCw className="size-3" />
          </IconButton>
          {treeFits(panelWidth) && (
            <IconButton
              label="Toggle the changed-file tree"
              command="panel.right.tree"
              active={showTree}
              onClick={() => useWorkspaceStore.getState().setTreeOpen(sessionId, !ws.treeOpen)}
            >
              <PanelLeft className="size-3" />
            </IconButton>
          )}
        </span>
      </div>

      {/* Tree on the right, matching the file tab. Two tabs in one panel
          disagreeing about which side the tree lives on would read as a bug. */}
      <div className="flex min-h-0 flex-1">
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
          {body}
        </div>
        {showTree && (
          <>
            <ResizeHandle
              side="right"
              label="Resize changed-file tree"
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
              className="min-h-0 shrink-0 border-l border-border/55 bg-card"
            >
              <ChangedTree
                files={changes.files}
                onPick={(path) => {
                  // Expand only if it is closed — picking an open file in the
                  // tree means "take me there", not "close it".
                  if (!changes.byFile[path]?.expanded) {
                    void useChangesStore.getState().toggleFile(sessionId, cwd, path)
                  }
                  useChangesStore.getState().revealFile(sessionId, path)
                }}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

/** The strip's icon and label for a changes row. */
export const CHANGES_TAB_ICON = FileDiff
