/**
 * Pure helpers for reading a run.
 *
 * Formatting and the error-to-fix guess live here rather than in the canvas
 * component so they can be tested without mounting React Flow.
 */
import type { WorkflowNode, WorkflowNodeRunState } from '../../../shared/workflow-types'

/** `1m 12s`, `4.2s`, `840ms`. Short enough for a chip that reflows every second. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/** Short token count: `12.4k`, `840`. */
export function tokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Every bucket added up, since a node's cost is all four or none of them. */
export function sumTokens(states: WorkflowNodeRunState[]): number {
  return states.reduce(
    (sum, s) =>
      sum +
      (s.tokens
        ? s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation
        : 0),
    0
  )
}

const CLAUDE_TOOLS = /\b(Bash|Write|Edit|WebFetch|WebSearch|Task|NotebookEdit|Read|Grep|Glob)\b/

/**
 * An error that names its own fix.
 *
 * A prompt node asking to run `hyperfine` with `allowedTools: Read, Grep` fails
 * with a message about a disallowed tool. The fix is one edit to the chips in
 * this node's own config, so the panel offers it rather than leaving you to
 * translate the message into a config change yourself.
 *
 * Deliberately narrow: only a permission-shaped error, only a tool the node does
 * not already allow, only on a prompt node. A wrong suggestion costs more than
 * no suggestion.
 */
export function suggestFix(
  error: string,
  node: WorkflowNode
): { label: string; tool: string } | null {
  if (node.data.type !== 'prompt') return null
  if (!/not allowed|permission|disallow|allowedtools/i.test(error)) return null
  const tool = CLAUDE_TOOLS.exec(error)?.[1]
  if (!tool) return null
  if ((node.data.allowedTools ?? []).includes(tool)) return null
  return { label: `Add ${tool} to allowed tools`, tool }
}

/**
 * The first non-empty line of a node's output, for a one-line summary.
 *
 * A node's result is usually a paragraph or a diff; the run summary has one row
 * per step and needs the opening line, not a squashed version of all of them.
 */
export function firstLine(text: string | undefined, max = 120): string {
  if (!text) return ''
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
