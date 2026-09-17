import { describe, it, expect, beforeEach } from 'vitest'
import {
  useBackgroundAgentsStore,
  hasBackgroundAgents,
  anyBackgroundAgents
} from '../../renderer/src/store/backgroundAgents'

const agent = (taskId: string, description: string) => ({ taskId, description })

describe('backgroundAgents store', () => {
  beforeEach(() => useBackgroundAgentsStore.setState({ bySession: {} }))

  it('keeps the roster the CLI sends, and clears it on an empty one', () => {
    const { setAgents } = useBackgroundAgentsStore.getState()
    setAgents('s1', [agent('t1', 'Explore the renderer'), agent('t2', 'Explore IPC')])
    expect(hasBackgroundAgents('s1')).toBe(true)

    setAgents('s1', [])
    expect(hasBackgroundAgents('s1')).toBe(false)
    expect(useBackgroundAgentsStore.getState().bySession.s1).toBeUndefined()
  })

  it('carries a live line across a roster update', () => {
    const { setAgents, noteProgress } = useBackgroundAgentsStore.getState()
    setAgents('s1', [agent('t1', 'Explore the renderer'), agent('t2', 'Explore IPC')])
    noteProgress('s1', { taskId: 't1', activity: 'Reading MarkdownRenderer.tsx', lastTool: 'Read' })

    // One agent finishing must not blank what the other is doing.
    setAgents('s1', [agent('t1', 'Explore the renderer')])
    const [only] = useBackgroundAgentsStore.getState().bySession.s1
    expect(only.activity).toBe('Reading MarkdownRenderer.tsx')
    expect(only.lastTool).toBe('Read')
  })

  it('drops progress it cannot attribute rather than guessing', () => {
    const { setAgents, noteProgress } = useBackgroundAgentsStore.getState()
    setAgents('s1', [agent('t1', 'A'), agent('t2', 'B')])
    // With several agents out, putting an unidentified line on one of them would
    // show the wrong agent doing the wrong work.
    noteProgress('s1', { taskId: '', activity: 'Running something' })
    noteProgress('s1', { taskId: 'nope', activity: 'Running something' })

    expect(useBackgroundAgentsStore.getState().bySession.s1.every((a) => !a.activity)).toBe(true)
  })

  it('ignores progress for a session with nothing out', () => {
    useBackgroundAgentsStore.getState().noteProgress('ghost', { taskId: 't1', activity: 'x' })
    expect(useBackgroundAgentsStore.getState().bySession.ghost).toBeUndefined()
  })

  it('answers the rail question across several sessions', () => {
    const { setAgents } = useBackgroundAgentsStore.getState()
    setAgents('s2', [agent('t1', 'A')])
    const { bySession } = useBackgroundAgentsStore.getState()
    expect(anyBackgroundAgents(bySession, ['s1', 's2'])).toBe(true)
    expect(anyBackgroundAgents(bySession, ['s1'])).toBe(false)
  })

  it('forget drops a session entirely', () => {
    const { setAgents, forget } = useBackgroundAgentsStore.getState()
    setAgents('s1', [agent('t1', 'A')])
    forget('s1')
    expect(hasBackgroundAgents('s1')).toBe(false)
  })
})
