import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { COMMANDS, COMMANDS_BY_ID, type CommandId } from '../commands/registry'
import { normalizeChord, type Chord, type Platform } from '../lib/keys'

/**
 * User rebindings, as deltas over the registry's defaults.
 *
 * Its own store rather than a key on `NyraSettings` for two reasons. Rust's
 * settings struct ignores unknown fields, so mirroring this would be an IPC
 * round trip the backend throws away on every rebind; and `resetSettings()` —
 * "Reset all settings" in Advanced — would take the keybindings with it.
 *
 * Deltas, not a full table: a default chord changed in a later release reaches
 * everyone who never touched it, and leaves everyone who did alone.
 */
type Overrides = Record<string, Chord | null>

export type ShortcutsStore = {
  /** Missing key = the registry default. `null` = deliberately unbound. */
  overrides: Overrides
  /** True while the capture field has the keyboard; the dispatcher stands down. */
  recording: boolean
  setBinding: (id: CommandId, chord: Chord) => void
  clearBinding: (id: CommandId) => void
  resetBinding: (id: CommandId) => void
  resetAll: () => void
  setRecording: (recording: boolean) => void
}

/**
 * Fold a persisted blob into the current defaults.
 *
 * Exported so the two things it has to get right stay tested: an override for a
 * command that no longer exists is dropped rather than shadowing a live one, and
 * a chord that no longer parses is dropped rather than matching nothing forever.
 */
export function mergeShortcutOverrides(
  persisted: unknown,
  current: ShortcutsStore,
  platform?: Platform
): ShortcutsStore {
  const raw = (persisted as { overrides?: unknown } | undefined)?.overrides
  const overrides: Overrides = {}
  if (raw && typeof raw === 'object') {
    for (const [id, chord] of Object.entries(raw as Record<string, unknown>)) {
      if (!COMMANDS_BY_ID.has(id as CommandId)) continue
      if (chord === null) {
        overrides[id] = null
        continue
      }
      if (typeof chord !== 'string') continue
      const normalized = normalizeChord(chord, platform)
      if (normalized) overrides[id] = normalized
    }
  }
  // `recording` is never restored: a reload during capture would otherwise leave
  // the dispatcher permanently asleep.
  return { ...current, overrides, recording: false }
}

export const useShortcutsStore = create<ShortcutsStore>()(
  persist(
    (set) => ({
      overrides: {},
      recording: false,
      setBinding: (id, chord) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: normalizeChord(chord) ?? chord } })),
      clearBinding: (id) => set((s) => ({ overrides: { ...s.overrides, [id]: null } })),
      resetBinding: (id) =>
        set((s) => {
          const next = { ...s.overrides }
          delete next[id]
          return { overrides: next }
        }),
      resetAll: () => set({ overrides: {} }),
      setRecording: (recording) => set({ recording })
    }),
    {
      name: 'nyra-shortcuts',
      partialize: (s) => ({ overrides: s.overrides }),
      merge: (persisted, current) => mergeShortcutOverrides(persisted, current as ShortcutsStore)
    }
  )
)

/** The chord in force for a command: the override if there is one, else the default. */
export function chordFor(id: CommandId, overrides: Overrides): Chord | null {
  if (id in overrides) return overrides[id]
  return COMMANDS_BY_ID.get(id)?.defaultChord ?? null
}

/** Convenience for components, which mostly want the live value. */
export function useChordFor(id: CommandId): Chord | null {
  return useShortcutsStore((s) => chordFor(id, s.overrides))
}

/**
 * Chord → command, for the bindable commands only.
 *
 * One to one by construction: the capture UI clears the previous owner before it
 * assigns, so there is never a silent shadow or a last-one-wins race.
 */
export function bindingMap(overrides: Overrides): Map<Chord, CommandId> {
  const map = new Map<Chord, CommandId>()
  for (const command of COMMANDS) {
    if (command.readOnly) continue
    const chord = chordFor(command.id, overrides)
    if (chord && !map.has(chord)) map.set(chord, command.id)
  }
  return map
}

/** Who already holds this chord, if anyone other than `self`. */
export function conflictFor(
  chord: Chord,
  self: CommandId,
  overrides: Overrides
): CommandId | null {
  const normalized = normalizeChord(chord)
  if (!normalized) return null
  for (const command of COMMANDS) {
    if (command.id === self) continue
    if (chordFor(command.id, overrides) === normalized) return command.id
  }
  return null
}
