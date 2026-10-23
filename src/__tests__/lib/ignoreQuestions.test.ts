import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionsStore, type DeferredState, type Session, type ToolCallMessage } from '../../renderer/src/store/sessions'
import { useQuestionAnswerStore } from '../../renderer/src/store/questionAnswer'
import { hasOpenQuestions, ignoreQuestions } from '../../renderer/src/lib/ignoreQuestions'

const ask = (id: string, partial: Partial<ToolCallMessage> = {}): ToolCallMessage => ({
  id,
  role: 'tool_call',
  tool_id: id,
  tool_name: 'AskUserQuestion',
  input: { questions: [{ question: `${id}?`, options: [{ label: 'Yes' }, { label: 'No' }] }] },
  ...partial
})
const later = (id: string, deferred: DeferredState): ToolCallMessage => ask(id, { deferred })

function session(id: string, messages: ToolCallMessage[]): Session {
  return {
    id,
    provider: 'claude',
    providerSessionIds: {},
    title: id,
    cwd: '/tmp',
    createdAt: 0,
    messages,
    tasks: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    needsAnswer: true
  }
}

const messagesOf = (id: string): ToolCallMessage[] =>
  useSessionsStore.getState().sessions.find((s) => s.id === id)!.messages as ToolCallMessage[]

describe('ignoring questions', () => {
  beforeEach(() => useQuestionAnswerStore.getState().clear())

  it('drops the one Claude stopped for and every open one it carried on past', () => {
    useSessionsStore.setState({
      sessions: [
        session('s1', [
          later('l1', 'open'),
          later('l2', 'sending'),
          ask('answered', { result: 'Yes' }),
          later('l3', 'open'),
          ask('live')
        ])
      ],
      activeSessionId: 's1'
    })
    useQuestionAnswerStore.getState().open('live')
    useQuestionAnswerStore.getState().pick(0, 'Yes', false)
    expect(hasOpenQuestions('s1')).toBe(true)

    ignoreQuestions('s1')

    const byId = Object.fromEntries(messagesOf('s1').map((m) => [m.tool_id, m]))
    expect(byId.l1.deferred).toBe('kept')
    expect(byId.l3.deferred).toBe('kept')
    // Already on its way to Claude: not this button's to take back.
    expect(byId.l2.deferred).toBe('sending')
    expect(byId.answered.ignored).toBeUndefined()
    expect(byId.live.ignored).toBe(true)
    expect(byId.live.result).toBeUndefined()
    expect(useSessionsStore.getState().sessions[0].needsAnswer).toBe(false)
    expect(useQuestionAnswerStore.getState().toolId).toBeNull()
    expect(hasOpenQuestions('s1')).toBe(false)
  })

  it('leaves other chats alone', () => {
    useSessionsStore.setState({
      sessions: [session('s1', [ask('a')]), session('s2', [ask('b')])],
      activeSessionId: 's1'
    })
    ignoreQuestions('s1')
    expect(hasOpenQuestions('s2')).toBe(true)
  })
})
