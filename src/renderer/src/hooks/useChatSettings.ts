import { useSettingsStore } from '../store/settings'
import { useSessionsStore } from '../store/sessions'
import type { NyraSettings } from '../../../shared/types'

/**
 * The spawn settings in force for the conversation you are looking at.
 *
 * Settings holds the default a new chat starts with; the composer sets what
 * *this* chat is doing. They used to be the same value, so turning plan mode on
 * here turned it on in every other chat, including ones mid-turn.
 */
export type ChatSettings = {
  planMode: boolean
  model: string
  effort: NyraSettings['effort']
}

/** Resolve one chat's settings against the defaults. Pure, so it can be tested. */
export function resolveChatSettings(
  session: { planMode?: boolean; model?: string; effort?: NyraSettings['effort'] } | undefined,
  defaults: Pick<NyraSettings, 'planMode' | 'model' | 'effort'>
): ChatSettings {
  return {
    planMode: session?.planMode ?? defaults.planMode,
    model: session?.model ?? defaults.model,
    effort: session?.effort ?? defaults.effort
  }
}

export function useChatSettings(): ChatSettings & {
  update: (partial: Partial<ChatSettings>) => void
} {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const planMode = useSettingsStore((s) => s.planMode)
  const model = useSettingsStore((s) => s.model)
  const effort = useSettingsStore((s) => s.effort)

  const resolved = resolveChatSettings(session, { planMode, model, effort })

  return {
    ...resolved,
    update: (partial) => {
      // No chat open yet — the composer in an empty window still has to go
      // somewhere, and the default is the only thing there is.
      if (!activeSessionId) {
        useSettingsStore.getState().updateSettings(partial)
        return
      }
      useSessionsStore.getState().setSessionSettings(activeSessionId, partial)
    }
  }
}
