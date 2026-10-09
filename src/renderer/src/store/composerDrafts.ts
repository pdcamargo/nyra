import type { FileAttachment, ImageAttachment } from './sessions'

/**
 * What you had typed into each chat and not sent yet.
 *
 * The composer is one component that outlives the chat it is showing, and its
 * text used to be one piece of state: type into A, click B, and B's composer
 * held A's words — send there and they went to the wrong conversation. Drafts
 * are filed by chat now. Leaving a chat files whatever is in the box under it,
 * arriving at one puts back what was filed there, or nothing.
 *
 * In memory only. A draft is a few minutes' thought, and keeping one across a
 * restart would mean persisting staged attachments, which are file paths into
 * a scratch dir the restart may have swept.
 */
export type ComposerDraft = {
  text: string
  images: ImageAttachment[]
  files: FileAttachment[]
}

const drafts = new Map<string, ComposerDraft>()

export const EMPTY_DRAFT: ComposerDraft = { text: '', images: [], files: [] }

export function hasContent(d: ComposerDraft): boolean {
  return d.text.trim().length > 0 || d.images.length > 0 || d.files.length > 0
}

export function getDraft(sessionId: string): ComposerDraft | undefined {
  return drafts.get(sessionId)
}

export function setDraft(sessionId: string, draft: ComposerDraft): void {
  if (hasContent(draft)) drafts.set(sessionId, draft)
  else drafts.delete(sessionId)
}

export function clearDrafts(): void {
  drafts.clear()
}

/**
 * Moving from one chat to another: what the composer should show, and what to
 * file where.
 *
 * The one case the draft travels is a message that was never a conversation:
 * you hit New message, typed, then started a new message somewhere else — in
 * another project, usually — before sending. That is the same message with a
 * different destination, so it goes with you. Both chats have to be empty and
 * the one you arrive at must not have a draft of its own, or it would be
 * overwritten.
 */
export function switchDraft(
  from: { id: string | null; empty: boolean },
  to: { id: string; empty: boolean },
  current: ComposerDraft
): ComposerDraft {
  const own = getDraft(to.id)
  if (from.id && from.empty && to.empty && !own && hasContent(current)) {
    drafts.delete(from.id)
    return current
  }
  if (from.id) setDraft(from.id, current)
  return own ?? EMPTY_DRAFT
}
