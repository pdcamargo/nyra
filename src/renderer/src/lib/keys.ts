/**
 * Keyboard chords: one normalized string form, and the three things done to it.
 *
 * The app had no chord model at all — every shortcut was a hand-written
 * comparison against `e.key` inside `if (e.metaKey)`, which is how `⌘⇧F` came to
 * test `e.key === 'f'` while holding Shift (it is `'F'`, so that binding never
 * fired), and why nothing at all worked off macOS.
 *
 * `platform` is an argument with a default rather than something read from
 * `navigator` inside the matcher. That is what makes both platforms testable.
 */

/** Normalized: lowercase, `+`-joined, modifiers in a fixed order. */
export type Chord = string
export type Platform = 'mac' | 'other'

let cachedPlatform: Platform | null = null

export function currentPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  cachedPlatform = /Mac|iPhone|iPad|iPod/.test(ua) ? 'mac' : 'other'
  return cachedPlatform
}

/** Test seam. */
export function resetPlatformCache(): void {
  cachedPlatform = null
}

/**
 * Canonical order. `mod` is ⌘ on macOS and Ctrl everywhere else; `ctrl` is the
 * literal Control key, which only means something distinct on macOS — elsewhere
 * it *is* mod, and `normalizeChord` folds it in.
 */
const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift', 'meta'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'mod',
  cmd: 'mod',
  command: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  super: 'meta',
  win: 'meta'
}

/** `e.key` values that are not a single character. */
const NAMED_KEYS: Record<string, string> = {
  escape: 'escape',
  esc: 'escape',
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  ' ': 'space',
  space: 'space',
  spacebar: 'space',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown'
}

/** Single characters accepted straight off `e.key`, in their unshifted form. */
const PUNCTUATION = new Set(['[', ']', ',', '.', '/', '\\', ';', "'", '`', '-', '='])

/** `e.code` → key token, for layouts and shifted characters `e.key` gets wrong. */
const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/'
}

function keyTokenFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_KEYS[code] ?? null
}

function keyToken(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower
  if (lower.length === 1 && (/[a-z0-9]/.test(lower) || PUNCTUATION.has(lower))) return lower
  return null
}

function assemble(mods: Set<Modifier>, key: string, platform: Platform): Chord {
  // Off macOS there is no Control that is not the mod key, so a chord asking for
  // both would be unsatisfiable and one asking for plain `ctrl` is just `mod`.
  if (platform === 'other' && mods.has('ctrl')) {
    mods.delete('ctrl')
    mods.add('mod')
  }
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m))
  return [...ordered, key].join('+')
}

/**
 * Parse a written chord into canonical form, or null if it is not one.
 *
 * Accepts the spellings people actually write — `Cmd+Shift+B`, `shift+mod+b` —
 * and returns the single form everything else compares against.
 */
export function normalizeChord(raw: string, platform: Platform = currentPlatform()): Chord | null {
  if (typeof raw !== 'string') return null
  const parts = raw.trim().split('+').filter((p) => p.length > 0)
  // A trailing `+` is the key itself: "mod++" means mod and the plus key.
  if (raw.trim().endsWith('+') && raw.trim().length > 1) parts.push('=')
  if (parts.length === 0) return null

  const mods = new Set<Modifier>()
  let key: string | null = null
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()]
    if (alias) {
      mods.add(alias)
      continue
    }
    if (key !== null) return null // two non-modifier tokens is not a chord
    key = keyToken(part)
    if (key === null) return null
  }
  if (key === null) return null
  return assemble(mods, key, platform)
}

/**
 * The chord a keydown represents, or null when it is only modifiers.
 *
 * The key token is taken from `e.key` and lowercased — which is the fix for the
 * Shift+F bug — falling back to `e.code` when `e.key` is something we cannot
 * name, such as a Cyrillic letter or a shifted `+`.
 */
export function eventToChord(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: Platform = currentPlatform()
): Chord | null {
  const key = keyToken(e.key) ?? keyTokenFromCode(e.code ?? '')
  if (key === null) return null

  const mods = new Set<Modifier>()
  if (platform === 'mac') {
    if (e.metaKey) mods.add('mod')
    if (e.ctrlKey) mods.add('ctrl')
  } else {
    if (e.ctrlKey) mods.add('mod')
    if (e.metaKey) mods.add('meta')
  }
  if (e.altKey) mods.add('alt')
  if (e.shiftKey) mods.add('shift')

  return assemble(mods, key, platform)
}

export function chordMatches(
  chord: Chord,
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: Platform = currentPlatform()
): boolean {
  const actual = eventToChord(e, platform)
  return actual !== null && actual === normalizeChord(chord, platform)
}

const MAC_GLYPHS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
  escape: '⎋',
  enter: '⏎',
  tab: '⇥',
  space: '␣',
  backspace: '⌫',
  delete: '⌦',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
}

const OTHER_NAMES: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
}

/** The chord as separate keycaps, for rendering one `<kbd>` per part. */
export function chordParts(chord: Chord, platform: Platform = currentPlatform()): string[] {
  const normalized = normalizeChord(chord, platform)
  if (!normalized) return []
  const table = platform === 'mac' ? MAC_GLYPHS : OTHER_NAMES
  return normalized.split('+').map((part) => table[part] ?? part.toUpperCase())
}

/** The chord as one string: `⌘⇧B` on macOS, `Ctrl+Shift+B` elsewhere. */
export function formatChord(chord: Chord, platform: Platform = currentPlatform()): string {
  const parts = chordParts(chord, platform)
  return platform === 'mac' ? parts.join('') : parts.join('+')
}

/**
 * Is focus somewhere that swallows plain keys?
 *
 * Used to decide whether an unmodified binding should fire. Monaco and
 * CodeMirror both render a focusable surface that is not an `<input>`, so both
 * are named explicitly.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.closest('[contenteditable="true"], [contenteditable=""]')) return true
  return target.closest('.monaco-editor, .cm-editor, .xterm') !== null
}
