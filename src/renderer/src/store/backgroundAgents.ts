import { create } from 'zustand'

/**
 * Subagents still working after the turn that spawned them has ended.
 *
 * Claude closes a turn the moment it has launched background agents — in one
 * observed run, three of them started over 21 seconds, the turn ended 10 seconds
 * later, and they kept going for nearly three more minutes. Nyra called the turn
 * over, because it was, and showed nothing: no spinner, no stop button, an idle
 * app in front of work in flight.
 *
 * So "is a turn running" is the wrong question for the UI to ask. This answers
 * the right one.
 *
 * Deliberately not persisted, for the same reason `running` is not: a reload
 * leaves no process to report back, so a restored entry would never clear.
 */
export type BackgroundAgent = {
  taskId: string
  description: string
  /** Its own `subagent_type`, when the CLI has told us one. */
  kind?: string
  /** The latest line from `task_progress` — what it is doing right now. */
  activity?: string
  lastTool?: string
}

interface BackgroundAgentsState {
  /** Session id → the agents it is still waiting on. */
  bySession: Record<string, BackgroundAgent[]>
  /** Replace the roster. The CLI sends the whole list, including `[]` when done. */
  setAgents: (sessionId: string, agents: BackgroundAgent[]) => void
  /** Attach a live progress line to the agent it belongs to. */
  noteProgress: (
    sessionId: string,
    progress: { taskId: string; activity: string; kind?: string; lastTool?: string }
  ) => void
  forget: (sessionId: string) => void
}

const EMPTY: BackgroundAgent[] = []

export const useBackgroundAgentsStore = create<BackgroundAgentsState>((set) => ({
  bySession: {},

  setAgents: (sessionId, agents) =>
    set((state) => {
      if (agents.length === 0 && !state.bySession[sessionId]) return state
      // Carry the live line across a roster update; the roster itself does not
      // carry one, and losing it would blank the row every few seconds.
      const previous = state.bySession[sessionId] ?? EMPTY
      const merged = agents.map((a) => {
        const before = previous.find((p) => p.taskId === a.taskId)
        return before ? { ...a, activity: before.activity, lastTool: before.lastTool } : a
      })
      const next = { ...state.bySession }
      if (merged.length === 0) delete next[sessionId]
      else next[sessionId] = merged
      return { bySession: next }
    }),

  noteProgress: (sessionId, progress) =>
    set((state) => {
      const agents = state.bySession[sessionId]
      if (!agents) return state
      // `task_progress` carries the parent's session id, not the subagent's, so
      // `task_id` is the only thing that says which agent this line is from.
      // Without one there is nothing to attach it to — with several agents
      // running, guessing would put one agent's work under another's name.
      const index = agents.findIndex((a) => a.taskId && a.taskId === progress.taskId)
      if (index === -1) return state
      const updated = [...agents]
      updated[index] = {
        ...updated[index],
        activity: progress.activity,
        kind: progress.kind || updated[index].kind,
        lastTool: progress.lastTool || updated[index].lastTool
      }
      return { bySession: { ...state.bySession, [sessionId]: updated } }
    }),

  forget: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
}))

/** Read without subscribing — for event handlers and other non-render callers. */
export function hasBackgroundAgents(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return (useBackgroundAgentsStore.getState().bySession[sessionId]?.length ?? 0) > 0
}

/** True when any of `sessionIds` still has agents out. The rail's spinner rule. */
export function anyBackgroundAgents(
  bySession: Record<string, BackgroundAgent[]>,
  sessionIds: string[]
): boolean {
  return sessionIds.some((id) => (bySession[id]?.length ?? 0) > 0)
}
