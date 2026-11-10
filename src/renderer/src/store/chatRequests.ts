/**
 * What `nyra_chat` is waiting on, per chat: a chat Claude wants to start, and
 * a project whose chats it wants to look at. See `lib/chatControl.ts`.
 *
 * Not persisted, like `secrets` and `desktop`: each entry is a tool call held
 * open, and none of them survives a restart.
 */
import { create } from 'zustand'
import type { Effort } from '@shared/types'

export type ChatStartAnswer =
  | { outcome: 'started'; open: boolean }
  | { outcome: 'declined'; message: string }
  /** The turn that asked ended before anyone answered. */
  | { outcome: 'withdrawn' }

export type ChatStartRequest = {
  requestId: string
  title: string
  reason: string
  /** The new chat's first message, word for word. */
  prompt: string
  /** What Claude asked for, so the answer can say what you changed. */
  asked: { model: string; effort: Effort; planMode: boolean; projectId: string | null }
  /** What the chat will start with: Claude's choice until you change a chip. */
  model: string
  effort: Effort
  planMode: boolean
  /** The project it starts in, or null for a chat outside any. */
  projectId: string | null
  askedAt: number
  /** Handed the request as it stood when answered, chips and all. */
  resolve: (answer: ChatStartAnswer, request: ChatStartRequest) => void
}

export type ChatStartEdit = Partial<Pick<ChatStartRequest, 'model' | 'effort' | 'planMode' | 'projectId'>>

export type StatusAccessAnswer = 'chat' | 'always' | 'no'

export type StatusAccessAsk = {
  key: string
  /** `Project.statusAccess`'s key: a project id, or '' for chats outside any. */
  projectKey: string
  projectName: string
  /** Whether "Always" can be kept: a chat outside any project has nowhere to keep it. */
  canAlways: boolean
  resolve: (answer: StatusAccessAnswer | 'dismissed') => void
}

type ChatAsks = { starts: ChatStartRequest[]; peeks: StatusAccessAsk[] }
const EMPTY: ChatAsks = { starts: [], peeks: [] }

type ChatRequestsStore = {
  bySession: Record<string, ChatAsks>
  pushStart: (sessionId: string, request: ChatStartRequest) => void
  editStart: (sessionId: string, requestId: string, edit: ChatStartEdit) => void
  /** Answer and remove one request. Settling twice is a no-op. */
  settleStart: (sessionId: string, requestId: string, answer: ChatStartAnswer) => void
  pushPeek: (sessionId: string, ask: StatusAccessAsk) => void
  settlePeek: (sessionId: string, key: string, answer: StatusAccessAnswer | 'dismissed') => void
}

const patch = (
  state: ChatRequestsStore,
  sessionId: string,
  next: (asks: ChatAsks) => ChatAsks
): Pick<ChatRequestsStore, 'bySession'> => ({
  bySession: { ...state.bySession, [sessionId]: next(state.bySession[sessionId] ?? EMPTY) }
})

export const useChatRequestsStore = create<ChatRequestsStore>()((set, get) => ({
  bySession: {},
  pushStart: (sessionId, request) =>
    set((s) => patch(s, sessionId, (a) => ({ ...a, starts: [...a.starts, request] }))),
  editStart: (sessionId, requestId, edit) =>
    set((s) =>
      patch(s, sessionId, (a) => ({
        ...a,
        starts: a.starts.map((r) => (r.requestId === requestId ? { ...r, ...edit } : r))
      }))
    ),
  settleStart: (sessionId, requestId, answer) => {
    const request = get().bySession[sessionId]?.starts.find((r) => r.requestId === requestId)
    if (!request) return
    set((s) =>
      patch(s, sessionId, (a) => ({ ...a, starts: a.starts.filter((r) => r.requestId !== requestId) }))
    )
    request.resolve(answer, request)
  },
  pushPeek: (sessionId, ask) => set((s) => patch(s, sessionId, (a) => ({ ...a, peeks: [...a.peeks, ask] }))),
  settlePeek: (sessionId, key, answer) => {
    const ask = get().bySession[sessionId]?.peeks.find((p) => p.key === key)
    if (!ask) return
    set((s) => patch(s, sessionId, (a) => ({ ...a, peeks: a.peeks.filter((p) => p.key !== key) })))
    ask.resolve(answer)
  }
}))

/** The request on top for a chat, if any. */
export const startRequestOf = (s: ChatRequestsStore, sessionId: string | null): ChatStartRequest | null =>
  (sessionId && s.bySession[sessionId]?.starts[0]) || null
