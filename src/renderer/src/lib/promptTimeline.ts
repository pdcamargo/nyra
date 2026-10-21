import type { Message, TextMessage, ToolCallMessage } from '../store/sessions'

/**
 * Your prompts, in order, each with what its turn changed.
 *
 * Read off the transcript and nothing else, so the rail and the outline draw
 * for free on every render. A turn is everything from one user message to the
 * next.
 *
 * What it changed comes from one of two places. A `nyra-changes` block is the
 * better one: git's own counts, and a `base` that keeps the diff honest after a
 * commit. When the turn carried none, the edit tools' inputs stand in. Their
 * counts are lines written and lines replaced rather than a real diff, and
 * anything the shell changed is missing, but every turn that edited a file has
 * them.
 */

export type TimelineFile = {
  /** As the source names it: repo-relative from a block, absolute from a tool. */
  path: string
  insertions: number
  deletions: number
}

export type TimelinePrompt = {
  /** The user message's id, which is what a jump scrolls to. */
  id: string
  /** 1-based, the way the outline numbers them. */
  n: number
  /** The first line that has anything on it. */
  text: string
  at?: number
  /** From the prompt to the turn's last message. Absent while it is the only one. */
  durationMs?: number
  files: TimelineFile[]
  /** Set when `files` came from a `nyra-changes` block; that block's SHA. */
  base?: string
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function lines(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  return value.replace(/\n$/, '').split('\n').length
}

/** One tool call's contribution, or null when it did not land. */
function editOf(call: ToolCallMessage): TimelineFile | null {
  if (!EDIT_TOOLS.has(call.tool_name) || call.denied || call.isError) return null
  const input = call.input
  const path = (input.file_path ?? input.notebook_path) as string | undefined
  if (typeof path !== 'string' || path.length === 0) return null
  switch (call.tool_name) {
    case 'Edit':
      return { path, insertions: lines(input.new_string), deletions: lines(input.old_string) }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      return {
        path,
        insertions: edits.reduce((n, e) => n + lines(e.new_string), 0),
        deletions: edits.reduce((n, e) => n + lines(e.old_string), 0)
      }
    }
    case 'Write':
      return { path, insertions: lines(input.content), deletions: lines(call.originalContent) }
    default:
      return { path, insertions: lines(input.new_source), deletions: 0 }
  }
}

/** One row per path, summed, biggest first. */
function merge(entries: TimelineFile[]): TimelineFile[] {
  const byPath = new Map<string, TimelineFile>()
  for (const e of entries) {
    const prev = byPath.get(e.path)
    byPath.set(
      e.path,
      prev ? { path: e.path, insertions: prev.insertions + e.insertions, deletions: prev.deletions + e.deletions } : e
    )
  }
  return [...byPath.values()].sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions))
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
}

export function buildTimeline(messages: Message[]): TimelinePrompt[] {
  const prompts: TimelinePrompt[] = []
  let current: TimelinePrompt | null = null
  let edits: TimelineFile[] = []
  let blocks: TimelineFile[] = []
  let base: string | undefined
  let last: number | undefined

  const close = (): void => {
    if (!current) return
    if (blocks.length > 0) {
      current.files = merge(blocks)
      if (base) current.base = base
    } else {
      current.files = merge(edits)
    }
    if (current.at !== undefined && last !== undefined && last > current.at) current.durationMs = last - current.at
    prompts.push(current)
  }

  for (const m of messages) {
    if (m.role === 'user') {
      close()
      const text = firstLine((m as TextMessage).text) || 'Attachment'
      current = { id: m.id, n: prompts.length + 1, text, at: m.timestamp, files: [] }
      edits = []
      blocks = []
      base = undefined
      last = m.timestamp
      continue
    }
    if (!current) continue
    if (m.timestamp !== undefined) last = m.timestamp
    if (m.role === 'tool_call') {
      const edit = editOf(m)
      if (edit) edits.push(edit)
    } else if (m.role === 'assistant' && m.changes) {
      // The latest block wins rather than adding up: a second block in one turn
      // is a fuller account of the same work, not more of it.
      blocks = m.changes.files
      base = m.changes.base || undefined
    }
  }
  close()
  return prompts
}

/** The file's name, for a chip; the path stays in its tooltip. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
