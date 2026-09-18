import React from 'react'
import { CommandKbd } from '../ui/kbd'
import { NEW_TAB_CHOICES, type NewTabKind } from './tabs'

/**
 * A panel with nothing in it.
 *
 * The same two choices the "+" offers, laid out as rows — an open panel saying
 * only "no tabs open" is a dead end, and this is the one moment where what the
 * panel can do is worth spelling out.
 */
export default function WorkspaceEmpty({
  onPick
}: {
  onPick: (kind: NewTabKind) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col justify-center gap-1 p-3">
      {NEW_TAB_CHOICES.map(({ kind, label, icon: Icon, command }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onPick(kind)}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{label}</span>
          <CommandKbd id={command} />
        </button>
      ))}
    </div>
  )
}
