/**
 * A skill Claude loaded, as one line in the transcript.
 *
 * As a trace line it read "Skill  skill nyra-app" — the tool's name, then the
 * label's verb stripped down to the word it had already said. Loading a skill
 * changes how the rest of the turn goes, so it gets its own kind of line: an
 * icon and the skill's name, at the same density as the memory chip.
 */
import React from 'react'
import { Sparkles } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'

function failed(result: string): boolean {
  return /^(error|<tool_use_error>)/i.test(result.trim())
}

export function skillHeadline(message: ToolCallMessage): string {
  const name = String(message.input.skill ?? message.input.name ?? 'A')
  if (message.denied) return `${name} skill could not be loaded`
  if (message.result === undefined) return `Loading ${name} skill…`
  if (failed(message.result)) return `${name} skill could not be loaded`
  return `${name} skill loaded`
}

export default function SkillChip({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const bad = message.denied === true || (message.result !== undefined && failed(message.result))
  const pending = !bad && message.result === undefined
  const textClass = pending ? 'nyra-shimmer' : bad ? 'text-danger' : 'text-muted-foreground'

  return (
    <div className="py-1">
      <div className="flex w-full items-center gap-2 py-1">
        <Sparkles className="size-3 shrink-0 text-muted-foreground" />
        <span className={`truncate text-c-sm ${textClass}`}>{skillHeadline(message)}</span>
      </div>
    </div>
  )
}
