import { useSessionsStore, findProject, type PendingWorktree, type Session } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { useRunningStore } from '../store/running'

/**
 * A branch name nobody has to think about.
 *
 * Codex sidesteps naming entirely by using detached HEAD, but Nyra's Merge action
 * needs a real branch, so one gets generated up front and stays editable in the
 * composer. Dated rather than derived from the prompt: the worktree is created
 * before the first message exists.
 */
export function defaultBranchName(now: Date = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
  const suffix = Math.random().toString(36).slice(2, 6)
  return `nyra/${stamp}-${suffix}`
}

export function newPendingWorktree(): PendingWorktree {
  return { branch: defaultBranchName(), baseRef: '', seed: true }
}

/** Managed worktree chats, oldest first — the order the cap prunes in. */
export function prunableSessions(sessions: Session[], running: Record<string, true>): Session[] {
  return sessions
    .filter((s) => s.worktree && !s.worktree.permanent)
    // Codex's three protections, and the reason "Pinned" earns its name: a pinned
    // chat, a chat still working, and a permanent worktree are all off limits.
    .filter((s) => !s.favorite)
    .filter((s) => running[s.id] !== true)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** How many managed worktrees exist right now, protected ones included. */
export function managedCount(sessions: Session[]): number {
  return sessions.filter((s) => s.worktree && !s.worktree.permanent).length
}

/**
 * Snapshot a chat's managed worktree, then remove it.
 *
 * The snapshot is what makes automatic deletion acceptable — reopening the chat
 * offers to bring the work back. Removal failing is not fatal: the chat keeps its
 * worktree record, which is the only handle left on a directory still on disk.
 */
export async function retireWorktree(session: Session): Promise<boolean> {
  const wt = session.worktree
  if (!wt) return false
  try {
    const snap = await window.api.git.worktreeSnapshot(wt.path, wt.branch, session.id)
    const removed = await window.api.git.worktreeRemove(wt.path, wt.path)
    if (!removed.success) return false
    const store = useSessionsStore.getState()
    store.setWorktree(session.id, null)
    store.setWorktreeSnapshotted(session.id, snap.success === true)
    return true
  } catch {
    return false
  }
}

/**
 * Keep the number of managed worktrees at or under the configured limit.
 *
 * Returns how many were retired. Does nothing when auto-deletion is off, and
 * never touches a pinned, running or permanent worktree even if that means
 * staying over the limit — going over is better than deleting work someone is
 * plainly still using.
 */
export async function pruneManagedWorktrees(): Promise<number> {
  const { worktreeLimit, worktreeAutoDelete } = useSettingsStore.getState()
  if (!worktreeAutoDelete || worktreeLimit <= 0) return 0

  const { sessions } = useSessionsStore.getState()
  const over = managedCount(sessions) - worktreeLimit
  if (over <= 0) return 0

  const candidates = prunableSessions(sessions, useRunningStore.getState().running).slice(0, over)
  let retired = 0
  for (const session of candidates) {
    if (await retireWorktree(session)) retired += 1
  }
  return retired
}

export type MaterializeResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Turn a composer choice into a real worktree.
 *
 * Deferred to the first send rather than done on selection, so clicking through
 * the options doesn't litter `~/.nyra/worktrees` with directories for chats that
 * were never used.
 */
export async function materializeWorktree(sessionId: string): Promise<MaterializeResult> {
  const state = useSessionsStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  const pending = session?.pendingWorktree
  if (!session || !pending) return { ok: false, error: 'Nothing to create' }

  const project = findProject(state, session.projectId)
  const base = project?.path ?? session.cwd
  if (!base) return { ok: false, error: 'This chat has no project to branch from' }

  const branch = pending.branch.trim() || defaultBranchName()
  try {
    const result = await window.api.git.worktreeCreateManaged(
      base,
      branch,
      pending.baseRef || null,
      pending.seed
    )
    if (result.error || !result.path) {
      return { ok: false, error: result.error || 'Could not create the worktree' }
    }

    const store = useSessionsStore.getState()
    store.setWorktree(sessionId, { name: branch, branch: result.branch, path: result.path })
    store.updateSessionCwd(sessionId, result.path)
    store.setGitInfo(sessionId, { isGitRepo: true, branch: result.branch })
    store.setPendingWorktree(sessionId, null)

    // Enforce the cap after adding, not before — the new one counts.
    void pruneManagedWorktrees()

    return { ok: true, path: result.path }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** Bring a pruned worktree back from its snapshot. */
export async function restoreWorktree(sessionId: string): Promise<MaterializeResult> {
  const state = useSessionsStore.getState()
  const session = state.sessions.find((s) => s.id === sessionId)
  const project = findProject(state, session?.projectId)
  if (!session || !project) return { ok: false, error: 'This chat has no project' }

  try {
    const result = await window.api.git.worktreeRestore(project.path, sessionId)
    if (!result.success || !result.path || !result.branch) {
      return { ok: false, error: result.error || 'Could not restore the worktree' }
    }
    const store = useSessionsStore.getState()
    store.setWorktree(sessionId, { name: result.branch, branch: result.branch, path: result.path })
    store.updateSessionCwd(sessionId, result.path)
    store.setWorktreeSnapshotted(sessionId, false)
    void window.api.git.snapshotDiscard(sessionId)
    return { ok: true, path: result.path }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** Create a long-lived worktree shared by several chats, from the project menu. */
export async function createPermanentWorktree(
  projectPath: string,
  branch: string
): Promise<MaterializeResult> {
  try {
    const result = await window.api.git.worktreeCreateManaged(projectPath, branch, null, true)
    if (result.error || !result.path) {
      return { ok: false, error: result.error || 'Could not create the worktree' }
    }
    return { ok: true, path: result.path }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
