import type { Message, TextMessage, ToolCallMessage, VersionSet } from '../store/sessions'
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
  /** The files of the version on screen can be put back: there is a copy of
   *  them, and a checkpoint to rewind what ran since. */
  restorable: boolean
}

/** What Regenerate needs from a turn: the prompt to run again, what the turn
 *  changed, the checkpoint that puts it back, and the shell commands it ran,
 *  whose changes nothing can. */
export type TurnRegen = { promptId: string; files: string[]; checkpoint?: string; commands: string[] }

/** Where a version's own run began, which rewinding to undoes. A regenerated
 *  prompt is shared, so a `reply` version keeps its run in its tail. */
export function versionCheckpoint(set: VersionSet, index: number): string | undefined {
  const tail = set.tails[index]
  if (!tail) return undefined
  return set.kind === 'reply' ? tail.run?.checkpoint : (tail.messages[0] as TextMessage | undefined)?.checkpoint
}

/** Every file the chat has edited, on screen or in a version put away. A copy
 *  of the version leaving the disk has to hold all of them: any could differ
 *  in whichever version comes back. */
export function chatEditedPaths(messages: Message[], versions: Record<string, VersionSet> | undefined): string[] {
  const paths = new Set(editedPaths(messages))
  for (const set of Object.values(versions ?? {})) {
    for (const tail of set.tails) for (const p of editedPaths(tail.messages)) paths.add(p)
  }
  return [...paths]
}

/** The shell commands these messages ran. Nothing tracks what they changed. */
export function shellCommands(messages: Message[]): string[] {
  const commands: string[] = []
  for (const m of messages) {
    if (m.role !== 'tool_call') continue
    const call = m as ToolCallMessage
    if (call.tool_name !== 'Bash' || call.denied) continue
    const command = call.input.command
    if (typeof command === 'string' && command.trim()) commands.push(command.trim())
  }
  return commands
}

/** What Claude last left in each file, from turns' `fileHashes` in order. */
export function lastWritten(runs: Array<Record<string, string | null> | undefined>): Map<string, string | null> {
  const last = new Map<string, string | null>()
  for (const hashes of runs) for (const [path, hash] of Object.entries(hashes ?? {})) last.set(path, hash)
  return last
}

/** The `fileHashes` of every turn in `messages`, in order. */
export function turnHashes(messages: Message[]): Array<Record<string, string | null> | undefined> {
  return messages.filter((m) => m.role === 'user').map((m) => (m as TextMessage).fileHashes)
}

/**
 * Files a restore overwrote that held something Claude did not leave there: a
 * hand edit, or a shell command's. Only files Claude wrote are judged — for any
 * other there is nothing to compare with.
 */
export function overwrittenEdits(
  overwritten: string[],
  before: Record<string, string | null>,
  expected: Map<string, string | null>
): string[] {
  return overwritten.filter((p) => expected.has(p) && p in before && expected.get(p) !== before[p])
}

/** From `from` up to the next user message: one turn. */
function turnFrom(messages: Message[], from: number): Message[] {
  const end = messages.findIndex((m, i) => i >= from && m.role === 'user')
  return messages.slice(from, end < 0 ? messages.length : end)
}

function view(key: string, set: VersionSet, onScreen: Message[], ranTurn: Message[]): VersionView {
  const touched = set.ran !== set.current && (editedPaths(onScreen).length > 0 || editedPaths(ranTurn).length > 0)
  const restorable = touched && !!set.tails[set.current]?.files && !!versionCheckpoint(set, set.ran)
  return { key, index: set.current, total: set.tails.length, ranElsewhere: touched ? set.ran : null, restorable }
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
    const turn = turnFrom(messages, prompt + 1)
    const { id, checkpoint } = messages[prompt] as TextMessage
    regens.set(m.id, { promptId: id, files: editedPaths(turn), ...(checkpoint ? { checkpoint } : {}), commands: shellCommands(turn) })
  })
  return regens
}
