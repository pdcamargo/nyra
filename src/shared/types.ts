export type ThemePreference = 'dark' | 'light' | 'system'

export type NyraSettings = {
  model: string // '' = default, or model ID like 'sonnet', 'opus', 'haiku'
  skipPermissions: boolean
  notifications: boolean
  systemPrompt: string
  claudeBinaryPath: string
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
  /** Whether Claude gets the tools that drive Nyra itself. */
  appTools: boolean
  /** The floating miniature. Codex had to add this switch after the fact; it
   *  costs nothing to have from the start. */
  browserPip: boolean
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
  /** The conversation's measure. */
  chatWidth: ChatWidth
  /** How the Changes tab draws a patch. Preferences rather than per-chat state:
   *  someone who reads diffs unified reads every diff unified. */
  diffView: DiffViewMode
  diffWrap: boolean
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
  browserPip: true,
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
  chatWidth: 'wide',
  diffView: 'auto',
  diffWrap: false,
  diffIgnoreWhitespace: false,
  dictationModel: 'turbo',
  dictationLanguage: '',
  dictationDevice: '',
  dictationLiveTranscript: true,
  dictationVocabulary: true
}
