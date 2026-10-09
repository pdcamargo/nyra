import { create } from 'zustand'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  parseTheme,
  serializeTheme,
  type ColorKey,
  type OptionalKey,
  type Theme,
  type ThemeColors,
  type ThemeMode
} from '../lib/themes'
import { isCoreKey } from '../lib/themes'
import { readThemeCache } from '../lib/theme'

/**
 * Themes in memory: the user's, read off `~/.nyra/themes/`, and the two kinds of
 * "not what is saved" the window can be showing.
 *
 * - A **preview** is the theme picker following the keyboard. Nothing is
 *   written; closing the picker without choosing drops it.
 * - An **edit** is the theme editor's draft. The window paints the draft until
 *   Save or Cancel, and holding ⌥ paints the baseline instead — what the window
 *   looked like before editing began.
 *
 * Which of these wins, and what reaches the DOM, is `activeTheme` below and
 * `useApplyTheme`.
 */

export type ThemeEdit = {
  draft: Theme
  /** The theme as last saved, or null for one that has never been. */
  saved: Theme | null
  /** What the window showed before editing began; ⌥ shows it again. */
  baseline: Theme
  /** Earlier states of the draft's colours, newest last. */
  history: ThemeColors[]
  selected: ColorKey | null
  picking: boolean
  comparing: boolean
  /** Focus the name field when the editor opens: a copy wants naming first. */
  focusName: boolean
}

type ThemeStore = {
  userThemes: Theme[]
  loaded: boolean
  preview: Theme | null
  edit: ThemeEdit | null

  load: () => Promise<void>
  save: (theme: Theme) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
  setPreview: (theme: Theme | null) => void

  startEdit: (draft: Theme, opts: { saved: Theme | null; baseline: Theme; focusName?: boolean }) => void
  setColor: (key: ColorKey, value: string | undefined, opts?: { coalesce?: boolean }) => void
  setColors: (colors: ThemeColors) => void
  rename: (name: string) => void
  undo: () => void
  select: (key: ColorKey | null) => void
  setPicking: (on: boolean) => void
  setComparing: (on: boolean) => void
  endEdit: () => void
}

const HISTORY_LIMIT = 100

export const useThemeStore = create<ThemeStore>()((set, get) => ({
  // Seeded from the boot cache so the slots resolve to the right theme before
  // the folder has been read; `load` replaces it with what is on disk.
  userThemes: readThemeCache(),
  loaded: false,
  preview: null,
  edit: null,

  load: async () => {
    const raw = await window.api.themes.list().catch(() => [] as unknown[])
    const themes = raw
      .map(parseTheme)
      .filter((t): t is Theme => t !== null)
      // A user file cannot take a built-in's id: the built-in would shadow it
      // in every lookup and the file would look lost.
      .filter((t) => !BUILT_IN_THEMES.some((b) => b.id === t.id))
      .sort((a, b) => a.name.localeCompare(b.name))
    set({ userThemes: themes, loaded: true })
  },

  save: async (theme) => {
    const clean: Theme = { ...theme, builtIn: undefined }
    delete clean.builtIn
    const result = await window.api.themes.save(clean.id, serializeTheme(clean))
    if (result.error) return result.error
    const saved = { ...clean, updatedAt: Date.now() }
    set((s) => ({
      userThemes: [...s.userThemes.filter((t) => t.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    }))
    return null
  },

  remove: async (id) => {
    const result = await window.api.themes.remove(id)
    if (result.error) return result.error
    set((s) => ({ userThemes: s.userThemes.filter((t) => t.id !== id) }))
    return null
  },

  setPreview: (preview) => set({ preview }),

  startEdit: (draft, { saved, baseline, focusName = false }) =>
    set({
      preview: null,
      edit: { draft, saved, baseline, history: [], selected: null, picking: false, comparing: false, focusName }
    }),

  // A drag across the picker is hundreds of changes and one decision, so a
  // `coalesce` change replaces the top of the history rather than adding to it.
  setColor: (key, value, { coalesce = false } = {}) => {
    const edit = get().edit
    if (!edit) return
    if (value === undefined && isCoreKey(key)) return
    const colors = { ...edit.draft.colors } as ThemeColors
    if (value === undefined) delete colors[key as OptionalKey]
    else (colors as Record<string, string>)[key] = value
    const history = coalesce && edit.history.length ? edit.history : [...edit.history, edit.draft.colors].slice(-HISTORY_LIMIT)
    set({ edit: { ...edit, draft: { ...edit.draft, colors }, history } })
  },

  setColors: (colors) => {
    const edit = get().edit
    if (!edit) return
    set({
      edit: { ...edit, draft: { ...edit.draft, colors }, history: [...edit.history, edit.draft.colors].slice(-HISTORY_LIMIT) }
    })
  },

  rename: (name) => {
    const edit = get().edit
    if (edit) set({ edit: { ...edit, draft: { ...edit.draft, name }, focusName: false } })
  },

  undo: () => {
    const edit = get().edit
    if (!edit || !edit.history.length) return
    const history = edit.history.slice(0, -1)
    const colors = edit.history[edit.history.length - 1]
    set({ edit: { ...edit, draft: { ...edit.draft, colors }, history } })
  },

  select: (selected) => {
    const edit = get().edit
    if (edit) set({ edit: { ...edit, selected, picking: false } })
  },
  setPicking: (picking) => {
    const edit = get().edit
    if (edit) set({ edit: { ...edit, picking } })
  },
  setComparing: (comparing) => {
    const edit = get().edit
    if (edit && edit.comparing !== comparing) set({ edit: { ...edit, comparing } })
  },
  endEdit: () => set({ edit: null })
}))

/** Built-in first, in their own order, then the user's by name. */
export function allThemes(userThemes: Theme[]): Theme[] {
  return [...BUILT_IN_THEMES, ...userThemes]
}

export function findTheme(id: string, userThemes: Theme[]): Theme | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id) ?? userThemes.find((t) => t.id === id)
}

/**
 * The theme a slot resolves to: the one it names, if it exists and is the right
 * mode, and Nyra's own otherwise. A slot naming a deleted theme, or a theme
 * file someone hand-edited from dark to light, quietly falls back rather than
 * painting a light theme in dark mode.
 */
export function slotTheme(mode: ThemeMode, id: string, userThemes: Theme[]): Theme {
  const found = findTheme(id, userThemes)
  if (found && found.mode === mode) return found
  return BUILT_IN_THEMES.find((t) => t.id === DEFAULT_THEME_ID[mode]) as Theme
}

/** Whether the draft differs from what Save would be replacing. */
export function isDirty(edit: ThemeEdit): boolean {
  if (!edit.saved) return true
  return (
    edit.saved.name !== edit.draft.name ||
    JSON.stringify(sortKeys(edit.saved.colors)) !== JSON.stringify(sortKeys(edit.draft.colors))
  )
}

/** How many colours the draft has changed, against what it would replace. */
export function changeCount(edit: ThemeEdit): number {
  const before = (edit.saved ?? edit.baseline).colors as Record<string, string | undefined>
  const after = edit.draft.colors as Record<string, string | undefined>
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  let n = 0
  for (const k of keys) if (before[k] !== after[k]) n++
  return n
}

function sortKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}
