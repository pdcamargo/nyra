import type { Project, Session } from './sessions'

/** `/a/b/repo` → `repo`; tolerates trailing slashes and a bare `/`. */
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path || 'project'
}

/** `/a/b/repo` → `b/repo`, the disambiguator when two projects share a basename. */
export function qualifiedName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return basename(path)
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

/**
 * A display name for `path` that no existing project already uses.
 *
 * Two checkouts of the same repo under different parents are the common case
 * (`~/work/api` and `~/oss/api`), and two rows both reading `api` would be
 * unusable.
 */
export function nameForPath(path: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const short = basename(path)
  if (!used.has(short)) return short
  const qualified = qualifiedName(path)
  if (!used.has(qualified)) return qualified
  for (let n = 2; ; n++) {
    const candidate = `${qualified} (${n})`
    if (!used.has(candidate)) return candidate
  }
}

export type BackfillResult = { sessions: Session[]; projects: Project[] }

/**
 * Give every pre-projects session a home.
 *
 * Runs inside the persist `merge`, so it has to be synchronous and cannot ask git
 * anything. Sessions whose `cwd` is a worktree are therefore left alone here —
 * their cwd is the worktree directory, not the project root, and grouping by it
 * would mint a bogus project per worktree. `attachWorktreeSessions` picks those
 * up after hydration, once `window.api` is reachable.
 *
 * Sessions with no `cwd` at all stay unassigned on purpose: they become Recents.
 */
export function backfillProjects(sessions: Session[], existing: Project[]): BackfillResult {
  const projects = [...existing]
  const byPath = new Map(projects.map((p) => [p.path, p]))
  let changed = false

  const next = sessions.map((session) => {
    if (session.projectId || !session.cwd || session.worktree) return session
    let project = byPath.get(session.cwd)
    if (!project) {
      project = {
        id: crypto.randomUUID(),
        name: nameForPath(session.cwd, projects.map((p) => p.name)),
        path: session.cwd,
        order: projects.length
      }
      projects.push(project)
      byPath.set(project.path, project)
    }
    changed = true
    return { ...session, projectId: project.id }
  })

  return changed ? { sessions: next, projects } : { sessions, projects }
}
