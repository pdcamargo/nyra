/**
 * Markdown editing over a plain textarea.
 *
 * Pure functions from (text, selection) to (text, selection) so the behaviour is
 * testable without a DOM: the caller applies the result and restores the caret.
 */
export type Edit = { text: string; selectionStart: number; selectionEnd: number }

/** The markers we toggle, longest first so `**` is recognised before `*`. */
export const MARKERS = {
  bold: '**',
  italic: '*',
  code: '`',
  strike: '~~'
} as const

export type MarkerName = keyof typeof MARKERS

function lineBoundsAt(text: string, index: number): [number, number] {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const nl = text.indexOf('\n', index)
  return [start, nl === -1 ? text.length : nl]
}

/** How many of `ch` run leftward from `index`. */
function runBefore(text: string, index: number, ch: string): number {
  let n = 0
  while (index - n - 1 >= 0 && text[index - n - 1] === ch) n++
  return n
}

/** How many of `ch` run rightward from `index`. */
function runAfter(text: string, index: number, ch: string): number {
  let n = 0
  while (index + n < text.length && text[index + n] === ch) n++
  return n
}

/**
 * Wrap the selection in a marker, or unwrap it if it is already wrapped.
 *
 * Detection is run-length exact rather than a prefix test, because `*` is a
 * prefix of `**`: asking for italic inside `**bold**` would otherwise strip one
 * asterisk from each side and quietly turn the bold into italic. A run of two
 * only answers to bold, a run of one only to italic.
 *
 * Handles the marker sitting just outside the selection, which is what you get
 * after wrapping and reselecting the inner text, and inside it, which is what
 * you get from selecting the whole `**word**`.
 */
export function toggleInlineMarker(
  text: string,
  start: number,
  end: number,
  name: MarkerName
): Edit {
  const m = MARKERS[name]
  const len = m.length
  const ch = m[0]

  if (runBefore(text, start, ch) === len && runAfter(text, end, ch) === len) {
    return {
      text: text.slice(0, start - len) + text.slice(start, end) + text.slice(end + len),
      selectionStart: start - len,
      selectionEnd: end - len
    }
  }

  const selected = text.slice(start, end)
  if (
    selected.length >= len * 2 &&
    runAfter(selected, 0, ch) === len &&
    runBefore(selected, selected.length, ch) === len
  ) {
    const inner = selected.slice(len, -len)
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length
    }
  }

  return {
    text: text.slice(0, start) + m + selected + m + text.slice(end),
    selectionStart: start + len,
    selectionEnd: end + len
  }
}

/** Wrap the selection as a link, putting the caret where the URL goes. */
export function insertLink(text: string, start: number, end: number): Edit {
  const label = text.slice(start, end) || 'text'
  const next = `${text.slice(0, start)}[${label}]()${text.slice(end)}`
  const caret = start + label.length + 3
  return { text: next, selectionStart: caret, selectionEnd: caret }
}

const LIST_LINE = /^(\s*)(?:([-*+])\s+|(\d+)([.)])\s+|(>)\s?)(.*)$/

export type ListMarker = {
  indent: string
  /** The marker the *next* item opens with. */
  next: string
  /** What the line says after its marker. */
  content: string
}

/**
 * The list, quote or bullet marker a line opens with, if it opens with one.
 *
 * Split out from the continuation itself so the classification is testable on
 * its own, and so both halves agree about what counts as a list.
 */
export function listMarkerAt(line: string): ListMarker | null {
  const m = LIST_LINE.exec(line)
  if (!m) return null
  const [, indent, bullet, ordinal, delim, quote, rest] = m

  // A GFM checkbox continues as an unticked one; carrying `[x]` forward would
  // mean every new item arrived already done.
  const task = /^\[[ xX]\]\s+/.exec(rest)
  const box = task ? '[ ] ' : ''

  const next = bullet
    ? `${bullet} ${box}`
    : ordinal
      ? `${Number(ordinal) + 1}${delim} ${box}`
      : `${quote} `
  return { indent, next, content: task ? rest.slice(task[0].length) : rest }
}

/**
 * Shift+Enter: break the line, and inside a list start the next item.
 *
 * This replaces `continueListOnEnter`, which only ever ran off the send key and
 * so could refuse: it bailed on a non-collapsed selection and on a caret that
 * was not at end-of-line, leaving Enter to send the message. Shift+Enter is now
 * the only way to get a newline at all, so refusing is not available to it —
 * hence the line is reconstructed from both sides of the selection (the
 * selection is replaced first, then whatever remains is classified) and a caret
 * mid-item pushes the tail onto the new one.
 *
 * Pressing it on an item with nothing in it ends the list, which is how every
 * markdown editor gets you out of one.
 */
export function newlineInList(text: string, start: number, end: number): Edit {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lineStart = before.lastIndexOf('\n') + 1
  const nlAfter = after.indexOf('\n')
  const line = before.slice(lineStart) + (nlAfter === -1 ? after : after.slice(0, nlAfter))

  const marker = listMarkerAt(line)
  if (!marker) {
    return { text: `${before}\n${after}`, selectionStart: start + 1, selectionEnd: start + 1 }
  }

  if (marker.content.trim() === '') {
    // An empty marker means "done with the list": clear the line.
    const lineEnd = nlAfter === -1 ? text.length : end + nlAfter
    return {
      text: text.slice(0, lineStart) + text.slice(lineEnd),
      selectionStart: lineStart,
      selectionEnd: lineStart
    }
  }

  const insert = `\n${marker.indent}${marker.next}`
  return {
    text: before + insert + after,
    selectionStart: start + insert.length,
    selectionEnd: start + insert.length
  }
}

/**
 * Set or clear a heading level on the current line.
 *
 * Applying the level a line already has removes it, so the same key toggles.
 */
export function toggleHeading(text: string, start: number, end: number, level: number): Edit {
  const [lineStart, lineEnd] = lineBoundsAt(text, start)
  const line = text.slice(lineStart, lineEnd)
  const existing = /^(#{1,6})\s+/.exec(line)
  const body = existing ? line.slice(existing[0].length) : line
  const next = existing && existing[1].length === level ? body : `${'#'.repeat(level)} ${body}`
  const delta = next.length - line.length
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selectionStart: Math.max(lineStart, start + delta),
    selectionEnd: Math.max(lineStart, end + delta)
  }
}
