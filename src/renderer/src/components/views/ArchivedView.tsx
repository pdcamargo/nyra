import React, { useMemo, useState } from 'react'
import { Archive, GitBranch, Trash2, Undo2 } from 'lucide-react'
import {
  activeProject,
  archivedSessions,
  sortProjects,
  useSessionsStore,
  type Session
} from '../../store/sessions'
import { unarchiveChat } from '../../lib/archive'
import { useUiStore } from '../../store/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { EmptyNote, LibrarySearch, ProjectTabs, SectionHeading } from './Library'

/** "3d ago", "45m ago" — the same scale the memory list reads on. */
function archivedAgo(at: number): string {
  const diff = Date.now() - at
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  if (diff < min) return 'just now'
  if (diff < hr) return `${Math.floor(diff / min)}m ago`
  if (diff < day) return `${Math.floor(diff / hr)}h ago`
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`
  const d = new Date(at)
  return `on ${d.getMonth() + 1}/${d.getDate()}`
}

/** The whole path is noise; the tail is what names the directory you worked in. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

/**
 * One archived chat.
 *
 * A card rather than a sidebar row, because this is an index — you are looking
 * for a conversation you remember, not managing the ones you are working in.
 * The row is informational; Restore and Delete are separate, named controls.
 */
function ArchivedCard({
  session,
  projectName,
  busy,
  onRestore,
  onDelete
}: {
  session: Session
  projectName: string | null
  busy: boolean
  onRestore: () => void
  onDelete: () => void
}): React.JSX.Element {
  const where = projectName ? `${projectName} · ${shortPath(session.cwd)}` : shortPath(session.cwd)
  return (
    <div
      className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/55 bg-muted/40 px-2.5 py-2 text-left"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/70 ring-1 ring-border/60">
        <Archive className="size-3.5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-c-md font-medium text-foreground">{session.title}</span>
          {/* Says the click is not free: this one has a branch behind it, and
              bringing it back means a checkout before the chat can open. */}
          {session.worktreeSnapshotted && (
            <span className="flex shrink-0 items-center gap-1 rounded-[3px] border border-border/70 px-1 py-px text-[0.62em] uppercase tracking-wide text-muted-foreground">
              <GitBranch className="size-2.5" />
              Worktree
            </span>
          )}
        </span>
        <span className="block truncate text-c-sm text-muted-foreground">
          {where} · archived {archivedAgo(session.archivedAt ?? 0)}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            onClick={onRestore}
            aria-label={`Restore ${session.title}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Undo2 className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Restore chat</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete ${session.title}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Delete archived chat</TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * Conversations that were put away, grouped the way the Commands page groups
 * what it shows: everything with no project, then the projects themselves.
 *
 * A page rather than a section of the rail. An archive is somewhere you go
 * looking for one thing you remember, and the rail is a list of what you are
 * working on — the two want different amounts of room.
 */
export function ArchivedView({ projectId }: { projectId?: string | null }): React.JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const rawProjects = useSessionsStore((s) => s.projects)
  const projects = useMemo(() => sortProjects(rawProjects), [rawProjects])
  // The ui store owns which project the page is looking at — the rail's row and
  // a project's own menu both go through `openArchived`, so there is one answer
  // rather than two. The prop is the same value, for a router that would rather
  // pass it than read it.
  const stored = useUiStore((s) => s.archivedProjectId)
  const setStored = useUiStore((s) => s.openArchived)
  const activeProjectId = useSessionsStore((s) => activeProject(s)?.id ?? null)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null)
  const [deletePrompt, setDeletePrompt] = useState<Session | null>(null)

  const wanted = projectId !== undefined ? projectId : stored
  const known = new Set(projects.map((p) => p.id))
  const activeId =
    wanted && known.has(wanted)
      ? wanted
      : activeProjectId && known.has(activeProjectId)
        ? activeProjectId
        : (projects[0]?.id ?? null)

  const archived = useMemo(() => archivedSessions(sessions), [sessions])
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name] as const)),
    [projects]
  )
  const query = search.trim().toLowerCase()
  const projectNameOf = (session: Session): string | null =>
    session.projectId ? (projectNames.get(session.projectId) ?? null) : null

  const matching = (list: Session[]): Session[] =>
    !query
      ? list
      : list.filter((s) => {
          const project = projectNameOf(s) ?? ''
          return (
            s.title.toLowerCase().includes(query) ||
            s.cwd.toLowerCase().includes(query) ||
            project.toLowerCase().includes(query)
          )
        })

  // No project, or a project that has since been removed. Both are the page's
  // "Global" — the same bucket the Commands page means by it.
  const global = matching(archived.filter((s) => !s.projectId || !known.has(s.projectId)))
  const inProject = matching(archived.filter((s) => s.projectId === activeId))

  const restore = async (session: Session): Promise<void> => {
    setBusyId(session.id)
    setError(null)
    const result = await unarchiveChat(session.id)
    setBusyId(null)
    if (!result.ok) setError({ sessionId: session.id, message: result.error })
  }

  const list = (rows: Session[]): React.JSX.Element => (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {rows.map((s) => (
        <ArchivedCard
          key={s.id}
          session={s}
          projectName={projectNameOf(s)}
          busy={busyId === s.id}
          onRestore={() => void restore(s)}
          onDelete={() => setDeletePrompt(s)}
        />
      ))}
    </div>
  )

  const restoreError = (rows: Session[]): React.JSX.Element | null => {
    if (!error || !rows.some((s) => s.id === error.sessionId)) return null
    return (
      <p className="mt-2 text-c-sm text-danger">
        {error.message} The chat is still archived — try again.
      </p>
    )
  }

  return (
    // The same shell the other pages in this area use. Duplicated rather than
    // imported only because the shared one lives inside MainViews.
    <div className="scroll-auto-hide flex-1 overflow-y-scroll">
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header className="mb-6">
          <h1 className="flex items-center gap-2 text-[1.6em] font-semibold tracking-tight text-foreground">
            <Archive className="size-5 shrink-0 text-muted-foreground" />
            Archived
          </h1>
          <p className="mt-1 text-c-md text-muted-foreground">
            Conversations you put away. Nothing runs while one is here; its worktree was saved
            when it went.
          </p>
        </header>

        <LibrarySearch value={search} onChange={setSearch} placeholder="Search archived chats" />

        <section className="mb-8">
          <SectionHeading>Global</SectionHeading>
          {global.length > 0 ? (
            list(global)
          ) : (
            <EmptyNote>
              {query ? (
                'Nothing matches here.'
              ) : (
                <>Nothing yet. Chats that are not in a project land here.</>
              )}
            </EmptyNote>
          )}
          {restoreError(global)}
        </section>

        <section>
          <SectionHeading>By project</SectionHeading>
          <ProjectTabs
            projects={projects}
            activeId={activeId}
            onSelect={(id) => {
              setStored(id)
              setError(null)
            }}
          />
          {projects.length === 0 ? (
            <EmptyNote>Add a project and its archived chats show up here.</EmptyNote>
          ) : inProject.length > 0 ? (
            list(inProject)
          ) : (
            <EmptyNote>
              {query ? 'Nothing matches here.' : 'This project has nothing archived.'}
            </EmptyNote>
          )}
          {restoreError(inProject)}
        </section>
      </div>
      <AlertDialog open={deletePrompt !== null} onOpenChange={(open) => { if (!open) setDeletePrompt(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deletePrompt?.title ?? ''}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the chat from Nyra and discards any saved worktree snapshot. It cannot
              be restored from Archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deletePrompt) useSessionsStore.getState().deleteSession(deletePrompt.id)
                setDeletePrompt(null)
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ArchivedView
