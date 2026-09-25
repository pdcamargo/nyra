import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SkillChip, { skillHeadline } from '../../renderer/src/components/SkillChip'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const call = (over: Partial<ToolCallMessage> = {}): ToolCallMessage => ({
  id: 'm1',
  role: 'tool_call',
  tool_id: 't1',
  tool_name: 'Skill',
  input: { skill: 'nyra-app' },
  ...over
})

describe('SkillChip', () => {
  it('names the skill once, not "Skill skill"', () => {
    render(<SkillChip message={call({ result: 'Launching skill: nyra-app' })} />)
    expect(screen.getByText('nyra-app skill loaded')).toBeTruthy()
  })

  it('says it is loading until the result lands', () => {
    expect(skillHeadline(call())).toBe('Loading nyra-app skill…')
  })

  it('reports a failed or denied load', () => {
    expect(skillHeadline(call({ result: '<tool_use_error>Unknown skill</tool_use_error>' }))).toBe(
      'nyra-app skill could not be loaded'
    )
    expect(skillHeadline(call({ denied: true }))).toBe('nyra-app skill could not be loaded')
  })
})
