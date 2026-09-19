import React, { useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import { useSessionsStore, activeProject, activeProjectCwd, sortProjects } from '../store/sessions'
import { useUiStore, type SidebarTab } from '../store/ui'
import type { Project, Session } from '../store/sessions'
import { usePlanApprovalStore } from '../store/planApprovals'
import { useBrowserStore } from '../store/browser'
import { useRunningStore, projectSpinnerVisible } from '../store/running'
import { useSkillEditorStore } from '../store/skillEditor'
import { useWorkflowStore } from '../store/workflow'
import { usePanelLayoutStore } from '../store/panelLayout'
import { ArrowDownToLine, Copy, Folder, Sparkles, Terminal, FolderOpen, GitBranch, GitFork, Globe, GripVertical, LoaderCircle, MoreHorizontal, Pencil, Plus, SquarePen, Star, Timer, Trash2, Workflow } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChordLabel } from './ui/kbd'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { BUILT_IN_COMMANDS } from '../data/commands'
import { homedir } from '../lib/homedir'
import { groupFlowsByProject, triggerSummary, flowMeta, flowComposition } from '../lib/flowGrouping'
import { createPermanentWorktree, defaultBranchName } from '../lib/worktrees'
import type { WorkflowDefinition } from '../../../shared/workflow-types'

// Lazy so monaco-editor only loads when Memory is opened.
const MemoryTab = React.lazy(() => import('./MemoryTab'))

export default function Sidebar(): React.JSX.Element {
  // In the ui store rather than local state: opening a memory file from an agent
  // definition has to be able to bring this tab forward from outside.
  const activeTab = useUiStore((s) => s.sidebarTab)
  const setActiveTab = useUiStore((s) => s.setSidebarTab)
  // The canvas already replaced the chat area rather than floating over it, so
  // this flag was a view mode in all but name. The toggle just makes it one.
  const flowMode = useWorkflowStore((s) => s.isCanvasOpen)
  // shrink-0 because the width has to stay what the user set: flex would
  // otherwise squeeze this rail on a narrow window and --rail would start lying.
  const width = usePanelLayoutStore((s) => s.sidebarWidth)

  return (
    // The rail's type is set once here and everything inside is sized in `em`
    // against it. Bumping the conversation's text used to leave the project list
    // exactly as small as it was.
    <aside
      style={{ width, fontSize: 'var(--ui-font-size, 13px)' }}
      className="flex h-full shrink-0 flex-col bg-card border-r border-border/55"
    >
      {/* The wordmark sits here rather than only in the title bar: the rail is
          what you look at, and the title bar shows the chat's name. Search stays
          up there with the other window-level actions. */}
      {/* The mode toggle rides the wordmark row rather than sitting under it.
          Stacked, wordmark + toggle + tabs is three bars of chrome before any
          content; on one row it reads as a header and costs nothing. */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <span className="text-[1.08em] font-semibold tracking-tight text-foreground">Nyra</span>
        <ModeToggle />
      </div>

      <UpdateBadge />

      {/* Tabs — Chat mode only. A rail of chat tabs is no use beside a graph. */}
      {!flowMode && (
      <div className="mb-2 flex gap-0.5 px-2 pt-2">
        {(['sessions', 'skills', 'commands', 'memory'] as SidebarTab[]).map((tab) => {
          const label: Record<SidebarTab, string> = {
            sessions: 'Chats',
            skills: 'Skills',
            commands: 'Cmds',
            memory: 'Memory'
          }
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`min-w-0 flex-1 truncate rounded-md py-1.5 text-[0.85em] font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground/80 hover:bg-accent/50'
              }`}
            >
              {label[tab]}
            </button>
          )
        })}
      </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {flowMode ? (
          <FlowsList />
        ) : (
          <>
            {activeTab === 'sessions' && <SessionsList />}
            {activeTab === 'skills' && <SkillsList />}
            {activeTab === 'commands' && <CommandsList />}
            {activeTab === 'memory' && (
              <Suspense
                fallback={<div className="p-3 text-[0.85em] text-muted-foreground/70">Loading…</div>}
              >
                <MemoryTab />
              </Suspense>
            )}
          </>
        )}
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
      {activeTab === 'skills' && (
        <div className="p-2 border-t border-border/55 flex gap-1.5">
          <button
            onClick={() => useSkillEditorStore.getState().openNew()}
            className="flex-1 rounded-md bg-info/90 hover:bg-info py-1.5 text-[0.92em] font-medium text-info-foreground transition-colors"
          >
            + New
          </button>
          <button
            onClick={async () => {
              const filePath = await window.api.dialog.pickFile()
              if (!filePath) return
              const { content, error } = await window.api.fs.readFile(filePath)
              if (error || !content) return
              // Extract name from frontmatter if present, otherwise derive from filename
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
              let name: string | null = null
              if (fmMatch) {
                const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m)
                if (nameMatch) name = nameMatch[1].trim()
              }
              if (!name) {
                const parts = filePath.split('/')
                const fileName = parts[parts.length - 1]
                if (fileName.toLowerCase() === 'skill.md') {
                  name = parts[parts.length - 2] ?? 'imported-skill'
                } else {
                  name = fileName.replace(/\.md$/i, '')
                }
              }
              name = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'imported-skill'
              // If no frontmatter, open editor so user can add description
              if (!fmMatch) {
                const cwd = activeProjectCwd(useSessionsStore.getState()) || homedir()
                // Write the file first so the editor can load it
                await window.api.skills.write('project', name, content, cwd)
                window.dispatchEvent(new Event('nyra:skills-changed'))
                const projectDir = cwd + '/.claude/skills/' + name + '/SKILL.md'
                useSkillEditorStore.getState().openEdit({ name, scope: 'project', filePath: projectDir })
              } else {
                const cwd = activeProjectCwd(useSessionsStore.getState()) || homedir()
                await window.api.skills.write('project', name, content, cwd)
                window.dispatchEvent(new Event('nyra:skills-changed'))
              }
            }}
            className="flex-1 rounded-md border border-border bg-muted/40 hover:bg-accent py-1.5 text-[0.92em] font-medium text-foreground/80 hover:text-foreground transition-colors"
          >
            Import
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
                    ? 'bg-secondary font-semibold text-foreground shadow-2xs'
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
    <p className="px-2 mb-1.5 text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground/70">
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
            <span className="shrink-0 text-info/70">
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

function Spinner({ title }: { title: string }): React.JSX.Element {
  return (
    <span title={title} className="flex shrink-0 items-center">
      <LoaderCircle className="size-3 animate-spin text-warning/80" />
    </span>
  )
}

/**
 * A chat that is waiting on you, said in the list rather than only inside it.
 *
 * A spinner says Claude is busy. This says the opposite — it has stopped, and it
 * stopped on you. Without it the two look identical from the sidebar: quiet.
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
  const sessions = useSessionsStore((state) => state.sessions)
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

  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const pinned = sessions
    .filter((s) => s.favorite)
    .sort((a, b) => (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0))

  const knownProjects = new Set(projects.map((p) => p.id))
  const recents = sessions.filter(
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
    const isActive = session.id === activeSessionId
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
        className={`group relative flex items-center rounded-md transition-colors ${
          isActive ? 'bg-accent' : 'hover:bg-accent/50'
        } ${dragId === session.id ? 'opacity-40' : ''}`}
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
                className="flex items-center pl-1.5 cursor-grab active:cursor-grabbing text-muted-foreground/70 hover:text-foreground/80 transition-colors"
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
          onClick={() => setActiveSession(session.id)}
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
              {isRunning && <Spinner title="Agent running" />}
              <p className={`truncate text-[0.92em] ${unread ? 'font-medium text-foreground' : ''}`}>
                {session.title}
              </p>
              {waiting && <WaitingChip label={waiting} />}
              {!waiting && unread > 0 && (
                <span
                  title={`${unread} new message${unread === 1 ? '' : 's'}`}
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-info"
                />
              )}
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
                    : 'text-muted-foreground/70 hover:text-foreground/80 opacity-0 group-hover:opacity-100'
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
    const children = sessions.filter(
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
            <span className="text-[0.92em] truncate">{project.name}</span>
            {projectSpinner && <Spinner title="Agent running in this project" />}
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
                  className="p-1 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
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
            {hiddenCount > 0 && (
              <button
                onClick={() => setExpandedAll((prev) => new Set(prev).add(project.id))}
                className="py-1 pl-[27px] pr-2 text-[0.77em] text-muted-foreground/70 hover:text-foreground/80 transition-colors"
              >
                Show more ({hiddenCount})
              </button>
            )}
            {children.length === 0 && (
              <p className="py-1 pl-[27px] pr-2 text-[0.77em] text-muted-foreground/40">No chats yet</p>
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
            <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Pinned
            </span>
          </div>
          <div className="space-y-px">{pinned.map((s) => renderRow(s))}</div>
        </div>
      )}

      <div className="mb-2">
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground/70">
            Projects
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={addProject}
                className="p-0.5 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
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
            className="w-full px-2 py-1.5 text-left text-[0.85em] text-muted-foreground/70 hover:text-foreground/80 transition-colors"
          >
            Add a folder to get started
          </button>
        ) : (
          <div className="space-y-1.5">{projects.map(renderProject)}</div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[0.77em] font-semibold uppercase tracking-widest text-muted-foreground/70">
            Recents
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={newRecentChat}
                className="p-0.5 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
                aria-label="New chat with no project (runs in ~)"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New chat with no project (runs in ~)</TooltipContent>
          </Tooltip>
        </div>
        {recents.length === 0 ? (
          <p className="px-2 py-1 text-[0.77em] text-muted-foreground/40">Nothing outside a project</p>
        ) : (
          <div className="space-y-px">{recents.map((s) => renderRow(s))}</div>
        )}
      </div>
    </div>
  )
}

function SkillsList(): React.JSX.Element {
  const [skills, setSkills] = useState<{ global: SkillInfo[]; project: SkillInfo[] }>({ global: [], project: [] })
  const [search, setSearch] = useState('')
  // Skills Nyra installs into ~/.claude/skills. Marked in the list so a file
  // nobody wrote by hand explains where it came from.
  const [bundled, setBundled] = useState<BundledSkill[]>([])
  const setPendingAction = useSessionsStore((s) => s.setPendingAction)

  // Skills resolve against the project root, not the chat's cwd — a worktree chat
  // should still list and write the project's skills.
  const cwd = useSessionsStore(activeProjectCwd)

  const refresh = useCallback(() => {
    window.api.skills.list(cwd).then(setSkills)
  }, [cwd])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    window.api.skills.bundledNames().then(setBundled)
  }, [])

  useEffect(() => {
    window.addEventListener('nyra:skills-changed', refresh)
    return () => window.removeEventListener('nyra:skills-changed', refresh)
  }, [refresh])

  const filter = (list: SkillInfo[]): SkillInfo[] => {
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }

  const filteredProject = filter(skills.project)
  const filteredGlobal = filter(skills.global)
  const hasResults = filteredProject.length > 0 || filteredGlobal.length > 0

  const handleRun = useCallback((skill: SkillInfo) => {
    setPendingAction({ type: 'send', text: `/${skill.name}` })
  }, [setPendingAction])

  const handleEdit = useCallback((skill: SkillInfo) => {
    useSkillEditorStore.getState().openEdit(skill)
  }, [])

  const handleDelete = useCallback(async (skill: SkillInfo) => {
    await window.api.skills.delete(skill.filePath)
    window.dispatchEvent(new Event('nyra:skills-changed'))
  }, [])

  const handleExport = useCallback(async (skill: SkillInfo) => {
    const { content, error } = await window.api.fs.readFile(skill.filePath)
    if (error || !content) return
    await window.api.dialog.saveFile(`${skill.name}.md`, content)
  }, [])

  const handleRestore = useCallback(async (name: string) => {
    await window.api.skills.restoreBundled(name)
    window.dispatchEvent(new Event('nyra:skills-changed'))
  }, [])

  // Two states leave a Nyra skill off updates, and neither is visible anywhere
  // else: deleted (the backend records it and stops reinstalling) and edited
  // (the backend adopts it and stops writing). Both are one-way doors without
  // an offer to reinstall, and a silently stale skill is a bad surprise.
  const needsAttention = bundled.flatMap((b) => {
    const installed = skills.global.some((s) => s.name === b.name)
    // "not installed" rather than "removed": this row also shows in the moment
    // before the launch sync lands, when nothing has been removed.
    if (!installed) return [{ name: b.name, note: 'is not installed', action: 'Install' }]
    if (b.status === 'adopted')
      return [{ name: b.name, note: 'is edited, so updates stopped', action: 'Reset' }]
    return []
  })

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter skills…"
        className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[0.85em] text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
      />
      {filteredProject.length > 0 && (
        <div>
          <SectionLabel label="Project" />
          <div className="space-y-1">
            {filteredProject.map((skill) => (
              <SkillRow
                key={skill.filePath}
                skill={skill}
                managed={
                  skill.scope === 'global'
                    ? bundled.find((b) => b.name === skill.name)?.status
                    : undefined
                }
                onRun={handleRun}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onExport={handleExport}
              />
            ))}
          </div>
        </div>
      )}
      {filteredGlobal.length > 0 && (
        <div>
          <SectionLabel label="Global" />
          <div className="space-y-1">
            {filteredGlobal.map((skill) => (
              <SkillRow
                key={skill.filePath}
                skill={skill}
                managed={
                  skill.scope === 'global'
                    ? bundled.find((b) => b.name === skill.name)?.status
                    : undefined
                }
                onRun={handleRun}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onExport={handleExport}
              />
            ))}
          </div>
        </div>
      )}
      {!hasResults && (
        <p className="text-center text-[0.77em] text-muted-foreground/70 py-4">
          {search ? 'No matching skills' : 'No skills found'}
        </p>
      )}
      {!search &&
        needsAttention.map(({ name, note, action }) => (
          <div
            key={name}
            className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border/55 px-2.5 py-2"
          >
            <span className="truncate text-[0.77em] text-muted-foreground">
              Nyra&rsquo;s <span className="font-medium text-foreground/70">/{name}</span> {note}
            </span>
            <button
              onClick={() => handleRestore(name)}
              className="shrink-0 text-[0.77em] text-info/80 transition-colors hover:text-info"
            >
              {action}
            </button>
          </div>
        ))}
    </div>
  )
}

const SkillRow = React.memo(function SkillRow({
  skill,
  managed,
  onRun,
  onEdit,
  onDelete,
  onExport
}: {
  skill: SkillInfo
  /** Set when Nyra ships this skill; the value says whether it still updates it. */
  managed?: BundledSkill['status']
  onRun: (skill: SkillInfo) => void
  onEdit: (skill: SkillInfo) => void
  onDelete: (skill: SkillInfo) => void
  onExport: (skill: SkillInfo) => void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="group rounded-md border border-border/55 bg-muted/40 hover:bg-accent/50 px-2.5 py-2 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[0.92em] font-medium text-foreground/80">/{skill.name}</span>
          {managed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0 rounded-[3px] border border-border/70 px-1 py-px text-[0.62em] font-medium uppercase tracking-wide text-muted-foreground">
                  {managed === 'adopted' ? 'Nyra · yours' : 'Nyra'}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {managed === 'adopted'
                  ? 'Shipped by Nyra, then edited — so Nyra no longer updates it. Reset it below to go back to the current version.'
                  : 'Installed by Nyra and kept current. Edit it and it becomes yours — Nyra stops touching it.'}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5 text-[0.77em]">
            <span className="text-muted-foreground">Delete?</span>
            <button
              onClick={() => { onDelete(skill); setConfirmDelete(false) }}
              className="text-danger/80 hover:text-danger transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-muted-foreground hover:text-foreground/80 transition-colors"
            >
              No
            </button>
          </div>
        ) : (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
            <button
              onClick={() => onEdit(skill)}
              className="text-[0.77em] text-muted-foreground hover:text-foreground/80 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={() => onExport(skill)}
              className="text-[0.77em] text-muted-foreground hover:text-foreground/80 transition-colors"
            >
              Exp
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-[0.77em] text-muted-foreground hover:text-danger transition-colors"
            >
              Del
            </button>
            <button
              onClick={() => onRun(skill)}
              className="text-[0.77em] text-info/80 hover:text-info transition-colors"
            >
              Run
            </button>
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[0.77em] text-muted-foreground truncate">{skill.description}</p>
    </div>
  )
})

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
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-all hover:bg-accent hover:text-foreground/80 group-hover:opacity-100 focus-visible:opacity-100"
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
      <ContextMenuTrigger asChild>
      <Tooltip>
      <TooltipTrigger asChild>
      <button
        type="button"
        onClick={() => open(wf.id)}
        className={`flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left transition-colors ${
          indent ? 'pl-5' : 'pl-2'
        } ${
          currentWorkflow?.id === wf.id ? 'bg-accent' : 'hover:bg-accent/50'
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
            running ? 'text-info' : ended === 'failed' ? 'text-danger' : 'text-muted-foreground/60'
          }`}
        >
          {trigger && !running && !ended && <Timer className="size-[0.9em] shrink-0" />}
          <span className="truncate">{meta}</span>
        </span>
      </button>
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
      </ContextMenuTrigger>
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
        <ContextMenuLabel className="text-[0.7em] uppercase tracking-wider text-muted-foreground/70">
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
              <Folder className="size-[0.9em] shrink-0 text-muted-foreground/60" />
              <span className="truncate text-[0.85em] font-semibold text-foreground/70">
                {project.name}
              </span>
              {/* The count rides with the + rather than sitting there always:
                  the flows are listed directly underneath, so at rest it is
                  restating what you can already see. */}
              <span className="ml-auto text-[0.77em] tabular-nums text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100">
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
        <span className="text-[0.7em] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Any project
        </span>
        <span className="ml-auto text-[0.77em] tabular-nums text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100">
          {grouped.loose.length}
        </span>
        {addButton(null, 'any project')}
      </div>
      {grouped.loose.map((wf) => row(wf, false))}

      {workflows.length === 0 && (
        <p className="px-2 pt-3 text-[0.8em] leading-relaxed text-muted-foreground/60">
          No flows yet. Use <span className="text-foreground/70">+</span> on a project to make one
          there, or on <span className="text-foreground/70">Any project</span> for one that suits
          any repo.
        </p>
      )}
    </div>
  )
}

function CommandsList(): React.JSX.Element {
  const [search, setSearch] = useState('')

  const filtered = search.trim()
    ? BUILT_IN_COMMANDS.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.description.toLowerCase().includes(search.toLowerCase())
      )
    : BUILT_IN_COMMANDS

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter commands…"
        className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[0.85em] text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
      />
      {filtered.length > 0 ? (
        <div>
          <SectionLabel label="CLI Reference" />
          <p className="px-2 mb-1.5 text-[0.77em] text-muted-foreground/70">
            These commands work in the Claude Code CLI terminal, not in Nyra chat.
          </p>
          <div className="space-y-0.5">
            {filtered.map((cmd) => (
              <div
                key={cmd.name}
                className="rounded-md px-2 py-1.5"
              >
                <div className="text-[0.92em] font-mono text-muted-foreground">{cmd.name}</div>
                <div className="text-[0.77em] text-muted-foreground/70">{cmd.description}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-center text-[0.77em] text-muted-foreground/70 py-4">No matching commands</p>
      )}
    </div>
  )
}
