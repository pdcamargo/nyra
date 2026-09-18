/**
 * "Open this file" — the one answer to it.
 *
 * Its own module rather than a method on the workspace store, because the store
 * is already imported *by* `sessions` (a deleted chat forgets its tabs) and
 * reaching back the other way would make the two mutually dependent for the
 * sake of one function. This sits downstream of both.
 */
import { cwdForSession, useSessionsStore } from '../store/sessions'
import { useUiStore } from '../store/ui'
import {
  activeTab,
  tabKey,
  useWorkspaceStore,
  workspaceFor
} from '../store/workspace'
import { resolvePath } from '../utils/paths'

/**
 * Show a file in the side panel.
 *
 * Replaces the file-preview modal, so there is one answer to "open this file"
 * rather than two surfaces that would drift. Takes a path straight out of
 * Claude's output, which may be relative — `resolvePath` is the existing rule
 * for that and stays the only copy of it.
 *
 * Reuses a tab rather than stacking them up: clicking five paths in a row is
 * five looks at the transcript, not a request for five tabs. Same idiom as
 * picking a file in the tree.
 */
export function openFileInPanel(filePath: string): void {
  const sessions = useSessionsStore.getState()
  const sessionId = sessions.activeSessionId
  if (!sessionId) return

  const absolute = resolvePath(filePath, cwdForSession(sessions, sessionId))
  const store = useWorkspaceStore.getState()
  const ws = workspaceFor(store, sessionId)

  useUiStore.getState().setRightPanelOpen(true)

  const already = ws.tabs.find((t) => t.kind === 'file' && t.path === absolute)
  if (already) return store.selectTab(sessionId, tabKey(already))

  const active = activeTab(ws)
  if (active?.kind === 'file') {
    store.setFilePath(sessionId, active.id, absolute)
    return store.selectTab(sessionId, tabKey(active))
  }

  store.openFileTab(sessionId, absolute)
}
