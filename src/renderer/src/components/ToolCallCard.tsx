import { formatToolName } from '../utils/toolSummary'
import React, { useState, useEffect, useMemo } from 'react'
import type { ToolCallMessage } from '../store/sessions'
import { useSessionsStore } from '../store/sessions'
import DiffViewer from './LazyDiffViewer'
import { buildDiffFromToolInput } from '../utils/diff'
import { openFileInPanel } from '../lib/openFile'
import { useSettingsStore } from '../store/settings'
import { detectError, type DetectedError } from '../utils/errorDetection'

const TOOL_ICONS: Record<string, string> = {
  Bash: '$',
  Read: 'R',
  Write: 'W',
  Edit: 'E',
  Glob: '*',
  Grep: '/',
  Task: 'T',
  WebFetch: '↗',
  WebSearch: '↗',
  TodoWrite: '✓',
  TodoRead: '✓',
  TaskCreate: '✓',
  TaskUpdate: '✓',
  TaskList: '✓',
  TaskGet: '✓'
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⚙'
}

// Format tool input into a readable one-liner summary
function inputSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '').split('\n')[0].slice(0, 80)
  if (name === 'Read') return String(input.file_path ?? input.path ?? '')
  if (name === 'Write' || name === 'Edit') return String(input.file_path ?? input.path ?? '')
  if (name === 'Glob') return String(input.pattern ?? '')
  if (name === 'Grep') return String(input.pattern ?? '')
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url ?? input.query ?? '')
  if (name === 'TaskCreate') return String(input.subject ?? '')
  if (name === 'TaskUpdate') return `#${input.taskId ?? '?'} → ${input.status ?? '?'}`
  if (name === 'TaskList') return 'List all tasks'
  if (name === 'TaskGet') return `#${input.taskId ?? '?'}`
  const first = Object.values(input)[0]
  if (first == null) return ''
  if (typeof first === 'string') return first.slice(0, 60)
  if (typeof first === 'number' || typeof first === 'boolean') return String(first)
  return ''
}

function truncateResult(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n... (truncated)'
}

function handleFixThis(message: ToolCallMessage): void {
  const command =
    message.tool_name === 'Bash' ? String(message.input.command ?? '').split('\n')[0] : ''

  const prompt = command
    ? `The command \`${command}\` failed with this error:\n\n\`\`\`\n${truncateResult(message.result!, 500)}\n\`\`\`\n\nPlease fix this error.`
    : `The ${message.tool_name} tool failed with this error:\n\n\`\`\`\n${truncateResult(message.result!, 500)}\n\`\`\`\n\nPlease fix this error.`

  useSessionsStore.getState().setPendingAction({ type: 'send', text: prompt })
}

function handleExplainError(message: ToolCallMessage): void {
  const prompt = `Explain this error in simple terms:\n\n\`\`\`\n${truncateResult(message.result!, 500)}\n\`\`\`\n\nWhat went wrong and what are possible fixes?`

  useSessionsStore.getState().setPendingAction({ type: 'send', text: prompt })
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write'])

function ToolCallCardInner({
  message,
  isLoading,
  nested
}: {
  message: ToolCallMessage
  isLoading?: boolean
  nested?: boolean
}): React.JSX.Element {
  const isFileOp = message.tool_name === 'Edit' || message.tool_name === 'Write'
  const [expanded, setExpanded] = useState(isFileOp)
  const done = message.result !== undefined
  const denied = message.denied === true
  const summary = inputSummary(message.tool_name, message.input)
  const hasFilePath = FILE_TOOLS.has(message.tool_name) && !!summary

  const diff = useMemo(
    () => isFileOp ? buildDiffFromToolInput(message.tool_name, message.input, message.originalContent) : null,
    [isFileOp, message.tool_name, message.input, message.originalContent]
  )

  const error: DetectedError | null = useMemo(
    () => (done && !denied && message.result ? detectError(message.tool_name, message.result) : null),
    [done, denied, message.result, message.tool_name]
  )

  // Auto-expand on error
  useEffect(() => {
    if (error) setExpanded(true)
  }, [error])

  const dotClass = denied
    ? 'bg-danger/60'
    : error?.severity === 'error'
      ? 'bg-danger/70'
      : error?.severity === 'warning'
        ? 'bg-warning/70'
        : done
          ? 'bg-success/60'
          : 'bg-warning/70 animate-pulse'

  const borderClass = denied
    ? 'border-danger/12 bg-danger/3'
    : error?.severity === 'error'
      ? 'border-danger/15 bg-danger/4'
      : error?.severity === 'warning'
        ? 'border-warning/12 bg-warning/3'
        : 'border-border bg-muted/40'

  return (
    <div className={`${nested ? 'my-0' : 'my-1'} ${nested ? 'rounded-md border-border/55 bg-muted/40' : borderClass} rounded-lg border overflow-hidden text-c-md`}>
      {/* Header row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className={"w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"}
      >
        {/* Status dot */}
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />

        {/* Icon */}
        <span className="font-mono text-muted-foreground/70 w-3 text-center shrink-0">
          {toolIcon(message.tool_name)}
        </span>

        {/* Tool name */}
        <span className={`font-medium shrink-0 ${denied ? 'text-danger/60' : 'text-foreground/80'}`}>
          {formatToolName(message.tool_name)}
        </span>

        {/* Status labels for file ops */}
        {isFileOp && denied && (
          <span className="text-c-xs text-danger/50 shrink-0">
            rejected — file not modified
          </span>
        )}
        {isFileOp && done && !denied && (
          <span className="text-c-xs text-success/40 shrink-0">file updated</span>
        )}

        {/* Denied label for non-file ops */}
        {!isFileOp && denied && (
          <span className="text-c-xs text-danger/50 shrink-0">denied</span>
        )}

        {/* Error summary badge */}
        {error && (
          <span
            className={`text-c-xs shrink-0 ${
              error.severity === 'error' ? 'text-danger/70' : 'text-warning/60'
            }`}
          >
            {error.summary}
          </span>
        )}

        {/* Summary */}
        {summary && !denied && !error && (
          hasFilePath ? (
            <span
              className="text-info/60 hover:text-info font-mono truncate min-w-0 cursor-pointer transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                openFileInPanel(summary)
              }}
            >
              {summary}
            </span>
          ) : (
            <span className="text-muted-foreground/70 font-mono truncate min-w-0">{summary}</span>
          )
        )}

        {/* Expand toggle */}
        <span className="ml-auto text-muted-foreground/70 shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border/55">
          {/* Diff view for file operations */}
          {diff ? (
            <div className="p-3">
              <DiffViewer
                filePath={diff.filePath}
                original={diff.original}
                modified={diff.modified}
                height={240}
              />
            </div>
          ) : (
            /* Raw input for other tools */
            <div className="px-3 py-2">
              <p className="text-c-xs text-muted-foreground/70 uppercase tracking-wider mb-1.5">Input</p>
              <pre className="text-c-sm text-foreground/80 font-mono overflow-x-auto whitespace-pre-wrap wrap-break-word leading-relaxed max-h-40 overflow-y-auto">
                {JSON.stringify(message.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {done && !denied && (
            <div className="px-3 py-2 border-t border-border/55">
              <p className="text-c-xs text-muted-foreground/70 uppercase tracking-wider mb-1.5">Output</p>
              <pre className="text-c-sm text-foreground/80 font-mono overflow-x-auto whitespace-pre-wrap wrap-break-word leading-relaxed max-h-48 overflow-y-auto">
                {message.result || '(empty)'}
              </pre>
            </div>
          )}

          {/* Error action buttons */}
          {done && !denied && error && (
            <div className="px-3 py-2 border-t border-border/55 flex gap-2">
              <button
                disabled={isLoading}
                onClick={() => handleFixThis(message)}
                className="text-c-sm px-2.5 py-1 rounded-sm bg-danger/10 text-danger/80 hover:bg-danger/20 hover:text-danger transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Fix this
              </button>
              <button
                disabled={isLoading}
                onClick={() => handleExplainError(message)}
                className="text-c-sm px-2.5 py-1 rounded-sm bg-accent/50 text-muted-foreground hover:bg-accent hover:text-foreground/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Explain error
              </button>
            </div>
          )}

          {!done && !denied && (
            <div className="px-3 py-2 border-t border-border/55">
              <span className="text-c-sm text-muted-foreground/70 italic">Running…</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ToolCallCard = React.memo(ToolCallCardInner) as React.MemoExoticComponent<typeof ToolCallCardInner>
export default ToolCallCard
