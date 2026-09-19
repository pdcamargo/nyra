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
 *
 * The keycap takes its colours from `currentColor` rather than from surface
 * tokens. It used to be `bg-muted/60` + `text-muted-foreground`, which assumes
 * the keycap sits on `--background`. On a filled button (`bg-foreground
 * text-background`) those two tokens land within ~0.08 lightness of each other
 * and the glyph vanishes, leaving a row of blank plates. Deriving from the text
 * colour means whatever contrast the parent already guarantees for its own
 * label, the keycap inherits — on any surface, in either theme.
 */
export function Kbd({ chord, className }: { chord: Chord; className?: string }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {chordParts(chord).map((part, i) => (
        <kbd
          key={i}
          // `TooltipContent` styles descendants matching this slot — it reserves
          // right padding when a keycap is present and lifts the cap above the
          // rotated arrow. Nothing in the app set the attribute, so those rules
          // had never once matched.
          data-slot="kbd"
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-current/25 bg-current/10 px-1 font-sans text-[10px] leading-none text-current/75"
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
export function useChordLabel(id: CommandId | undefined): string {
  const chord = useChordFor(id)
  return chord ? formatChord(chord) : ''
}
