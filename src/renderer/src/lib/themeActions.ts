import { useSettingsStore } from '../store/settings'
import { useUiStore } from '../store/ui'
import { allThemes, slotTheme, useThemeStore } from '../store/themes'
import { resolveTheme } from './theme'
import {
  copyName,
  nameTaken,
  parseTheme,
  serializeTheme,
  themeIdFor,
  type Theme,
  type ThemeMode
} from './themes'

/**
 * What the theme buttons do. Plain functions over the stores rather than hooks,
 * so the command palette, Settings and the editor's own menu share them.
 */

function themes(): Theme[] {
  return allThemes(useThemeStore.getState().userThemes)
}

/** The theme in a mode's slot right now. */
export function themeInSlot(mode: ThemeMode): Theme {
  const s = useSettingsStore.getState()
  return slotTheme(mode, mode === 'light' ? s.lightTheme : s.darkTheme, useThemeStore.getState().userThemes)
}

/** The mode Appearance is asking for, following the OS under System. */
export function preferredMode(): ThemeMode {
  return resolveTheme(useSettingsStore.getState().theme)
}

export function assignSlot(theme: Theme): void {
  useSettingsStore.getState().updateSettings(theme.mode === 'light' ? { lightTheme: theme.id } : { darkTheme: theme.id })
}

/** A new, unsaved theme starting as a copy of `source`. */
export function copyOf(source: Theme, name = copyName(source.name, themes())): Theme {
  return {
    id: themeIdFor(name, themes().map((t) => t.id)),
    name,
    mode: source.mode,
    colors: { ...source.colors },
    basedOn: source.name
  }
}

/**
 * Open the editor on a theme.
 *
 * One of yours is edited in place. A built-in one is never touched: the editor
 * opens on a copy with the name field focused, because the copy needs a name
 * before it can be anything. Settings closes so the window is the preview, and
 * comes back when the editor does.
 */
export function editTheme(theme: Theme): void {
  const store = useThemeStore.getState()
  if (theme.builtIn) {
    store.startEdit(copyOf(theme), { saved: null, baseline: theme, focusName: true })
  } else {
    store.startEdit(theme, { saved: theme, baseline: theme })
  }
  useUiStore.getState().setSettingsOpen(false)
}

/** "New theme": a copy of whatever the window is showing. */
export function newTheme(mode: ThemeMode = preferredMode()): void {
  const source = themeInSlot(mode)
  useThemeStore.getState().startEdit(copyOf(source), { saved: null, baseline: source, focusName: true })
  useUiStore.getState().setSettingsOpen(false)
}

/** The palette command: edit what is on screen. */
export function editActiveTheme(): void {
  editTheme(themeInSlot(preferredMode()))
}

/** Back to where the editor was opened from. */
export function closeEditor(): void {
  useThemeStore.getState().endEdit()
  useUiStore.getState().openSettings('appearance')
}

/**
 * Save the draft, put it in its mode's slot, and close the editor. Returns an
 * error to show, or null.
 *
 * Putting it in the slot is the point of having edited it: you have been
 * looking at it for the whole edit, and closing on something else would read
 * as the save not having worked.
 */
export async function saveDraft(): Promise<string | null> {
  const edit = useThemeStore.getState().edit
  if (!edit) return null
  const name = edit.draft.name.trim()
  if (!name) return 'Give the theme a name.'
  if (nameTaken(name, themes(), edit.draft.id)) return `${name} is already a theme. Pick another name.`
  // A theme that has never been saved takes its file name from the name it is
  // saved under, not the placeholder it was opened with ("Nord copy").
  const id = edit.saved ? edit.draft.id : themeIdFor(name, themes().map((t) => t.id))
  const theme = { ...edit.draft, name, id }
  const error = await useThemeStore.getState().save(theme)
  if (error) return error
  assignSlot(theme)
  closeEditor()
  return null
}

export async function deleteTheme(theme: Theme): Promise<string | null> {
  const error = await useThemeStore.getState().remove(theme.id)
  if (error) return error
  const s = useSettingsStore.getState()
  if (s.lightTheme === theme.id) s.updateSettings({ lightTheme: 'nyra-light' })
  if (s.darkTheme === theme.id) s.updateSettings({ darkTheme: 'nyra-dark' })
  return null
}

export async function exportTheme(theme: Theme): Promise<void> {
  await window.api.dialog.saveFile(`${theme.id}.json`, serializeTheme(theme))
}

/**
 * Read a theme file someone sent you and add it to yours, in its mode's slot.
 *
 * Its id and name are re-made if either is taken, so importing never replaces
 * a theme you already have — importing the same file twice gives you two.
 */
export async function importTheme(): Promise<{ theme?: Theme; error?: string; canceled?: boolean }> {
  const path = await window.api.dialog.pickFile()
  if (!path) return { canceled: true }
  const read = await window.api.fs.readTextFile(path)
  if (read.kind !== 'text' || read.truncated) return { error: 'Could not read that file as text.' }
  const text = read.content
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'That file is not JSON, so it is not a theme.' }
  }
  const parsed = parseTheme(raw)
  if (!parsed) return { error: 'That file is not a Nyra theme, or its colours are not hex.' }
  const all = themes()
  let name = parsed.name
  for (let i = 2; nameTaken(name, all); i++) name = `${parsed.name} ${i}`
  const ids = all.map((t) => t.id)
  const theme: Theme = { ...parsed, name, id: ids.includes(parsed.id) ? themeIdFor(name, ids) : parsed.id }
  const error = await useThemeStore.getState().save(theme)
  if (error) return { error }
  assignSlot(theme)
  return { theme }
}

export async function revealThemesFolder(): Promise<void> {
  const dir = await window.api.themes.dirPath()
  await window.api.fs.reveal(dir)
}
