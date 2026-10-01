import type { Session } from '../store/sessions'
import type { PrState } from './pullRequests'

/**
 * How a project lists its chats in the rail.
 *
 * `reverse` is relative to each key's natural order rather than a bare
 * asc/desc, because what "first" means differs per key: newest for Created,
 * the one that needs you for Status. The menu names each end in those terms,
 * so nobody has to decode "ascending" against a PR state.
 */
export type ChatSortKey = 'created' | 'activity' | 'status' | 'pr' | 'name'

export type ChatSort = { key: ChatSortKey; reverse: boolean }

export const DEFAULT_CHAT_SORT: ChatSort = { key: 'created', reverse: false }

export const CHAT_SORT_KEYS: ChatSortKey[] = ['created', 'activity', 'status', 'pr', 'name']

export const CHAT_SORT_LABEL: Record<ChatSortKey, string> = {
  created: 'Created',
  activity: 'Last activity',
  status: 'Status',
  pr: 'Pull request',
  name: 'Name'
}

/** Each key's two ends: [natural, reversed]. */
export const CHAT_SORT_DIRECTIONS: Record<ChatSortKey, [string, string]> = {
  created: ['Newest first', 'Oldest first'],
  activity: ['Most recent', 'Least recent'],
  status: ['Needs you first', 'Quiet first'],
  pr: ['Open first', 'No PR first'],
  name: ['A → Z', 'Z → A']
}

export function chatSortOf(sort: ChatSort | undefined): ChatSort {
  return sort ?? DEFAULT_CHAT_SORT
}

export function isDefaultChatSort(sort: ChatSort | undefined): boolean {
  const s = chatSortOf(sort)
  return s.key === DEFAULT_CHAT_SORT.key && s.reverse === DEFAULT_CHAT_SORT.reverse
}

/** What the tooltip says: `Last activity · Most recent`. */
export function describeChatSort(sort: ChatSort | undefined): string {
  const s = chatSortOf(sort)
  return `${CHAT_SORT_LABEL[s.key]} · ${CHAT_SORT_DIRECTIONS[s.key][s.reverse ? 1 : 0]}`
}

/** What the rail knows about a chat that is not on the chat itself. */
export type ChatSortContext = {
  running: Record<string, boolean | undefined>
  planPending: ReadonlySet<string | undefined>
}

/**
 * The last message sent or received, or the chat's creation for one with
 * nothing timestamped yet. Walked from the end: the newest message is almost
 * always the last one, so this rarely looks at more than one.
 */
export function lastActivityOf(session: Session): number {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const t = session.messages[i].timestamp
    if (t !== undefined) return t
  }
  return session.createdAt
}

/**
 * Lower is more urgent. A chat blocked on you outranks one that is running —
 * running needs nothing from you yet, and it moves up on its own the moment it
 * does. Unread is next: finished, but you have not seen how.
 */
export function statusRankOf(session: Session, ctx: ChatSortContext): number {
  if (ctx.planPending.has(session.id) || session.needsAnswer) return 0
  if (ctx.running[session.id]) return 1
  if ((session.unread ?? 0) > 0) return 2
  return 3
}

// A PR whose state `gh` has not reported yet ranks as open: that is the icon it
// draws with, and the row should sort where it looks like it belongs.
const PR_RANK: Record<PrState, number> = { open: 0, draft: 0, merged: 1, closed: 2 }
const NO_PR_RANK = 3

/** A chat's best PR decides: one open PR among merged ones is still work in flight. */
export function prRankOf(session: Session): number {
  let rank = NO_PR_RANK
  for (const pr of session.pullRequests ?? []) {
    rank = Math.min(rank, pr.state ? PR_RANK[pr.state] : 0)
  }
  return rank
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The chats in `sort` order. A copy; the input is left alone.
 *
 * Grouping keys (Status, Pull request) break ties on last activity, so within a
 * group the chat you touched last is on top. Reversing flips the whole
 * comparison, ties included — "Quiet first" is the Status list read upwards.
 */
export function sortChats(sessions: Session[], sort: ChatSort | undefined, ctx: ChatSortContext): Session[] {
  const { key, reverse } = chatSortOf(sort)
  const compare = (a: Session, b: Session): number => {
    switch (key) {
      case 'created':
        return b.createdAt - a.createdAt
      case 'activity':
        return lastActivityOf(b) - lastActivityOf(a) || b.createdAt - a.createdAt
      case 'status':
        return statusRankOf(a, ctx) - statusRankOf(b, ctx) || lastActivityOf(b) - lastActivityOf(a)
      case 'pr':
        return prRankOf(a) - prRankOf(b) || lastActivityOf(b) - lastActivityOf(a)
      case 'name':
        return byName.compare(a.title, b.title)
    }
  }
  return [...sessions].sort((a, b) => (reverse ? compare(b, a) : compare(a, b)))
}
