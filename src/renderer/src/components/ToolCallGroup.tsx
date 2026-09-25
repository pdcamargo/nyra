import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { inlineLabel, buildGroupSummary, formatToolName } from '../utils/toolSummary'
import { openFileInPanel } from '../lib/openFile'
import AskUserQuestionCard from './AskUserQuestionCard'
import PlanCard, { type PlanAnswer } from './PlanCard'
import FinishedChecklist from './FinishedChecklist'
import GoalChip from './GoalChip'
import SkillChip from './SkillChip'

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])

export function TraceLine({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const done = message.result !== undefined
  const denied = message.denied === true
  const hasError = done && !denied && message.result && (
    message.result.includes('error') || message.result.includes('Error') ||
    message.result.includes('ENOENT') || message.result.includes('exit code')
  )

  // No status dot: the row lines up with the prose around it, so the state
  // rides on the name — shimmering while it runs, red when it failed.
  const nameClass = denied || hasError
    ? 'text-danger'
    : done
      ? 'text-muted-foreground'
      : 'nyra-shimmer'

  const label = inlineLabel(message.tool_name, message.input, done)
  const filePath = FILE_TOOLS.has(message.tool_name)
    ? String(message.input.file_path ?? message.input.path ?? '')
    : null

  return (
    <div className="w-full flex items-center gap-2 py-1">
      <span
        title={message.tool_name}
        className={`font-mono text-c-sm w-[120px] shrink-0 truncate ${nameClass}`}
      >
        {formatToolName(message.tool_name)}
      </span>
      {filePath && !denied ? (
        <button
          type="button"
          className="text-c-sm text-info hover:underline font-mono truncate min-w-0 transition-colors text-left"
          onClick={() => openFileInPanel(filePath)}
        >
          {filePath.split('/').slice(-3).join('/')}
        </button>
      ) : (
        <span
          // The label is a summary of a Bash call; the command itself is one hover away.
          title={message.tool_name === 'Bash' ? String(message.input.command ?? '') : undefined}
          // The whole line shimmers while it runs, not just the tool's name —
          // "Bash" alone moving is too little to notice beside a still command.
          className={`text-c-sm font-mono truncate min-w-0 ${denied ? 'text-danger' : done ? 'text-muted-foreground' : 'nyra-shimmer'}`}
        >
          {label.replace(/^\S+\s*/, '')}
        </span>
      )}
      {denied && (
        <span className="text-c-xs text-danger ml-auto shrink-0">denied</span>
      )}
    </div>
  )
}

export default function ToolCallGroup({
  messages,
  onPlanAnswer,
  onQuestionAnswer
}: {
  messages: ToolCallMessage[]
  isLoading?: boolean
  onPlanAnswer?: (toolId: string, answer: PlanAnswer, planPath?: string, note?: string) => void
  onQuestionAnswer?: (toolId: string, answer: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const allDone = messages.every((m) => m.result !== undefined)
  const anyDenied = messages.some((m) => m.denied)
  const isSingle = messages.length === 1

  // Single tool call — just render a trace line
  if (isSingle) {
    const only = messages[0]
    if (only.tool_name === 'AskUserQuestion') {
      return <AskUserQuestionCard message={only} onAnswer={onQuestionAnswer} />
    }
    if (only.tool_name === 'ExitPlanMode') {
      return <PlanCard message={only} onAnswer={onPlanAnswer} />
    }
    if (only.tool_name === 'TaskChecklist') {
      return <FinishedChecklist message={only} />
    }
    if (only.tool_name === 'GoalSet') {
      return <GoalChip message={only} />
    }
    if (only.tool_name === 'Skill') {
      return <SkillChip message={only} />
    }
    return (
      <div className="py-1">
        <TraceLine message={only} />
      </div>
    )
  }

  // Group of tool calls
  const summary = buildGroupSummary(messages)
  const summaryClass = anyDenied ? 'text-danger' : allDone ? 'text-muted-foreground' : 'nyra-shimmer'

  return (
    <div className="py-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        // -mx-1 px-1: the hover fill keeps its breathing room while the text
        // itself starts on the same edge as the prose above and below it.
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/40"
      >
        <span className={`text-c-sm font-mono ${summaryClass}`}>
          {summary}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="flex-1" />
      </button>
      {expanded && (
        <div className="ml-3 mt-1 border-l border-border/55 pl-2">
          {messages.map((m) => (
            <TraceLine key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  )
}
