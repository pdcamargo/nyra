import { describe, it, expect } from 'vitest'
import { inlineLabel, buildGroupSummary, formatToolName, mcpServer } from '../../renderer/src/utils/toolSummary'
import type { ToolCallMessage } from '../../renderer/src/store/sessions'

const call = (tool_name: string, input: Record<string, unknown> = {}): ToolCallMessage => ({
  id: tool_name, role: 'tool_call', tool_id: tool_name, tool_name, input
})

describe('tool naming', () => {
  it('names a skill by its skill, not by its arguments', () => {
    // The default branch took whichever key serialised first, so a long `args`
    // string read as if the skill were called "Edit a task prompt I'm about…".
    const label = inlineLabel('Skill', { args: 'Edit a task prompt I am about to hand over', skill: 'no-ai-slop' }, false)
    expect(label).toContain('no-ai-slop')
    expect(label).not.toContain('Edit a task prompt')
  })

  it('reads an mcp tool as server:function everywhere', () => {
    expect(formatToolName('mcp__playwright__browser_click')).toBe('playwright:browser_click')
    expect(mcpServer('mcp__playwright__browser_click')).toBe('playwright')
    expect(mcpServer('Bash')).toBeNull()
    // Past tense falls through to the same formatter rather than the raw name.
    expect(inlineLabel('mcp__playwright__browser_click', {}, true)).toContain('playwright:browser_click')
  })

  it('counts mcp calls by server instead of burying them in "other tools"', () => {
    const summary = buildGroupSummary([
      call('Read', { file_path: '/a' }),
      call('mcp__playwright__browser_click'),
      call('mcp__playwright__browser_type')
    ])
    expect(summary).toContain('2 playwright calls')
    expect(summary).not.toContain('other tool')
  })

  it('still buckets genuinely unknown tools', () => {
    const summary = buildGroupSummary([call('Read', { file_path: '/a' }), call('Wizardry')])
    expect(summary).toContain('1 other tool')
  })

  it('gives the newer built-ins a verb', () => {
    expect(inlineLabel('ToolSearch', { query: 'select:Read' }, false)).toContain('Looking up tools')
    expect(inlineLabel('Workflow', { name: 'review' }, true)).toContain('Ran workflow')
  })
})
