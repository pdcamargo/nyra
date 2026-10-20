import { create } from 'zustand'

/**
 * The reply as it is being typed, one text block per session.
 *
 * Apart from `sessions` on purpose. Deltas arrive dozens a second, and every
 * change to that store re-renders `Chat` whole and schedules an IndexedDB write.
 * Here only the draft view subscribes, and nothing is persisted: a draft is a
 * preview of the `assistant_text` that follows its block, which replaces it.
 *
 * Writes are batched to one per frame. Tauri delivers each delta as its own
 * event, and painting more often than the screen does buys nothing.
 */
interface StreamingDraftState {
  /** Session id → the text block being streamed. */
  drafts: Record<string, string>
}

export const useStreamingDraftStore = create<StreamingDraftState>(() => ({ drafts: {} }))

/** Text received since the last frame, per session; `reset` drops the old block first. */
const pending = new Map<string, { reset: boolean; text: string }>()
let frame: number | null = null

function flush(): void {
  frame = null
  if (pending.size === 0) return
  const drafts = { ...useStreamingDraftStore.getState().drafts }
  for (const [sid, { reset, text }] of pending) {
    drafts[sid] = (reset ? '' : (drafts[sid] ?? '')) + text
  }
  pending.clear()
  useStreamingDraftStore.setState({ drafts })
}

/** Add a delta; `reset` starts a new block, which drops what came before. */
export function appendDraft(sessionId: string, text: string, reset = false): void {
  const queued = pending.get(sessionId)
  if (reset) pending.set(sessionId, { reset: true, text })
  else if (queued) queued.text += text
  else pending.set(sessionId, { reset: false, text })
  frame ??= requestAnimationFrame(flush)
}

/** The block is finished, or the turn is over: the draft has nothing left to say. */
export function clearDraft(sessionId: string): void {
  pending.delete(sessionId)
  const { drafts } = useStreamingDraftStore.getState()
  if (drafts[sessionId] === undefined) return
  const next = { ...drafts }
  delete next[sessionId]
  useStreamingDraftStore.setState({ drafts: next })
}
