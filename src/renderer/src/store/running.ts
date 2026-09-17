import { create } from 'zustand'

/**
 * Which sessions have a turn in flight.
 *
 * This used to be `useState` inside `Chat`, which was fine while the sidebar only
 * ever listed sessions: nothing outside the conversation needed to know. Projects
 * changed that — the rail has to show a spinner on a project whose chat is running
 * in the background, and `Chat` unmounts entirely when the workflow canvas opens,
 * taking its closure with it.
 *
 * Deliberately not persisted. A child process does not survive a reload, so a
 * restored "running" flag would be a lie with no event coming to clear it.
 */
interface RunningState {
  /** Session ids with a turn in flight. */
  running: Record<string, true>
  /** Session id → when its thinking indicator started. */
  thinkingSince: Record<string, number>
  startRun: (sessionId: string) => void
  endRun: (sessionId: string) => void
  startThinking: (sessionId: string, at?: number) => void
  stopThinking: (sessionId: string) => void
  /** Forget a session entirely — on delete, so a stuck flag can't outlive it. */
  forget: (sessionId: string) => void
}

export const useRunningStore = create<RunningState>((set) => ({
  running: {},
  thinkingSince: {},

  startRun: (sessionId) =>
    set((state) =>
      state.running[sessionId] ? state : { running: { ...state.running, [sessionId]: true } }
    ),

  endRun: (sessionId) =>
    set((state) => {
      if (!state.running[sessionId]) return state
      const running = { ...state.running }
      delete running[sessionId]
      return { running }
    }),

  startThinking: (sessionId, at = Date.now()) =>
    set((state) => ({ thinkingSince: { ...state.thinkingSince, [sessionId]: at } })),

  stopThinking: (sessionId) =>
    set((state) => {
      if (state.thinkingSince[sessionId] === undefined) return state
      const thinkingSince = { ...state.thinkingSince }
      delete thinkingSince[sessionId]
      return { thinkingSince }
    }),

  forget: (sessionId) =>
    set((state) => {
      const running = { ...state.running }
      const thinkingSince = { ...state.thinkingSince }
      delete running[sessionId]
      delete thinkingSince[sessionId]
      return { running, thinkingSince }
    })
}))

/** Read without subscribing — for event handlers and other non-render callers. */
export function isSessionRunning(sessionId: string | null | undefined): boolean {
  return sessionId ? useRunningStore.getState().running[sessionId] === true : false
}

/** True when any of `sessionIds` is running. The sidebar's spinner rule. */
export function anyRunning(running: Record<string, true>, sessionIds: string[]): boolean {
  return sessionIds.some((id) => running[id] === true)
}

/**
 * Whether a project row shows a spinner. Spec §2, including its own caveat.
 *
 * Collapsed, the project row stands in for its chats. Expanded, the spinner
 * belongs on the individual chat rows instead — except for a chat hidden behind
 * `Show more`, whose spinner would otherwise be invisible with no hint that
 * anything is running.
 */
export function projectSpinnerVisible(opts: {
  collapsed: boolean
  childIds: string[]
  visibleCount: number
  running: Record<string, true>
}): boolean {
  const { collapsed, childIds, visibleCount, running } = opts
  if (collapsed) return anyRunning(running, childIds)
  return anyRunning(running, childIds.slice(visibleCount))
}
