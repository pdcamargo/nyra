import React from 'react'
import { cn } from 'cn'
import { chordParts, formatChord, type Chord } from '../../lib/keys'
import { useChordFor } from '../../store/shortcuts'
import type { CommandId } from '../../commands/registry'

/**
 * A chord, rendered as keycaps.
 *
 * Every shortcut hint in the app used to be a hardcoded string of macOS glyphs,
 * which meant they were wrong off macOS and — once bindings became editable —
 * wrong whenever someone changed one. Pass a command id and this shows whatever
 * that command is actually bound to right now.
 */
export function Kbd({ chord, className }: { chord: Chord; className?: string }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {chordParts(chord).map((part, i) => (
        <kbd
          key={i}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-border bg-muted/60 px-1 font-sans text-[10px] leading-none text-muted-foreground"
        >
          {part}
        </kbd>
      ))}
    </span>
  )
}

/** The same, looked up from the registry, or nothing when the command is unbound. */
export function CommandKbd({
  id,
  className
}: {
  id: CommandId
  className?: string
}): React.JSX.Element | null {
  const chord = useChordFor(id)
  return chord ? <Kbd chord={chord} className={className} /> : null
}

/** The plain-text form, for a tooltip or an aria-label. */
export function useChordLabel(id: CommandId): string {
  const chord = useChordFor(id)
  return chord ? formatChord(chord) : ''
}
