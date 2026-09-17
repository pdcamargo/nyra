export type ThemePreference = 'dark' | 'light' | 'system'

export type NyraSettings = {
  model: string // '' = default, or model ID like 'sonnet', 'opus', 'haiku'
  skipPermissions: boolean
  notifications: boolean
  systemPrompt: string
  claudeBinaryPath: string
  fontSize: 'small' | 'medium' | 'large'
  effort: '' | 'low' | 'medium' | 'high' | 'max'
  planMode: boolean
  autoCompact: boolean
  autoCompactThreshold: number
  onboardingComplete: boolean
  theme: ThemePreference
  allowedTools?: string[] // when set, passed as --allowed-tools to Claude CLI (used by workflow nodes)
  autoApproveTools: string[] // tool names that auto-approve without prompting (e.g., 'Bash', 'Edit')
  /** How many managed worktrees to keep before pruning the oldest idle one. */
  worktreeLimit: number
  /** Off means worktrees are only ever removed by hand. */
  worktreeAutoDelete: boolean
  /** Whether Claude gets the browser tools. Every chat carries their
   *  definitions whether or not it ever browses, so this is a switch. */
  browserTools: boolean
  /** The floating miniature. Codex had to add this switch after the fact; it
   *  costs nothing to have from the start. */
  browserPip: boolean
}

/**
 * The subset of settings that reaches a spawned Claude process, sent with each
 * `claude.query` rather than read from the backend's process-global. This is the
 * seam per-project model/effort overrides hang off: widen `spawnSettingsFor`
 * rather than the global sync.
 */
export type SpawnSettings = Pick<
  NyraSettings,
  | 'model'
  | 'effort'
  | 'systemPrompt'
  | 'planMode'
  | 'allowedTools'
  | 'claudeBinaryPath'
  | 'skipPermissions'
  | 'autoApproveTools'
>

export function spawnSettingsFor(settings: NyraSettings): SpawnSettings {
  return {
    model: settings.model,
    effort: settings.effort,
    systemPrompt: settings.systemPrompt,
    planMode: settings.planMode,
    allowedTools: settings.allowedTools,
    claudeBinaryPath: settings.claudeBinaryPath,
    skipPermissions: settings.skipPermissions,
    autoApproveTools: settings.autoApproveTools
  }
}

export const DEFAULT_SETTINGS: NyraSettings = {
  model: '',
  skipPermissions: false,
  notifications: true,
  systemPrompt: '',
  claudeBinaryPath: 'claude',
  fontSize: 'medium',
  effort: '',
  planMode: false,
  autoCompact: true,
  autoCompactThreshold: 90,
  onboardingComplete: false,
  theme: 'dark',
  autoApproveTools: [],
  worktreeLimit: 15,
  worktreeAutoDelete: true,
  browserTools: true,
  browserPip: true
}
