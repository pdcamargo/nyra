import React from 'react'
import { Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { CommandKbd } from '../ui/kbd'
import { NEW_TAB_CHOICES, type NewTabKind } from './tabs'

/**
 * The "+" on the tab strip.
 *
 * It used to make a browser tab outright. Now that a tab could be either thing,
 * pressing it has to ask — and the keycaps are read from the registry rather
 * than written here, so they stay right after a rebinding.
 */
export default function NewTabMenu({
  onPick
}: {
  onPick: (kind: NewTabKind) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="New tab"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent/50 aria-expanded:text-foreground"
      >
        <Plus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {NEW_TAB_CHOICES.map(({ kind, label, icon: Icon, command }) => (
          <DropdownMenuItem key={kind} onSelect={() => onPick(kind)}>
            <Icon />
            {label}
            <DropdownMenuShortcut>
              <CommandKbd id={command} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
