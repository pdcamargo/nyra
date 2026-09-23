/**
 * Up and Down through what you have already sent in this chat.
 *
 * Deliberately not a stack and not a store: the prompts themselves live in the
 * session's messages, which is what makes the history survive a restart and a
 * chat switch. This holds only the *cursor* — where in that list you currently
 * are, and the draft you had before you started walking back through it.
 *
 * The rules are the ones every other input has taught everyone:
 *
 * - `cursor` is -1 while you are in your draft, 0 at the newest prompt, and
 *   grows as you walk back. Past the oldest, Up does nothing.
 * - Walking back to the draft — Down off the newest prompt — restores the draft
 *   exactly, empty or not, and ends the walk.
 * - Editing a recalled prompt ends the walk. Down is not a second history then;
 *   it is the arrow key it always was.
 * - Down from the draft has nowhere to go. It does nothing rather than
 *   re-entering the history, which is what makes "Up once, Down once" land
 *   where you started.
 */

export type PromptHistory = {
  /** Oldest first, which is the order the messages are stored in. */
  entries: string[]
  /** -1 for the draft, 0 for the newest prompt, older from there. */
  cursor: number
  /** What was in the composer when the walk started. */
  draft: string
}

export function createPromptHistory(): PromptHistory {
  return { entries: [], cursor: -1, draft: '' }
}

/**
 * Adopt the chat's prompts as they stand now.
 *
 * Called on every keypress rather than cached, so a message you sent a moment
 * ago is already in the list. The walk is preserved when the list is the same
 * one — a keystroke is not a new conversation — and dropped when it is not, so
 * a reply that arrived mid-walk never leaves you holding an index into a
 * history that has grown underneath you.
 */
export function syncPromptHistory(history: PromptHistory, entries: string[]): PromptHistory {
  const same =
    history.entries.length === entries.length &&
    history.entries[history.entries.length - 1] === entries[entries.length - 1]
  if (same) return history.entries === entries ? history : { ...history, entries }
  return { entries, cursor: -1, draft: '' }
}

/** One step back. Null means there is nothing further up, so the key belongs to
 *  the editor and the caret moves instead. */
export function recallOlder(
  history: PromptHistory,
  draft: string
): { history: PromptHistory; text: string } | null {
  if (history.entries.length === 0) return null
  const cursor = history.cursor === -1 ? 0 : history.cursor + 1
  if (cursor > history.entries.length - 1) return null
  const next = history.cursor === -1 ? { ...history, draft } : history
  return {
    history: { ...next, cursor },
    text: history.entries[history.entries.length - 1 - cursor]
  }
}

/** One step forward, or out of the history and back into the draft. Null means
 *  there is nothing to come forward to. */
export function recallNewer(
  history: PromptHistory
): { history: PromptHistory; text: string } | null {
  if (history.cursor === -1) return null
  if (history.cursor === 0) {
    return { history: { ...history, cursor: -1, draft: '' }, text: history.draft }
  }
  const cursor = history.cursor - 1
  return {
    history: { ...history, cursor },
    text: history.entries[history.entries.length - 1 - cursor]
  }
}

/**
 * Whether the caret can still move that way inside the box.
 *
 * Up only reaches the history from the first line, and Down only from the last:
 * in a draft of several lines the arrows are moving between lines, and taking
 * them away would make the composer the one place in the app where you cannot
 * get back up to your first line. A selection counts as living on every line it
 * touches, so the end of it is what Down consults.
 */
export function hasRoomToMove(
  text: string,
  from: number,
  to: number,
  direction: 'up' | 'down'
): boolean {
  return direction === 'up'
    ? text.slice(0, from).includes('\n')
    : text.slice(to).includes('\n')
}

/** Stop walking, because what is in the box is no longer what was recalled. */
export function endPromptRecall(history: PromptHistory): PromptHistory {
  if (history.cursor === -1 && history.draft === '') return history
  return { ...history, cursor: -1, draft: '' }
}
