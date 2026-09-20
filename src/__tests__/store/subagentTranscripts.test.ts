import { beforeEach, describe, expect, it } from 'vitest'
import {
  transcriptFor,
  useSubagentTranscriptsStore,
  type SubagentWireEntry
} from '@renderer/store/subagentTranscripts'

const SID = 'chat-1'
const TOOL = 'toolu_1'
const store = (): ReturnType<typeof useSubagentTranscriptsStore.getState> =>
  useSubagentTranscriptsStore.getState()
const entries = (): ReturnType<typeof transcriptFor>['entries'] =>
  transcriptFor(useSubagentTranscriptsStore.getState(), SID, TOOL).entries

beforeEach(() => useSubagentTranscriptsStore.setState({ bySession: {} }))

describe('accumulating what a subagent says', () => {
  it('keeps prose and tool calls in the order they happened', () => {
    store().append(SID, TOOL, [
      { kind: 'thinking', text: 'where is it' },
      { kind: 'tool', tool_id: 'a', name: 'Grep', input: { pattern: 'x' } },
      { kind: 'text', text: 'found it' }
    ])
    expect(entries().map((e) => e.kind)).toEqual(['thinking', 'tool', 'text'])
  })

  it('folds a tool result into the call it answers, in place', () => {
    store().append(SID, TOOL, [
      { kind: 'tool', tool_id: 'a', name: 'Read', input: { file_path: '/a' } },
      { kind: 'tool', tool_id: 'b', name: 'Read', input: { file_path: '/b' } }
    ])
    // Results arrive later and out of order; the trace must stay in call order
    // rather than re-appending the answer at the bottom when it returns.
    store().append(SID, TOOL, [{ kind: 'tool_result', tool_id: 'b', result: 'bee' }])
    store().append(SID, TOOL, [{ kind: 'tool_result', tool_id: 'a', result: 'aye' }])

    const got = entries()
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ toolId: 'a', result: 'aye' })
    expect(got[1]).toMatchObject({ toolId: 'b', result: 'bee' })
  })

  it('ignores a result for a call it never saw rather than inventing a row', () => {
    store().append(SID, TOOL, [{ kind: 'tool_result', tool_id: 'ghost', result: 'x' }])
    expect(entries()).toEqual([])
  })

  it('keeps each agent apart', () => {
    store().append(SID, 'one', [{ kind: 'text', text: 'first' }])
    store().append(SID, 'two', [{ kind: 'text', text: 'second' }])
    const state = useSubagentTranscriptsStore.getState()
    expect(transcriptFor(state, SID, 'one').entries).toHaveLength(1)
    expect(transcriptFor(state, SID, 'two').entries).toHaveLength(1)
  })

  it('does not churn the store on an empty append', () => {
    store().append(SID, TOOL, [{ kind: 'text', text: 'a' }])
    const before = useSubagentTranscriptsStore.getState().bySession
    store().append(SID, TOOL, [])
    expect(useSubagentTranscriptsStore.getState().bySession).toBe(before)
  })
})

describe('reading a finished agent back off disk', () => {
  const onDisk: SubagentWireEntry[] = [
    { kind: 'tool', tool_id: 'a', name: 'Read', input: {} },
    { kind: 'tool_result', tool_id: 'a', result: 'contents' }
  ]

  it('fills an agent that was never watched live', () => {
    store().hydrate(SID, TOOL, { model: 'claude-opus-5', entries: onDisk })
    expect(entries()).toEqual([
      { kind: 'tool', toolId: 'a', name: 'Read', input: {}, result: 'contents' }
    ])
    expect(transcriptFor(useSubagentTranscriptsStore.getState(), SID, TOOL).model).toBe(
      'claude-opus-5'
    )
  })

  it('leaves a live stream alone — the file lags a tick behind it', () => {
    store().append(SID, TOOL, [{ kind: 'text', text: 'live' }])
    store().hydrate(SID, TOOL, { model: null, entries: onDisk })

    // Replacing what is on screen with a staler copy would make it jump back.
    expect(entries()).toEqual([{ kind: 'text', text: 'live' }])
    // Still marked, so the read is not retried on every render.
    expect(transcriptFor(useSubagentTranscriptsStore.getState(), SID, TOOL).hydrated).toBe(true)
  })
})

describe('the model', () => {
  it('is recorded per agent and only changes when it actually differs', () => {
    store().noteModel(SID, TOOL, 'claude-opus-5')
    const before = useSubagentTranscriptsStore.getState().bySession
    store().noteModel(SID, TOOL, 'claude-opus-5')
    expect(useSubagentTranscriptsStore.getState().bySession).toBe(before)
  })
})

describe('one source per agent', () => {
  it('clears what the inline stream drew when a tail takes over', () => {
    // Background agents stream inline *and* write a transcript. Both were drawn
    // and every line appeared twice; the tail now wins and says so with a reset.
    store().noteModel(SID, TOOL, 'claude-opus-5')
    store().append(SID, TOOL, [{ kind: 'text', text: 'said once, by the loser' }])
    store().reset(SID, TOOL)

    expect(entries()).toEqual([])
    // The model survives — it is the same agent, and it is not re-announced.
    expect(transcriptFor(useSubagentTranscriptsStore.getState(), SID, TOOL).model).toBe(
      'claude-opus-5'
    )
  })

  it('is a no-op on an agent that has said nothing yet', () => {
    const before = useSubagentTranscriptsStore.getState().bySession
    store().reset(SID, TOOL)
    expect(useSubagentTranscriptsStore.getState().bySession).toBe(before)
  })
})

describe('forget', () => {
  it('drops a session without touching the others', () => {
    store().append(SID, TOOL, [{ kind: 'text', text: 'a' }])
    store().append('chat-2', TOOL, [{ kind: 'text', text: 'b' }])
    store().forget(SID)
    const state = useSubagentTranscriptsStore.getState()
    expect(transcriptFor(state, SID, TOOL).entries).toEqual([])
    expect(transcriptFor(state, 'chat-2', TOOL).entries).toHaveLength(1)
  })
})
