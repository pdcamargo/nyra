import { useSettingsStore } from '../store/settings'
import { useSessionsStore } from '../store/sessions'
import type { NyraSettings, Provider } from '../../../shared/types'

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
  /** The CLI the chat runs on. Not a default anything else inherits: a new
   *  chat starts on Claude, and moves when a Codex model is picked in it. */
  provider: Provider
  update: (partial: Partial<ChatSettings> & { provider?: Provider }) => void
} {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const planMode = useSettingsStore((s) => s.planMode)
  const model = useSettingsStore((s) => s.model)
  const effort = useSettingsStore((s) => s.effort)

  const resolved = resolveChatSettings(session, { planMode, model, effort })

  return {
    ...resolved,
    provider: session?.provider ?? 'claude',
    update: (partial) => {
      // No chat open yet — the composer in an empty window still has to go
      // somewhere, and the default is the only thing there is. The defaults
      // are Claude's, so a Codex pick has nowhere to land.
      if (!activeSessionId) {
        const { provider, ...defaults } = partial
        if (provider !== 'codex') useSettingsStore.getState().updateSettings(defaults)
        return
      }
      useSessionsStore.getState().setSessionSettings(activeSessionId, partial)
    }
  }
}
