import { create } from 'zustand'

type Mode = 'picked' | 'typed'

type QuestionAnswerStore = {
  /** The question the dock currently owns, so the transcript card stands down. */
  toolId: string | null
  /** Question index → the labels ticked on it. */
  picks: Record<number, string[]>
  /**
   * Which of the two inputs was touched last.
   *
   * There is no "Something else" row any more — the composer *is* that option —
   * so the two ways of answering have to be told apart by something, and the
   * honest rule is recency. Typing means you want your own words, so the ticks
   * go. Going back to a tick means you want the tick, so the words are ignored:
   * left in the box and dimmed, never silently deleted out from under you.
   */
  mode: Mode
  /** Which question of a set is on screen. */
  page: number
  open: (toolId: string) => void
  pick: (index: number, label: string, multiSelect: boolean) => void
  noteTyping: () => void
  setPage: (page: number) => void
  clear: () => void
}

const FRESH = { picks: {}, mode: 'picked' as Mode, page: 0 }

export const useQuestionAnswerStore = create<QuestionAnswerStore>()((set) => ({
  toolId: null,
  ...FRESH,

  open: (toolId) => set((s) => (s.toolId === toolId ? s : { ...FRESH, toolId })),

  pick: (index, label, multiSelect) =>
    set((s) => {
      const current = s.picks[index] ?? []
      const next = multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : [label]
      // Picking is now the answer, whatever is sitting in the composer.
      return { mode: 'picked', picks: { ...s.picks, [index]: next } }
    }),

  noteTyping: () =>
    set((s) => {
      // Cheap to call on every keystroke: once there is nothing left to clear
      // this returns the same state and nothing re-renders.
      if (s.mode === 'typed' && Object.keys(s.picks).length === 0) return s
      return { mode: 'typed', picks: {} }
    }),

  setPage: (page) => set({ page }),
  clear: () => set({ ...FRESH, toolId: null })
}))
