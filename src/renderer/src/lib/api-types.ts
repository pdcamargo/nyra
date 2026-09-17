/**
 * Data shapes the Rust backend returns.
 *
 * These mirror the `#[derive(Serialize)]` structs in `src-tauri/src` — keep the
 * two in step. They live apart from `tauri-api.ts` so `env.d.ts` can re-export
 * them into the global scope, where components have always referenced them.
 */
export type Scope = 'global' | 'project'

export type SkillInfo = {
  name: string
  description: string
  scope: Scope
  filePath: string
}

export type AgentInfo = {
  name: string
  description: string
  scope: Scope
}

export type ScopedList<T> = {
  global: T[]
  project: T[]
}

export type MemorySource = 'project-memory' | 'global-claude' | 'project-claude' | 'subagent-claude'
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryFile = {
  filePath: string
  source: MemorySource
  name: string
  description?: string
  memoryType?: MemoryType
  exists: boolean
  size?: number
  mtime?: number
  isIndex?: boolean
}

export type MemoryListResult = {
  projectMemoryDir: string
  files: MemoryFile[]
  error?: string
}

export type ProcStatus = 'running' | 'exited' | 'killed' | 'orphaned' | 'untracked' | 'stopped'

export type BgProcessRow = {
  /** Claude's `tool_use_id` for the originating Bash call. */
  shellId: string
  /** Claude's task-registry id, e.g. "b407td0kk". */
  taskId: string | null
  description: string | null
  command: string
  outputFile: string | null
  startedAt: number
  endedAt: number | null
  pid: number | null
  status: ProcStatus
  exitCode: number | null
  lastOutput: string | null
  lastOutputAt: number | null
}

export type McpEntry = {
  name: string
  command?: string
  args?: string[]
  url?: string
  scope: Scope
}

/** A prompt attachment after the backend extracted its text. */
export type ProcessedFile = {
  id: string
  name: string
  path: string
  size: number
  category: 'image' | 'document' | 'text'
  extractedText?: string
  base64?: string
  mediaType?: string
}

/**
 * `claude_process_file` answers with either a ProcessedFile or `{ error }`, so
 * every field is optional at the call site until `error` has been checked.
 */
export type ProcessFileResult = Partial<ProcessedFile> & { error?: string }

/**
 * `fs_read_image` answers with base64 bytes or `{ error }`. `missing` marks the
 * one error worth retrying — a file Claude referenced before it wrote it — so
 * callers don't have to string-match an OS message.
 */
export type ReadImageResult = {
  base64?: string
  mediaType?: string
  error?: string
  missing?: boolean
}

export type FileEntry = {
  path: string
  type: 'file' | 'folder'
}
