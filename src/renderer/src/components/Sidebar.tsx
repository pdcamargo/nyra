import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useSessionsStore, activeProjectCwd, sortProjects } from '../store/sessions'
import type { Project, Session } from '../store/sessions'
import { usePlanApprovalStore } from '../store/planApprovals'
import { useRunningStore, projectSpinnerVisible } from '../store/running'
import { useSkillEditorStore } from '../store/skillEditor'
import { useWorkflowStore } from '../store/workflow'
import { usePanelLayoutStore } from '../store/panelLayout'
import { Folder, FolderOpen, GitBranch, GripVertical, LoaderCircle, MoreHorizontal, Pencil, Plus, SquarePen, Star, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './ui/context-menu'
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
import { createPermanentWorktree, defaultBranchName } from '../lib/worktrees'
import type { WorkflowDefinition } from '../../../shared/workflow-types'

type Tab = 'sessions' | 'skills' | 'commands' | 'workflows'

export default function Sidebar(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('sessions')
  // shrink-0 because the width has to stay what the user set: flex would
  // otherwise squeeze this rail on a narrow window and --rail would start lying.
  const width = usePanelLayoutStore((s) => s.sidebarWidth)

  return (
    <aside style={{ width }} className="flex h-full shrink-0 flex-col bg-card border-r border-border/55">
      {/* No title and no search button: the title bar carries the app's identity
          now, and search moved up there next to the other window-level actions. */}

      {/* Tabs */}
      <div className="flex px-2 pt-2 gap-0.5 mb-2">
        {(['sessions', 'skills', 'commands', 'workflows'] as Tab[]).map((tab) => {
          const label: Record<Tab, string> = {
            sessions: 'Sessions',
            skills: 'Skills',
            commands: 'Cmds',
            workflows: 'Flows'
          }
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {activeTab === 'sessions' && <SessionsList />}
        {activeTab === 'skills' && <SkillsList />}
        {activeTab === 'commands' && <CommandsList />}
        {activeTab === 'workflows' && <WorkflowsList />}
      </div>

      {activeTab === 'workflows' && (
        <div className="p-2 border-t border-border/55 flex gap-1.5">
          <button
            onClick={() => {
              const { openCanvas, setCurrentWorkflow } = useWorkflowStore.getState()
              const id = `wf-${Date.now()}`
              setCurrentWorkflow({
                id,
                name: 'New Workflow',
                nodes: [],
                edges: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
              })
              openCanvas()
            }}
            className="flex-1 rounded-md bg-info/90 hover:bg-info py-1.5 text-xs font-medium text-info-foreground transition-colors"
          >
            + New
          </button>
          <button
            onClick={() => {
              const { openCanvas, setCurrentWorkflow } = useWorkflowStore.getState()
              setCurrentWorkflow(null) // will show templates view
              openCanvas()
            }}
            className="flex-1 rounded-md border border-border bg-muted/40 hover:bg-accent py-1.5 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors"
          >
            Templates
          </button>
        </div>
      )}
      {activeTab === 'skills' && (
        <div className="p-2 border-t border-border/55 flex gap-1.5">
          <button
            onClick={() => useSkillEditorStore.getState().openNew()}
            className="flex-1 rounded-md bg-info/90 hover:bg-info py-1.5 text-xs font-medium text-info-foreground transition-colors"
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
            className="flex-1 rounded-md border border-border bg-muted/40 hover:bg-accent py-1.5 text-xs font-medium text-foreground/80 hover:text-foreground transition-colors"
          >
            Import
          </button>
        </div>
      )}
    </aside>
  )
}

function SectionLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
      {label}
    </p>
  )
}

/** How many chats a project shows before `Show more`. */
const VISIBLE_PER_PROJECT = 6

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
    <span className="shrink-0 rounded-sm bg-info/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-info">
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
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
            />
          </div>
        ) : (
          <>
            <DropdownMenuLabel className="pb-0">{project.name}</DropdownMenuLabel>
            <p className="px-2 pb-1.5 font-mono text-[10px] break-all text-muted-foreground">
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
          <div
            draggable
            onDragStart={() => setDragId(session.id)}
            onDragEnd={() => {
              setDragId(null)
              setDragOverId(null)
            }}
            className="flex items-center pl-1.5 cursor-grab active:cursor-grabbing text-muted-foreground/70 hover:text-foreground/80 transition-colors"
            title="Drag to reorder"
          >
            <GripVertical className="size-2.5" />
          </div>
        )}
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
              className="w-full bg-transparent text-xs text-foreground outline-hidden border-b border-info/50"
            />
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              {isRunning && <Spinner title="Agent running" />}
              <p className="text-xs truncate">{session.title}</p>
              {waiting && <WaitingChip label={waiting} />}
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-0.5">
            {opts.showFolder !== false && session.cwd && (
              <span className="text-[10px] text-muted-foreground/70 font-mono truncate">
                {session.cwd.split('/').pop()}
              </span>
            )}
            {session.branch && (
              <span className={`text-[9px] font-mono px-1 py-0.5 rounded shrink-0 ${
                session.worktree
                  ? 'bg-info/15 text-info/60'
                  : 'bg-accent/50 text-muted-foreground/70'
              }`}>
                {session.branch}
              </span>
            )}
            {session.worktree && (
              <span className="text-[8px] font-medium text-info/40 shrink-0">wt</span>
            )}
            {session.forkOf && (
              <span className="text-[9px] font-medium text-muted-foreground shrink-0" title={`Forked from "${session.forkOf.title}"`}>⑂</span>
            )}
          </div>
        </button>
        <div className="flex items-center shrink-0 pr-1.5">
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
            title={isPinned ? 'Unpin' : 'Pin'}
          >
            <Star className="size-3.5" />
          </button>
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
            <span className="text-xs truncate">{project.name}</span>
            {projectSpinner && <Spinner title="Agent running in this project" />}
          </button>
          <div className="flex items-center shrink-0 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <ProjectMenu project={project} />
            <button
              onClick={(e) => {
                e.stopPropagation()
                newChatIn(project)
              }}
              className="p-1 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
              title={`New chat in ${project.name}`}
            >
              <SquarePen className="size-3.5" />
            </button>
          </div>
        </div>
        {!collapsed && (
          <>
            {visible.map((s) => renderRow(s, { indented: true, showFolder: false }))}
            {hiddenCount > 0 && (
              <button
                onClick={() => setExpandedAll((prev) => new Set(prev).add(project.id))}
                className="py-1 pl-[27px] pr-2 text-[10px] text-muted-foreground/70 hover:text-foreground/80 transition-colors"
              >
                Show more ({hiddenCount})
              </button>
            )}
            {children.length === 0 && (
              <p className="py-1 pl-[27px] pr-2 text-[10px] text-muted-foreground/40">No chats yet</p>
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
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Pinned
            </span>
          </div>
          <div className="space-y-px">{pinned.map((s) => renderRow(s))}</div>
        </div>
      )}

      <div className="mb-2">
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
            Projects
          </span>
          <button
            onClick={addProject}
            className="p-0.5 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
            title="Add project"
          >
            <Plus className="size-3" />
          </button>
        </div>
        {projects.length === 0 ? (
          <button
            onClick={addProject}
            className="w-full px-2 py-1.5 text-left text-[11px] text-muted-foreground/70 hover:text-foreground/80 transition-colors"
          >
            Add a folder to get started
          </button>
        ) : (
          <div className="space-y-1.5">{projects.map(renderProject)}</div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between px-2 mb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
            Recents
          </span>
          <button
            onClick={newRecentChat}
            className="p-0.5 text-muted-foreground/70 hover:text-foreground/80 transition-colors"
            title="New chat with no project (runs in ~)"
          >
            <Plus className="size-3" />
          </button>
        </div>
        {recents.length === 0 ? (
          <p className="px-2 py-1 text-[10px] text-muted-foreground/40">Nothing outside a project</p>
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

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter skills…"
        className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
      />
      {filteredProject.length > 0 && (
        <div>
          <SectionLabel label="Project" />
          <div className="space-y-1">
            {filteredProject.map((skill) => (
              <SkillRow
                key={skill.filePath}
                skill={skill}
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
        <p className="text-center text-[10px] text-muted-foreground/70 py-4">
          {search ? 'No matching skills' : 'No skills found'}
        </p>
      )}
    </div>
  )
}

const SkillRow = React.memo(function SkillRow({
  skill,
  onRun,
  onEdit,
  onDelete,
  onExport
}: {
  skill: SkillInfo
  onRun: (skill: SkillInfo) => void
  onEdit: (skill: SkillInfo) => void
  onDelete: (skill: SkillInfo) => void
  onExport: (skill: SkillInfo) => void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="group rounded-md border border-border/55 bg-muted/40 hover:bg-accent/50 px-2.5 py-2 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground/80">/{skill.name}</span>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5 text-[10px]">
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
              className="text-[10px] text-muted-foreground hover:text-foreground/80 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={() => onExport(skill)}
              className="text-[10px] text-muted-foreground hover:text-foreground/80 transition-colors"
            >
              Exp
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-[10px] text-muted-foreground hover:text-danger transition-colors"
            >
              Del
            </button>
            <button
              onClick={() => onRun(skill)}
              className="text-[10px] text-info/80 hover:text-info transition-colors"
            >
              Run
            </button>
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground truncate">{skill.description}</p>
    </div>
  )
})

function WorkflowsList(): React.JSX.Element {
  const { workflows, setWorkflows, setCurrentWorkflow, openCanvas, setExecution } =
    useWorkflowStore()

  useEffect(() => {
    window.api.workflow.list().then((wfs) => setWorkflows(wfs as WorkflowDefinition[]))
  }, [])

  const handleOpen = async (id: string): Promise<void> => {
    const wf = (await window.api.workflow.load(id)) as WorkflowDefinition | null
    if (wf) {
      setCurrentWorkflow(wf)
      setExecution(null)
      openCanvas()
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.api.workflow.delete(id)
    const wfs = await window.api.workflow.list()
    setWorkflows(wfs as WorkflowDefinition[])
  }

  if (workflows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <p className="text-[11px] text-muted-foreground/70 text-center mb-3">
          No saved workflows yet
        </p>
        <p className="text-[10px] text-muted-foreground/40 text-center">
          Create a new workflow or start from a template
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {workflows.map((wf) => (
        <div
          key={wf.id}
          className="group flex items-center rounded-md px-2 py-2 hover:bg-muted/40 cursor-pointer transition-colors"
          onClick={() => handleOpen(wf.id)}
        >
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground/80 truncate">{wf.name}</div>
            <div className="text-[10px] text-muted-foreground/70">
              {wf.nodes.length} nodes
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDelete(wf.id)
            }}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground/70 hover:text-danger text-xs transition-opacity ml-1"
            title="Delete workflow"
          >
            ×
          </button>
        </div>
      ))}
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
        className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
      />
      {filtered.length > 0 ? (
        <div>
          <SectionLabel label="CLI Reference" />
          <p className="px-2 mb-1.5 text-[10px] text-muted-foreground/70">
            These commands work in the Claude Code CLI terminal, not in Nyra chat.
          </p>
          <div className="space-y-0.5">
            {filtered.map((cmd) => (
              <div
                key={cmd.name}
                className="rounded-md px-2 py-1.5"
              >
                <div className="text-xs font-mono text-muted-foreground">{cmd.name}</div>
                <div className="text-[10px] text-muted-foreground/70">{cmd.description}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-center text-[10px] text-muted-foreground/70 py-4">No matching commands</p>
      )}
    </div>
  )
}
