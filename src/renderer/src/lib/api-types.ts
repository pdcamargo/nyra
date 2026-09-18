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

/** One row in the file tree. `name` is a base name — the caller knows the
 *  directory it asked about and joins them itself. */
export type DirEntryInfo = {
  name: string
  type: 'dir' | 'file'
  symlink: boolean
  size: number
}

export type DirListing = {
  path: string
  entries: DirEntryInfo[]
  /** Hit the per-directory cap. Shown as a count; there is nothing to page to. */
  truncated: boolean
  /** False when there is no git repo above `path`, so nothing was filtered. */
  ignoreApplied: boolean
  error?: string
}

/** A flat search result. The filter box is a mode switch rather than a tree
 *  filter: a lazily-expanded tree only holds what you already opened, so
 *  filtering it would match nothing in a fresh panel and look broken. */
export type TreeSearchResult = {
  paths: string[]
  truncated: boolean
}

/** An editor this machine actually has. Detected, not hardcoded. */
export type EditorApp = { name: string; path: string }

export type TextFileResult = {
  kind: 'text'
  content: string
  truncated: boolean
  totalBytes: number
  returnedBytes: number
  /** Invalid UTF-8 was replaced rather than refused. */
  lossy: boolean
  mtimeMs: number
  ino: number
}

/** Why a preview did or did not happen. Switched on by name, never by parsing
 *  an OS error string. */
export type ReadTextOutcome =
  | TextFileResult
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number; limit: number }
  | { kind: 'missing' }
  | { kind: 'notAFile' }
  | { kind: 'error'; message: string }

/** Enough to notice a file changed underneath an open preview. */
export type FileStamp = {
  exists: boolean
  size: number
  mtimeMs: number
  ino: number
}

export type FileEntry = {
  path: string
  type: 'file' | 'folder'
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** One tab in one chat's browser, as the sidecar sees it. */
export type BrowserTab = {
  tabId: string
  /** The CDP target. The renderer attaches its own session to this to get
   *  pixels — the sidecar is not in the frame path. */
  targetId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserStatus = {
  /** `missing` is a first run, not a failure: Chromium is a download, not part
   *  of the bundle. */
  chromium: 'ready' | 'missing'
  executablePath: string | null
  error: string | null
  running: boolean
  cdpUrl: string | null
  viewport: { width: number; height: number }
  chats: string[]
}

/** Every browser command answers with a state rather than rejecting. */
export type BrowserResult<T = Record<string, never>> = { ok: true } & T
export type BrowserFailure = { ok: false; error: string }
export type BrowserReply<T = Record<string, never>> = BrowserResult<T> | BrowserFailure

/** Sidecar news, forwarded verbatim. `event` names the kind. */
export type BrowserEvent =
  | { event: 'ready'; params?: Record<string, unknown> }
  | { event: 'browser'; params: { state: 'launching' | 'ready' | 'gone'; cdpUrl?: string } }
  | { event: 'install'; params: { state: 'downloading' | 'done' | 'failed'; percent?: number; totalMb?: number } }
  | { event: 'tabs'; params: { chatId: string; tabs: BrowserTab[] } }
  | { event: 'cursor'; params: { chatId: string; tabId: string; x: number; y: number } }
  | { event: 'evicted'; params: { chatId: string } }
  | { event: 'exit'; params: { code: number } }

/** One installed font family, from the `fonts_list` command. */
export type FontFamily = {
  name: string
  /** Set when any face in the family reports itself monospaced; drives the
   *  code-font picker's filter. */
  monospaced: boolean
}
