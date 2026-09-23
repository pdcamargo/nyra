/**
 * `window.api` over Tauri IPC.
 *
 * The Electron build exposed this object from a preload script; every component
 * calls it and nothing else. Keeping the exact same surface here is what let the
 * whole renderer survive the migration untouched — each method is a thin wrapper
 * around one `invoke`, and each `on*` subscription reads from a local bus.
 *
 * Why the bus: Tauri's `listen()` is async, but the Electron API handed back an
 * unsubscribe function synchronously and callers rely on that in `useEffect`
 * cleanups. We attach every backend listener once during `initTauriApi()` — before
 * React mounts — so component-level subscribe/unsubscribe is synchronous and no
 * event can slip through the gap between mount and listener registration.
 */
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import type {
  AgentInfo,
  BgProcessRow,
  ChatMemory,
  CommandInfo,
  BundledSkill,
  BrowserEvent,
  BrowserReply,
  BrowserStatus,
  DesignEntry,
  BrowserTab,
  DevicePreset,
  TabDevice,
  DirListing,
  EditorApp,
  FileEntry,
  FileStamp,
  McpEntry,
  McpHealthResult,
  McpInspection,
  McpToggleResult,
  PluginCatalog,
  PluginActionRequest,
  PluginActionResult,
  MemoryListResult,
  ProcessFileResult,
  ReadTextOutcome,
  TreeSearchResult,
  FileListResult,
  ReadImageResult,
  Scope,
  ScopedList,
  SkillInfo
} from './api-types'
import type { FontFamily } from './api-types'
import type { SpawnSettings } from '@shared/types'
import type {
  MarketplaceIndex,
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowMetrics
} from '@shared/workflow-types'
import type { SubagentWireEntry } from '../store/subagentTranscripts'


/** Options for a dictation session. Mirrors `dictation::StartOptions` in Rust. */
export type DictationStartOptions = {
  model?: string
  /** `undefined` or 'auto' detects; otherwise an ISO code such as 'pt'. */
  language?: string
  device?: string
  /** Terms to bias the transcript towards, **least** valuable first: Whisper
   *  keeps only the last 224 prompt tokens, so the tail is what survives. */
  vocabulary?: string[]
  liveTranscript?: boolean
}

export type DictationModel = {
  id: string
  file: string
  label: string
  bytes: number
  note: string
}

export type DictationStatus = {
  model: string
  installed: boolean
  downloading: boolean
  bytes: number
  label: string
  catalogue: DictationModel[]
  recording: boolean
  devices: string[]
}

export type DictationEvent =
  | { type: 'recording_started' }
  | { type: 'level'; level: number }
  | { type: 'interim'; text: string }
  | { type: 'no_signal'; device: string }
  | { type: 'transcribing' }
  | { type: 'transcript'; text: string }
  | { type: 'cancelled' }
  | { type: 'error'; error: string }
  | { type: 'model_progress'; model: string; received: number; total: number }
  | { type: 'model_ready'; model: string }
  | { type: 'model_cancelled'; model: string }
  | { type: 'model_failed'; model: string; error: string }

const EVENT_NAMES = [
  'claude:event',
  'claude:permission',
  'workflow:event',
  'processes:update',
  'login:data',
  'login:exit',
  'terminal:data',
  'terminal:exit',
  'browser:event',
  'nyra:app-request',
  'nyra:update-available',
  'nyra:designs-changed',
  'dictation:event'
] as const

type EventName = (typeof EVENT_NAMES)[number]
type Handler = (payload: never) => void

const subscribers = new Map<EventName, Set<Handler>>(
  EVENT_NAMES.map((name) => [name, new Set<Handler>()])
)

function on<T>(name: EventName, callback: (payload: T) => void): () => void {
  const set = subscribers.get(name) as Set<(payload: T) => void>
  set.add(callback)
  return () => {
    set.delete(callback)
  }
}

function emit(name: EventName, payload: unknown): void {
  for (const handler of subscribers.get(name) ?? []) {
    try {
      ;(handler as (p: unknown) => void)(payload)
    } catch (err) {
      console.error(`[${name}] handler failed`, err)
    }
  }
}

/** Commands whose Rust side returns `()` still resolve; callers ignore the value. */
const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  invoke<T>(command, args)

export const api = {
  /** Checking for a newer Nyra, and taking it. */
  updates: {
    check: () =>
      call<{ available: boolean; version: string; notes: string; current: string }>(
        'update_check'
      ),
    install: () => call<void>('update_install'),
    version: () => call<string>('app_version'),
    /** Rust found one while answering `nyra_update`. */
    onAvailable: (cb: (p: { version: string }) => void) => on('nyra:update-available', cb)
  },

  /**
   * The half of the app-control bridge that lives on this side.
   *
   * Rust can drive flows and the updater on its own, but the panels, the theme
   * and the command registry are here — so it asks, and this answers. One op
   * name and a JSON payload; nothing evaluates code.
   */
  appControl: {
    onRequest: (cb: (p: { requestId: string; op: string; args: unknown }) => void) =>
      on('nyra:app-request', cb),
    respond: (requestId: string, result: unknown) =>
      call<void>('app_control_response', { requestId, result })
  },

  claude: {
    query: (
      prompt: string,
      cwd: string,
      sessionId: string | null,
      nyraSessionId: string,
      worktreeName?: string,
      settings?: SpawnSettings
    ) =>
      call<{ sessionId: string | null } | { error: string }>('claude_query', {
        prompt,
        cwd,
        sessionId,
        nyraSessionId,
        worktreeName: worktreeName ?? null,
        // Omitted means "use whatever settings_sync last pushed" — the backend
        // falls back to the global so workflow and trigger runs keep working.
        settings: settings ?? null
      }),

    onEvent: (callback: (event: unknown) => void) => on('claude:event', callback),
    onPermission: (callback: (permission: unknown) => void) => on('claude:permission', callback),

    respondPermission: (approved: boolean, nyraSessionId?: string) =>
      call<void>('claude_permission_response', {
        approved,
        nyraSessionId: nyraSessionId ?? null
      }),

    abort: (nyraSessionId?: string) =>
      call<void>('claude_abort', { nyraSessionId: nyraSessionId ?? null }),

    /**
     * Drop a message into the turn that is already running. Resolves false when
     * there was no live turn to drop it into — the caller keeps it queued.
     */
    steer: (prompt: string, nyraSessionId: string) =>
      call<boolean>('claude_steer', { prompt, nyraSessionId }),

    dispose: (nyraSessionId: string) => call<void>('claude_dispose', { nyraSessionId }),

    saveImage: (base64: string, mediaType: string) =>
      call<string>('claude_save_image', { base64, mediaType }),

    processFile: (filePath: string) =>
      call<ProcessFileResult>('claude_process_file', { filePath }),

    saveTempFile: (base64: string, name: string) =>
      call<string | null>('claude_save_temp_file', { base64, name }),

    checkBinary: (customPath?: string) =>
      call<{
        found: boolean
        path: string
        version?: string
        /** Every install in the usual places, so a stale second copy is visible. */
        installs?: { path: string; version: string | null }[]
      }>('claude_check_binary', {
        customPath: customPath ?? null
      }),

    accountStatus: (binaryPath: string) =>
      call<{
        loggedIn: boolean
        loginMethod: string | null
        organization: string | null
        email: string | null
        error: string | null
      }>('claude_account_status', { binaryPath }),

    /**
     * Family → the id this CLI build resolves that alias to, from its catalog.
     *
     * Empty when the scan finds nothing, which every caller already treats as
     * "not known yet".
     */
    modelAliasTargets: () => call<Record<string, string>>('model_alias_targets', {})
  },

  /**
   * Window gestures for the custom title bar.
   *
   * The Electron build got these from `-webkit-app-region: drag`, which is a
   * Chromium extension — WKWebView ignores it, so the title bar has not actually
   * been draggable since the port. Tauri wants the webview to ask the window to
   * move instead.
   */
  appWindow: {
    startDragging: () => getCurrentWindow().startDragging(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize()
  },

  dialog: {
    pickFolder: () => call<string | null>('dialog_pick_folder'),
    pickFile: () => call<string | null>('dialog_pick_file'),
    pickFiles: () => call<string[] | null>('dialog_pick_files'),
    saveFile: (defaultName: string, content: string) =>
      call<{ success?: boolean; canceled?: boolean; error?: string }>('dialog_save_file', {
        defaultName,
        content
      })
  },

  agents: {
    list: (cwd: string) => call<ScopedList<AgentInfo>>('agents_list', { cwd })
  },

  memory: {
    list: (cwd: string) => call<MemoryListResult>('memory_list', { cwd }),
    read: (filePath: string, cwd: string) =>
      call<{ content?: string; error?: string }>('memory_read', { filePath, cwd }),
    write: (filePath: string, content: string, cwd: string) =>
      call<{ success?: boolean; error?: string }>('memory_write', { filePath, content, cwd }),
    delete: (filePath: string, cwd: string) =>
      call<{ success?: boolean; error?: string }>('memory_delete', { filePath, cwd })
  },

  /** Custom slash commands on disk: ~/.claude/commands and .claude/commands. */
  commands: {
    list: (cwd: string) => call<ScopedList<CommandInfo>>('commands_list', { cwd }),
    /** Removes the one `.md` file. Refused unless it sits under
     *  `.claude/commands`, since this is one click inside a dialog. */
    delete: (filePath: string) =>
      call<{ success?: boolean; error?: string }>('commands_delete', { filePath })
  },

  skills: {
    list: (cwd: string) => call<ScopedList<SkillInfo>>('skills_list', { cwd }),
    write: (scope: Scope, name: string, content: string, cwd: string) =>
      call<{ success?: boolean; error?: string }>('skills_write', { scope, name, content, cwd }),
    delete: (filePath: string) =>
      call<{ success?: boolean; error?: string }>('skills_delete', { filePath }),
    /** The skills Nyra ships, and whether it still updates each one. */
    bundledNames: () => call<BundledSkill[]>('skills_bundled_names'),
    /** Reinstall one of those, overwriting whatever is there. Confirm first. */
    restoreBundled: (name: string) =>
      call<{ success?: boolean; error?: string }>('skills_restore_bundled', { name })
  },

  settings: {
    sync: (settings: Record<string, unknown>) => call<void>('settings_sync', { settings })
  },

  fonts: {
    /** Every family installed on this machine. Cached on the Rust side. */
    list: () => call<FontFamily[]>('fonts_list')
  },

  fs: {
    readFile: (filePath: string) =>
      call<{ content?: string; error?: string }>('fs_read_file', { filePath }),
    readImage: (filePath: string) =>
      call<ReadImageResult>('fs_read_image', { filePath }),
    revertFile: (filePath: string, originalContent: string | null) =>
      call<{ success?: boolean; error?: string }>('fs_revert_file', {
        filePath,
        originalContent
      }),
    listFiles: (cwd: string, query: string) =>
      call<FileEntry[]>('fs_list_files', { cwd, query }),
    /** One directory, gitignore-filtered and sorted. Lazy by design — the tree
     *  asks again for each folder it opens. */
    listDir: (dirPath: string) => call<DirListing>('fs_list_dir', { dirPath }),
    /** A file's text for the read-only preview. Bounded, unlike `readFile`,
     *  which backs editors that write what they read back. */
    readTextFile: (filePath: string) => call<ReadTextOutcome>('fs_read_text_file', { filePath }),
    statFile: (filePath: string) => call<FileStamp>('fs_stat_file', { filePath }),
    /** Every file in the repo at `cwd`, for the quick-open picker. */
    listProjectFiles: (cwd: string, limit = 20000) =>
      call<FileListResult>('fs_list_project_files', { cwd, limit }),
    searchTree: (cwd: string, query: string, limit = 200) =>
      call<TreeSearchResult>('fs_search_tree', { cwd, query, limit }),
    /** Editors installed on this machine. Empty off macOS, where the menu falls
     *  back to the system default. */
    listEditors: () => call<EditorApp[]>('fs_list_editors'),
    openWith: (filePath: string, appPath: string | null) =>
      call<{ ok?: boolean; error?: string }>('fs_open_with', { filePath, appPath }),
    reveal: (filePath: string) =>
      call<{ ok?: boolean; error?: string }>('fs_reveal', { filePath })
  },

  system: {
    homedir: () => call<string>('system_homedir'),
    /** Hand a URL to the user's own browser. http(s) only; anything else is
     *  refused in Rust rather than passed to the OS. */
    openExternal: (url: string) => call<{ ok: boolean; error?: string }>('open_external', { url })
  },

  /**
   * The PRs a chat opened.
   *
   * Only the state is asked for — the number came out of the transcript. Every
   * failure mode (`gh` missing, not signed in, offline) answers `{ error }`,
   * and the chip draws neutral rather than claiming a state it does not know.
   */
  pr: {
    state: (url: string) =>
      call<{
        number?: number
        title?: string
        state?: string
        isDraft?: boolean
        error?: string
      }>('pr_state', { url })
  },

  git: {
    branch: (cwd: string) => call<string>('git_branch', { cwd }),
    branchList: (cwd: string) => call<string[]>('git_branch_list', { cwd }),
    checkout: (cwd: string, branch: string, create = false) =>
      call<{ success: boolean; error?: string }>('git_checkout', { cwd, branch, create }),
    isRepo: (cwd: string) => call<boolean>('git_is_repo', { cwd }),
    mainWorktreeRoot: (cwd: string) => call<string | null>('git_main_worktree_root', { cwd }),
    worktreeCreate: (cwd: string, branch: string) =>
      call<{ path: string; branch: string; error?: string }>('git_worktree_create', {
        cwd,
        branch
      }),
    worktreeCreateManaged: (cwd: string, branch: string, baseRef: string | null, seed: boolean) =>
      call<{
        path: string
        branch: string
        managed?: boolean
        seeded?: { patchApplied: boolean; filesCopied: number }
        error?: string
      }>('git_worktree_create_managed', { cwd, branch, baseRef, seed }),
    worktreeList: (cwd: string) =>
      call<{ path: string; branch: string; detached: boolean }[]>('git_worktree_list', { cwd }),
    diffStat: (cwd: string, base: string | null) =>
      call<{ filesChanged: number; insertions: number; deletions: number }>('git_diff_stat', {
        cwd,
        base
      }),
    diffFiles: (cwd: string, base: string | null) =>
      call<import('./api-types').DiffFiles>('git_diff_files', { cwd, base }),
    diffPatch: (
      cwd: string,
      base: string | null,
      path: string,
      untracked: boolean,
      ignoreWhitespace = false
    ) =>
      call<{ patch: string; error?: string }>('git_diff_patch', {
        cwd,
        base,
        path,
        untracked,
        ignoreWhitespace
      }),
    worktreeSnapshot: (worktreePath: string, branch: string, sessionId: string) =>
      call<{ success: boolean; path?: string; error?: string }>('git_worktree_snapshot', {
        worktreePath,
        branch,
        sessionId
      }),
    worktreeRestore: (cwd: string, sessionId: string) =>
      call<{ success: boolean; path?: string; branch?: string; error?: string }>(
        'git_worktree_restore',
        { cwd, sessionId }
      ),
    snapshotExists: (sessionId: string) => call<boolean>('git_snapshot_exists', { sessionId }),
    snapshotDiscard: (sessionId: string) => call<void>('git_snapshot_discard', { sessionId }),
    worktreeMerge: (cwd: string, branch: string) =>
      call<{ success: boolean; into?: string; error?: string }>('git_worktree_merge', {
        cwd,
        branch
      }),
    worktreeRemove: (cwd: string, worktreePath: string) =>
      call<{ success: boolean; error?: string }>('git_worktree_remove', { cwd, worktreePath })
  },

  mcp: {
    list: (cwd: string) => call<McpEntry[]>('mcp_list', { cwd }),
    health: (cwd: string) => call<McpHealthResult>('mcp_health', { cwd }),
    inspect: (cwd: string, name: string) =>
      call<McpInspection>('mcp_inspect', { cwd, name }),
    setEnabled: (cwd: string, name: string, enabled: boolean) =>
      call<McpToggleResult>('mcp_set_enabled', { cwd, name, enabled })
  },

  plugins: {
    catalog: (cwd?: string) =>
      call<PluginCatalog>('plugins_catalog', { cwd: cwd ?? null }),
    action: (request: PluginActionRequest) =>
      call<PluginActionResult>('plugins_action', { request }),
    publicLogos: () => call<Record<string, string>>('plugins_public_logos')
  },

  hooks: {
    read: (scope: Scope, cwd: string) =>
      call<{ hooks: Record<string, unknown> }>('hooks_read', { scope, cwd }),
    write: (scope: Scope, hooks: unknown, cwd: string) =>
      call<{ success?: boolean; error?: string }>('hooks_write', { scope, hooks, cwd })
  },

  workflow: {
    list: () => call<WorkflowDefinition[]>('workflow_list'),
    load: (id: string) => call<WorkflowDefinition | null>('workflow_load', { id }),
    save: (workflow: unknown) =>
      call<{ success?: boolean; error?: string }>('workflow_save', { workflow }),
    delete: (id: string) => call<{ success?: boolean; error?: string }>('workflow_delete', { id }),
    run: (workflowId: string, cwd: string, inputValues?: Record<string, string>) =>
      call<{ executionId?: string; error?: string }>('workflow_run', {
        workflowId,
        cwd,
        inputValues: inputValues ?? null
      }),
    abort: (executionId: string) => call<void>('workflow_abort', { executionId }),
    templates: () => call<WorkflowDefinition[]>('workflow_templates'),
    reviewResponse: (executionId: string, nodeId: string, approved: boolean) =>
      call<{ ok: boolean }>('workflow_review_response', { executionId, nodeId, approved }),
    listExecutions: (workflowId?: string) =>
      call<WorkflowExecutionRecord[]>('workflow_executions_list', {
        workflowId: workflowId ?? null
      }),
    getExecution: (id: string) => call<WorkflowExecutionRecord | null>('workflow_executions_get', { id }),
    deleteExecution: (id: string) =>
      call<{ success?: boolean; error?: string }>('workflow_executions_delete', { id }),
    metrics: (workflowId: string) => call<WorkflowMetrics | null>('workflow_metrics', { workflowId }),
    testTrigger: (workflowId: string, triggerId: string) =>
      call<{ ok: boolean; error?: string }>('workflow_trigger_test', { workflowId, triggerId }),
    generateTriggerToken: () => call<{ token: string }>('workflow_trigger_generate_token'),
    webhookUrl: (workflowId: string, triggerId: string, token: string) =>
      call<{ url: string | null }>('workflow_trigger_webhook_url', {
        workflowId,
        triggerId,
        token
      }),
    marketplaceList: (forceRefresh?: boolean) =>
      call<{ index?: MarketplaceIndex; error?: string }>('marketplace_list', {
        forceRefresh: forceRefresh ?? false
      }),
    marketplaceInstall: (entry: unknown) =>
      call<{ workflow?: WorkflowDefinition; error?: string }>('marketplace_install', { entry }),
    marketplaceShare: (workflow: unknown) => call<{ ok: boolean }>('marketplace_share', { workflow }),
    marketplaceOpen: () => call<{ ok: boolean }>('marketplace_open'),
    exportWorkflow: (workflow: unknown) =>
      call<{ success?: boolean; canceled?: boolean; path?: string; error?: string }>(
        'workflow_export',
        { workflow }
      ),
    importWorkflow: () =>
      call<{ success?: boolean; canceled?: boolean; workflow?: unknown; error?: string }>(
        'workflow_import'
      ),
    /** Stop this flow's runs without needing an execution id. */
    abortFlow: (workflowId: string) =>
      call<{ aborted: number }>('workflow_abort_flow', { workflowId }),
    onEvent: (callback: (event: unknown) => void) => on('workflow:event', callback)
  },

  processes: {
    list: (nyraSessionId: string) => call<BgProcessRow[]>('processes_list', { nyraSessionId }),
    memory: (nyraSessionId: string) =>
      call<ChatMemory>('processes_memory', { nyraSessionId }),
    kill: (nyraSessionId: string, shellId: string) =>
      call<{ ok: boolean; error?: string }>('processes_kill', { nyraSessionId, shellId }),
    clear: (nyraSessionId: string) => call<void>('processes_clear', { nyraSessionId }),
    onUpdate: (callback: (event: { nyraSessionId: string; processes: BgProcessRow[] }) => void) =>
      on('processes:update', callback)
  },

  subagents: {
    /** A finished agent's transcript, off disk, for a tab opened after the fact. */
    transcript: (path: string) =>
      call<{ model: string | null; entries: SubagentWireEntry[] }>('subagent_transcript', { path })
  },

  login: {
    start: () => call<{ pid?: number; error?: string }>('login_start'),
    input: (data: string) => call<void>('login_input', { data }),
    resize: (cols: number, rows: number) => call<void>('login_resize', { cols, rows }),
    cancel: () => call<void>('login_cancel'),
    onData: (callback: (event: { data: string }) => void) => on('login:data', callback),
    onExit: (callback: (event: { exitCode: number; success: boolean }) => void) =>
      on('login:exit', callback)
  },

  /**
   * Designs: the index Rust owns, and the raster the sidecar produces.
   *
   * Rendering itself is not here — it happens in the renderer, which has React
   * and the design package. This is only the two things the renderer cannot do
   * itself: durable storage and a headless browser.
   */
  design: {
    raster: (request: Record<string, unknown>) =>
      call<{ ok: boolean; path?: string; width?: number; height?: number; cached?: boolean; error?: string }>(
        'design_raster',
        { request }
      ),
    list: (project?: string) => call<DesignEntry[]>('design_list', { project: project ?? null }),
    create: (name: string, project: string) =>
      call<{ ok: boolean; design?: DesignEntry; error?: string }>('design_create', { name, project }),
    adopt: (name: string, path: string, project: string) =>
      call<{ ok: boolean; design?: DesignEntry; error?: string }>('design_adopt', { name, path, project }),
    relocate: (id: string, to: string) =>
      call<{ ok: boolean; design?: DesignEntry; error?: string }>('design_relocate', { id, to }),
    rename: (id: string, name: string) =>
      call<{ ok: boolean; design?: DesignEntry; error?: string }>('design_rename', { id, name }),
    forget: (id: string, deleteFile = false) =>
      call<{ ok: boolean; error?: string }>('design_forget', { id, deleteFile }),
    /** Fires when the index changes, so a list never has to be refreshed by
     *  hand after Claude registers a design mid-conversation. */
    onChanged: (callback: () => void) => on<unknown>('nyra:designs-changed', () => callback())
  },

  browser: {
    /** What the sidecar can see. Starts it, but launches no Chromium — the
     *  panel asks this first so a first run reads as setup, not as an error. */
    status: () => call<BrowserReply<BrowserStatus>>('browser_status'),
    configure: (patch: Record<string, unknown>) => call<BrowserReply>('browser_configure', { patch }),
    install: () => call<BrowserReply>('browser_install'),
    /** `hostDpr` has to be decided here: Playwright takes the pixel ratio from
     *  context options, so the context cannot be built without it. */
    openChat: (chatId: string, hostDpr: number) =>
      call<
        BrowserReply<{
          cdpUrl: string
          viewport: { width: number; height: number }
          device: TabDevice
          devices: DevicePreset[]
        }>
      >('browser_open_chat', { chatId, hostDpr }),
    closeChat: (chatId: string) => call<BrowserReply<{ closed: boolean }>>('browser_close_chat', { chatId }),
    /** Ping while a surface for this chat is on screen, or the sidecar evicts
     *  its context to reclaim the ~300 MB it costs. */
    touch: (chatId: string) => call<BrowserReply<{ touched: boolean }>>('browser_touch', { chatId }),
    tabCreate: (chatId: string, url: string) =>
      call<BrowserReply<{ tab: BrowserTab }>>('browser_tab_create', { chatId, url }),
    tabClose: (chatId: string, tabId: string) =>
      call<BrowserReply<{ closed: boolean }>>('browser_tab_close', { chatId, tabId }),
    tabNavigate: (chatId: string, tabId: string, url: string) =>
      call<BrowserReply<{ url: string }>>('browser_tab_navigate', { chatId, tabId, url }),
    /** One method for the menu and for the agent alike — see the sidecar's
     *  `tab.setViewport`. `id` is a preset, `responsive`, or `custom`. */
    tabSetViewport: (
      chatId: string,
      tabId: string,
      spec: { id: string; width?: number; height?: number; by?: 'user' | 'agent' }
    ) =>
      call<BrowserReply<{ device: TabDevice }>>('browser_tab_set_viewport', {
        chatId,
        tabId,
        ...spec
      }),
    /** A full-resolution still, taken from the sidecar's session — see
     *  `browser::target_screenshot` for why not the renderer's. */
    targetScreenshot: (targetId: string) =>
      call<BrowserReply<{ data: string; width: number; height: number }>>(
        'browser_target_screenshot',
        { targetId }
      ),
    tabHistory: (chatId: string, tabId: string, action: 'back' | 'forward' | 'reload') =>
      call<BrowserReply<{ url: string | null }>>('browser_tab_history', { chatId, tabId, action }),
    tabList: (chatId: string) => call<BrowserReply<{ tabs: BrowserTab[] }>>('browser_tab_list', { chatId }),
    onEvent: (callback: (event: BrowserEvent) => void) => on('browser:event', callback)
  },

  terminal: {
    spawn: (id: string, cwd: string) => call<{ pid: number }>('terminal_spawn', { id, cwd }),
    write: (id: string, data: string) => call<void>('terminal_write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      call<void>('terminal_resize', { id, cols, rows }),
    kill: (id: string) => call<void>('terminal_kill', { id }),
    onData: (callback: (event: { id: string; data: string }) => void) => on('terminal:data', callback),
    onExit: (callback: (event: { id: string; exitCode: number }) => void) =>
      on('terminal:exit', callback)
  },

  /**
   * Voice dictation. Audio is captured and transcribed in Rust, so nothing
   * here moves samples across the bridge — the renderer says start and stop,
   * and text comes back on `dictation:event`.
   */
  dictation: {
    start: (options: DictationStartOptions) =>
      call<{ ok?: true; error?: string }>('dictation_start', { options }),
    stop: () => call<void>('dictation_stop'),
    cancel: () => call<void>('dictation_cancel'),
    status: (model?: string) => call<DictationStatus>('dictation_status', { model }),
    modelDownload: (model: string) =>
      call<{ ok?: true; error?: string }>('dictation_model_download', { model }),
    modelCancel: () => call<void>('dictation_model_cancel'),
    onEvent: (callback: (event: DictationEvent) => void) => on('dictation:event', callback)
  }
}

export type NyraApi = typeof api

/**
 * Attach the backend listeners and publish `window.api`. Must resolve before the
 * React tree mounts.
 */
export async function initTauriApi(): Promise<void> {
  await Promise.all(
    EVENT_NAMES.map((name) => listen(name, (event) => emit(name, event.payload)))
  )
  ;(window as unknown as { api: NyraApi }).api = api
}
