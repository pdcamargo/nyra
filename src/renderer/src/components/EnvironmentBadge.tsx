import React from 'react'
import { Badge } from './ui/badge'
import { environmentLabel } from '../lib/environment'

/**
 * `WSL · Ubuntu` beside a project that lives inside a distro, and nothing for
 * one on this machine. A WSL project's Claude, git and terminal all run in the
 * distro, with its own `~/.claude` — worth knowing at a glance, since the same
 * repo opened from `C:\` would behave differently.
 */
export default function EnvironmentBadge({ cwd }: { cwd: string }): React.JSX.Element | null {
  const label = environmentLabel(cwd)
  if (!label) return null
  return (
    <Badge variant="outline" className="h-4 px-1.5 font-normal">
      {label}
    </Badge>
  )
}
