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
import { usePanelSizesStore } from '../store/panelSizes'
import { useChangesStore, type ChangeScope } from '../store/changes'
import {
  activeTab,
  tabKey,
  useWorkspaceStore,
  workspaceFor
} from '../store/workspace'
import { resolvePath } from '../utils/paths'

/**
 * Wide enough for a diff.
 *
 * The panel ships at 256, and `treeFits` wants 280 — so at the default the tree
 * can never appear and a code line is cut off around column 35. A row list reads
 * fine that narrow; a diff does not. Opening the tab is the moment to fix that.
 */
export const CHANGES_MIN_WIDTH = 420

/**
 * Wide enough for prose.
 *
 * A plan is paragraphs and bullets, not code, and it is the thing the panel
 * exists to make readable — the whole reason it stopped living in a 45vh sliver
 * above the composer. A little more than a diff needs.
 */
export const PLAN_MIN_WIDTH = 480

/**
 * Wide enough for an agent at work.
 *
 * Same as a plan, for the same reason: it is prose with tool trace lines
 * threaded through it. The Pinned Summary already shows this at 308px and that
 * is exactly why it can only show one line each — this is the surface where
 * there is room to read.
 */
export const SUBAGENTS_MIN_WIDTH = 480

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

/**
 * Show the repo's changes in the side panel.
 *
 * `focusPath` opens that file's row once the list arrives — a click on a card row
 * in the transcript, which should land you on the diff rather than on a list you
 * then have to search.
 *
 * `scope` is how a card stays honest: it passes the SHA it recorded, so the diff
 * that opens is the one the card described even after the work is committed. A
 * click from the summary passes nothing and gets the working tree.
 */
export function openChangesInPanel(opts?: {
  scope?: ChangeScope
  focusPath?: string
}): void {
  const sessions = useSessionsStore.getState()
  const sessionId = sessions.activeSessionId
  if (!sessionId) return

  const changes = useChangesStore.getState()
  if (opts?.scope) changes.setScope(sessionId, opts.scope)
  if (opts?.focusPath) changes.focusFile(sessionId, opts.focusPath)

  useUiStore.getState().setRightPanelOpen(true)

  // Clamp up only. A width the user dragged to is a preference and survives;
  // the shipped default is not one, and leaving it would make the first open of
  // this tab look broken.
  const sizes = usePanelSizesStore.getState()
  if (sizes.rightPanelWidth < CHANGES_MIN_WIDTH) {
    sizes.setSize('rightPanelWidth', CHANGES_MIN_WIDTH)
  }

  useWorkspaceStore.getState().openChangesTab(sessionId)
}

/**
 * Show a plan in the side panel.
 *
 * Opened by clicking a plan card and by nothing else — there is no entry in
 * `NEW_TAB_CHOICES`, no button in the panel and no command, because a plan is
 * reviewed once and a permanent way back to it would outlive its use. Closing
 * the tab is a real close; the card in the transcript is how you reopen it.
 *
 * The verdict is not here. The plan composer is docked above the composer the
 * whole time this tab is open, so approving has a home already and a second set
 * of buttons would only be a second thing to keep in step.
 */
export function openPlanInPanel(toolId: string): void {
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return

  useUiStore.getState().setRightPanelOpen(true)

  // Clamp up only, as with changes: a width the user dragged to is a preference
  // and survives; the shipped default is not one.
  const sizes = usePanelSizesStore.getState()
  if (sizes.rightPanelWidth < PLAN_MIN_WIDTH) {
    sizes.setSize('rightPanelWidth', PLAN_MIN_WIDTH)
  }

  useWorkspaceStore.getState().openPlanTab(sessionId, toolId)
}

/**
 * Show this chat's subagents in the side panel.
 *
 * `focus` is null for the list and a `Task` toolId for one agent's stream. Both
 * go through here rather than reaching into the store, so the panel opens and
 * the width clamps whichever way you arrived — the summary row, the "See all"
 * header, the command palette, or the back arrow inside the tab itself.
 *
 * This replaced a modal. A modal was the wrong shape for something you watch
 * while it runs: it covered the conversation the agent was working on, and
 * there is no reason you should not have two of these open in different chats.
 */
export function openSubagentsInPanel(focus: string | null): void {
  const sessionId = useSessionsStore.getState().activeSessionId
  if (!sessionId) return

  useUiStore.getState().setRightPanelOpen(true)

  const sizes = usePanelSizesStore.getState()
  if (sizes.rightPanelWidth < SUBAGENTS_MIN_WIDTH) {
    sizes.setSize('rightPanelWidth', SUBAGENTS_MIN_WIDTH)
  }

  useWorkspaceStore.getState().openSubagentsTab(sessionId, focus)
}
