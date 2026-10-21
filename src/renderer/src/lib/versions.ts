import type { Message, TextMessage, VersionSet } from '../store/sessions'
import { editedPaths } from './promptTimeline'

/**
 * What the transcript draws for edited and regenerated messages, read off the
 * path on screen and the sets behind it. See `VersionSet` for the model.
 */

/** One ‹ n / m › switcher. */
export type VersionView = {
  key: string
  /** Zero-based, like the set's own. */
  index: number
  total: number
  /** The version whose edits are on disk, when that is another one and either
   *  of them changed files. Null when what is on screen is what ran. */
  ranElsewhere: number | null
}

/** What Regenerate needs from a turn: the prompt to run again, and what the
 *  turn changed — the files that will not rewind with it. */
export type TurnRegen = { promptId: string; files: string[] }

/** From `from` up to the next user message: one turn. */
function turnFrom(messages: Message[], from: number): Message[] {
  const end = messages.findIndex((m, i) => i >= from && m.role === 'user')
  return messages.slice(from, end < 0 ? messages.length : end)
}

function view(key: string, set: VersionSet, onScreen: Message[], ranTurn: Message[]): VersionView {
  const touched = set.ran !== set.current && (editedPaths(onScreen).length > 0 || editedPaths(ranTurn).length > 0)
  return { key, index: set.current, total: set.tails.length, ranElsewhere: touched ? set.ran : null }
}

/**
 * Switchers by the message they sit under: an edited prompt's own bubble, and
 * a regenerated turn's final reply — or, while it is still being written, its
 * latest one.
 */
export function versionViews(
  messages: Message[],
  versions: Record<string, VersionSet> | undefined,
  turnEnds: Set<string>
): Map<string, VersionView> {
  const views = new Map<string, VersionView>()
  if (!versions) return views
  messages.forEach((m, i) => {
    if (m.role !== 'user') return
    const { promptVersions, replyVersions } = m as TextMessage

    const prompt = promptVersions ? versions[promptVersions] : undefined
    if (prompt && prompt.tails.length > 1) {
      // A put-away prompt version starts with its own user message.
      const ran = prompt.tails[prompt.ran]?.messages ?? []
      views.set(m.id, view(promptVersions!, prompt, turnFrom(messages, i + 1), turnFrom(ran, 1)))
    }

    const reply = replyVersions ? versions[replyVersions] : undefined
    if (reply && reply.tails.length > 1) {
      const turn = turnFrom(messages, i + 1)
      const replies = turn.filter((t) => t.role === 'assistant')
      const under = replies.find((t) => turnEnds.has(t.id)) ?? replies[replies.length - 1]
      if (!under) return
      const ran = reply.tails[reply.ran]?.messages ?? []
      views.set(under.id, view(replyVersions!, reply, turn, turnFrom(ran, 0)))
    }
  })
  return views
}

/**
 * Regenerate, by the reply it sits under. Only for a turn started by a sent
 * message: one steered into a running turn has no reply of its own to rewind
 * to, and its `resumeAt` is never set.
 */
export function turnRegens(messages: Message[], turnEnds: Set<string>): Map<string, TurnRegen> {
  const regens = new Map<string, TurnRegen>()
  let prompt = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      prompt = 'resumeAt' in m ? i : -1
      return
    }
    if (prompt < 0 || !turnEnds.has(m.id)) return
    regens.set(m.id, { promptId: messages[prompt].id, files: editedPaths(turnFrom(messages, prompt + 1)) })
  })
  return regens
}
