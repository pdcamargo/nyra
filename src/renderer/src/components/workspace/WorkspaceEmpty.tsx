import React from 'react'
import { CommandKbd } from '../ui/kbd'
import { NEW_TAB_CHOICES, type NewTabKind } from './tabs'

/**
 * A panel with nothing in it.
 *
 * The same two choices the "+" offers, laid out as rows — an open panel saying
 * only "no tabs open" is a dead end, and this is the one moment where what the
 * panel can do is worth spelling out.
 *
 * Each row carries its own fill rather than only lighting up on hover: with two
 * items and nothing else on screen, they have to read as things to press before
 * the pointer is anywhere near them. Centred and capped rather than stretched,
 * because a full-width row in a wide panel reads as a list header.
 */
export default function WorkspaceEmpty({
  onPick
}: {
  onPick: (kind: NewTabKind) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-3">
      <div className="flex w-4/5 max-w-[280px] flex-col gap-1">
        {NEW_TAB_CHOICES.map(({ kind, label, icon: Icon, command }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onPick(kind)}
            className="flex items-center gap-2.5 rounded-md border border-border/55 bg-muted/40 px-2.5 py-2 text-left text-[12px] text-foreground/80 transition-colors hover:border-border-strong hover:bg-accent/50 hover:text-foreground"
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <CommandKbd id={command} className="shrink-0" />
          </button>
        ))}
      </div>
    </div>
  )
}
