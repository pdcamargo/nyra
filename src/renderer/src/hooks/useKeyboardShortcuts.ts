import { useEffect } from 'react'
import { COMMANDS, runCommand, type Command } from '../commands/registry'
import { chordFor, useShortcutsStore } from '../store/shortcuts'
import { currentPlatform, eventToChord, isEditableTarget, type Chord, type Platform } from '../lib/keys'

/**
 * One listener over the command registry, instead of a chain of hand-written
 * comparisons in two files.
 *
 * The matching half is a pure function so it can be tested without a DOM, and so
 * the focus rule — which bindings fire while you are typing — is written down
 * once rather than implied by where each `if` happened to live.
 */

/** Modified chords reach into a text field; bare keys do not, unless asked to. */
function firesInInput(command: Command, chord: Chord): boolean {
  if (command.allowInInput !== undefined) return command.allowInInput
  return /(^|\+)(mod|ctrl|alt|meta)\+/.test(chord)
}

export function resolveCommandForEvent(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
    target?: EventTarget | null
  },
  overrides: Record<string, Chord | null>,
  platform: Platform = currentPlatform()
): Command | null {
  const pressed = eventToChord(e, platform)
  if (!pressed) return null

  const editable = isEditableTarget(e.target ?? null)
  for (const command of COMMANDS) {
    if (command.readOnly || !command.run) continue
    const chord = chordFor(command.id, overrides)
    if (!chord || chord !== pressed) continue
    if (editable && !firesInInput(command, chord)) return null
    return command
  }
  return null
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    // Bubble phase on purpose. PermissionDialog listens in the capture phase and
    // calls stopImmediatePropagation so its Enter/Escape outrank the global
    // abort, and the rebinding field stops propagation to shield itself.
    const handler = (e: KeyboardEvent): void => {
      const { recording, overrides } = useShortcutsStore.getState()
      if (recording) return
      const command = resolveCommandForEvent(e, overrides)
      if (!command?.run) return
      e.preventDefault()
      // Through the dispatcher rather than `command.run()`, so the availability
      // rule lives in one place. No `agent` flag: a person pressing the key is
      // never who the denylist is about.
      runCommand(command.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
