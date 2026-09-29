import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TraceLine, failureLabel } from '../../renderer/src/components/ToolCallGroup'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const bash = (partial: Partial<ToolCallMessage>): ToolCallMessage => ({
  id: 'm1',
  role: 'tool_call',
  tool_id: 't1',
  tool_name: 'Bash',
  input: { command: 'grep -rn isError src', description: 'Find error handling' },
  ...partial
})

const name = (): HTMLElement => screen.getByTitle('Bash')

describe('TraceLine', () => {
  it('does not go red because the output mentions an error', () => {
    // The old heuristic: any "error" in the text meant failure.
    render(<TraceLine message={bash({ result: 'src/a.ts:12: if (isError) throw new Error()' })} />)
    expect(name().className).not.toMatch(/text-danger/)
    expect(screen.queryByText(/failed|exit/)).toBeNull()
  })

  it('goes red when the CLI says it failed, and says why', () => {
    render(<TraceLine message={bash({ result: 'Exit code 2\nno such file', isError: true })} />)
    expect(name().className).toMatch(/text-danger/)
    expect(screen.getByText('exit 2')).toBeInTheDocument()
  })
})

describe('failureLabel', () => {
  it('names the exit code of a failed command, and falls back to "failed"', () => {
    expect(failureLabel('Exit code 127\ncommand not found')).toBe('exit 127')
    expect(failureLabel('The operation timed out.')).toBe('failed')
    expect(failureLabel(undefined)).toBe('failed')
  })
})
