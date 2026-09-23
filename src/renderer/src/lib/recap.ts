import type { ChangedEntry } from './changeBlocks'
import type { Message, Session, TextMessage } from '../store/sessions'
import type { PullRequest } from './pullRequests'

/**
 * What happened while you were not looking.
 *
 * Every number here is already on disk — messages, their `nyra-changes` blocks,
 * the task list, the PRs the turn opened. Nothing is re-queried and nothing is
 * generated, which is the point: the card draws instantly and for free the
 * moment you open the chat, and the one thing that does cost a turn (asking
 * Claude to summarise it in prose) is a button you press, not a thing that
 * happens to you.
 *
 * Turn counts come from the session's own counter rather than from the
 * transcript — see `Session.turns` for why counting messages would count
 * paragraphs instead.
 */

export type RecapStat =
  | { kind: 'tasks'; done: number; total: number }
  | { kind: 'pr'; number: number; title?: string; url: string }
  | { kind: 'error'; text: string }

export type Recap = {
  /** How long the chat ran without you, in ms. */
  awayMs: number
  turns: number
  stats: RecapStat[]
  /** Merged across every change block in the window, biggest first. */
  files: ChangedEntry[]
  /** Where to scroll back to. Null when the window has no message in it. */
  firstMessageId: string | null
}

/** Rows shown before "and N more". The rest are a count, not a list. */
export const RECAP_FILE_LIMIT = 3

function isText(m: Message): m is TextMessage {
  return m.role === 'user' || m.role === 'assistant' || m.role === 'error'
}

/**
 * One row per path, insertions and deletions summed.
 *
 * A file touched by three turns in the window is one row: you want to know what
 * moved while you were away, not how many times it moved.
 */
function mergeFiles(blocks: ChangedEntry[][]): ChangedEntry[] {
  const byPath = new Map<string, ChangedEntry>()
  for (const entries of blocks) {
    for (const entry of entries) {
      const prev = byPath.get(entry.path)
      byPath.set(
        entry.path,
        prev
          ? {
              path: entry.path,
              insertions: prev.insertions + entry.insertions,
              deletions: prev.deletions + entry.deletions
            }
          : entry
      )
    }
  }
  return [...byPath.values()].sort(
    (a, b) => b.insertions + b.deletions - (a.insertions + a.deletions)
  )
}

/** The last error in the window, trimmed to its first line. */
function lastError(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isText(m) && m.role === 'error') {
      const line = m.text.split('\n').find((l) => l.trim().length > 0)
      if (line) return line.trim()
    }
  }
  return null
}

/**
 * Build the recap for a session's away window, or null if there is nothing to
 * say about it.
 *
 * `now` is a parameter rather than `Date.now()` so the elapsed figure is
 * testable and so a card that stays open does not silently disagree with itself.
 */
export function buildRecap(session: Session, now: number): Recap | null {
  const away = session.away
  if (!away) return null

  const window = session.messages.filter((m) => (m.timestamp ?? 0) >= away.since)
  if (window.length === 0) return null

  const turns = Math.max(0, (session.turns ?? 0) - away.turnsAtLeave)

  const stats: RecapStat[] = []

  // Tasks are the headline when there are any: a checklist that finished is the
  // clearest possible answer to "did it get done".
  const tasks = session.tasks ?? []
  if (tasks.length > 0) {
    stats.push({
      kind: 'tasks',
      done: tasks.filter((t) => t.status === 'completed').length,
      total: tasks.length
    })
  }

  // Only PRs opened *in the window*. One from yesterday is not news.
  for (const pr of (session.pullRequests ?? []) as PullRequest[]) {
    if (pr.createdAt >= away.since) {
      stats.push({ kind: 'pr', number: pr.number, title: pr.title, url: pr.url })
    }
  }

  const error = lastError(window)
  if (error) stats.push({ kind: 'error', text: error })

  const files = mergeFiles(
    window.filter(isText).flatMap((m) => (m.changes ? [m.changes.files] : []))
  )

  // A window with nothing in it but prose is not worth a card. The turn count
  // alone is not news — you can see the messages.
  if (stats.length === 0 && files.length === 0) return null

  return {
    awayMs: away.ms ?? Math.max(0, now - away.since),
    turns,
    stats,
    files,
    firstMessageId: window[0]?.id ?? null
  }
}

/** `12 min`, `1 hr 4 min`, `48s`. Coarse on purpose — this is "how long were you gone". */
export function formatAway(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`
}
