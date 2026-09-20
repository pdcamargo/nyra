import { create } from 'zustand'

/**
 * What a subagent is doing, while it does it.
 *
 * Clicking a subagent used to open a modal with two states and nothing in
 * between: a blue italic line, or the whole report at once. The report has one
 * source — the `Task` tool's result — and it is written once, at the end, so
 * there was by construction nothing to show in the middle.
 *
 * This is the middle. Both spawn modes feed it: a foreground subagent's
 * messages arrive inline tagged with `parent_tool_use_id`, a background one's
 * come from Rust tailing the transcript it writes. The panel cannot tell which.
 *
 * Not persisted. A reload leaves no process to report back, and the transcript
 * is still on disk — `hydrate` reads it off `Agent.outputFile` instead, which
 * is cheaper than carrying hundreds of KB per agent through IndexedDB.
 */
export type SubagentEntry =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolId: string; name: string; input: Record<string, unknown>; result?: string }

/** A wire entry, before the `tool_result` halves are folded into their calls. */
export type SubagentWireEntry =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool_id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_id: string; result: string }

export type SubagentTranscript = {
  model?: string
  entries: SubagentEntry[]
  /** Set once a disk read has happened, so an empty agent is not read forever. */
  hydrated?: boolean
}

const EMPTY: SubagentTranscript = { entries: [] }

interface SubagentTranscriptsState {
  /** Session id → `Task` tool id → what that agent has said. */
  bySession: Record<string, Record<string, SubagentTranscript>>
  append: (sessionId: string, toolId: string, entries: SubagentWireEntry[]) => void
  noteModel: (sessionId: string, toolId: string, model: string) => void
  /** Replace wholesale from a disk read. */
  hydrate: (
    sessionId: string,
    toolId: string,
    data: { model?: string | null; entries: SubagentWireEntry[] }
  ) => void
  /** Drop one agent's stream, when a second source takes over from the first. */
  reset: (sessionId: string, toolId: string) => void
  forget: (sessionId: string) => void
}

/**
 * Fold `tool_result` into the `tool` entry it answers.
 *
 * A result can arrive many entries after its call, and searching backwards
 * keeps the trace line in the order the agent actually did things rather than
 * re-appending it at the bottom when it returns.
 */
function merge(existing: SubagentEntry[], incoming: SubagentWireEntry[]): SubagentEntry[] {
  let next = existing
  let copied = false
  const own = (): SubagentEntry[] => {
    if (!copied) {
      next = [...next]
      copied = true
    }
    return next
  }

  for (const entry of incoming) {
    if (entry.kind === 'tool_result') {
      const list = own()
      for (let i = list.length - 1; i >= 0; i--) {
        const candidate = list[i]
        if (candidate.kind === 'tool' && candidate.toolId === entry.tool_id) {
          list[i] = { ...candidate, result: entry.result }
          break
        }
      }
      continue
    }
    if (entry.kind === 'tool') {
      own().push({ kind: 'tool', toolId: entry.tool_id, name: entry.name, input: entry.input })
      continue
    }
    own().push(entry)
  }

  return next
}

export const useSubagentTranscriptsStore = create<SubagentTranscriptsState>((set) => ({
  bySession: {},

  append: (sessionId, toolId, entries) =>
    set((state) => {
      if (entries.length === 0) return state
      const forSession = state.bySession[sessionId] ?? {}
      const current = forSession[toolId] ?? EMPTY
      const merged = merge(current.entries, entries)
      if (merged === current.entries) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...forSession, [toolId]: { ...current, entries: merged } }
        }
      }
    }),

  noteModel: (sessionId, toolId, model) =>
    set((state) => {
      const forSession = state.bySession[sessionId] ?? {}
      const current = forSession[toolId] ?? EMPTY
      if (current.model === model) return state
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...forSession, [toolId]: { ...current, model } }
        }
      }
    }),

  hydrate: (sessionId, toolId, data) =>
    set((state) => {
      const forSession = state.bySession[sessionId] ?? {}
      const current = forSession[toolId] ?? EMPTY
      // A live stream beats a disk read: the file lags by up to a tick, and
      // replacing what we already showed would make the panel jump backwards.
      if (current.entries.length > 0) {
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: { ...forSession, [toolId]: { ...current, hydrated: true } }
          }
        }
      }
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...forSession,
            [toolId]: {
              model: data.model ?? current.model,
              entries: merge([], data.entries),
              hydrated: true
            }
          }
        }
      }
    }),

  reset: (sessionId, toolId) =>
    set((state) => {
      const forSession = state.bySession[sessionId]
      const current = forSession?.[toolId]
      if (!current || (current.entries.length === 0 && !current.hydrated)) return state
      // Keep the model: it is the same agent either way, and re-announcing it is
      // not guaranteed.
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...forSession, [toolId]: { model: current.model, entries: [] } }
        }
      }
    }),

  forget: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state
      const next = { ...state.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
}))

/** Read without subscribing, and without minting a fresh object per call. */
export function transcriptFor(
  state: SubagentTranscriptsState,
  sessionId: string | null | undefined,
  toolId: string | null | undefined
): SubagentTranscript {
  if (!sessionId || !toolId) return EMPTY
  return state.bySession[sessionId]?.[toolId] ?? EMPTY
}
