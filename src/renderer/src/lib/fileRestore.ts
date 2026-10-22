import { editedPaths } from './promptTimeline'
import { spawnSettingsForSession } from './spawnSettings'
import { chatEditedPaths, lastWritten, overwrittenEdits, shellCommands, turnHashes, versionCheckpoint } from './versions'
import { useSessionsStore, versionStart, type Session, type TextMessage, type VersionSet } from '../store/sessions'
import { useRestoresStore } from '../store/restores'
import { capabilitiesOf } from './providers'

/**
 * Putting a version's files back: the renderer's half of `checkpoints.rs`.
 *
 * Two rules hold it together. Whenever a version stops being the one on disk,
 * its files are copied first (`copyFiles`, or the copy `rewindFiles` takes on
 * its way), and the copy is recorded on its tail. And every restore is the
 * same move: rewind to a turn's checkpoint, then write a copy over the result
 * when there is one — `rewindFiles`, whichever button asked.
 */

function session(sid: string): Session | undefined {
  return useSessionsStore.getState().sessions.find((s) => s.id === sid)
}

/** Copy every file the chat has edited, for the version leaving the disk.
 *  Null when there is nothing to copy, or the copy could not be taken. */
export async function copyFiles(sid: string): Promise<string | null> {
  const s = session(sid)
  if (!s) return null
  const paths = chatEditedPaths(s.messages, s.versions)
  if (paths.length === 0) return null
  const copied = await window.api.checkpoints.capture(sid, s.cwd, paths).catch(() => null)
  return copied && 'capture' in copied ? copied.capture : null
}

/** What a restore puts back, and what to say about it afterwards. */
export type Rewind = {
  /** The user message uuid whose turn, and everything after it, is undone. */
  checkpoint: string
  /** A copy to write over the rewound files: a version's own result. */
  overlay: string | null
  /** The message the progress, or a failure, shows under. */
  at: string
  /** Where the report goes once it worked, when that is somewhere else: an
   *  edit's new message, which does not exist until the files are back. */
  reportAt?: string
  version: number | null
  /** The version the replaced files' copy is kept with. */
  savedWith: number | null
  /** Shell commands among what is undone. */
  commands: string[]
  /** What Claude last left in each file, along whatever is on disk now. */
  expected: Map<string, string | null>
}

/** The CLI's refusals, in the words the note uses. */
function plain(error: string): string {
  if (/no file checkpoint/i.test(error)) return 'Claude has no record of these files from that point.'
  return error
}

/**
 * Put the files back. Answers the copy taken of what was there, for the
 * caller to record on the version it replaced, or null when nothing changed.
 * Either way the chat's note says what happened, when there is anything to say.
 */
export async function rewindFiles(sid: string, r: Rewind): Promise<{ files: string } | null> {
  const s = session(sid)
  if (!s) return null
  const restores = useRestoresStore.getState()
  const failed = (error: string): null => {
    restores.finish(sid, { at: r.at, version: r.version, overwritten: [], savedWith: null, commands: [], error })
    return null
  }
  // Nothing has run here since checkpoints existed, so there is nothing to fork.
  if (!s.diskSession) return failed('No turn here has recorded its files yet.')

  restores.start(sid, r.at)
  const result = await window.api.checkpoints
    .restore({
      chatId: sid,
      cwd: s.cwd,
      sessionId: s.diskSession,
      checkpoint: r.checkpoint,
      paths: chatEditedPaths(s.messages, s.versions),
      overlay: r.overlay,
      settings: spawnSettingsForSession(sid)
    })
    .catch((e: unknown) => ({ error: String(e) }))
  if ('error' in result) return failed(plain(result.error))

  const overwritten = overwrittenEdits(result.overwritten, result.before, r.expected)
  const quiet = overwritten.length === 0 && r.commands.length === 0
  restores.finish(
    sid,
    quiet ? null : { at: r.reportAt ?? r.at, version: r.version, overwritten, savedWith: r.savedWith, commands: r.commands }
  )
  return { files: result.capture }
}

/**
 * The files, before a run that rewinds the conversation to `messageId`: put
 * back to before its turn when `restore` is asked, copied as they are when not.
 * Either way the copy is the version leaving the disk, for `branchAt` to keep.
 * Null when a restore was asked and could not be done; the run should not go.
 * `reportAt` is the message the run will show its note under.
 */
export async function filesBeforeRun(
  sid: string,
  messageId: string,
  kind: VersionSet['kind'],
  restore: boolean,
  reportAt: string
): Promise<{ files: string | null } | null> {
  const s = session(sid)
  const idx = s?.messages.findIndex((m) => m.id === messageId) ?? -1
  const m = s?.messages[idx] as TextMessage | undefined
  if (!s || !m) return null
  // Only the CLI that checkpointed the turn can rewind its files; a chat on one
  // that cannot copies them as they are, the way an edit without restore does.
  if (!restore || !m.checkpoint || !capabilitiesOf(s).fileRestore) return { files: await copyFiles(sid) }

  const key = kind === 'prompt' ? m.promptVersions : m.replyVersions
  const set = key ? s.versions?.[key] : undefined
  const restored = await rewindFiles(sid, {
    checkpoint: m.checkpoint,
    overlay: null,
    at: messageId,
    reportAt,
    version: null,
    // What is on disk now is the version that ran, which is about to be put away.
    savedWith: (set?.ran ?? 0) + 1,
    commands: shellCommands(s.messages.slice(kind === 'prompt' ? idx : idx + 1)),
    expected: lastWritten(turnHashes(s.messages))
  })
  return restored ? { files: restored.files } : null
}

/**
 * Put the files of the version on screen back: rewind what the version on disk
 * did, then write this one's copy over it. `at` is where its note sits.
 */
export async function restoreVersion(sid: string, key: string, at: string): Promise<void> {
  const s = session(sid)
  const vs = s?.versions?.[key]
  if (!s || !vs || vs.ran === vs.current) return
  const checkpoint = versionCheckpoint(vs, vs.ran)
  const overlay = vs.tails[vs.current]?.files
  const start = versionStart(s.messages, key, vs.kind)
  if (!checkpoint || !overlay || start < 0) return

  // What Claude left on disk came from the version that ran, not the one on
  // screen — and for a regenerated turn, not from the prompt's own run either.
  const ran = vs.tails[vs.ran]
  const before = s.messages.slice(0, vs.kind === 'reply' ? start - 1 : start)
  const expected = lastWritten([
    ...turnHashes(before),
    ...(vs.kind === 'reply' ? [ran.run?.fileHashes] : []),
    ...turnHashes(ran.messages)
  ])
  const restored = await rewindFiles(sid, {
    checkpoint,
    overlay,
    at,
    version: vs.current + 1,
    savedWith: vs.ran + 1,
    commands: shellCommands(ran.messages),
    expected
  })
  if (restored) useSessionsStore.getState().markVersionRestored(sid, key, restored.files)
}

/**
 * At the end of a turn, what it left in each file it edited. Later, a restore
 * that finds something else there knows it was not Claude's doing.
 */
export async function recordTurnFiles(sid: string): Promise<void> {
  const s = session(sid)
  if (!s) return
  let at = -1
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    if (m.role === 'user' && (m as TextMessage).checkpoint) {
      at = i
      break
    }
  }
  if (at < 0) return
  const paths = editedPaths(s.messages.slice(at + 1))
  if (paths.length === 0) return
  const hashes = await window.api.checkpoints.hashes(s.cwd, paths).catch(() => null)
  if (hashes) useSessionsStore.getState().setFileHashes(sid, s.messages[at].id, hashes)
}

