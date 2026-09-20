import { describe, expect, it } from 'vitest'
import {
  cleanAgentReport,
  isLaunchReceipt,
  outputFileFromReceipt
} from '@renderer/lib/agentReport'

// The exact thing that showed up in the panel where a report should have been.
const RECEIPT = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: a9c928a5c527845d2 (internal ID - do not mention to user.)
The agent is working in the background. You will be notified automatically when it completes.
output_file: /private/tmp/claude-501/tasks/a9c928a5c527845d2.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript.`

describe('isLaunchReceipt', () => {
  it('recognises the background-launch acknowledgement', () => {
    expect(isLaunchReceipt(RECEIPT)).toBe(true)
  })

  it('does not mistake a real report for one', () => {
    expect(isLaunchReceipt('## What I found\n\nThe flag lives in three files.')).toBe(false)
    expect(isLaunchReceipt('')).toBe(false)
    expect(isLaunchReceipt(null)).toBe(false)
  })
})

describe('cleanAgentReport', () => {
  it('shows nothing rather than the receipt', () => {
    expect(cleanAgentReport(RECEIPT)).toBeNull()
  })

  it('passes a real report through untouched', () => {
    const report = '## What I found\n\nThe flag lives in three files.'
    expect(cleanAgentReport(report)).toBe(report)
  })

  it('strips the transcript-path housekeeping off the end of a real report', () => {
    const mixed = [
      '## Findings',
      '',
      'Two things matter here.',
      'output_file: /private/tmp/claude-501/tasks/abc.output',
      'Do NOT Read or tail this file via the shell tool — it will overflow your context.'
    ].join('\n')
    expect(cleanAgentReport(mixed)).toBe('## Findings\n\nTwo things matter here.')
  })

  it('is null for an empty or absent result', () => {
    expect(cleanAgentReport(null)).toBeNull()
    expect(cleanAgentReport('   ')).toBeNull()
  })
})

describe('outputFileFromReceipt', () => {
  it('pulls the transcript path out of the same receipt', () => {
    // The receipt tells the *model* not to read this file. Nyra is not a context
    // window — following it is the only way to watch a background agent work.
    expect(outputFileFromReceipt(RECEIPT)).toBe(
      '/private/tmp/claude-501/tasks/a9c928a5c527845d2.output'
    )
  })

  it('is null when there is no such line', () => {
    expect(outputFileFromReceipt('It finished. Here is the answer.')).toBeNull()
    expect(outputFileFromReceipt(null)).toBeNull()
  })

  it('does not mistake prose that merely mentions the words for a path', () => {
    expect(outputFileFromReceipt('the output_file: was never written')).toBeNull()
  })
})
