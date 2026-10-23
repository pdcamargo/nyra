import { describe, it, expect, vi, afterEach } from 'vitest'
import { SUMMARY_THRESHOLD, estimateTokens, handoffText, planHandoff, resolveHandoff } from '../../renderer/src/lib/handoff'
import type { Message } from '../../renderer/src/store/sessions'
import type { SpawnSettings } from '@shared/types'

const msg = (id: string, role: 'user' | 'assistant', text: string): Message => ({ id, role, text }) as Message

/** A chat that ran on Claude through `a0`, then on Codex for `pairs` exchanges, now back on Claude. */
function backOnClaude(pairs: number, words = 5) {
  const filler = Array.from({ length: words }, () => 'lorem').join(' ')
  const messages: Message[] = [msg('a0', 'assistant', 'started on Claude')]
  for (let i = 0; i < pairs; i++) {
    messages.push(msg(`u${i}`, 'user', `ask ${i} ${filler}`), msg(`r${i}`, 'assistant', `answer ${i} ${filler}`))
  }
  return {
    provider: 'claude' as const,
    providerSessionIds: { claude: 'c', codex: 't' },
    providerSeenThrough: { claude: 'a0', codex: messages[messages.length - 1].id },
    needsRecap: false,
    resumeFrom: null,
    messages
  }
}

const settings = { provider: 'claude', model: 'opus', effort: '', planMode: false } as unknown as SpawnSettings

afterEach(() => {
  vi.restoreAllMocks()
})

describe('planHandoff', () => {
  it('has nothing to hand over when the chat never left its CLI', () => {
    const chat = { ...backOnClaude(1), providerSeenThrough: { claude: 'r0' } }
    expect(planHandoff(chat).kind).toBe('none')
  })

  it('sends a short miss as it is — cheaper than having it summarised', () => {
    const plan = planHandoff(backOnClaude(2))
    expect(plan.kind).toBe('recap')
    if (plan.kind === 'recap') {
      expect(plan.from).toBe('codex')
      expect(plan.missed).toBe(4)
      expect(plan.text).toContain('[Earlier in this chat, with Codex]')
    }
  })

  it('has a long miss summarised by the CLI that was answering, keeping the last exchange', () => {
    const plan = planHandoff(backOnClaude(12, 400))
    expect(plan.kind).toBe('summary')
    if (plan.kind === 'summary') {
      expect(plan.tokens).toBeGreaterThan(SUMMARY_THRESHOLD)
      expect(plan.from).toBe('codex')
      expect(plan.fromSessionId).toBe('t')
      expect(plan.recent.map((m) => m.id)).toEqual(['u11', 'r11'])
      expect(plan.earlier).toHaveLength(22)
    }
  })

  it('falls back to the prose when the CLI that answered has no conversation to summarise from', () => {
    const chat = { ...backOnClaude(12, 400), providerSessionIds: { claude: 'c' } }
    expect(planHandoff(chat).kind).toBe('recap')
  })
})

describe('resolveHandoff', () => {
  it('asks the CLI that answered, from its own conversation, and frames its summary', async () => {
    const sideAnswer = vi.fn().mockResolvedValue('Built the parser; tests pass.')
    ;(window.api as unknown as { agent: unknown }).agent = { sideAnswer }
    const plan = planHandoff(backOnClaude(12, 400))
    const text = await resolveHandoff(plan, { sid: 's', cwd: '/repo', settings })
    const ask = sideAnswer.mock.calls[0][0]
    expect(ask.sessionId).toBe('t')
    expect(ask.settings.provider).toBe('codex')
    expect(ask.prompt).toContain('Another assistant (Claude)')
    expect(text).toContain('[Handoff from Codex, summarising 22 earlier messages you have not seen]')
    expect(text).toContain('Built the parser; tests pass.')
    expect(text).toContain('User: ask 11')
  })

  it('sends the prose when the summary cannot be had', async () => {
    ;(window.api as unknown as { agent: unknown }).agent = { sideAnswer: vi.fn().mockRejectedValue(new Error('gone')) }
    const text = await resolveHandoff(planHandoff(backOnClaude(12, 400)), { sid: 's', cwd: '/repo', settings })
    expect(text).toContain('[Earlier in this chat, with Codex]')
    expect(text).toContain('User: ask 0')
  })
})

describe('handoffText and estimateTokens', () => {
  it('puts the summary first and the last exchange after it', () => {
    const text = handoffText('codex', 'summary here', 10, [msg('u', 'user', 'q'), msg('r', 'assistant', 'a')])
    expect(text.indexOf('summary here')).toBeLessThan(text.indexOf('User: q'))
  })

  it('counts about a token per four characters', () => {
    expect(estimateTokens('x'.repeat(380))).toBe(100)
  })
})
