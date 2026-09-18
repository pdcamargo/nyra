import { formatChord } from '../lib/keys'
import React, { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import DiffViewer from './LazyDiffViewer'
import MarkdownRenderer from './MarkdownRenderer'
import { buildDiffFromToolInput } from '../utils/diff'
import { computeDiffHeight } from '../utils/permission'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export type PermissionRequest = {
  tool_id: string
  tool_name: string
  input: Record<string, unknown>
  originalContent?: string | null
}

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
  TaskGet: '✓',
  ExitPlanMode: '▶'
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '⚙'
}

function inputPreview(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '')
  if (name === 'Read') return String(input.file_path ?? input.path ?? '')
  if (name === 'Write' || name === 'Edit') return String(input.file_path ?? input.path ?? '')
  if (name === 'Glob') return `Pattern: ${input.pattern ?? ''}`
  if (name === 'Grep') return `Pattern: ${input.pattern ?? ''}`
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url ?? input.query ?? '')
  return JSON.stringify(input, null, 2)
}

export default function PermissionDialog({
  permission,
  queueLength,
  onAllow,
  onDeny,
  onAllowAll,
  onAlwaysAllow
}: {
  permission: PermissionRequest
  queueLength: number
  onAllow: () => void
  onDeny: () => void
  onAllowAll?: () => void
  onAlwaysAllow?: () => void
}): React.JSX.Element {
  const isFileOp = permission.tool_name === 'Edit' || permission.tool_name === 'Write'
  const diff = isFileOp
    ? buildDiffFromToolInput(permission.tool_name, permission.input, permission.originalContent)
    : null

  const preview = diff ? '' : inputPreview(permission.tool_name, permission.input)
  const wide = diff != null

  // Diff height: computed once on mount from viewport. Modal is short-lived;
  // skipping resize listening avoids re-rendering Monaco mid-drag.
  const [diffHeight] = useState(() => computeDiffHeight(window.innerHeight))

  // Latest-callback ref pattern: lets the keydown listener stay attached
  // across parent re-renders without re-creating it on every callback identity change.
  const callbacksRef = useRef({ onAllow, onDeny, onAllowAll, onAlwaysAllow })
  useEffect(() => {
    callbacksRef.current = { onAllow, onDeny, onAllowAll, onAlwaysAllow }
  })

  // Keyboard shortcuts. Capture phase + stopImmediatePropagation so the dialog
  // claims Enter/Esc unconditionally while open — beats the global abort handler
  // (useKeyboardShortcuts.ts) and prevents the chat textarea from also receiving
  // the key. Assumes PermissionDialog is the topmost modal; if stacking is added,
  // introduce a modal-stack registry to suppress this.
  const actedRef = useRef(false)
  useEffect(() => {
    actedRef.current = false

    const handleKey = (e: KeyboardEvent): void => {
      if (e.repeat) return // ignore held-key repeats
      if (actedRef.current) return // already responded to this permission

      const isCmdOrCtrl = e.metaKey || e.ctrlKey

      if (e.key === 'Enter' && isCmdOrCtrl) {
        if (queueLength > 1 && callbacksRef.current.onAllowAll) {
          e.preventDefault()
          e.stopImmediatePropagation()
          actedRef.current = true
          callbacksRef.current.onAllowAll()
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        actedRef.current = true
        callbacksRef.current.onAllow()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        actedRef.current = true
        callbacksRef.current.onDeny()
      }
    }

    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [permission.tool_id, queueLength])

  const showAllowAllHint = queueLength > 1 && onAllowAll

  return (
    <Modal
      onClose={onDeny}
      title="Tool approval"
      className={`p-5 ${wide ? 'max-w-3xl' : 'max-w-md'}`}
    >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg font-mono text-sm shrink-0 ${
            'bg-warning/10 text-warning/80'
          }`}>
            {toolIcon(permission.tool_name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {isFileOp ? 'Review file change' : 'Permission required'}
              {queueLength > 1 ? ` (${queueLength} pending)` : ''}
            </p>
            <p className="text-sm font-medium text-foreground">
              {permission.tool_name}
              {diff?.isNewFile && (
                <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 rounded-sm bg-success/15 text-success/70">
                  New file
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Content: a diff, or a text preview */}
        {diff ? (
          <div className="mb-5">
            <DiffViewer
              filePath={diff.filePath}
              original={diff.original}
              modified={diff.modified}
              height={diffHeight}
            />
          </div>
        ) : (
          <div className="rounded-lg bg-card border border-border/55 p-3 mb-5">
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed max-h-36 overflow-y-auto">
              {preview}
            </pre>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={onDeny}
            className="flex-1 rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/80 hover:bg-accent hover:text-foreground/80 transition-colors"
          >
            {isFileOp ? 'Reject' : 'Deny'}
          </button>
          {onAlwaysAllow && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onAlwaysAllow}
                  className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/80 hover:bg-accent hover:text-foreground/80 transition-colors whitespace-nowrap"
                >
                  Always allow
                </button>
              </TooltipTrigger>
              <TooltipContent>{`Auto-approve ${permission.tool_name} from now on`}</TooltipContent>
            </Tooltip>
          )}
          <button
            onClick={onAllow}
            className="flex-1 rounded-lg bg-info px-4 py-2 text-sm font-medium text-info-foreground transition-colors hover:bg-info/85"
          >
            {isFileOp ? 'Accept' : 'Allow'}
          </button>
        </div>

        {/* Keyboard shortcut hints */}
        <div className="mt-3 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/70">
          <span><kbd className="px-1 py-0.5 rounded-sm bg-accent/50 font-mono">{formatChord('enter')}</kbd> Allow</span>
          <span><kbd className="px-1 py-0.5 rounded-sm bg-accent/50 font-mono">Esc</kbd> Deny</span>
          {showAllowAllHint && (
            <span><kbd className="px-1 py-0.5 rounded-sm bg-accent/50 font-mono">{formatChord('mod+enter')}</kbd> Allow all ({queueLength})</span>
          )}
        </div>
    </Modal>
  )
}
