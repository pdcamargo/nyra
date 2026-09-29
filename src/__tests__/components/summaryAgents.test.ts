import { describe, expect, it } from 'vitest'
import { AGENTS_INLINE_LIMIT, inlineAgents } from '../../renderer/src/components/SummaryPanel'
import type { Agent } from '../../renderer/src/store/sessions'

const agent = (id: string, status: Agent['status']): Agent => ({
  toolId: id,
  name: id,
  subagentType: 'Explore',
  status,
  startedAt: 0
})

describe('inlineAgents', () => {
  it('lists every agent while there are few of them', () => {
    const few = [agent('a', 'done'), agent('b', 'running'), agent('c', 'failed')]
    expect(inlineAgents(few)).toEqual({ shown: few, hidden: 0 })
  })

  it('keeps only the running ones once there are more than the limit', () => {
    const many = [
      ...Array.from({ length: 6 }, (_, i) => agent(`done-${i}`, 'done')),
      agent('live-1', 'running'),
      agent('live-2', 'running')
    ]
    const { shown, hidden } = inlineAgents(many)
    expect(shown.map((a) => a.toolId)).toEqual(['live-1', 'live-2'])
    expect(hidden).toBe(6)
  })

  it('caps the running ones too, and folds away everything when none are running', () => {
    const running = Array.from({ length: 8 }, (_, i) => agent(`live-${i}`, 'running'))
    expect(inlineAgents(running).shown).toHaveLength(AGENTS_INLINE_LIMIT)
    expect(inlineAgents(running).hidden).toBe(3)

    const finished = Array.from({ length: 9 }, (_, i) => agent(`done-${i}`, 'done'))
    expect(inlineAgents(finished)).toEqual({ shown: [], hidden: 9 })
  })
})
