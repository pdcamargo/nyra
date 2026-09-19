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
  BundledSkill,
  BrowserEvent,
  BrowserReply,
  BrowserStatus,
  BrowserTab,
  DirListing,
  EditorApp,
  FileEntry,
  FileStamp,
  McpEntry,
  MemoryListResult,
  ProcessFileResult,
  ReadTextOutcome,
  TreeSearchResult,
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

const EVENT_NAMES = [
  'claude:event',
  'claude:permission',
  'workflow:event',
  'processes:update',
  'login:data',
  'login:exit',
  'terminal:data',
  'terminal:exit',
  'browser:event'
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
    version: () => call<string>('app_version')
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

    dispose: (nyraSessionId: string) => call<void>('claude_dispose', { nyraSessionId }),

    saveImage: (base64: string, mediaType: string) =>
      call<string>('claude_save_image', { base64, mediaType }),

    processFile: (filePath: string) =>
      call<ProcessFileResult>('claude_process_file', { filePath }),

    saveTempFile: (base64: string, name: string) =>
      call<string | null>('claude_save_temp_file', { base64, name }),

    checkBinary: (customPath?: string) =>
      call<{ found: boolean; path: string; version?: string }>('claude_check_binary', {
        customPath: customPath ?? null
      })
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
    homedir: () => call<string>('system_homedir')
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
    list: (cwd: string) => call<McpEntry[]>('mcp_list', { cwd })
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
    kill: (nyraSessionId: string, shellId: string) =>
      call<{ ok: boolean; error?: string }>('processes_kill', { nyraSessionId, shellId }),
    clear: (nyraSessionId: string) => call<void>('processes_clear', { nyraSessionId }),
    onUpdate: (callback: (event: { nyraSessionId: string; processes: BgProcessRow[] }) => void) =>
      on('processes:update', callback)
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

  browser: {
    /** What the sidecar can see. Starts it, but launches no Chromium — the
     *  panel asks this first so a first run reads as setup, not as an error. */
    status: () => call<BrowserReply<BrowserStatus>>('browser_status'),
    configure: (patch: Record<string, unknown>) => call<BrowserReply>('browser_configure', { patch }),
    install: () => call<BrowserReply>('browser_install'),
    openChat: (chatId: string) =>
      call<BrowserReply<{ cdpUrl: string; viewport: { width: number; height: number } }>>(
        'browser_open_chat',
        { chatId }
      ),
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
