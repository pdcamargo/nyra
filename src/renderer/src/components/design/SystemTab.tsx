import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  Ellipsis,
  FolderInput,
  FolderOpen,
  GraduationCap,
  MessageCircle,
  Moon,
  Sun,
  SwatchBook,
  Trash2,
  X
} from 'lucide-react'
import { FORMAT_VERSION } from '@nyra/design'
import { cn } from 'cn'
import { IconButton } from '../ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useSessionsStore } from '../../store/sessions'
import { usePanelTabsStore, type DesignPanelTab, type DesignTabPatch } from '../../store/panelTabs'
import type { DesignEntry, SystemEntry } from '../../lib/api-types'
import type { DesignComment } from '../../lib/designComments'
import { loadSystem, projectSkill, upgradeSystemFiles, type LoadedSystem, type OutlineFile } from '../../lib/designSystem'
import { basename, dirname, isWithin, joinPath } from '../../lib/paths'
import { platform } from '../../lib/platform'
import DesignFileView from './DesignFileView'
import { CAPTION, DesignPicker, GROUP_LABEL, tildePath } from './DesignPicker'
import { useProjectSystems } from './DesignTab'
import SystemOverview from './SystemOverview'

/** How often a system's files are checked for changes while it is on screen. */
const POLL_MS = 1500

/** How long a toast that needs nothing from you stays up. */
const TOAST_MS = 8000

// ---- names, for the tab strip ----

/**
 * The names a system tab's label is made of: each system's, and each of its
 * files'. The strip has only the ids a tab carries; the names are learnt here,
 * where systems are listed and loaded anyway, so drawing a tab never asks Rust
 * for anything.
 */
export type SystemNames = {
  systems: Readonly<Record<string, string>>
  /** By system id, then by the file's path inside the system. */
  files: Readonly<Record<string, Readonly<Record<string, string>>>>
}

let known: SystemNames = { systems: {}, files: {} }
const nameListeners = new Set<() => void>()

function learnNames(next: SystemNames): void {
  if (next === known) return
  known = next
  for (const listener of nameListeners) listener()
}

function subscribeNames(listener: () => void): () => void {
  nameListeners.add(listener)
  return () => nameListeners.delete(listener)
}

export function useSystemNames(): SystemNames {
  return useSyncExternalStore(subscribeNames, () => known, () => known)
}

/** `Closeup · system` on the overview, the file's own name on the canvas. */
export function systemTabLabel(tab: Pick<DesignPanelTab, 'systemId' | 'view' | 'file'>, names: SystemNames): string {
  const id = tab.systemId
  if (!id) return 'Design'
  if (tab.view === 'canvas' && tab.file) {
    return names.files[id]?.[tab.file] ?? basename(tab.file).replace(/\.nyui\.json$/i, '')
  }
  const name = names.systems[id]
  return name ? `${name} · system` : 'Design system'
}

const sameRecord = (a: Readonly<Record<string, string>> | undefined, b: Record<string, string>): boolean => {
  if (!a) return false
  const keys = Object.keys(b)
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k])
}

// ---- loading ----

/**
 * A system, kept current: one listing per tick for the whole folder, and only
 * the files whose size or mtime moved are read again. Paused while the window
 * is hidden, like every other poll in the app.
 */
function useLoadedSystem(entry: SystemEntry | null): { sys: LoadedSystem | null; error: string | null } {
  const [sys, setSys] = useState<LoadedSystem | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!entry) return
    let cancelled = false
    let last = ''
    let busy = false
    const tick = async (): Promise<void> => {
      if (busy || (typeof document !== 'undefined' && document.hidden)) return
      busy = true
      try {
        const listing = await window.api.designSystem.files(entry.id, entry.root)
        if (!listing.ok || !listing.files) {
          if (!cancelled) setError(listing.error ?? 'could not list the system')
          return
        }
        const stamp = listing.files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('|')
        if (stamp === last) return
        last = stamp
        const loaded = await loadSystem(entry)
        if (!cancelled) {
          setSys(loaded)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [entry])
  return { sys: entry && sys?.entry.id === entry.id ? sys : null, error }
}

/** The system's open comments, every file's, kept current. */
function useOpenComments(systemId: string | null): DesignComment[] {
  const [open, setOpen] = useState<{ systemId: string; comments: DesignComment[] } | null>(null)
  useEffect(() => {
    if (!systemId) return
    const scope = `sys:${systemId}`
    let live = true
    const load = (): void =>
      void window.api.comments.list(scope).then((res) => {
        if (live && res.ok) setOpen({ systemId, comments: (res.comments ?? []).filter((c) => c.status === 'open') })
      })
    load()
    const stop = window.api.comments.onChanged((p) => {
      if (p.scope === scope) load()
    })
    return () => {
      live = false
      stop()
    }
  }, [systemId])
  // Another system's count, until this one's arrives, would be a wrong number.
  return open !== null && open.systemId === systemId ? open.comments : NO_COMMENTS
}

const NO_COMMENTS: DesignComment[] = []

/** The folder name Rust gives a system's repo skill: `closeup-design-system`. */
export function skillFolder(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'system'}-design-system`
}

const MODE_ICON: Record<string, React.ComponentType<{ className?: string }>> = { light: Sun, dark: Moon }

/** A segment that is on: a fill *and* a step in the foreground, edged with a
 *  hairline — the shadow ladder paints nothing in this app. */
const SEGMENT_ON = 'bg-background text-foreground ring-1 ring-border'
const SEGMENT_OFF = 'text-muted-foreground hover:text-foreground'

/** One row of a design menu: icon on the first line, a hint under the label. */
const MENU_ROW = 'items-start gap-2 rounded-at-4 text-[12.5px] leading-[1.5]'
/** The `!` holds the muted colour through the item's focus style, which
 *  otherwise repaints every descendant. */
const MENU_ICON = 'mt-0.5 size-3.5 text-muted-foreground!'
const MENU_HINT = cn(CAPTION, 'text-muted-foreground!')

type Toast = { tone: 'ok' | 'error'; text: React.ReactNode; reveal?: string }

const Mono = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <span className="font-mono text-[11.5px] leading-[1.45]">{children}</span>
)

export default function SystemTab({ sessionId, tab }: { sessionId: string; tab: DesignPanelTab }): React.ReactElement {
  const cwd = useSessionsStore((s) => s.sessions.find((session) => session.id === sessionId)?.cwd ?? null)
  const update = usePanelTabsStore((s) => s.updateDesignTab)
  const openSystem = usePanelTabsStore((s) => s.openSystemTab)
  const pickDraft = usePanelTabsStore((s) => s.setDesignTabDesign)
  const projectSystems = useProjectSystems(cwd)
  const [everySystem, setEverySystem] = useState<SystemEntry[] | null>(null)
  const [drafts, setDrafts] = useState<DesignEntry[]>([])
  const [mode, setMode] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<Toast | null>(null)
  /** Set by the comments button, for the canvas to open its list. Cleared by
   *  any other move, so a file opened later does not open the list again. */
  const [commentsAt, setCommentsAt] = useState<number | null>(null)

  // Every system, not just this project's: a chip can open one from elsewhere.
  useEffect(() => {
    const load = (): void => {
      void window.api.designSystem.list().then(setEverySystem)
      void window.api.design.list(cwd ?? undefined).then(setDrafts)
    }
    load()
    return window.api.design.onChanged(load)
  }, [cwd])

  // This chat's view of it first: in a worktree that is the worktree's copy,
  // the one Claude is editing. Any other system as it is registered.
  const entry = useMemo(
    () => projectSystems.find((s) => s.id === tab.systemId) ?? everySystem?.find((s) => s.id === tab.systemId) ?? null,
    [everySystem, projectSystems, tab.systemId]
  )
  const { sys, error } = useLoadedSystem(entry)
  const modes = sys?.tokens.modes ?? []
  const shownMode = mode !== undefined && modes.includes(mode) ? mode : undefined
  const openComments = useOpenComments(entry?.id ?? null)

  // A repo system that opted in keeps its project skill current: rewritten
  // whenever the files change, and only then (Rust skips identical content).
  useEffect(() => {
    if (sys && sys.entry.projectSkill) void window.api.designSystem.writeProjectSkill(sys.entry.id, projectSkill(sys), sys.entry.root)
  }, [sys])

  // What the tab strip needs to name this tab, learnt from what is already here.
  useEffect(() => {
    const listed: Record<string, string> = {}
    for (const s of [...(everySystem ?? []), ...projectSystems]) listed[s.id] = s.name
    if (Object.keys(listed).every((id) => known.systems[id] === listed[id])) return
    learnNames({ ...known, systems: { ...known.systems, ...listed } })
  }, [everySystem, projectSystems])
  useEffect(() => {
    if (!sys) return
    const files: Record<string, string> = {}
    for (const f of sys.files) files[f.rel] = f.name
    if (sameRecord(known.files[sys.entry.id], files)) return
    learnNames({ ...known, files: { ...known.files, [sys.entry.id]: files } })
  }, [sys])

  // A toast that only reports something done goes on its own; one that says
  // something failed stays until it is read and dismissed.
  useEffect(() => {
    if (notice?.tone !== 'ok') return
    const timer = setTimeout(() => setNotice(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const view = tab.view ?? 'overview'
  const members = sys?.files ?? []
  const file: OutlineFile | null =
    members.find((f) => f.rel === tab.file) ?? members.find((f) => f.kind === 'screen') ?? members[0] ?? null

  /** Every way of moving around the system except the comments button. */
  const go = (patch: DesignTabPatch): void => {
    setCommentsAt(null)
    update(sessionId, tab.id, patch)
  }

  /** To the canvas, with the comment list open — on this file if it has an
   *  open comment, otherwise on the first file that does. */
  const showComments = (): void => {
    const here = file !== null && openComments.some((c) => c.rel === file.rel)
    const there = here ? null : (openComments.find((c) => c.rel && members.some((f) => f.rel === c.rel))?.rel ?? null)
    update(sessionId, tab.id, there ? { view: 'canvas', file: there, artboardId: null } : { view: 'canvas', file: file?.rel ?? null })
    setCommentsAt(Date.now())
  }

  const upgradeAll = useCallback(async () => {
    if (!entry) return
    const { upgraded, backup } = await upgradeSystemFiles(entry)
    setNotice(
      upgraded.length
        ? {
            tone: 'ok',
            text: (
              <>
                Upgraded {upgraded.length} file{upgraded.length === 1 ? '' : 's'} to format v{FORMAT_VERSION}. The
                originals are in <Mono>{tildePath(backup)}</Mono>.
              </>
            ),
            reveal: backup
          }
        : { tone: 'ok', text: 'Every file is already current.' }
    )
  }, [entry])

  if (everySystem !== null && !entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-xs">
        <SwatchBook className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">This design system is no longer in Nyra</p>
        <p className="max-w-xs text-muted-foreground">Its files are where they were. Ask Claude to adopt the folder again, or pick another design.</p>
        <DesignPicker
          label="Designs"
          systems={projectSystems}
          drafts={drafts}
          current={null}
          onSystem={(id) => openSystem(sessionId, id)}
          onDraft={(id) => pickDraft(sessionId, tab.id, id)}
        />
      </div>
    )
  }

  const inRepo = entry ? isWithin(entry.project, entry.root) : false
  const olderCount = members.filter((f) => f.olderFormat !== undefined).length
  const skillDir = entry ? `.claude/skills/${skillFolder(entry.name)}/` : ''
  /** Where "Move into repo" puts it, as the toast and the hint say it. */
  const repoTarget = entry ? joinPath(basename(entry.project), 'design') : ''
  const componentCount = sys
    ? sys.files.filter((f) => f.kind === 'component').reduce((n, f) => n + Math.max(1, f.components.length), 0)
    : undefined

  const teach = async (on: boolean): Promise<void> => {
    if (!entry) return
    const res = await window.api.designSystem.setProjectSkill(entry.id, on)
    if (!res.ok) {
      setNotice({ tone: 'error', text: res.error ?? 'Could not change the setting.' })
      return
    }
    const folder = joinPath(entry.project, skillDir)
    if (!on) {
      setNotice({ tone: 'ok', text: <>Stopped updating <Mono>{skillDir}</Mono>. The skill is still in the repo.</>, reveal: folder })
      return
    }
    // Written now rather than on the next change, so Show has something to show.
    const written = sys ? await window.api.designSystem.writeProjectSkill(entry.id, projectSkill(sys), entry.root) : null
    setNotice({
      tone: 'ok',
      text: (
        <>
          Claude Code learns {entry.name} from <Mono>{skillDir}</Mono>.
        </>
      ),
      reveal: written?.path ?? folder
    })
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <SwatchBook className="size-[15px] shrink-0 text-design-accent" />
        <div className="min-w-0 shrink">
          <DesignPicker
            size="title"
            label={entry?.name ?? 'Design system'}
            systems={projectSystems.some((s) => s.id === entry?.id) || !entry ? projectSystems : [entry, ...projectSystems]}
            drafts={drafts}
            current={entry?.id ?? null}
            componentCounts={entry && componentCount !== undefined ? { [entry.id]: componentCount } : undefined}
            onSystem={(id) => openSystem(sessionId, id)}
            onDraft={(id) => pickDraft(sessionId, tab.id, id)}
          />
        </div>
        {/* A truncated path: `title` discloses the rest, per the tooltip rule. */}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-[1.45] text-muted-foreground"
          title={entry?.root}
        >
          {entry ? tildePath(entry.root) : null}
        </span>
        <div role="tablist" aria-label="View" className="flex shrink-0 rounded-at-8 bg-muted p-0.5">
          {(['overview', 'canvas'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => go({ view: v, file: v === 'canvas' ? (file?.rel ?? null) : tab.file })}
              className={cn(
                'rounded-at-4 px-3 py-0.5 text-[12.5px] leading-[1.5]',
                view === v ? cn(SEGMENT_ON, 'font-[550]') : SEGMENT_OFF
              )}
            >
              {v === 'overview' ? 'Overview' : 'Canvas'}
            </button>
          ))}
        </div>
        <ModeSwitch
          modes={modes}
          current={shownMode}
          missingLabel={(m) => (sys ? `${sys.manifest.name || entry?.name} has no ${m} mode` : 'Loading the system…')}
          onPick={(m, isBase) => setMode(isBase ? undefined : m)}
        />
        {openComments.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Comments: ${openComments.length} open`}
                onClick={showComments}
                className="flex h-[26px] shrink-0 items-center gap-1 rounded-at-4 px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <MessageCircle className="size-3.5" />
                <span className="text-[12.5px] leading-[1.5] font-[550] tabular-nums">{openComments.length}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Comments</TooltipContent>
          </Tooltip>
        )}
        {entry && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger
                  aria-label="Design system options"
                  className="flex size-[26px] shrink-0 items-center justify-center rounded-at-4 text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent"
                >
                  <Ellipsis className="size-3.5" />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Design system options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="flex w-[310px] flex-col gap-px rounded-at-12 shadow-panel">
              {!inRepo && (
                <DropdownMenuItem
                  className={cn(MENU_ROW, 'px-2 py-1')}
                  onSelect={async () => {
                    const to = joinPath(entry.project, 'design')
                    const res = await window.api.designSystem.relocate(entry.id, to)
                    if (res.ok) await window.api.designSystem.setProjectSkill(entry.id, true)
                    setNotice(
                      res.ok
                        ? {
                            tone: 'ok',
                            text: (
                              <>
                                Moved {entry.name} to <Mono>{repoTarget}</Mono>. Links in old chats still open it.
                              </>
                            ),
                            reveal: res.system?.root ?? to
                          }
                        : { tone: 'error', text: res.error ?? 'Could not move the system.' }
                    )
                  }}
                >
                  <FolderInput className={MENU_ICON} />
                  <span className="flex min-w-0 flex-col">
                    <span>Move into repo…</span>
                    <span className={MENU_HINT}>
                      {tildePath(dirname(entry.root))} → {repoTarget}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className={cn(MENU_ROW, 'px-2 py-1')} onSelect={() => void window.api.fs.reveal(entry.root)}>
                <FolderOpen className={MENU_ICON} />
                <span>{platform().revealLabel}</span>
              </DropdownMenuItem>
              {/* Unavailable outside the repo, but drawn at full strength: the
                  hint says why, which a faded row cannot. */}
              <DropdownMenuCheckboxItem
                className={cn(MENU_ROW, 'py-1 data-disabled:opacity-100')}
                checked={entry.projectSkill}
                disabled={!inRepo}
                onCheckedChange={(on) => void teach(on === true)}
              >
                <GraduationCap className={MENU_ICON} />
                <span className="flex min-w-0 flex-col">
                  <span>Teach Claude Code about this system</span>
                  <span className={MENU_HINT}>
                    {inRepo ? `Writes ${skillDir}` : `Writes ${skillDir} once the system is in the repo`}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
              {olderCount > 0 && (
                <DropdownMenuItem className={cn(MENU_ROW, 'px-2 py-1')} onSelect={() => void upgradeAll()}>
                  <CircleArrowUp className={MENU_ICON} />
                  <span className="flex min-w-0 flex-col">
                    <span>Upgrade every file to format v{FORMAT_VERSION}</span>
                    <span className={MENU_HINT}>
                      {olderCount} file{olderCount === 1 ? ' is' : 's are'} older. The originals are backed up first.
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="mx-0 my-0 bg-border" />
              <DropdownMenuItem
                className={cn(MENU_ROW, 'px-2 py-1')}
                onSelect={async () => {
                  await window.api.designSystem.forget(entry.id)
                  pickDraft(sessionId, tab.id, null)
                }}
              >
                <Trash2 className={MENU_ICON} />
                <span className="flex min-w-0 flex-col">
                  <span>Remove from Nyra</span>
                  <span className={MENU_HINT}>The files stay on disk</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {error && !sys ? (
        <pre className="m-2 rounded-at-4 border border-destructive/40 bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive">{error}</pre>
      ) : !sys || !entry ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">Loading…</div>
      ) : view === 'overview' ? (
        <SystemOverview
          sys={sys}
          mode={shownMode}
          section={tab.section ?? null}
          onSection={(id) => update(sessionId, tab.id, { section: id })}
          onOpenFile={(rel, artboard) => go({ view: 'canvas', file: rel, artboardId: artboard ?? null })}
        />
      ) : file ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
            <FilePicker files={members} current={file} onPick={(rel) => go({ file: rel, artboardId: null })} />
          </div>
          <DesignFileView
            key={file.path}
            sessionId={sessionId}
            path={file.path}
            name={`${entry.name} — ${file.name}`}
            mode={shownMode}
            focus={tab.artboardId}
            upgradeLabel="Upgrade system"
            onUpgradeAll={upgradeAll}
            openCommentsAt={commentsAt ?? undefined}
          />
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
          <p>No component, pattern or screen files yet.</p>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className={cn(
            'absolute left-6 z-40 flex max-w-[calc(100%-48px)] items-center gap-3 rounded-at-12 border bg-background px-3 py-2 text-[12.5px] leading-[1.5] shadow-panel',
            // Clear of the canvas's zoom control, which sits in the same corner.
            view === 'canvas' ? 'bottom-12' : 'bottom-4'
          )}
        >
          {notice.tone === 'error' ? (
            <CircleAlert className="size-[15px] shrink-0 text-danger" />
          ) : (
            <CircleCheck className="size-[15px] shrink-0 text-success" />
          )}
          <span className="min-w-0">{notice.text}</span>
          {notice.reveal && (
            <button
              type="button"
              className="shrink-0 font-[550] text-design-accent hover:underline"
              onClick={() => void window.api.fs.reveal(notice.reveal!)}
            >
              Show
            </button>
          )}
          <IconButton label="Dismiss" className="shrink-0" onClick={() => setNotice(null)}>
            <X className="size-3" />
          </IconButton>
        </div>
      )}
    </div>
  )
}

/**
 * The system's light and dark, always there. A system with one mode keeps the
 * other button, unavailable, with a tooltip that says so — a switch that only
 * appears sometimes reads as a layout bug, and its absence explains nothing.
 */
function ModeSwitch({
  modes,
  current,
  missingLabel,
  onPick
}: {
  /** The system's modes, base first; empty for the built-in theme. */
  modes: string[]
  /** The mode on screen, or undefined for the base. */
  current: string | undefined
  missingLabel: (mode: string) => string
  onPick: (mode: string, isBase: boolean) => void
}): React.ReactElement {
  const base = modes[0] ?? 'light'
  const shown = current ?? base
  const buttons: { mode: string; available: boolean }[] =
    modes.length > 1
      ? modes.map((mode) => ({ mode, available: true }))
      : base === 'dark'
        ? [
            { mode: 'light', available: false },
            { mode: 'dark', available: true }
          ]
        : [
            { mode: base, available: true },
            { mode: 'dark', available: false }
          ]
  return (
    <div role="tablist" aria-label="Mode" className="flex shrink-0 rounded-at-8 bg-muted p-0.5">
      {buttons.map(({ mode, available }) => {
        const Icon = MODE_ICON[mode]
        const on = available && shown === mode
        const label = available ? `${mode.charAt(0).toUpperCase()}${mode.slice(1)} mode` : missingLabel(mode)
        return (
          <Tooltip key={mode}>
            <TooltipTrigger asChild>
              {/* `aria-disabled` rather than `disabled`: a disabled button gets
                  no pointer events, so its tooltip could never say why. */}
              <button
                type="button"
                role="tab"
                aria-selected={on}
                aria-disabled={!available || undefined}
                aria-label={label}
                onClick={() => {
                  if (available) onPick(mode, mode === base)
                }}
                className={cn(
                  'flex h-[22px] min-w-[26px] items-center justify-center rounded-at-4 text-[11.5px]',
                  on ? SEGMENT_ON : available ? SEGMENT_OFF : 'cursor-default text-muted-foreground'
                )}
              >
                {Icon ? <Icon className="size-[13px]" /> : <span className="px-1.5">{mode}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

const KIND_TITLE = { component: 'Components', pattern: 'Patterns', screen: 'Screens' } as const

function FilePicker({ files, current, onPick }: { files: OutlineFile[]; current: OutlineFile; onPick: (rel: string) => void }): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="-mx-1 flex min-w-0 items-center gap-1 rounded-at-4 px-1 py-0.5 text-[12.5px] leading-[1.5] hover:bg-accent"
        >
          <span className="shrink-0 text-muted-foreground">{KIND_TITLE[current.kind]} /</span>
          <span className="truncate font-[550]">{current.name}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto rounded-at-12 shadow-panel">
        {(['component', 'pattern', 'screen'] as const).map((kind) => {
          const group = files.filter((f) => f.kind === kind)
          if (!group.length) return null
          return (
            <div key={kind}>
              <DropdownMenuLabel className={GROUP_LABEL}>{KIND_TITLE[kind]}</DropdownMenuLabel>
              {group.map((f) => (
                <DropdownMenuItem
                  key={f.rel}
                  className="rounded-at-4 px-2 py-1 text-[12.5px] leading-[1.5]"
                  onSelect={() => onPick(f.rel)}
                >
                  <span className="min-w-0 flex-1 truncate" title={f.rel}>
                    {f.name}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
