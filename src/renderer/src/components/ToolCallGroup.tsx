import React, { useState } from 'react'
import type { ToolCallMessage } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { inlineLabel, buildGroupSummary, formatToolName } from '../utils/toolSummary'
import { useFilePreviewStore } from '../store/filePreview'
import AskUserQuestionCard from './AskUserQuestionCard'

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])

function TraceLine({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const done = message.result !== undefined
  const denied = message.denied === true
  const hasError = done && !denied && message.result && (
    message.result.includes('error') || message.result.includes('Error') ||
    message.result.includes('ENOENT') || message.result.includes('exit code')
  )

  const dotClass = denied
    ? 'bg-danger/50'
    : hasError
      ? 'bg-danger/60'
      : done
        ? 'bg-success/40'
        : 'bg-warning/60 animate-pulse'

  const label = inlineLabel(message.tool_name, message.input, done)
  const filePath = FILE_TOOLS.has(message.tool_name)
    ? String(message.input.file_path ?? message.input.path ?? '')
    : null

  return (
    <div className="w-full flex items-center gap-2 py-[3px] px-1">
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span
        title={message.tool_name}
        className={`font-mono text-[11px] w-[120px] shrink-0 truncate ${denied ? 'text-danger/50' : 'text-muted-foreground'}`}
      >
        {formatToolName(message.tool_name)}
      </span>
      {filePath && !denied ? (
        <button
          type="button"
          className="text-[11px] text-info/50 hover:text-info font-mono truncate min-w-0 transition-colors text-left"
          onClick={() => useFilePreviewStore.getState().open(filePath)}
        >
          {filePath.split('/').slice(-3).join('/')}
        </button>
      ) : (
        <span className={`text-[11px] font-mono truncate min-w-0 ${denied ? 'text-danger/40' : 'text-muted-foreground/70'}`}>
          {label.replace(/^\S+\s*/, '')}
        </span>
      )}
      {denied && (
        <span className="text-[10px] text-danger/40 ml-auto shrink-0">denied</span>
      )}
    </div>
  )
}

export default function ToolCallGroup({
  messages
}: {
  messages: ToolCallMessage[]
  isLoading?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const allDone = messages.every((m) => m.result !== undefined)
  const anyDenied = messages.some((m) => m.denied)
  const isSingle = messages.length === 1

  // Single tool call — just render a trace line
  if (isSingle) {
    const only = messages[0]
    if (only.tool_name === 'AskUserQuestion') {
      return <AskUserQuestionCard message={only} />
    }
    return (
      <div className="py-0.5">
        <TraceLine message={only} />
      </div>
    )
  }

  // Group of tool calls
  const summary = buildGroupSummary(messages)
  const dotClass = anyDenied
    ? 'bg-danger/50'
    : allDone
      ? 'bg-success/40'
      : 'bg-warning/60 animate-pulse'

  return (
    <div className="py-0.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 py-[3px] px-1 text-left rounded-sm hover:bg-muted/40 transition-colors"
      >
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />
        <span className={`text-[11px] font-mono ${anyDenied ? 'text-danger/40' : 'text-muted-foreground'}`}>
          {summary}
        </span>
        <span className="ml-auto text-muted-foreground/70 shrink-0 text-[10px]">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="ml-3 border-l border-border/55 pl-2 mt-0.5">
          {messages.map((m) => (
            <TraceLine key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  )
}
