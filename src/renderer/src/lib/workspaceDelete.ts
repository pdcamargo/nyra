/**
 * Deleting a workspace.
 *
 * Its chats are never deleted with it: they move to a target workspace and
 * carry on under that account, history and memory included. What is deleted is
 * the account's own data — its login, settings, skills and transcripts — once
 * a copy of everything a chat could need is safely in the target.
 *
 * Each step starts only if the one before it succeeded, and the first one is
 * the only one that can fail with nothing to show for it. Running turns block
 * the whole thing: a turn is never cancelled to delete.
 */
import { DEFAULT_WORKSPACE_ID, findWorkspace, useWorkspacesStore } from '../store/workspaces'
import { projectsInWorkspace, sessionsInWorkspace, useSessionsStore } from '../store/sessions'
import { anyRunning, useRunningStore } from '../store/running'
import { useTerminalsStore } from '../store/terminals'
import { useRateLimitStore } from '../store/rateLimit'
import { useAccountsStore } from '../store/accounts'

/** What deleting `workspaceId` would touch — the counts the dialog states. */
export type DeletePlan = {
  projects: number
  /** Archived ones too: they move with the rest. */
  chats: number
  /** Chats with a turn in flight. Any at all blocks the delete. */
  running: number
  /** Open terminals started under it, which will be closed. */
  terminals: number
}

export function planDelete(workspaceId: string): DeletePlan {
  const state = useSessionsStore.getState()
  const chats = sessionsInWorkspace(state, state.sessions, workspaceId)
  const running = useRunningStore.getState().running
  const terminals = Object.values(useTerminalsStore.getState().byProject)
    .flatMap((panel) => panel.tabs)
    .filter((tab) => tab.workspaceId === workspaceId).length
  return {
    projects: projectsInWorkspace(state.projects, workspaceId).length,
    chats: chats.length,
    running: chats.filter((s) => running[s.id]).length,
    terminals
  }
}

export type DeleteOutcome = { ok: true; warning?: string } | { ok: false; error: string }

export async function deleteWorkspace(workspaceId: string, targetId: string): Promise<DeleteOutcome> {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return { ok: false, error: "The Default workspace can't be deleted." }
  const workspace = findWorkspace(workspaceId)
  const target = findWorkspace(targetId)
  if (!workspace) return { ok: false, error: 'That workspace no longer exists.' }
  if (!target || target.id === workspace.id) return { ok: false, error: 'Choose another workspace for its chats.' }

  const sessions = useSessionsStore.getState()
  const chatIds = sessionsInWorkspace(sessions, sessions.sessions, workspace.id).map((s) => s.id)
  const running = chatIds.filter((id) => anyRunning(useRunningStore.getState().running, [id])).length
  if (running > 0) {
    return { ok: false, error: `${running} ${running === 1 ? 'chat is' : 'chats are'} still running.` }
  }

  // 1. Every conversation and memory note, copied into the target now: the
  //    source is about to disappear, so there is nothing to copy from later.
  const copied = await window.api.workspace
    .copyTranscripts(workspace.id, target.configDir)
    .catch((e: unknown) => ({ ok: false, error: String(e) }))
  if (!copied.ok) {
    return { ok: false, error: `Nothing was changed: copying its conversations failed. ${copied.error ?? ''}`.trim() }
  }

  // 2. Its projects and chats become the target's. An idle chat's process is
  //    let go, so its next send respawns under the target's account.
  useSessionsStore.getState().reassignWorkspace(workspace.id, target.id)
  await Promise.all(chatIds.map((id) => window.api.claude.dispose(id).catch(() => undefined)))

  // 3. Every shell started under it. One left open would bring the directory
  //    back the next time `claude` ran in it.
  for (const id of useTerminalsStore.getState().closeStartedUnder(workspace.id)) {
    void Promise.resolve(window.api.terminal.kill(id)).catch(() => undefined)
  }

  // 4. Sign the account out. Deleting the folder alone would leave a login the
  //    OS keeps elsewhere — the macOS Keychain — behind.
  let warning: string | undefined
  const signedOut = await window.api.workspace
    .logout(workspace.configDir)
    .catch((e: unknown) => ({ ok: false, error: String(e) }))
  if (!signedOut.ok) {
    warning = `${workspace.name} could not be signed out${signedOut.error ? ` (${signedOut.error})` : ''}, so its login may still be stored.`
  }

  // 5. The directory, by id: Rust works out the path and refuses anything that
  //    is not a real directory inside ~/.nyra/workspaces.
  const deleted = await window.api.workspace
    .delete(workspace.id)
    .catch((e: unknown) => ({ ok: false, error: String(e) }))
  if (!deleted.ok) {
    return {
      ok: false,
      error: `Its chats are now in ${target.name}, but its folder could not be deleted. ${deleted.error ?? ''}`.trim()
    }
  }

  // 6. What was remembered about it. If it was on screen, the target is now —
  //    with the same chat open, since that chat is the target's now.
  useRateLimitStore.getState().clear(workspace.id)
  useAccountsStore.getState().forget(workspace.id)
  const workspaces = useWorkspacesStore.getState()
  if (workspaces.activeId === workspace.id) {
    workspaces.setActive(target.id)
    void useAccountsStore.getState().refresh(target.id)
  }
  useWorkspacesStore.getState().remove(workspace.id)
  return warning ? { ok: true, warning } : { ok: true }
}
