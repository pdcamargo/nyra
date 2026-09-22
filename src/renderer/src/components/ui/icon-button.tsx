/**
 * A small icon control with a real tooltip, and the shortcut on it.
 *
 * The title bar had this, the panels did not — they used the native `title`
 * attribute, which looks nothing like the app, takes a second to appear, and has
 * nowhere to put a keycap. Anything a power user would want a key for should say
 * what that key is, and read it from the registry rather than hardcoding it, so
 * it stays right after a rebinding.
 */
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { useChordLabel } from './kbd'
import type { CommandId } from '../../commands/registry'

export function IconButton({
  label,
  command,
  active,
  onClick,
  className = '',
  children
}: {
  label: string
  /** When the action has a registered command, its keycap is appended. */
  command?: CommandId
  active?: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const keys = useChordLabel(command)
  const full = keys ? `${label} (${keys})` : label

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        aria-pressed={active}
        aria-label={label}
        className={`rounded p-0.5 transition-colors hover:text-foreground ${
          active ? 'bg-accent text-foreground' : 'text-muted-foreground'
        } ${className}`}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  )
}
