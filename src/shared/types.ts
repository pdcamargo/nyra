export type ThemePreference = 'dark' | 'light' | 'system'

export type NyraSettings = {
  model: string // '' = default, or model ID like 'sonnet', 'opus', 'haiku'
  skipPermissions: boolean
  notifications: boolean
  systemPrompt: string
  claudeBinaryPath: string
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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
  /** Whether Claude gets the tools that drive Nyra itself. */
  appTools: boolean
  /** Whether Claude gets the tools that operate other apps. Off by default:
   *  on macOS the permission they need is inherited by every command a chat
   *  runs, and on Windows there is no permission at all. */
  desktopTools: boolean
  /** Apps answered "always" in the desktop allow prompt, by the opaque id
   *  Rust gave them. Rust reads this list. */
  desktopAllowedApps: string[]
  /** What to call each of those ids in Settings. Renderer-only; Rust ignores it. */
  desktopAppNames: Record<string, string>
  /** The floating miniature. Codex had to add this switch after the fact; it
   *  costs nothing to have from the start. */
  browserPip: boolean
  /** Hold the computer awake while Claude works: a chat mid-turn, a monitor or
   *  background task it started, a flow. Off by default — it changes how the
   *  machine behaves outside Nyra. Rust holds the power assertion. */
  keepAwake: boolean
  /** Keep the screen on too, rather than only the system. */
  keepAwakeDisplay: boolean
  /** Let the machine sleep normally on battery. */
  keepAwakeOnlyOnAc: boolean
  /**
   * Show what the active chat is holding in memory, in the summary card.
   *
   * Off by default. It answers one question — which conversation is the heavy
   * one — and answers it with a number that is only worth having while you are
   * asking, and costs a process-table read every few seconds while it is on.
   * Renderer-only, like `browserDevice`: nothing Rust-side reads it.
   */
  showChatMemory: boolean
  /** Offer a "While you were away" recap on coming back to a chat that kept
   *  working without you. Renderer-only. */
  awayRecap: boolean
  /** How long, in minutes, a chat has to have worked without you before the
   *  recap is offered. Counted until the turn finished, not until you returned. */
  awayRecapMinutes: number
  /** Download new versions in the background and install them on quit. Off by
   *  default: an app that fetches and replaces itself should be asked to.
   *  Renderer-only; Rust installs whatever the renderer staged. */
  autoUpdate: boolean
  /**
   * Where device mode goes when it is switched back on.
   *
   * The binding cannot be persisted — the tab it applied to does not survive a
   * restart — but the preference can, and someone doing phone work this week
   * wants it to come back to the phone. Never applied on its own: a tab that
   * opens as a phone because of a setting nobody remembers is a bad hour.
   *
   * Deliberately absent from `settings.rs`. Nothing Rust-side reads it, and the
   * appearance keys are the precedent for leaving a renderer-only key out of
   * that struct rather than carrying it around for no one.
   */
  browserDevice: string
  /** Webview zoom factor. Scales everything, including the hardcoded px sizes a
   *  root font-size change cannot reach. */
  zoom: number
  /** Font family names, as enumerated from the system. '' = the bundled default. */
  uiFont: string
  uiFontWeight: number
  contentFont: string
  contentFontWeight: number
  codeFont: string
  codeFontWeight: number
  /** Conversation and composer type size, in px. Replaces the old small/medium/large
   *  `fontSize`, which only ever reached the message scroller. */
  contentFontSize: number
  /** The chrome's type size, in px: the project rail, the chat list, the panels.
   *  Separate from the conversation, because making the message text bigger is
   *  about reading and making the rail bigger is about seeing. */
  uiFontSize: number
  /** The theme used in light mode, and the one in dark mode, by id. Built-in ids
   *  are fixed; a user theme's is its file name in `~/.nyra/themes/`. An id that
   *  no longer resolves falls back to Nyra Light or Nyra Dark. */
  lightTheme: string
  darkTheme: string
  /** The corner radius everything rounded scales from, in px. Global rather than
   *  per theme: themes are per mode, and shapes changing at sunset would be odd. */
  cornerRadius: number
  /** The conversation's measure. */
  chatWidth: ChatWidth
  /** How the Changes tab draws a patch. Preferences rather than per-chat state:
   *  someone who reads diffs unified reads every diff unified. */
  diffView: DiffViewMode
  diffWrap: boolean
  /** Soft-wrap the text in a file preview tab. The file equivalent of the
   *  conversation's measure: a minified JSON or a long line of prose is the
   *  same complaint, and this is the switch that answers it. Separate from
   *  `diffWrap` because reading a patch and reading a file are different jobs
   *  and someone can reasonably want one wrapped and not the other. */
  fileWrap: boolean
  /** Passes `-w` to git. Unlike the other two this is not a rendering choice —
   *  the library draws a patch that git already computed, so whitespace has to
   *  be dropped when the patch is made, not when it is shown. */
  diffIgnoreWhitespace: boolean
  /** Which Whisper model voice dictation uses. Only multilingual models are
   *  offered: the `.en` variants are better at English per megabyte but cannot
   *  transcribe Portuguese at all. */
  dictationModel: string
  /** '' detects the language; otherwise an ISO code such as 'pt' or 'en'.
   *  Detection on a two-second utterance is unreliable, so pinning it is worth
   *  having even though auto is the default. */
  dictationLanguage: string
  /** '' is the system default input. */
  dictationDevice: string
  /** Show a running transcript above the composer while speaking. Whisper is
   *  not a streaming model, so this re-runs over a growing buffer — accurate
   *  enough to follow, and replaced by the real transcript on stop. */
  dictationLiveTranscript: boolean
  /** Bias the transcript towards identifiers from the working directory, so
   *  'ComposerBar' does not come back as 'composer bar'. */
  dictationVocabulary: boolean
}

/** Side-by-side, or one column. `auto` picks by the panel's width, which is what
 *  makes the default read well in a 420px panel and in a 1000px one. */
export type DiffViewMode = 'auto' | 'unified' | 'split'

/** How wide the conversation column is allowed to get. */
export type ChatWidth = 'compact' | 'default' | 'wide' | 'full'

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
> & {
  /** The workspace's `CLAUDE_CONFIG_DIR`; null is Default. Part of the spawn
   *  fingerprint, so a changed account respawns the chat. */
  configDir: string | null
}

export function spawnSettingsFor(settings: NyraSettings, configDir: string | null): SpawnSettings {
  return {
    configDir,
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
  appTools: true,
  desktopTools: false,
  desktopAllowedApps: [],
  desktopAppNames: {},
  browserPip: true,
  keepAwake: false,
  keepAwakeDisplay: false,
  keepAwakeOnlyOnAc: true,
  showChatMemory: false,
  awayRecap: true,
  awayRecapMinutes: 30,
  autoUpdate: false,
  browserDevice: 'iphone-16-pro',
  zoom: 1,
  uiFont: '',
  uiFontWeight: 400,
  contentFont: '',
  contentFontWeight: 400,
  codeFont: '',
  codeFontWeight: 400,
  contentFontSize: 15,
  uiFontSize: 13,
  lightTheme: 'nyra-light',
  darkTheme: 'nyra-dark',
  // 0.84rem, what the stylesheet has always said.
  cornerRadius: 13.44,
  chatWidth: 'wide',
  diffView: 'auto',
  diffWrap: false,
  fileWrap: false,
  diffIgnoreWhitespace: false,
  dictationModel: 'turbo',
  dictationLanguage: '',
  dictationDevice: '',
  dictationLiveTranscript: true,
  dictationVocabulary: true
}
