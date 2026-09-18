/**
 * Telling a subagent's report apart from its launch receipt.
 *
 * A `Task` tool call used to block until the subagent finished, so its result
 * was the report. Background subagents answer straight away with an
 * acknowledgement — an internal id, an output path, and a note not to quote any
 * of it — and the report arrives later. Nyra kept showing the result, so
 * clicking a subagent produced a wall of harness metadata instead of an answer.
 */

/** Phrases that only ever appear in the launch receipt, never in a report. */
const LAUNCH_MARKERS = [
  'async agent launched successfully',
  'agent is working in the background',
  'the agent is running in the background'
]

export function isLaunchReceipt(result: string | null | undefined): boolean {
  if (!result) return false
  const head = result.slice(0, 400).toLowerCase()
  return LAUNCH_MARKERS.some((m) => head.includes(m))
}

/**
 * The part of a tool result worth showing, or null when there is nothing yet.
 *
 * Also drops a trailing `output_file:` line and the "do not read this file"
 * warning that rides along with it — both are instructions to the model about
 * its own transcript, and neither means anything to someone reading the panel.
 */
export function cleanAgentReport(result: string | null | undefined): string | null {
  if (!result || isLaunchReceipt(result)) return null
  const trimmed = result
    .split('\n')
    .filter(
      (line) =>
        !/^\s*output_file:\s/i.test(line) &&
        !/^\s*do not (read|tail)\b[^\n]*\bthis file\b/i.test(line) &&
        !/^\s*<\/?task-notification>/i.test(line)
    )
    .join('\n')
    .trim()
  return trimmed || null
}
