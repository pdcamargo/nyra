import { describe, it, expect } from 'vitest'
import { duration, tokenCount, sumTokens, suggestFix, firstLine } from '../../renderer/src/lib/flowRun'
import type { WorkflowNode, WorkflowNodeRunState } from '../../shared/workflow-types'

const promptNode = (allowedTools?: string[]): WorkflowNode => ({
  id: 'n',
  label: 'Perf audit',
  position: { x: 0, y: 0 },
  data: { type: 'prompt', prompt: '', allowedTools }
})

const state = (tokens?: WorkflowNodeRunState['tokens']): WorkflowNodeRunState => ({
  nodeId: 'n',
  status: 'done',
  tokens
})

describe('duration', () => {
  it('stays in milliseconds below a second, so a fast node does not read as 0s', () => {
    expect(duration(840)).toBe('840ms')
  })

  it('rounds to seconds, then to minutes', () => {
    expect(duration(4200)).toBe('4s')
    expect(duration(72_000)).toBe('1m 12s')
  })

  it('keeps the seconds place when a minute lands exactly', () => {
    expect(duration(120_000)).toBe('2m 0s')
  })
})

describe('tokenCount', () => {
  it('spells small counts out and abbreviates from a thousand', () => {
    expect(tokenCount(840)).toBe('840')
    expect(tokenCount(12_400)).toBe('12.4k')
  })
})

describe('sumTokens', () => {
  it('adds all four buckets, since a node costs all of them or none', () => {
    expect(
      sumTokens([state({ input: 100, output: 20, cacheRead: 4000, cacheCreation: 300 })])
    ).toBe(4420)
  })

  it('treats a node that never ran as zero rather than NaN', () => {
    expect(sumTokens([state(), state({ input: 1, output: 1, cacheRead: 0, cacheCreation: 0 })])).toBe(2)
  })
})

describe('suggestFix', () => {
  it('offers the tool a permission error names', () => {
    const fix = suggestFix('Tool Bash is not allowed for this node', promptNode(['Read', 'Grep']))
    expect(fix).toEqual({ label: 'Add Bash to allowed tools', tool: 'Bash' })
  })

  it('stays quiet when the node already allows that tool', () => {
    expect(suggestFix('Bash is not allowed', promptNode(['Bash']))).toBeNull()
  })

  it('stays quiet on an error that is not about permissions', () => {
    // "Bash" appears, but the failure is the command itself. Suggesting a
    // permission change here would send someone down the wrong path.
    expect(suggestFix('Bash script exited with code 1', promptNode([]))).toBeNull()
  })

  it('stays quiet on a node type that has no allowed-tools list', () => {
    const script: WorkflowNode = {
      id: 's',
      label: 'Run tests',
      position: { x: 0, y: 0 },
      data: { type: 'script', command: 'npm test' }
    }
    expect(suggestFix('Bash is not allowed', script)).toBeNull()
  })

  it('stays quiet when no tool is named at all', () => {
    expect(suggestFix('Permission denied', promptNode([]))).toBeNull()
  })
})

describe('firstLine', () => {
  it('takes the opening line, not a squashed version of all of them', () => {
    expect(firstLine('three files changed\nand some detail\nmore')).toBe('three files changed')
  })

  it('skips leading blank lines', () => {
    // Model output often opens with a newline.
    expect(firstLine('\n\n  the actual answer  \nrest')).toBe('the actual answer')
  })

  it('truncates a long line with an ellipsis', () => {
    const out = firstLine('x'.repeat(200))
    expect(out).toHaveLength(120)
    expect(out.endsWith('…')).toBe(true)
  })

  it('leaves a line that fits alone', () => {
    expect(firstLine('short')).toBe('short')
  })

  it('is empty for nothing', () => {
    expect(firstLine(undefined)).toBe('')
    expect(firstLine('')).toBe('')
    expect(firstLine('   \n  ')).toBe('')
  })
})
