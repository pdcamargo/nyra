import React, { useMemo, useState } from 'react'
import { RotateCcw, Search } from 'lucide-react'
import {
  COMMANDS,
  COMMANDS_BY_ID,
  RESERVED,
  type Command,
  type CommandGroup,
  type CommandId
} from '../../commands/registry'
import { chordFor, conflictFor, useShortcutsStore } from '../../store/shortcuts'
import { eventToChord, formatChord, normalizeChord, type Chord } from '../../lib/keys'
import { Kbd } from '../ui/kbd'
import { SectionLabel, SectionNote } from './primitives'

const GROUP_ORDER: CommandGroup[] = ['General', 'Session', 'Panels', 'View', 'Composer']

type Pending = { id: CommandId; chord: Chord; conflict: CommandId }

/** The modifiers currently held, for the live preview while nothing else is down. */
function heldModifiers(e: React.KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push('mod')
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  return parts.length ? formatChord(`${parts.join('+')}+a`).replace(/A$/i, '') : ''
}

export default function ShortcutsTab(): React.JSX.Element {
  const overrides = useShortcutsStore((s) => s.overrides)
  const setBinding = useShortcutsStore((s) => s.setBinding)
  const clearBinding = useShortcutsStore((s) => s.clearBinding)
  const resetBinding = useShortcutsStore((s) => s.resetBinding)
  const resetAll = useShortcutsStore((s) => s.resetAll)
  const setRecording = useShortcutsStore((s) => s.setRecording)

  const [query, setQuery] = useState('')
  const [capturing, setCapturing] = useState<CommandId | null>(null)
  const [preview, setPreview] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)

  // Matched on the label and on the chord, so "⌘K" and "palette" both find it.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<CommandGroup, Command[]>()
    for (const c of COMMANDS) {
      if (q) {
        const chord = chordFor(c.id, overrides)
        const haystack = `${c.label} ${c.group} ${chord ? formatChord(chord) : ''} ${chord ?? ''}`
        if (!haystack.toLowerCase().includes(q)) continue
      }
      const list = map.get(c.group) ?? []
      list.push(c)
      map.set(c.group, list)
    }
    return map
  }, [query, overrides])

  const stopCapture = (): void => {
    setCapturing(null)
    setPreview('')
    setRecording(false)
  }

  const startCapture = (id: CommandId): void => {
    setPending(null)
    setCapturing(id)
    setPreview('')
    setRecording(true)
  }

  const commit = (id: CommandId, chord: Chord): void => {
    const occupant = conflictFor(chord, id, overrides)
    if (occupant) {
      setPending({ id, chord, conflict: occupant })
      stopCapture()
      return
    }
    setBinding(id, chord)
    stopCapture()
  }

  const onCaptureKey = (id: CommandId) => (e: React.KeyboardEvent): void => {
    // Nothing else gets a say while the field has the keyboard — not the global
    // dispatcher, not the dialog's own Escape.
    e.preventDefault()
    e.stopPropagation()
    e.nativeEvent.stopImmediatePropagation()

    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      stopCapture()
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      clearBinding(id)
      stopCapture()
      return
    }

    const chord = eventToChord(e.nativeEvent)
    if (!chord) {
      setPreview(heldModifiers(e))
      return
    }
    commit(id, chord)
  }

  const reserved = (chord: Chord): string | null =>
    RESERVED.find((r) => normalizeChord(r.chord) === normalizeChord(chord))?.label ?? null

  return (
    <>
      <SectionLabel>Keyboard shortcuts</SectionLabel>
      <SectionNote>
        Click a shortcut and press the keys you want. Escape cancels, Backspace removes the
        binding. Composer keys are listed for reference and are not reassignable — they act on
        the text you have selected, so they belong to the composer rather than to the app.
      </SectionNote>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts…"
          aria-label="Search shortcuts"
          className="w-full rounded-lg border border-border bg-muted/40 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground/70 outline-hidden transition-colors focus:border-border-strong"
        />
      </div>

      {pending && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="text-[11px] text-foreground/80">
            <span className="font-medium">{formatChord(pending.chord)}</span> is already{' '}
            <span className="font-medium">{COMMANDS_BY_ID.get(pending.conflict)!.label}</span>.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                // Clear the previous owner first, so chord → command stays one to
                // one and nothing is silently shadowed.
                if (!COMMANDS_BY_ID.get(pending.conflict)?.readOnly) clearBinding(pending.conflict)
                setBinding(pending.id, pending.chord)
                setPending(null)
              }}
              className="rounded-md bg-accent px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-secondary"
            >
              {COMMANDS_BY_ID.get(pending.conflict)?.readOnly ? 'Use it anyway' : 'Replace'}
            </button>
            <button
              onClick={() => setPending(null)}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground/80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {query.trim() && GROUP_ORDER.every((g) => !(grouped.get(g) ?? []).length) && (
        <p className="py-6 text-center text-xs text-muted-foreground">Nothing matches that.</p>
      )}

      {GROUP_ORDER.filter((g) => (grouped.get(g) ?? []).length > 0).map((group) => (
        <div key={group} className="mb-5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group}
          </p>
          <div className="overflow-hidden rounded-lg border border-border/55">
            {(grouped.get(group) ?? []).map((command, i) => {
              const chord = chordFor(command.id, overrides)
              const overridden = command.id in overrides
              const isCapturing = capturing === command.id
              const claimed = chord ? reserved(chord) : null

              return (
                <div
                  key={command.id}
                  className={`flex items-center justify-between gap-3 px-3 py-1.5 ${
                    i > 0 ? 'border-t border-separator' : ''
                  } ${command.readOnly ? 'opacity-60' : ''}`}
                >
                  <span className="min-w-0 truncate text-xs text-foreground/80">
                    {command.label}
                    {claimed && (
                      <span className="text-warning/80"> — the system uses this for {claimed}</span>
                    )}
                  </span>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {overridden && !command.readOnly && (
                      <button
                        onClick={() => resetBinding(command.id)}
                        title="Reset to default"
                        className="text-muted-foreground/70 transition-colors hover:text-foreground"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}
                    {command.readOnly ? (
                      chord ? (
                        <Kbd chord={chord} />
                      ) : null
                    ) : (
                      <button
                        onClick={() => (isCapturing ? stopCapture() : startCapture(command.id))}
                        onKeyDown={isCapturing ? onCaptureKey(command.id) : undefined}
                        onBlur={isCapturing ? stopCapture : undefined}
                        autoFocus={isCapturing}
                        aria-label={`Shortcut for ${command.label}`}
                        className={`min-w-24 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                          isCapturing
                            ? 'border-info bg-info/10 text-info'
                            : 'border-transparent hover:border-border hover:bg-muted/50'
                        }`}
                      >
                        {isCapturing ? (
                          preview || 'Press keys…'
                        ) : chord ? (
                          <Kbd chord={chord} />
                        ) : (
                          <span className="text-muted-foreground/60">Not set</span>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="border-t border-border/55 pt-4">
        <button
          onClick={resetAll}
          disabled={Object.keys(overrides).length === 0}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground/80 disabled:opacity-40 disabled:hover:text-muted-foreground"
        >
          Reset all shortcuts
        </button>
      </div>
    </>
  )
}
