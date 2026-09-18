/**
 * A write to Claude's own memory, recognised out of the tool stream.
 *
 * Memory is not a file in the user's project — it is Claude keeping notes about
 * them, in `~/.claude/projects/<slug>/memory/`. The backend already treats those
 * paths as its own (`is_claude_owned_file` in `claude.rs`, which is why a memory
 * write never raises the permission gate); this is the same rule on the renderer
 * side, so the transcript can name the act instead of showing a path nobody
 * recognises folded into "Created 1 file, Edited 2 files".
 */
import type { ToolCallMessage } from '../store/sessions'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

const MEMORY_TYPES = new Set<string>(['user', 'feedback', 'project', 'reference'])

export type MemoryWrite = {
  toolId: string
  filePath: string
  /** MEMORY.md — the index of memories, not a memory itself. */
  isIndex: boolean
  /** The file did not exist before this write. Unknown reads as "updated". */
  created: boolean
  /** How the memory tab would name it, so both surfaces say the same thing. */
  displayName: string
  description?: string
  type?: MemoryType
  status: 'pending' | 'done' | 'failed'
}

/** Only file writes can be memory writes; a Read of one is recall, not a record. */
const WRITE_TOOLS = new Set(['Write', 'Edit'])

/**
 * The memory file this tool call writes, or null for anything else.
 *
 * Deliberately narrower than "anywhere under `.claude`" — agent definitions,
 * settings and hooks live there too, and a write to one of those is a change to
 * the user's setup that should read as exactly that.
 */
export function memoryFilePath(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null
  const path = String(input.file_path ?? input.path ?? '')
  if (!path.endsWith('.md')) return null
  if (!path.includes('/.claude/projects/') || !path.includes('/memory/')) return null
  return path
}

/** A denied write recorded nothing, so it stays an ordinary tool line. */
export function isMemoryWrite(message: ToolCallMessage): boolean {
  if (message.denied) return false
  return memoryFilePath(message.tool_name, message.input) !== null
}

/** `project_nyra_tauri_port.md` → `nyra tauri port`, matching the memory tab. */
export function memoryDisplayName(fileName: string): string {
  return fileName
    .replace(/\.md$/, '')
    .replace(/^(project|feedback|user|reference)_/, '')
    .replace(/_/g, ' ')
}

/**
 * `description` and `type` out of a memory's YAML frontmatter.
 *
 * Lines are trimmed before matching because the memory format nests `type:`
 * under `metadata:` — an unindented match finds the description and nothing
 * else, which is how the memory tab ended up with no type badges. The key is
 * compared whole so `node_type:`, which sits right above it, is not mistaken
 * for it.
 */
export function parseMemoryFrontmatter(content: string): {
  name?: string
  description?: string
  type?: MemoryType
} {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}

  const out: { name?: string; description?: string; type?: MemoryType } = {}
  for (const line of content.slice(3, end).split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = unquote(line.slice(colon + 1).trim())
    if (!value) continue
    if (key === 'name') out.name = value
    else if (key === 'description') out.description = value
    else if (key === 'type' && MEMORY_TYPES.has(value.toLowerCase())) {
      out.type = value.toLowerCase() as MemoryType
    }
  }
  return out
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}

/**
 * What the file holds after this call, so an Edit describes itself as well as a
 * Write does.
 *
 * `originalContent` is the whole pre-edit file — the backend reads it before the
 * tool runs so a change can be reverted — so replaying the edit onto it gives
 * the frontmatter even when the edit only touched the body. Without it, all
 * there is to go on is the fragment.
 */
export function resultingContent(message: ToolCallMessage): string {
  if (message.tool_name === 'Write') return String(message.input.content ?? '')

  const oldStr = String(message.input.old_string ?? '')
  const newStr = String(message.input.new_string ?? '')
  const original = message.originalContent
  if (original == null) return newStr
  if (!oldStr) return original
  // split/join rather than String.replace: a replacement containing `$&` or
  // `$1` is a memory about regexes, not a backreference.
  if (message.input.replace_all === true) return original.split(oldStr).join(newStr)
  const at = original.indexOf(oldStr)
  if (at === -1) return original
  return original.slice(0, at) + newStr + original.slice(at + oldStr.length)
}

/** Whether the tool reported a failure, going by the same text the card shows. */
function failed(result: string): boolean {
  return /^(error|<tool_use_error>)/i.test(result.trim())
}

/** The memory a tool call recorded, or null if it recorded none. */
export function memoryWriteFrom(message: ToolCallMessage): MemoryWrite | null {
  const filePath = memoryFilePath(message.tool_name, message.input)
  if (!filePath || message.denied) return null

  const fileName = filePath.split('/').pop() ?? filePath
  const isIndex = fileName === 'MEMORY.md'
  const front = isIndex ? {} : parseMemoryFrontmatter(resultingContent(message))

  return {
    toolId: message.tool_id,
    filePath,
    isIndex,
    // `null` is the backend saying it looked and found no file. An absent field
    // is a call from before that was recorded, which reads as an update.
    created: message.tool_name === 'Write' && message.originalContent === null,
    displayName: front.name ?? memoryDisplayName(fileName),
    description: front.description,
    type: front.type,
    status:
      message.result === undefined ? 'pending' : failed(message.result) ? 'failed' : 'done'
  }
}

/**
 * The headline for a run of memory writes.
 *
 * Saving one memory is usually two writes — the memory, then a pointer line in
 * MEMORY.md — so the index is counted as bookkeeping under whatever it
 * accompanies rather than announced as a second event.
 */
export function summarizeMemoryWrites(writes: MemoryWrite[]): string {
  const entries = writes.filter((w) => !w.isIndex)
  if (writes.some((w) => w.status === 'pending')) return 'Saving to memory…'
  if (writes.every((w) => w.status === 'failed')) return 'Memory could not be saved'

  if (entries.length === 0) return 'Memory index updated'
  if (entries.length === 1) {
    return entries[0].created ? 'Project memory saved' : 'Project memory updated'
  }
  // No count: the names follow the headline, and they carry it better.
  return 'Project memories updated'
}
