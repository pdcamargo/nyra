import { create } from 'zustand'
import { byReadingOrder, type ChatAnnotation } from '../lib/chatAnnotations'

/** A request to bring a range on screen, and what to do once it is. */
export type AnnotationJump = {
  messageId: string
  start: number
  end: number
  /** Reopen this pending annotation's popover once it is visible. */
  editId?: string
  /** Bumped per request, so asking for the same range twice still fires. */
  seq: number
}

const NONE: ChatAnnotation[] = []

type AnnotationsStore = {
  /** Pending annotations per chat, in reading order. */
  bySession: Record<string, ChatAnnotation[] | undefined>
  /** The annotation whose popover is open for editing. */
  editing: string | null
  jump: AnnotationJump | null
  add: (sessionId: string, annotation: ChatAnnotation) => void
  update: (sessionId: string, id: string, comment: string) => void
  remove: (sessionId: string, id: string) => void
  /** Hand over everything pending and empty the chat's list — on send. */
  take: (sessionId: string) => ChatAnnotation[]
  clear: (sessionId: string) => void
  edit: (id: string | null) => void
  requestJump: (jump: Omit<AnnotationJump, 'seq'>) => void
}

/**
 * Annotations waiting for the next message. Not persisted: they are a draft,
 * like the text in the composer, and a range is only good for the render it
 * was taken from.
 */
export const useAnnotationsStore = create<AnnotationsStore>()((set, get) => ({
  bySession: {},
  editing: null,
  jump: null,
  add: (sessionId, annotation) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: [...(s.bySession[sessionId] ?? NONE), annotation].sort(byReadingOrder)
      }
    })),
  update: (sessionId, id, comment) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: (s.bySession[sessionId] ?? NONE).map((a) => (a.id === id ? { ...a, comment } : a))
      }
    })),
  remove: (sessionId, id) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: (s.bySession[sessionId] ?? NONE).filter((a) => a.id !== id) },
      editing: s.editing === id ? null : s.editing
    })),
  take: (sessionId) => {
    const taken = get().bySession[sessionId] ?? NONE
    if (taken.length > 0) get().clear(sessionId)
    return taken
  },
  clear: (sessionId) =>
    set((s) => {
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession, editing: null }
    }),
  edit: (id) => set({ editing: id }),
  requestJump: (jump) => set((s) => ({ jump: { ...jump, seq: (s.jump?.seq ?? 0) + 1 } }))
}))

/** A chat's pending annotations; a stable empty array when there are none. */
export function useSessionAnnotations(sessionId: string | null | undefined): ChatAnnotation[] {
  return useAnnotationsStore((s) => (sessionId ? s.bySession[sessionId] ?? NONE : NONE))
}
