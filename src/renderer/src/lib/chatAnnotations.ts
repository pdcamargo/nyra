/**
 * Comments pinned to a stretch of text in the transcript, sent with the next
 * message.
 *
 * A range is kept as character offsets into its message's rendered text, not
 * as a live DOM `Range`: the transcript is virtualised, so the row it was made
 * in unmounts on scroll and comes back as new nodes. Offsets survive that; a
 * `Range` would point into a detached tree.
 */
import type { MessageContext } from '../store/sessions'

/** One pending annotation, before it is sent. */
export type ChatAnnotation = {
  id: string
  messageId: string
  /** Whose words were selected. */
  source: 'user' | 'assistant'
  /** Offsets into the message root's text, `[start, end)`. */
  start: number
  end: number
  /** The selected text, as the user saw it. */
  quote: string
  /** May be empty: a quote on its own is still a pointer. */
  comment: string
  /** Where the message sits in the conversation, so pins number in reading order. */
  order: number
}

/** What a sent message keeps of each annotation, for its receipt. */
export type SentAnnotation = Pick<ChatAnnotation, 'messageId' | 'source' | 'start' | 'end' | 'quote' | 'comment'>

/** The attribute that marks a message's text as annotatable; its value is the message id. */
export const ANNOTATABLE = 'data-annotatable'

/** Reading order: by message, then by where the range starts in it. */
export function byReadingOrder(a: ChatAnnotation, b: ChatAnnotation): number {
  return a.order - b.order || a.start - b.start
}

/** The root a node belongs to, if it is inside an annotatable message. */
export function annotatableRoot(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement
  return (el?.closest(`[${ANNOTATABLE}]`) as HTMLElement | null) ?? null
}

/** `[start, end)` of a range, counted in its root's text. */
export function offsetsOf(root: HTMLElement, range: Range): { start: number; end: number } {
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return { start, end: start + range.toString().length }
}

/**
 * A selection cut down to one message. A triple-click selects the paragraph
 * and ends at the start of whatever follows it — often outside the message
 * entirely — and dropping that selection is what closed the toolbar under
 * you. Null when nothing of the message is left.
 */
export function clampToRoot(root: HTMLElement, picked: Range): Range | null {
  const range = picked.cloneRange()
  if (!root.contains(range.startContainer)) range.setStart(root, 0)
  if (!root.contains(range.endContainer)) range.setEnd(root, root.childNodes.length)
  return range.collapsed ? null : range
}

const WORD = /[\p{L}\p{N}_'’]/u

/**
 * Widen a range that cuts into a word to the whole word, at either end. A drag
 * that starts a pixel inside "through" selects "hrough", and that is not what
 * anyone meant to quote. A range that already starts or ends on a boundary is
 * left alone.
 */
export function snapToWords(range: Range): void {
  const { startContainer: start, startOffset } = range
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.nodeValue ?? ''
    let at = startOffset
    if (at > 0 && WORD.test(text[at - 1]) && WORD.test(text[at] ?? '')) {
      while (at > 0 && WORD.test(text[at - 1])) at--
      range.setStart(start, at)
    }
  }
  const { endContainer: end, endOffset } = range
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.nodeValue ?? ''
    let at = endOffset
    if (at > 0 && at < text.length && WORD.test(text[at - 1]) && WORD.test(text[at])) {
      while (at < text.length && WORD.test(text[at])) at++
      range.setEnd(end, at)
    }
  }
}

/**
 * The live range for `[start, end)` in a root, or null when the text no longer
 * reaches that far — the message was edited or is still streaming.
 */
export function rangeAt(root: HTMLElement, start: number, end: number): Range | null {
  if (end <= start) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let seen = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0
    if (!started && start < seen + length) {
      range.setStart(node, start - seen)
      started = true
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen)
      return range
    }
    seen += length
  }
  return null
}

/** Each line of a quote, prefixed the way markdown quotes it. */
function quoted(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * What Claude receives after the typed text: every annotation, numbered as its
 * pin is, quote first and the comment under it. Written from the user's side —
 * "my earlier message", "your reply" — because that is whose voice the prompt is.
 */
export function annotationsBody(annotations: SentAnnotation[]): string {
  const entries = annotations.map((a, i) => {
    const where = a.source === 'user' ? 'On my earlier message:' : 'On your reply:'
    return [`[${i + 1}] ${where}`, quoted(a.quote), a.comment.trim()].filter(Boolean).join('\n')
  })
  return ['<annotations>', entries.join('\n\n'), '</annotations>'].join('\n')
}

export function annotationsLabel(count: number): string {
  return count === 1 ? '1 annotation' : `${count} annotations`
}

/** Pending annotations as the context a message carries: a receipt label, the prompt block, and what the receipt lists. */
export function annotationContext(annotations: ChatAnnotation[]): MessageContext {
  const sent: SentAnnotation[] = annotations.map(({ messageId, source, start, end, quote, comment }) => ({
    messageId,
    source,
    start,
    end,
    quote,
    comment
  }))
  return {
    kind: 'chat-annotation',
    label: annotationsLabel(sent.length),
    body: annotationsBody(sent),
    ref: { annotations: sent }
  }
}
