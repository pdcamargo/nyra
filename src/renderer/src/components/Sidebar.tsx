import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import {
  useSessionsStore,
  activeProject,
  activeProjectCwd,
  liveSessions,
  sortProjects
} from '../store/sessions'
import { useUiStore, type MainView } from '../store/ui'
import type { Project, Session } from '../store/sessions'
import { usePlanApprovalStore } from '../store/planApprovals'
import { useBrowserStore } from '../store/browser'
import { useRunningStore, projectSpinnerVisible } from '../store/running'
import { useAutoHideScrollbar } from '../hooks/useAutoHideScrollbar'
import { useWorkflowStore } from '../store/workflow'
import { usePanelLayoutStore } from '../store/panelLayout'
import { Archive, ArrowDownToLine, Brain, Copy, Folder, Slash, Sparkles, Store, Terminal, FolderOpen, GitBranch, GitFork, Globe, GripVertical, MoreHorizontal, Pencil, Plus, SquarePen, Star, Timer, Trash2, Workflow } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { ChatRowPrChip, PrCardLines } from './PullRequestChips'
import UsageMenu from './UsageMenu'
import { CommandKbd, useChordLabel } from './ui/kbd'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { homedir } from '../lib/homedir'
import { groupFlowsByProject, triggerSummary, flowMeta, flowComposition } from '../lib/flowGrouping'
import { createPermanentWorktree, defaultBranchName } from '../lib/worktrees'
import { archiveChat, openArchivedChats } from '../lib/archive'
import type { WorkflowDefinition } from '../../../shared/workflow-types'

// Lazy so monaco-editor only loads when Memory is opened.
const MemoryTab = React.lazy(() => import('./MemoryTab'))

/** The main area's pages, in the order the rail lists them. */
const NAV = [
  { view: 'skills', label: 'Skills', Icon: Sparkles },
  { view: 'commands', label: 'Commands', Icon: Slash },
  { view: 'memory', label: 'Memory', Icon: Brain },
  { view: 'plugins', label: 'Plugins', Icon: Store },
  { view: 'archived', label: 'Archived', Icon: Archive }
] as const satisfies readonly { view: Exclude<MainView, 'chat'>; label: string; Icon: unknown }[]

export default function Sidebar(): React.JSX.Element {
  // In the ui store rather than local state: opening a memory file from an agent
  // definition has to be able to bring this tab forward from outside.
  const mainView = useUiStore((s) => s.mainView)
  const setMainView = useUiStore((s) => s.setMainView)
  // The canvas already replaced the chat area rather than floating over it, so
  // this flag was a view mode in all but name. The toggle just makes it one.
  const flowMode = useWorkflowStore((s) => s.isCanvasOpen)
  // shrink-0 because the width has to stay what the user set: flex would
  // otherwise squeeze this rail on a narrow window and --rail would start lying.
  const width = usePanelLayoutStore((s) => s.sidebarWidth)
  const { onScroll } = useAutoHideScrollbar()

  return (
    // The rail's type is set once here and everything inside is sized in `em`
    // against it. Bumping the conversation's text used to leave the project list
    // exactly as small as it was.
    <aside
      style={{ width, fontSize: 'var(--ui-font-size, 13px)' }}
      className="flex h-full shrink-0 flex-col bg-sidebar border-r border-border/55"
    >
      {/* The wordmark sits here rather than only in the title bar: the rail is
          what you look at, and the title bar shows the chat's name. Search stays
          up there with the other window-level actions. */}
      {/* The mode toggle is segmented — one of two is on — so it marks the live
          one with --bubble and white on it, the same dark pill the reader's own
          messages are drawn in. It used to differ from the page by a fill
          alone, and on the light rail that fill was 0.9702 against 0.984: the
          `on` state was, in practice, not drawn.

          Stacked, wordmark + toggle + nav would be three bars of chrome before
          any content; on one row the first two read as a header. */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <span className="text-[1.08em] font-semibold tracking-tight text-foreground">Nyra</span>
        <ModeToggle />
      </div>

      <UpdateBadge />

      {/* The rail's nav.

          Vertical, and no longer tabs over the rail's own body: picking Skills
          used to replace the chat list with a 256px column of them, so a chat
          and a page about your setup competed for the same 256px. They are
          pages in the main area now and the chats stay where they are. Chats is
          not in the list for the same reason — it is not a destination when it
          is always on screen; the page it opens is whatever chat is selected.

          Each row carries its chord, shown on hover and kept visible on the
          live one. */}
      {!flowMode && (
        /* pb-4, not pb-1: the rows inside this list sit 2px apart, so a 4px
           break under it was the same distance as the gaps within it and
           PROJECTS read as a fourth nav item. The space between two groups has
           to beat the space inside one. */
        <nav className="flex flex-col gap-0.5 px-2 pb-4">
          {NAV.map(({ view, label, Icon }) => {
            const on = mainView === view
            return (
              <button
                key={view}
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  if (on) {
                    setMainView('chat')
                    return
                  }
                  // The Archived page carries a project selection, so its row
                  // opens it the way the command does rather than setting the
                  // view alone. `null` clears the selection, which lands on the
                  // project the chat you are reading belongs to.
                  if (view === 'archived') openArchivedChats(null)
                  else setMainView(view)
                }}
                /* The same fill and ring a selected chat gets. One rail, one
                   idea of "this is what you are looking at" — and since only
                   one of the two can be true at a time, they never appear
                   together to be told apart. */
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.92em] transition-colors ${
                  on
                    ? 'bg-rail-selected text-foreground ring-1 ring-rail-selected-ring'
                    : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <CommandKbd
                  id={`view.${view}`}
                  className={on ? 'opacity-70' : 'opacity-0 transition-opacity group-hover:opacity-60'}
                />
              </button>
            )
          })}
        </nav>
      )}

      {/* Content */}
      <div className="scroll-auto-hide flex-1 overflow-y-auto px-2 pb-2" onScroll={onScroll}>
        {flowMode ? <FlowsList /> : <SessionsList />}
      </div>

      {/* The rail's footer: a rule to sit on, and a fade above it.
          
          Both, not either. The rule is what separates the footer from the list
          at rest — without it the row floats in the same field as the chats and
          reads as one more of them. The fade is for the scrolling case, where a
          row arriving at a hard line is cut in half; it dissolves into the
          rail's own colour over 28px so the row leaves instead. It is drawn
          above the border and outside the footer's box, so it costs the list no
          height and the footer stays the size of its own content — the same bar
          as the status line it replaces. */}
      <div className="relative shrink-0 border-t border-border/55 px-2 py-1.5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-7 h-7 bg-gradient-to-t from-sidebar to-transparent"
        />
        <UsageMenu />
      </div>

      {flowMode && (
        <div className="p-2 border-t border-border/55 flex gap-1.5">
          <button
            onClick={() =>
              useWorkflowStore
                .getState()
                .setCurrentWorkflow(
                  blankFlow(activeProject(useSessionsStore.getState())?.id ?? null)
                )
            }
            className="flex-1 rounded-md bg-secondary hover:bg-accent py-1.5 text-[0.92em] font-medium text-foreground transition-colors"
          >
            + New flow
          </button>
          <button
            onClick={() => useWorkflowStore.getState().setCurrentWorkflow(null)}
            className="flex-1 rounded-md border border-border bg-muted/40 hover:bg-accent py-1.5 text-[0.92em] font-medium text-foreground/80 hover:text-foreground transition-colors"
          >
            Templates
          </button>
        </div>
      )}
    </aside>
  )
}

/**
 * Chat / Flow, on the wordmark row.
 *
 * A toggle rather than a dropdown on the wordmark: a menu hides the alternative
 * behind a click, and nobody has ever run a flow. Two views is a toggle; a third
 * would make it a menu.
 *
 * `panel.canvas` already toggles the same state, so the keycap stays honest if
 * that chord is rebound.
 */
function ModeToggle(): React.JSX.Element {
  const flowMode = useWorkflowStore((s) => s.isCanvasOpen)
  const openCanvas = useWorkflowStore((s) => s.openCanvas)
  const closeCanvas = useWorkflowStore((s) => s.closeCanvas)
  const keys = useChordLabel('panel.canvas')

  return (
    <div className="flex shrink-0 items-center gap-0 rounded-full border border-border/70 bg-background/60 p-[2px]">
      {(
        [
          ['Chat', false],
          ['Flow', true]
        ] as const
      ).map(([label, isFlow]) => {
        const on = flowMode === isFlow
        return (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => (isFlow ? openCanvas() : closeCanvas())}
                className={`rounded-full px-2.5 py-[3px] text-[0.8em] transition-colors ${
                  on
                    ? 'bg-bubble font-semibold text-bubble-foreground'
                    : 'text-muted-foreground hover:text-foreground/80'
                }`}
              >
                {label}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {keys ? `${isFlow ? 'Flows' : 'Chats'} (${keys})` : isFlow ? 'Flows' : 'Chats'}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function SectionLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="px-2 mb-1.5 text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </p>
  )
}

/** How many chats a project shows before `Show more`. */
const VISIBLE_PER_PROJECT = 6

/**
 * What a chat is, on hover.
 *
 * The row used to carry its folder, branch, worktree mark and browser glyph on a
 * second line, which made every row two lines tall to answer a question nobody
 * asks while scanning the list. The line says what is *happening* — running,
 * waiting on you, unread — and the rest is here when you point at it.
 */
/**
 * A new version exists, said quietly.
 *
 * Above the tabs because that is the one part of the rail that is not a list of
 * your things — a banner among the chats would read as a chat. It only appears
 * when the launch check found something, and it opens Settings rather than
 * installing: the decision stays where the release notes are.
 */
function UpdateBadge(): React.JSX.Element | null {
  const version = useUiStore((s) => s.updateAvailable)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  if (!version) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-info/10 px-2 py-1 text-[0.85em] text-info transition-colors hover:bg-info/20"
        >
          <ArrowDownToLine className="size-3 shrink-0" />
          <span className="truncate">Update to {version}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{`Nyra ${version} is available`}</TooltipContent>
    </Tooltip>
  )
}

function ChatCard({
  session,
  hasBrowser
}: {
  session: Session
  hasBrowser: boolean
}): React.JSX.Element {
  const folder = session.cwd?.split('/').pop()
  return (
    <div className="flex min-w-[14rem] flex-col gap-1.5">
      <p className="text-[0.92em] font-medium text-foreground">{session.title}</p>
      {folder && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Folder className="size-3 shrink-0" />
          <span className="truncate font-mono">{folder}</span>
        </span>
      )}
      {session.branch && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono">{session.branch}</span>
          {session.worktree && (
            <span className="shrink-0 text-info">
              {session.worktree.permanent ? 'permanent worktree' : 'worktree'}
            </span>
          )}
        </span>
      )}
      {hasBrowser && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Globe className="size-3 shrink-0" />
          Browser open
        </span>
      )}
      {/* The numbers the row's chip could only count. */}
      <PrCardLines prs={session.pullRequests ?? []} />
      {session.forkOf && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <GitFork className="size-3 shrink-0" />
          <span className="truncate">Forked from “{session.forkOf.title}”</span>
        </span>
      )}
    </div>
  )
}

/**
 * A flow, on hover.
 *
 * The same treatment as `ChatCard`, because it answers the same question about
 * the same kind of row. This started as a native `title` — the truncated-string
 * rule in CLAUDE.md — but that rule is about revealing text an ellipsis ate, and
 * this is row metadata, which the sidebar had already decided gets a real card.
 */
function FlowCard({
  wf,
  projectName
}: {
  wf: WorkflowDefinition
  projectName: string | null
}): React.JSX.Element {
  const { nodes, prompts, scripts, subflows } = flowComposition(wf)
  const trigger = triggerSummary(wf)
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

  return (
    // A set width, not min-width: these are hovered one after another down a
    // list, and a card that resizes to each flow's description makes the column
    // jump around as the pointer moves.
    <div className="flex w-[15rem] flex-col gap-1.5">
      <p className="text-[0.92em] font-medium text-foreground">{wf.name}</p>
      {wf.description?.trim() && (
        <p className="line-clamp-3 text-[0.85em] leading-relaxed text-muted-foreground">
          {wf.description.trim()}
        </p>
      )}
      <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
        <Workflow className="size-3 shrink-0" />
        {nodes === 0 ? 'Empty' : plural(nodes, 'node', 'nodes')}
      </span>
      {prompts > 0 && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Sparkles className="size-3 shrink-0" />
          {plural(prompts, 'Claude turn', 'Claude turns')}
        </span>
      )}
      {scripts > 0 && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Terminal className="size-3 shrink-0" />
          {plural(scripts, 'shell command', 'shell commands')}
        </span>
      )}
      {subflows > 0 && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Workflow className="size-3 shrink-0" />
          {plural(subflows, 'sub-flow', 'sub-flows')}
        </span>
      )}
      {trigger && (
        <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
          <Timer className="size-3 shrink-0" />
          <span className="truncate font-mono">{trigger}</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[0.85em] text-muted-foreground">
        <Folder className="size-3 shrink-0" />
        <span className="truncate">{projectName ?? 'Any project'}</span>
      </span>
    </div>
  )
}

/**
 * A chat that is waiting on you, said in the list rather than only inside it.
 *
 * A shimmering title says Claude is busy. This says the opposite — it has
 * stopped, and it stopped on you. Without it the two look identical from the
 * sidebar: quiet.
 */
function WaitingChip({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm bg-info/15 px-1 py-px text-[0.70em] font-medium uppercase tracking-wide text-info">
      {label}
    </span>
  )
}

/**
 * A project's overflow menu.
 *
 * Renaming happens inline in the menu rather than in a dialog, which is why the
 * open state is controlled: committing a name closes it, and typing in the field
 * must not.
 */
function ProjectMenu({ project }: { project: Project }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.name)

  const commit = (): void => {
    if (name.trim()) useSessionsStore.getState().renameProject(project.id, name.trim())
    setRenaming(false)
    setOpen(false)
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setRenaming(false)
      }}
    >
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        title="Project options"
        aria-label={`Options for ${project.name}`}
        className="rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground"
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {renaming ? (
          <div className="p-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setRenaming(false)
              }}
              onBlur={commit}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-[0.92em] text-foreground outline-none focus:border-ring"
            />
          </div>
        ) : (
          <>
            <DropdownMenuLabel className="pb-0">{project.name}</DropdownMenuLabel>
            <p className="px-2 pb-1.5 font-mono text-[0.77em] break-all text-muted-foreground">
              {project.path}
            </p>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            setRenaming(true)
          }}
        >
          <Pencil />
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void window.api.dialog.pickFolder().then((folder) => {
              if (folder) useSessionsStore.getState().setProjectPath(project.id, folder)
            })
          }
        >
          <FolderOpen />
          Change folder…
        </DropdownMenuItem>
        {/* The project's own way in to the archive. It opens already on this
            project rather than on whatever the page last showed. */}
        <DropdownMenuItem onSelect={() => openArchivedChats(project.id)}>
          <Archive />
          View archived chats
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            const branch = window.prompt('Branch for the permanent worktree', defaultBranchName())
            if (!branch?.trim()) return
            void createPermanentWorktree(project.path, branch.trim()).then((result) => {
              if (!result.ok) return
              const store = useSessionsStore.getState()
              // Permanent worktrees are shared by several chats and never
              // auto-pruned, so the chat opened here is not their owner.
              const sid = store.createSession(result.path, project.id)
              store.setWorktree(sid, {
                name: branch.trim(),
                branch: branch.trim(),
                path: result.path,
                permanent: true
              })
            })
          }}
        >
          <GitBranch />
          New permanent worktree…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => useSessionsStore.getState().removeProject(project.id)}
        >
          <Trash2 />
          Remove project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SessionsList(): React.JSX.Element {
  // A chat stops looking selected the moment a page covers it: the rail would
  // otherwise show two live rows, and only one of them is what you are reading.
  const onChatView = useUiStore((s) => s.mainView === 'chat')
  const showChat = useUiStore((s) => s.setMainView)
  const sessions = useSessionsStore((state) => state.sessions)
  // Archived chats are not in the rail at all. Their own page is where they
  // live, and it is the only place that knows how to bring one back.
  const railSessions = useMemo(() => liveSessions(sessions), [sessions])
  // Subscribe to the raw array and sort in render: sortProjects allocates, and a
  // selector returning a fresh reference re-renders forever under zustand's
  // Object.is comparison.
  const rawProjects = useSessionsStore((state) => state.projects)
  const projects = useMemo(() => sortProjects(rawProjects), [rawProjects])
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const running = useRunningStore((s) => s.running)
  const browsers = useBrowserStore((s) => s.bySession)
  const pendingPlans = usePlanApprovalStore((s) => s.pending)
  const planPending = useMemo(() => new Set(Object.values(pendingPlans)), [pendingPlans])
  const { setActiveSession, deleteSession, renameSession, toggleFavorite, reorderFavorites } =
    useSessionsStore()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [expandedAll, setExpandedAll] = useState<Set<string>>(new Set())
  // Archiving a chat that is working has to ask first — it stops the work. A
  // chat that is idle goes straight away, and only shows up here if it could
  // not go: a snapshot that failed is not worth a silent menu item.
  const [archivePrompt, setArchivePrompt] = useState<
    { kind: 'confirm' | 'failed'; session: Session; error?: string } | null
  >(null)

  const runArchive = useCallback(async (session: Session): Promise<void> => {
    const result = await archiveChat(session.id)
    if (!result.ok) setArchivePrompt({ kind: 'failed', session, error: result.error })
  }, [])

  const requestArchive = (session: Session): void => {
    if (running[session.id]) setArchivePrompt({ kind: 'confirm', session })
    else void runArchive(session)
  }

  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const pinned = railSessions
    .filter((s) => s.favorite)
    .sort((a, b) => (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0))

  const knownProjects = new Set(projects.map((p) => p.id))
  const recents = railSessions.filter(
    (s) =>
      (!s.projectId || !knownProjects.has(s.projectId)) &&
      (s.messages.length > 0 || s.id === activeSessionId)
  )

  const handleDrop = (targetId: string): void => {
    const sourceId = dragId
    setDragId(null)
    setDragOverId(null)
    if (!sourceId || sourceId === targetId) return
    const ids = pinned.map((s) => s.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1)
    // The drop indicator renders at the top of the target row ("insert before"),
    // so when dragging downward the target shifts left by one after removal.
    ids.splice(from < to ? to - 1 : to, 0, sourceId)
    reorderFavorites(ids)
  }

  const addProject = async (): Promise<void> => {
    const folder = await window.api.dialog.pickFolder()
    if (!folder) return
    const store = useSessionsStore.getState()
    const projectId = store.createProject(folder)
    store.createSession(folder, projectId)
  }

  const newChatIn = (project: Project): void => {
    useSessionsStore.getState().createSession(project.path, project.id)
    setExpandedAll((prev) => new Set(prev).add(project.id))
  }

  const newRecentChat = (): void => {
    // Spec §6: a chat with no project runs in the home directory, so it sees only
    // the global ~/.claude scope for skills, memory, MCP and hooks.
    useSessionsStore.getState().createSession(homedir(), null)
  }

  const renderRow = (
    session: Session,
    opts: { indented?: boolean; showFolder?: boolean } = {}
  ): React.JSX.Element => {
    const isPinned = !!session.favorite
    const isActive = session.id === activeSessionId && onChatView
    const isRunning = running[session.id] === true
    const unread = session.unread ?? 0
    // A chat's browser keeps running whether or not you are looking at that
    // chat, and a background chat gets no miniature. Without this there would
    // be nothing anywhere saying it has one.
    const hasBrowser = (browsers[session.id]?.tabs.length ?? 0) > 0
    // A plan outranks a question: it is the bigger decision, and a session
    // rarely has both.
    const waiting = planPending.has(session.id)
      ? 'Pending approval'
      : session.needsAnswer
        ? 'Needs answer'
        : null
    return (
      <ContextMenu key={session.id}>
      <ContextMenuTrigger
        /* --rail-selected rather than --accent: on the light rail --accent is
           0.9702 against a 0.9740 sidebar and the list read as having nothing
           selected at all. A running chat also washes, because a shimmering
           title alone is not findable in a list this long. */
        className={`group relative flex items-center rounded-md transition-colors ${
          isActive ? 'bg-rail-selected ring-1 ring-rail-selected-ring' : 'hover:bg-accent/50'
        } ${isRunning ? 'nyra-shimmer-bg' : ''} ${
          dragId === session.id ? 'opacity-40' : ''
        }`}
        onDragOver={
          isPinned
            ? (e) => {
                if (!dragId) return
                e.preventDefault()
                if (dragOverId !== session.id) setDragOverId(session.id)
              }
            : undefined
        }
        onDragLeave={isPinned ? () => setDragOverId((id) => (id === session.id ? null : id)) : undefined}
        onDrop={isPinned ? () => handleDrop(session.id) : undefined}
      >
        {dragOverId === session.id && dragId !== session.id && (
          <div className="absolute top-[-2px] left-1 right-1 h-0.5 rounded-full bg-info" />
        )}
        {isPinned && !opts.indented && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                draggable
                onDragStart={() => setDragId(session.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDragOverId(null)
                }}
                className="flex items-center pl-1.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground/80 transition-colors"
                aria-label="Drag to reorder"
              >
                <GripVertical className="size-2.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent>Drag to reorder</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
        <TooltipTrigger asChild>
        <button
          onClick={() => {
            setActiveSession(session.id)
            // Picking a chat is asking to read it, which a page is in the way of.
            showChat('chat')
          }}
          onDoubleClick={() => {
            setRenamingId(session.id)
            setRenameValue(session.title)
          }}
          className={`min-w-0 flex-1 py-1.5 pr-2 text-left ${opts.indented ? 'pl-[27px]' : 'pl-2'} ${
            isActive ? 'text-foreground' : 'text-foreground/80'
          }`}
        >
          {renamingId === session.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setRenamingId(null)
                e.stopPropagation()
              }}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-transparent text-[0.92em] text-foreground outline-hidden border-b border-info/50"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              {/* Running is said by the title itself rather than by a spinner
                  beside it. One less thing in the row, and it is the same
                  signal the transcript uses for the same state. */}
              <p
                className={`truncate text-[0.92em] ${
                  isRunning ? 'nyra-shimmer' : unread ? 'font-medium text-foreground' : ''
                }`}
              >
                {session.title}
              </p>
              {waiting && <WaitingChip label={waiting} />}
              {/* Pushed right by whichever of these comes first, so a row with
                  both a PR and an unread dot keeps them together at the end. */}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <ChatRowPrChip sessionId={session.id} />
                {!waiting && unread > 0 && (
                  <span
                    title={`${unread} new message${unread === 1 ? '' : 's'}`}
                    className="size-1.5 shrink-0 rounded-full bg-info"
                  />
                )}
              </span>
            </div>
          )}
        </button>
        </TooltipTrigger>
        {/* A card, not a label: the tooltip's own surface is inverted, which is
            right for one line of text and wrong for five. */}
        <TooltipContent
          side="right"
          align="start"
          arrow={false}
          sideOffset={6}
          className="max-w-none items-start border border-border bg-popover p-2.5 text-popover-foreground"
        >
          <ChatCard session={session} hasBrowser={hasBrowser} />
        </TooltipContent>
        </Tooltip>
        <div className="flex items-center shrink-0 pr-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(session.id)
                }}
                className={`p-1 transition-all ${
                  isPinned
                    ? 'text-warning/80 hover:text-warning'
                    : 'text-muted-foreground hover:text-foreground/80 opacity-0 group-hover:opacity-100'
                }`}
                aria-label={isPinned ? 'Unpin' : 'Pin'}
              >
                <Star className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{isPinned ? 'Unpin' : 'Pin'}</TooltipContent>
          </Tooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => requestArchive(session)}>
          <Archive />
          Archive chat
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => deleteSession(session.id)}>
          <Trash2 />
          Delete chat
        </ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>
    )
  }

  const renderProject = (project: Project): React.JSX.Element => {
    // A chat with nothing in it is not worth a row — it reads as a stray
    // "New session" line. The one you are looking at stays, or it would vanish
    // from under you the moment you started it.
    const children = railSessions.filter(
      (s) => s.projectId === project.id && (s.messages.length > 0 || s.id === activeSessionId)
    )
    const collapsed = project.collapsed === true
    const showingAll = expandedAll.has(project.id)
    const visible = showingAll ? children : children.slice(0, VISIBLE_PER_PROJECT)
    const hiddenCount = children.length - visible.length

    const projectSpinner = projectSpinnerVisible({
      collapsed,
      childIds: children.map((s) => s.id),
      visibleCount: visible.length,
      running
    })

    return (
      <div key={project.id} className="relative space-y-px">
        <div className="group flex items-center rounded-md hover:bg-accent/50 transition-colors">
          <button
            onClick={() => useSessionsStore.getState().setProjectCollapsed(project.id, !collapsed)}
            className="min-w-0 flex-1 flex items-center gap-1.5 px-2 py-1.5 text-left text-foreground/80"
            title={project.path}
          >
            {collapsed ? (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={`truncate text-[0.92em] ${projectSpinner ? 'nyra-shimmer' : ''}`}>
              {project.name}
            </span>
          </button>
          <div className="flex items-center shrink-0 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <ProjectMenu project={project} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    newChatIn(project)
                  }}
                  className="p-1 text-muted-foreground hover:text-foreground/80 transition-colors"
                  aria-label={`New chat in ${project.name}`}
                >
                  <SquarePen className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{`New chat in ${project.name}`}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {!collapsed && (
          <>
            {visible.map((s) => renderRow(s, { indented: true, showFolder: false }))}
            {/* One control, both directions. `Show more` was a one-way door: a
                project opened to forty chats stayed forty rows tall for the
                rest of the session, and the only way back was a reload.
                
                Keyed off the child count rather than off hiddenCount, which is
                zero while expanded — and rather than off the expanded set,
                which can still name a project whose chats have since been
                deleted down below the cap. */}
            {children.length > VISIBLE_PER_PROJECT && (
              <button
                onClick={() =>
                  setExpandedAll((prev) => {
                    const next = new Set(prev)
                    if (showingAll) next.delete(project.id)
                    else next.add(project.id)
                    return next
                  })
                }
                className="py-1 pl-[27px] pr-2 text-left text-[0.77em] text-muted-foreground transition-colors hover:text-foreground/80"
              >
                {showingAll ? 'Show less' : `Show more (${hiddenCount})`}
              </button>
            )}
            {children.length === 0 && (
              <p className="py-1 pl-[27px] pr-2 text-[0.77em] text-muted-foreground">No chats yet</p>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div>
      {pinned.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-1 px-2 mb-1.5">
            <Star className="size-2.5 text-warning/80" />
            <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground">
              Pinned
            </span>
          </div>
          <div className="space-y-px">{pinned.map((s) => renderRow(s))}</div>
        </div>
      )}

      <div className="mb-2">
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground">
            Projects
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={addProject}
                className="p-0.5 text-muted-foreground hover:text-foreground/80 transition-colors"
                aria-label="Add project"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add project</TooltipContent>
          </Tooltip>
        </div>
        {projects.length === 0 ? (
          <button
            onClick={addProject}
            className="w-full px-2 py-1.5 text-left text-[0.85em] text-muted-foreground hover:text-foreground/80 transition-colors"
          >
            Add a folder to get started
          </button>
        ) : (
          <div className="space-y-1.5">{projects.map(renderProject)}</div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground">
            Recents
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={newRecentChat}
                className="p-0.5 text-muted-foreground hover:text-foreground/80 transition-colors"
                aria-label="New chat with no project (runs in ~)"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New chat with no project (runs in ~)</TooltipContent>
          </Tooltip>
        </div>
        {recents.length === 0 ? (
          <p className="px-2 py-1 text-[0.77em] text-muted-foreground">Nothing outside a project</p>
        ) : (
          <div className="space-y-px">{recents.map((s) => renderRow(s))}</div>
        )}
      </div>

      {/* One dialog for both halves of the same question. A running chat is
          asked before it is put away; a chat that could not be put away says
          why and offers to try again, rather than a menu item that did nothing. */}
      <AlertDialog
        open={archivePrompt !== null}
        onOpenChange={(next) => {
          if (!next) setArchivePrompt(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archivePrompt?.kind === 'failed'
                ? `Could not archive “${archivePrompt.session.title}”`
                : `Archive “${archivePrompt?.session.title ?? ''}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archivePrompt?.kind === 'failed' ? (
                <>
                  {archivePrompt.error} Nothing was changed — the chat is still in your rail.
                </>
              ) : (
                <>
                  This chat is working. Archiving stops its Claude session, anything it started in
                  the background, and its browser. Its worktree is saved before it goes, and the
                  chat moves to Archived, where you can bring it back.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {archivePrompt?.kind === 'failed' ? 'Close' : 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const session = archivePrompt?.session
                if (!session) return
                // Cleared first: a second failure puts the dialog straight back
                // up with the new reason.
                setArchivePrompt(null)
                void runArchive(session)
              }}
            >
              {archivePrompt?.kind === 'failed' ? 'Try again' : 'Archive'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The rail in Flow mode.
 *
 * Mirrors the chat rail on purpose: projects, with their flows nested under
 * them, so switching projects is the same gesture in both modes and no separate
 * picker is needed.
 *
 * Two sections sit outside that. RUNNING pins on top while something executes,
 * so a live run surfaces whatever project owns it. ANY PROJECT catches flows
 * scoped to nothing — some are deliberately unscoped, and everything installed
 * from a template arrives owned by nobody.
 */
/** A blank flow, owned by `projectId` (null means it suits any repo). */
export function blankFlow(projectId: string | null): WorkflowDefinition {
  return {
    id: `wf-${Date.now()}`,
    name: 'New Flow',
    projectId,
    nodes: [],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function FlowsList(): React.JSX.Element {
  const { workflows, setWorkflows, setCurrentWorkflow, setExecution, execution, currentWorkflow } =
    useWorkflowStore()
  const projects = useSessionsStore((s) => s.projects)
  const ordered = useMemo(() => sortProjects(projects), [projects])
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const wfs = (await window.api.workflow.list()) as WorkflowDefinition[]
    setWorkflows(wfs)
  }, [setWorkflows])

  const remove = useCallback(
    async (wf: WorkflowDefinition): Promise<void> => {
      await window.api.workflow.delete(wf.id)
      // Clear the canvas if it was showing the flow that just went away.
      if (useWorkflowStore.getState().currentWorkflow?.id === wf.id) setCurrentWorkflow(null)
      await refresh()
    },
    [refresh, setCurrentWorkflow]
  )

  const duplicate = useCallback(
    async (wf: WorkflowDefinition): Promise<void> => {
      const copy: WorkflowDefinition = {
        ...wf,
        id: `wf-${Date.now()}`,
        name: `${wf.name} copy`,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await window.api.workflow.save(copy)
      await refresh()
    },
    [refresh]
  )

  const moveTo = useCallback(
    async (wf: WorkflowDefinition, projectId: string | null): Promise<void> => {
      await window.api.workflow.save({ ...wf, projectId, updatedAt: Date.now() })
      if (useWorkflowStore.getState().currentWorkflow?.id === wf.id) {
        useWorkflowStore.getState().updateCurrentWorkflow({ projectId })
      }
      await refresh()
    },
    [refresh]
  )

  useEffect(() => {
    window.api.workflow.list().then((wfs) => setWorkflows(wfs as WorkflowDefinition[]))
  }, [])

  const open = useCallback(
    async (id: string): Promise<void> => {
      const wf = (await window.api.workflow.load(id)) as WorkflowDefinition | null
      if (!wf) return
      setCurrentWorkflow(wf)
      setExecution(null)
    },
    [setCurrentWorkflow, setExecution]
  )

  const runningId = execution?.status === 'running' ? execution.workflowId : null
  const endedBadlyId =
    execution?.status === 'failed' || execution?.status === 'aborted' ? execution.workflowId : null
  const grouped = useMemo(() => groupFlowsByProject(workflows), [workflows])

  const create = (projectId: string | null): void => {
    setCurrentWorkflow(blankFlow(projectId))
    setExecution(null)
  }

  /** The `+` on a group header, which is the only way to pick a flow's owner. */
  const addButton = (projectId: string | null, where: string): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => create(projectId)}
          aria-label={`New flow in ${where}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground/80 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent>New flow in {where}</TooltipContent>
    </Tooltip>
  )

  const row = (wf: WorkflowDefinition, indent: boolean): React.JSX.Element => {
    const running = wf.id === runningId
    const ended =
      wf.id === endedBadlyId ? (execution?.status as 'failed' | 'aborted' | undefined) : undefined
    const trigger = triggerSummary(wf)
    const meta = flowMeta(wf, {
      running: running
        ? {
            done: Object.values(execution?.nodeStates ?? {}).filter((n) => n.status === 'done')
              .length,
            total: wf.nodes.length
          }
        : undefined,
      ended,
      home: homedir()
    })
    const confirming = confirmId === wf.id
    return (
      <ContextMenu key={wf.id}>
      {/* Both triggers land `asChild` on the same button, and the nesting is
          load-bearing. A ContextMenuTrigger wrapping <Tooltip> hands its props to
          Radix's Root, which renders no DOM and forwards nothing — onContextMenu
          never reaches the button, and the row answers a right-click with
          WebKit's native menu instead of this one. A Slot-based trigger inside
          another Slot-based trigger merges all the way down; a Root in between
          swallows it. */}
      <Tooltip>
      <TooltipTrigger asChild>
      <ContextMenuTrigger asChild>
      <button
        type="button"
        onClick={() => open(wf.id)}
        className={`flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left transition-colors ${
          indent ? 'pl-5' : 'pl-2'
        } ${
          currentWorkflow?.id === wf.id
            ? 'bg-rail-selected ring-1 ring-rail-selected-ring'
            : 'hover:bg-accent/50'
        }`}
      >
        <span className="flex items-center gap-1.5">
          {running && <span className="size-1.5 shrink-0 rounded-full bg-info" />}
          {ended === 'failed' && <span className="size-1.5 shrink-0 rounded-full bg-danger" />}
          <span
            className={`truncate text-[0.92em] ${
              currentWorkflow?.id === wf.id ? 'font-semibold text-foreground' : 'text-foreground/80'
            }`}
          >
            {wf.name}
          </span>
        </span>
        <span
          className={`flex items-center gap-1 text-[0.77em] ${
            running ? 'text-info' : ended === 'failed' ? 'text-danger' : 'text-muted-foreground'
          }`}
        >
          {trigger && !running && !ended && <Timer className="size-[0.9em] shrink-0" />}
          <span className="truncate">{meta}</span>
        </span>
      </button>
      </ContextMenuTrigger>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        arrow={false}
        sideOffset={6}
        className="max-w-none items-start border border-border bg-popover p-2.5 text-popover-foreground"
      >
        <FlowCard
          wf={wf}
          projectName={ordered.find((pr) => pr.id === wf.projectId)?.name ?? null}
        />
      </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => open(wf.id)}>
          <Workflow />
          Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void duplicate(wf)}>
          <Copy />
          Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel className="text-[0.7em] uppercase tracking-wider text-muted-foreground">
          Belongs to
        </ContextMenuLabel>
        <ContextMenuItem
          disabled={!wf.projectId}
          onSelect={() => void moveTo(wf, null)}
        >
          <Workflow className="opacity-0" />
          Any project
        </ContextMenuItem>
        {ordered.map((pr) => (
          <ContextMenuItem
            key={pr.id}
            disabled={wf.projectId === pr.id}
            onSelect={() => void moveTo(wf, pr.id)}
          >
            <Folder />
            <span className="truncate">{pr.name}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        {confirming ? (
          <ContextMenuItem variant="destructive" onSelect={() => void remove(wf)}>
            <Trash2 />
            Really delete it?
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            variant="destructive"
            onSelect={(e) => {
              // Deleting a flow throws away a graph someone drew, and there is
              // no undo — so the first pick only arms it.
              e.preventDefault()
              setConfirmId(wf.id)
            }}
          >
            <Trash2 />
            Delete flow
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      </ContextMenu>
    )
  }

  const running = runningId ? workflows.filter((w) => w.id === runningId) : []

  return (
    <div className="space-y-0.5">
      {running.length > 0 && (
        <>
          <SectionLabel label="Running" />
          {running.map((wf) => row(wf, false))}
        </>
      )}

      <SectionLabel label="Projects" />
      {ordered.map((project) => {
        const flows = grouped.byProject.get(project.id) ?? []
        return (
          <div key={project.id}>
            <div className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent/40">
              <Folder className="size-[0.9em] shrink-0 text-muted-foreground" />
              <span className="truncate text-[0.85em] font-semibold text-foreground/80">
                {project.name}
              </span>
              {/* The count rides with the + rather than sitting there always:
                  the flows are listed directly underneath, so at rest it is
                  restating what you can already see. */}
              <span className="ml-auto text-[0.77em] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                {flows.length}
              </span>
              {addButton(project.id, project.name)}
            </div>
            {flows.map((wf) => row(wf, true))}
          </div>
        )
      })}

      {/* Always rendered, unlike the other sections: it is the only place to
          make a flow that is not about a repo, and hiding it until one exists
          made that unreachable. */}
      <div className="group flex items-center gap-1.5 rounded-md px-2 pt-2 hover:bg-accent/40">
        <span className="text-[0.7em] font-semibold uppercase tracking-wider text-muted-foreground">
          Any project
        </span>
        <span className="ml-auto text-[0.77em] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {grouped.loose.length}
        </span>
        {addButton(null, 'any project')}
      </div>
      {grouped.loose.map((wf) => row(wf, false))}

      {workflows.length === 0 && (
        <p className="px-2 pt-3 text-[0.8em] leading-relaxed text-muted-foreground">
          No flows yet. Use <span className="text-foreground/80">+</span> on a project to make one
          there, or on <span className="text-foreground/80">Any project</span> for one that suits
          any repo.
        </p>
      )}
    </div>
  )
}
