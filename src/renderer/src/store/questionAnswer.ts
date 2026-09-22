import { create } from 'zustand'

type QuestionAnswerStore = {
  /** The question the dock currently owns, so the transcript card stands down. */
  toolId: string | null
  /** Question index → the labels ticked on it. */
  picks: Record<number, string[]>
  /**
   * Question index → what you typed instead of ticking.
   *
   * There is no "Something else" row any more — the composer *is* that option.
   * This used to be a single `mode: 'picked' | 'typed'` for the whole set, with
   * typing clearing every pick: one keystroke on question 3 threw away the
   * answers to 1 and 2, and the reply carried nothing but the sentence you had
   * just written. The conflict is per question, so the record is too. Answer
   * one in your own words and the next by ticking; they compose.
   */
  typed: Record<number, string>
  /** Which question of a set is on screen. */
  page: number
  open: (toolId: string) => void
  pick: (index: number, label: string, multiSelect: boolean) => void
  setTyped: (index: number, text: string) => void
  /** Drop everything given for one question. What Skip means. */
  skip: (index: number) => void
  /**
   * Record this question's words, step to the next one, and hand back what that
   * one was last answered with — which is what the composer should now show.
   *
   * One action rather than three calls from the composer, so the transition is
   * reachable from a test without mounting a thousand-line component.
   */
  advance: (index: number, text: string) => string
  setPage: (page: number) => void
  clear: () => void
}

const FRESH = { picks: {}, typed: {}, page: 0 }

export const useQuestionAnswerStore = create<QuestionAnswerStore>()((set, get) => ({
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
      // Ticking is this question's answer, so whatever was typed *for this
      // question* stops counting. Other questions are untouched.
      const { [index]: _dropped, ...typed } = s.typed
      return { picks: { ...s.picks, [index]: next }, typed }
    }),

  setTyped: (index, text) =>
    set((s) => {
      const trimmed = text.trim()
      const hadText = (s.typed[index] ?? '') !== ''
      const hasPicks = (s.picks[index] ?? []).length > 0
      // Cheap to call on every keystroke: with nothing to record and nothing to
      // clear this returns the same state and nothing re-renders.
      if (!trimmed && !hadText && !hasPicks) return s

      const typed = { ...s.typed }
      if (trimmed) typed[index] = text
      else delete typed[index]

      if (!trimmed || !hasPicks) return { typed, picks: s.picks }
      const { [index]: _dropped, ...picks } = s.picks
      return { typed, picks }
    }),

  skip: (index) =>
    set((s) => {
      // Typing is recorded as it happens, so by the time Skip is pressed the
      // words are already this question's answer. Without this, "Skip" would
      // carry whatever is sitting in the box straight into the reply.
      const { [index]: _t, ...typed } = s.typed
      const { [index]: _p, ...picks } = s.picks
      return { typed, picks }
    }),

  advance: (index, text) => {
    get().setTyped(index, text)
    const next = index + 1
    set({ page: next })
    return get().typed[next] ?? ''
  },

  setPage: (page) => set({ page }),
  clear: () => set({ ...FRESH, toolId: null })
}))
