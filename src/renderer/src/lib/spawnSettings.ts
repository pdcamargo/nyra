import { spawnSettingsFor, type SpawnSettings } from '@shared/types'
import { configDirForSession, useSessionsStore } from '../store/sessions'
import { useSettingsStore } from '../store/settings'

/** What "auto-accept edits" actually waives — file writes, nothing else. */
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/**
 * Spawn settings for one conversation.
 *
 * Everything but auto-accept is global. That one is per session because it is
 * granted by approving a particular plan, and `autoApproveTools` is sent with
 * every query — so it takes effect on the next turn without respawning.
 */
export function spawnSettingsForSession(sessionId: string): SpawnSettings {
  // The chat's workspace decides the account. Its project's, when it has one —
  // so a chat whose project moved respawns under the new account on this send.
  const base = spawnSettingsFor(useSettingsStore.getState(), configDirForSession(useSessionsStore.getState(), sessionId))
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)

  // Plan mode, model and effort are per-conversation, falling back to the
  // defaults in Settings. They used to be global, so changing one in a chat
  // changed it in every chat, including ones already running.
  const resolved: SpawnSettings = {
    ...base,
    planMode: session?.planMode ?? base.planMode,
    model: session?.model ?? base.model,
    effort: session?.effort ?? base.effort
  }

  if (!session?.autoAcceptEdits) return resolved
  const merged = new Set([...resolved.autoApproveTools, ...EDIT_TOOLS])
  return { ...resolved, autoApproveTools: [...merged] }
}
