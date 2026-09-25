import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SubagentChip, { joinNames } from '../../renderer/src/components/SubagentChip'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const spawn = (id: string, description: string, over: Partial<ToolCallMessage> = {}): ToolCallMessage => ({
  id: `m-${id}`,
  role: 'tool_call',
  tool_id: id,
  tool_name: 'Agent',
  input: { description },
  ...over
})

const end = (id: string, name: string, status: 'done' | 'failed'): ToolCallMessage => ({
  id: `e-${id}`,
  role: 'tool_call',
  tool_id: `ended-${id}`,
  tool_name: 'SubagentEnded',
  input: { agentToolId: id, name, status },
  result: ''
})

describe('SubagentChip', () => {
  it('keeps saying the spawn started, even once the agent is done', () => {
    render(<SubagentChip messages={[spawn('a', 'Engine choice', { result: 'ok' })]} />)
    expect(screen.getByText('Engine choice started working')).toBeTruthy()
  })

  it('announces an end on its own line', () => {
    render(<SubagentChip ended messages={[end('a', 'Engine choice', 'done')]} />)
    expect(screen.getByText('Engine choice finished')).toBeTruthy()
  })

  it('says an agent cut off with its turn was interrupted', () => {
    render(<SubagentChip ended messages={[end('a', 'A', 'failed'), end('b', 'B', 'failed')]} />)
    expect(screen.getByText('A and B were interrupted')).toBeTruthy()
  })

  it('joins names the way a sentence does', () => {
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C')
  })
})
