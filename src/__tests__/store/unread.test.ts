import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionsStore } from '../../renderer/src/store/sessions'

const session = (id: string) => useSessionsStore.getState().sessions.find((s) => s.id === id)!

function reset(): void {
  useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
}

const assistant = (text: string) => ({ id: text, role: 'assistant' as const, text })
const user = (text: string) => ({ id: text, role: 'user' as const, text })

describe('unread', () => {
  beforeEach(reset)

  it('counts what arrives in a chat you are not looking at', () => {
    const store = useSessionsStore.getState()
    const watched = store.createSession('/tmp/a')
    const other = useSessionsStore.getState().createSession('/tmp/b')
    // createSession activates the new one, so `other` is active here.
    useSessionsStore.getState().addMessage(watched, assistant('one'))
    useSessionsStore.getState().addMessage(watched, assistant('two'))

    expect(session(watched).unread).toBe(2)
    expect(session(other).unread ?? 0).toBe(0)
  })

  it('does not count the chat you are reading', () => {
    const id = useSessionsStore.getState().createSession('/tmp/a')
    useSessionsStore.getState().addMessage(id, assistant('hello'))
    expect(session(id).unread ?? 0).toBe(0)
  })

  it('does not count your own messages', () => {
    const watched = useSessionsStore.getState().createSession('/tmp/a')
    useSessionsStore.getState().createSession('/tmp/b')
    useSessionsStore.getState().addMessage(watched, user('sent from elsewhere'))
    expect(session(watched).unread ?? 0).toBe(0)
  })

  it('clears when you open the chat', () => {
    const watched = useSessionsStore.getState().createSession('/tmp/a')
    useSessionsStore.getState().createSession('/tmp/b')
    useSessionsStore.getState().addMessage(watched, assistant('one'))
    expect(session(watched).unread).toBe(1)

    useSessionsStore.getState().setActiveSession(watched)
    expect(session(watched).unread).toBe(0)
  })

  it('counts tool calls and errors too, not just prose', () => {
    const watched = useSessionsStore.getState().createSession('/tmp/a')
    useSessionsStore.getState().createSession('/tmp/b')
    useSessionsStore.getState().addMessage(watched, {
      id: 't', role: 'tool_call', tool_id: 't1', tool_name: 'Bash', input: {}
    })
    useSessionsStore.getState().addMessage(watched, { id: 'e', role: 'error', text: 'boom' })
    expect(session(watched).unread).toBe(2)
  })
})
