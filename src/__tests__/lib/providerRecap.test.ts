import { describe, it, expect } from 'vitest'
import { recapFor } from '../../renderer/src/lib/historyText'
import { anchorFor, capabilitiesOf } from '../../renderer/src/lib/providers'
import type { Anchor, Message, Session } from '../../renderer/src/store/sessions'

const msg = (id: string, role: 'user' | 'assistant', text: string): Message => ({ id, role, text }) as Message

const messages = [
  msg('u1', 'user', 'make a plan'),
  msg('a1', 'assistant', 'here is the plan'),
  msg('u2', 'user', 'now build it'),
  msg('a2', 'assistant', 'built')
]

type Source = Parameters<typeof recapFor>[0]
const chat = (over: Partial<Source>): Source => ({
  provider: 'claude',
  providerSessionIds: {},
  providerSeenThrough: {},
  needsRecap: false,
  resumeFrom: null,
  messages,
  ...over
})

describe('recapFor', () => {
  it('tells a chat that only ever ran on one CLI nothing', () => {
    expect(recapFor(chat({ providerSessionIds: { claude: 'c' }, providerSeenThrough: { claude: 'a2' } }))).toBe('')
  })

  it('gives a CLI taking over a chat for the first time all of it', () => {
    const recap = recapFor(chat({ provider: 'codex', providerSeenThrough: { claude: 'a2' } }))
    expect(recap).toContain('[Earlier in this chat, with Claude]')
    expect(recap).toContain('User: make a plan')
    expect(recap).toContain('Assistant: built')
  })

  it('gives a CLI coming back only what happened while it was away', () => {
    const recap = recapFor(
      chat({ provider: 'claude', providerSessionIds: { claude: 'c', codex: 't' }, providerSeenThrough: { claude: 'a1', codex: 'a2' } })
    )
    expect(recap).toContain('[Earlier in this chat, with Codex]')
    expect(recap).not.toContain('make a plan')
    expect(recap).toContain('User: now build it')
    expect(recap).toContain('Assistant: built')
  })

  it('says nothing to a CLI that has seen everything since', () => {
    expect(recapFor(chat({ provider: 'codex', providerSeenThrough: { claude: 'a1', codex: 'a2' } }))).toBe('')
  })

  it('still carries a fork that predates anchors', () => {
    expect(recapFor(chat({ needsRecap: true }))).toContain('[Previous conversation]')
  })

  it('hands a fork of a Claude chat that moved to Codex its history, since Codex cannot fork it', () => {
    const anchor = { sessionId: 'c', uuid: 'x' }
    expect(recapFor(chat({ provider: 'codex', resumeFrom: anchor }))).toContain('User: make a plan')
    expect(recapFor(chat({ provider: 'claude', resumeFrom: anchor }))).toBe('')
  })
})

describe('capabilitiesOf', () => {
  it('reads a chat from before providers as Claude', () => {
    expect(capabilitiesOf({} as Partial<Session>).rewind).toBe(true)
    expect(capabilitiesOf(null).sideQuestions).toBe(true)
  })

  it('takes from a Codex chat what Codex cannot do yet', () => {
    const codex = capabilitiesOf({ provider: 'codex' })
    expect(codex).toEqual({ rewind: true, fileRestore: false, sideQuestions: true, planMode: false, cliCommands: false })
  })
})

describe('anchorFor', () => {
  const claudeAnchor: Anchor = { sessionId: 'c', uuid: 'u' }
  const codexAnchor: Anchor = { sessionId: 't', uuid: 'turn-1', provider: 'codex' }

  it("keeps an anchor in the chat's own CLI's transcript", () => {
    expect(anchorFor({ provider: 'claude' }, claudeAnchor)).toBe(claudeAnchor)
    expect(anchorFor({ provider: 'codex' }, codexAnchor)).toBe(codexAnchor)
  })

  it("drops one the other CLI left, which this one cannot fork from", () => {
    expect(anchorFor({ provider: 'codex' }, claudeAnchor)).toBeNull()
    expect(anchorFor({ provider: 'claude' }, codexAnchor)).toBeNull()
    expect(anchorFor({ provider: 'claude' }, null)).toBeNull()
  })
})
