import { useBrowserStore } from '../store/browser'
import { useProcessesStore } from '../store/processes'
import { useResourceDockStore } from '../store/resourceDock'
import { useRunningStore } from '../store/running'
import { findProject, useSessionsStore, type Session } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { useWorkspaceStore } from '../store/workspace'

export type ArchiveResult = { ok: true } | { ok: false; error: string }

/**
 * Open the Archived page, on one project when the caller named one.
 *
 * One call, so the page mounts already looking at the project whose menu was
 * clicked rather than spending a frame on the wrong one. `null` means "no
 * project in particular", and the page falls back to the active chat's.
 */
export function openArchivedChats(projectId: string | null = null): void {
  useUiStore.getState().openArchived(projectId)
}

/**
 * Everything this chat is running, stopped. Its transcript is not touched.
 *
 * Three things can be running for a chat and only one of them is the chat: the
 * Claude process, the shells Claude left behind (children of that process,
 * which is why they outlive a turn), and its browser context. All three are
 * memory, and putting a chat away is a claim about memory.
 */
async function stopChatWork(sessionId: string): Promise<ArchiveResult> {
  // The long-lived PTY. Killing it is what actually ends a turn in flight.
  try {
    await window.api.claude.dispose(sessionId)
  } catch (error) {
    return { ok: false, error: `Could not stop Claude: ${String(error)}` }
  }

  // Then the shells it started, which the PTY does not take with it.
  const shells = useProcessesStore.getState().bySession[sessionId] ?? []
  for (const proc of shells) {
    if (proc.status !== 'running' && proc.status !== 'orphaned') continue
    try {
      const stopped = await window.api.processes.kill(sessionId, proc.shellId)
      if (!stopped.ok) {
        return { ok: false, error: stopped.error || `Could not stop ${proc.shellId}.` }
      }
    } catch (error) {
      return { ok: false, error: `Could not stop ${proc.shellId}: ${String(error)}` }
    }
  }
  useProcessesStore.getState().clearSession(sessionId)

  // And the browser. Its rows go with it; file tabs stay, because they are just
  // paths and they are what you had open when you put the chat down.
  try {
    await window.api.browser.closeChat(sessionId)
  } catch {
    /* never had one */
  }
  useBrowserStore.getState().forget(sessionId)
  useWorkspaceStore.getState().reconcile(sessionId, [])

  // A /mcp or /status card open above the composer belongs to the chat that is
  // running; there is nothing left for it to describe.
  useResourceDockStore.getState().forget(sessionId)

  // The spinner too, or an archived row keeps shimmering where nothing runs.
  useRunningStore.getState().forget(sessionId)
  return { ok: true }
}

/**
 * Snapshot and remove the chat's managed worktree, if it has one.
 *
 * Nothing is written to the session until both halves have succeeded, so a
 * failed snapshot leaves the chat exactly as it was — in the rail, with its
 * worktree record, which is the only handle left on the directory. Removal is
 * held to the same bar: the record is what lets the next attempt find the
 * directory again.
 */
async function retireForArchive(session: Session): Promise<ArchiveResult> {
  const wt = session.worktree
  // A permanent worktree is shared with other chats. Same rule as deleting: it
  // belongs to the project, not to this conversation.
  if (!wt || wt.permanent) return { ok: true }

  const snapshot = await window.api.git.worktreeSnapshot(wt.path, wt.branch, session.id)
  if (!snapshot.success) {
    return { ok: false, error: snapshot.error || 'Could not save the worktree before archiving.' }
  }
  const removed = await window.api.git.worktreeRemove(wt.path, wt.path)
  if (!removed.success) {
    return { ok: false, error: removed.error || 'Could not remove the worktree.' }
  }

  const store = useSessionsStore.getState()
  store.setWorktree(session.id, null)
  store.setWorktreeSnapshotted(session.id, true)
  return { ok: true }
}

/**
 * Put a chat away.
 *
 * A running turn is stopped before snapshotting so no process can write a file
 * halfway through the snapshot. A failed snapshot or removal leaves the chat
 * unarchived, with its worktree record and a retry path.
 */
export async function archiveChat(sessionId: string): Promise<ArchiveResult> {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, error: 'That chat is gone.' }
  if (session.archivedAt) return { ok: true }

  const stopped = await stopChatWork(sessionId)
  if (!stopped.ok) return stopped

  const retired = await retireForArchive(session)
  if (!retired.ok) return retired

  useSessionsStore.getState().setArchivedAt(sessionId, Date.now())
  return { ok: true }
}

/**
 * Bring a chat back.
 *
 * Restores before clearing the flag, in that order on purpose: a chat whose
 * worktree failed to come back stays archived and stays retryable, and the
 * caller gets the error to show. Clearing first would leave an open conversation
 * pointing at a directory that is not there, with nothing left to retry from.
 */
export async function unarchiveChat(sessionId: string): Promise<ArchiveResult> {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, error: 'That chat is gone.' }
  if (!session.archivedAt) return { ok: true }

  if (session.worktreeSnapshotted) {
    const project = findProject(useSessionsStore.getState(), session.projectId)
    if (!project) {
      return { ok: false, error: 'This chat has no project to restore its worktree into.' }
    }
    const restored = await window.api.git.worktreeRestore(project.path, sessionId)
    if (!restored.success || !restored.path || !restored.branch) {
      return { ok: false, error: restored.error || 'Could not restore the worktree.' }
    }

    const store = useSessionsStore.getState()
    store.setWorktree(sessionId, {
      name: restored.branch,
      branch: restored.branch,
      path: restored.path
    })
    store.updateSessionCwd(sessionId, restored.path)
    store.setWorktreeSnapshotted(sessionId, false)
    void window.api.git.snapshotDiscard(sessionId)
  }

  useSessionsStore.getState().setArchivedAt(sessionId, null)
  return { ok: true }
}
