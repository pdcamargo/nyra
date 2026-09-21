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

/**
 * A skill Nyra ships into `~/.claude/skills`.
 *
 * `managed` — Nyra wrote it and still updates it.
 * `adopted` — someone edited it, so Nyra stopped touching it. Updates have
 *             silently stopped, which is the one state worth surfacing.
 * `removed` — deleted on purpose; Nyra will not reinstall it unprompted.
 */
export type BundledSkill = {
  name: string
  status: 'managed' | 'adopted' | 'removed'
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

/** One changed file, as `git_diff_files` reports it. Stat-only — the patch for a
 *  row arrives from `git_diff_patch` when that row is opened. */
export type ChangedFile = {
  path: string
  /** Git's status letter: A added, M modified, D deleted, R renamed. */
  status: string
  insertions: number
  deletions: number
  /** Git reported `-` for the counts; there are no lines to show. */
  binary: boolean
  /** Never seen by git, so its patch needs `--no-index`. */
  untracked: boolean
}

export type DiffFiles = {
  /** False when the base ref no longer exists — rebased away, or a fresh clone.
   *  Distinct from "nothing changed", which the card must not render as. */
  baseResolved: boolean
  files: ChangedFile[]
}

/**
 * A size a page can be rendered at.
 *
 * `deviceScaleFactor: null` on a preset means "whatever this screen is" — a
 * desktop preset should render the way the viewer's own browser would, while a
 * phone carries a pixel ratio of its own because that is a fact about the
 * device. The sidecar resolves the null before it ever reaches a tab.
 */
export type DevicePreset = {
  id: string
  label: string
  width: number
  height: number
  deviceScaleFactor: number | null
  mobile: boolean
  hasTouch: boolean
}

/**
 * The size one tab is actually being rendered at.
 *
 * `id` doubles as the mode: `responsive` means it follows the panel and will be
 * re-sent on every resize, anything else means it is pinned. `by` is who pinned
 * it, which is the only reason the panel can say a size was chosen by the agent
 * rather than by the person looking at it.
 */
export type TabDevice = {
  id: string
  label: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  hasTouch: boolean
  by: 'user' | 'agent'
}

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
  /** Null only for a tab adopted before the sidecar had a size for it. */
  device: TabDevice | null
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
  /** The menu is built from this rather than from a copy, so it cannot drift
   *  from what the agent's tool will accept. */
  devices: DevicePreset[]
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
  | { event: 'cursor'; params: { chatId: string; tabId: string; x: number; y: number; down: boolean } }
  /** The agent acted on a tab, pointer or not. Having the wheel is a state, so
   *  this is what keeps the ghost on screen between the moves. */
  | { event: 'driving'; params: { chatId: string; tabId: string } }
  | { event: 'evicted'; params: { chatId: string } }
  | { event: 'exit'; params: { code: number } }

/** One installed font family, from the `fonts_list` command. */
export type FontFamily = {
  name: string
  /** Set when any face in the family reports itself monospaced; drives the
   *  code-font picker's filter. */
  monospaced: boolean
}

/**
 * One design in the index.
 *
 * `id` is identity and `path` is a field, which is what makes "save to repo" a
 * one-field update rather than a migration — and what lets the model name a
 * design instead of remembering where it wrote one.
 */
export type DesignEntry = {
  id: string
  name: string
  path: string
  project: string
  updatedAt: string
}
