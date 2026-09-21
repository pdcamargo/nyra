/**
 * The "..." on the address bar.
 *
 * Only what you decide once. Choosing *which* device lives on the device bar
 * instead, next to the size it sets — putting it here meant toggling device
 * mode closed the menu, so the list of sizes only existed if you thought to
 * open it a second time. It read as being locked to whatever it turned on with.
 */
import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { CommandKbd } from '../ui/kbd'
import type { TabDevice } from '../../lib/api-types'

/** What the menu and the bar both hand back. `id` doubles as the mode. */
export type DeviceSpec = { id: string; width?: number; height?: number }

export function isEmulating(device: TabDevice | null): boolean {
  return Boolean(device) && device!.id !== 'responsive'
}

export default function BrowserMenu({
  device,
  remembered,
  onPick
}: {
  device: TabDevice | null
  /** Where "Device mode" goes when it is switched on. */
  remembered: string
  onPick: (spec: DeviceSpec) => void
}): React.JSX.Element {
  const emulating = isEmulating(device)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label="Browser options"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent/50 aria-expanded:text-foreground"
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Browser options</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuCheckboxItem
          checked={emulating}
          onCheckedChange={(on) => onPick({ id: on ? remembered : 'responsive' })}
        >
          Device mode
          <DropdownMenuShortcut>
            <CommandKbd id="browser.deviceMode" />
          </DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        {/* Future items land here. Sizes deliberately do not. */}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
