import { create } from 'zustand'
import type { ChatAnnotation } from '../lib/chatAnnotations'

/** The text a side question was asked about, where it sits in the transcript. */
export type SideQuote = Pick<ChatAnnotation, 'messageId' | 'source' | 'start' | 'end' | 'quote'>

export type SideTurn = {
  id: string
  question: string
  answer: string
  status: 'streaming' | 'done' | 'error'
  error?: string
  /** The tool it is using right now, while it looks something up. */
  activity?: string
}

/**
 * A throwaway question asked beside the chat. The main conversation never sees
 * it: it runs in a process of its own, forked off the chat's transcript, and is
 * gone when the sheet closes — unless it is added to the chat, which parks it
 * with the next message the way an annotation waits.
 */
export type SideThread = {
  /** Also the backend's handle on the process answering it. */
  id: string
  quote?: SideQuote
  turns: SideTurn[]
}

const NONE: SideThread[] = []

type SideQuestionsStore = {
  /** The open sheet's thread, per chat. One at a time: that is what makes it throwaway. */
  open: Record<string, SideThread | undefined>
  /** Threads added to the chat, waiting for the next send. */
  kept: Record<string, SideThread[] | undefined>
  /** Opens the sheet on a fresh thread, replacing whatever was open. Returns the old one so its process can go. */
  start: (sessionId: string, thread: SideThread) => SideThread | undefined
  addTurn: (sessionId: string, turn: SideTurn) => void
  /** Streams into the thread's latest turn. */
  patchTurn: (threadId: string, turnId: string, patch: Partial<SideTurn>) => void
  appendAnswer: (threadId: string, turnId: string, text: string) => void
  /** Closes the sheet. Returns the thread that was open. */
  close: (sessionId: string) => SideThread | undefined
  keep: (sessionId: string) => SideThread | undefined
  unkeep: (sessionId: string, threadId: string) => void
  /** Hand over everything kept and empty the chat's list — on send. */
  take: (sessionId: string) => SideThread[]
}

function mapThread(
  open: Record<string, SideThread | undefined>,
  threadId: string,
  fn: (t: SideThread) => SideThread
): Record<string, SideThread | undefined> {
  for (const [sid, t] of Object.entries(open)) {
    if (t?.id === threadId) return { ...open, [sid]: fn(t) }
  }
  return open
}

const withTurn =
  (turnId: string, fn: (turn: SideTurn) => SideTurn) =>
  (t: SideThread): SideThread => ({ ...t, turns: t.turns.map((x) => (x.id === turnId ? fn(x) : x)) })

/** Not persisted: like the composer's draft, a side thread does not outlive the window. */
export const useSideQuestionsStore = create<SideQuestionsStore>()((set, get) => ({
  open: {},
  kept: {},
  start: (sessionId, thread) => {
    const previous = get().open[sessionId]
    set((s) => ({ open: { ...s.open, [sessionId]: thread } }))
    return previous
  },
  addTurn: (sessionId, turn) =>
    set((s) => {
      const t = s.open[sessionId]
      return t ? { open: { ...s.open, [sessionId]: { ...t, turns: [...t.turns, turn] } } } : s
    }),
  patchTurn: (threadId, turnId, patch) =>
    set((s) => ({ open: mapThread(s.open, threadId, withTurn(turnId, (x) => ({ ...x, ...patch }))) })),
  appendAnswer: (threadId, turnId, text) =>
    set((s) => ({ open: mapThread(s.open, threadId, withTurn(turnId, (x) => ({ ...x, answer: x.answer + text }))) })),
  close: (sessionId) => {
    const t = get().open[sessionId]
    if (!t) return undefined
    set((s) => {
      const open = { ...s.open }
      delete open[sessionId]
      return { open }
    })
    return t
  },
  keep: (sessionId) => {
    const t = get().open[sessionId]
    if (!t || !t.turns.some((x) => x.status === 'done')) return undefined
    const answered = { ...t, turns: t.turns.filter((x) => x.status === 'done') }
    set((s) => {
      const open = { ...s.open }
      delete open[sessionId]
      return { open, kept: { ...s.kept, [sessionId]: [...(s.kept[sessionId] ?? NONE), answered] } }
    })
    return t
  },
  unkeep: (sessionId, threadId) =>
    set((s) => ({ kept: { ...s.kept, [sessionId]: (s.kept[sessionId] ?? NONE).filter((t) => t.id !== threadId) } })),
  take: (sessionId) => {
    const taken = get().kept[sessionId] ?? NONE
    if (taken.length > 0) {
      set((s) => {
        const kept = { ...s.kept }
        delete kept[sessionId]
        return { kept }
      })
    }
    return taken
  }
}))

export function useOpenSideThread(sessionId: string | null | undefined): SideThread | undefined {
  return useSideQuestionsStore((s) => (sessionId ? s.open[sessionId] : undefined))
}

export function useKeptSideThreads(sessionId: string | null | undefined): SideThread[] {
  return useSideQuestionsStore((s) => (sessionId ? s.kept[sessionId] ?? NONE : NONE))
}
