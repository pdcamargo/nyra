import { useSessionsStore } from './sessions'
import { nameForPath } from './projects-migration'

/**
 * Finish the projects backfill for worktree chats.
 *
 * A worktree chat's `cwd` is the worktree directory, not the project root, so the
 * synchronous migration in the store's `merge` deliberately skips it — grouping by
 * cwd there would mint one bogus project per worktree. Asking git which working
 * tree is the main one is the only reliable answer, and it can't happen inside
 * `merge`, so it happens here, once, right after hydration.
 *
 * Failures are survivable by design: a chat whose repo has since been deleted just
 * stays in Recents rather than blocking startup.
 */
export async function attachWorktreeSessions(): Promise<void> {
  const pending = useSessionsStore
    .getState()
    .sessions.filter((s) => !s.projectId && s.worktree && s.cwd)

  if (pending.length === 0) return

  // One lookup per distinct directory — several chats often share a worktree.
  const roots = new Map<string, string | null>()
  for (const session of pending) {
    if (roots.has(session.cwd)) continue
    try {
      roots.set(session.cwd, await window.api.git.mainWorktreeRoot(session.cwd))
    } catch {
      roots.set(session.cwd, null)
    }
  }

  useSessionsStore.setState((state) => {
    const projects = [...state.projects]
    const byPath = new Map(projects.map((p) => [p.path, p]))
    let changed = false

    const sessions = state.sessions.map((session) => {
      if (session.projectId || !session.worktree) return session
      const root = roots.get(session.cwd)
      if (!root) return session

      let project = byPath.get(root)
      if (!project) {
        project = {
          id: crypto.randomUUID(),
          name: nameForPath(root, projects.map((p) => p.name)),
          path: root,
          order: projects.length
        }
        projects.push(project)
        byPath.set(root, project)
      }
      changed = true
      return { ...session, projectId: project.id }
    })

    return changed ? { sessions, projects } : state
  })
}
