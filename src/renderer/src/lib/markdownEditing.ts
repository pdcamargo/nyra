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

const LIST_LINE = /^(\s*)(?:([-*+])\s+|(\d+)\.\s+|(>)\s?)(.*)$/

/**
 * Continue a list, quote or bullet on Enter — and end it when you press Enter on
 * an empty one, which is how every markdown editor gets out of a list.
 *
 * Returns null when the line is not a list, so the caller lets Enter do whatever
 * it normally does (which here is send the message).
 */
export function continueListOnEnter(text: string, start: number, end: number): Edit | null {
  if (start !== end) return null
  const [lineStart, lineEnd] = lineBoundsAt(text, start)
  if (start !== lineEnd) return null

  const m = LIST_LINE.exec(text.slice(lineStart, lineEnd))
  if (!m) return null

  const [, indent, bullet, ordinal, quote, content] = m

  if (content.trim() === '') {
    // An empty marker means "done with the list": clear the line.
    return {
      text: text.slice(0, lineStart) + text.slice(lineEnd),
      selectionStart: lineStart,
      selectionEnd: lineStart
    }
  }

  const marker = bullet
    ? `${bullet} `
    : ordinal
      ? `${Number(ordinal) + 1}. `
      : `${quote} `
  const insert = `\n${indent}${marker}`
  return {
    text: text.slice(0, start) + insert + text.slice(start),
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
