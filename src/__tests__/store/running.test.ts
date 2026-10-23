import { beforeEach, describe, expect, it } from 'vitest'
import { useRunningStore, isSessionRunning, anyRunning } from '@renderer/store/running'

const reset = (): void => useRunningStore.setState({ running: {}, thinkingSince: {}, startedAt: {} })

describe('running store', () => {
  beforeEach(reset)

  it('tracks runs per session', () => {
    const { startRun } = useRunningStore.getState()
    startRun('a')
    expect(isSessionRunning('a')).toBe(true)
    expect(isSessionRunning('b')).toBe(false)
  })

  it('ending a run leaves other sessions alone', () => {
    const { startRun, endRun } = useRunningStore.getState()
    startRun('a')
    startRun('b')
    endRun('a')
    expect(isSessionRunning('a')).toBe(false)
    expect(isSessionRunning('b')).toBe(true)
  })

  it('keeps the same object identity when a start changes nothing', () => {
    // Chat re-sends startRun on paths that may already be running; a fresh object
    // every time would re-render every sidebar row for nothing.
    const { startRun } = useRunningStore.getState()
    startRun('a')
    const first = useRunningStore.getState().running
    startRun('a')
    expect(useRunningStore.getState().running).toBe(first)
  })

  it('ending a run that was never started is a no-op', () => {
    const before = useRunningStore.getState().running
    useRunningStore.getState().endRun('ghost')
    expect(useRunningStore.getState().running).toBe(before)
  })

  it('records when thinking started', () => {
    useRunningStore.getState().startThinking('a', 1234)
    expect(useRunningStore.getState().thinkingSince.a).toBe(1234)
    useRunningStore.getState().stopThinking('a')
    expect(useRunningStore.getState().thinkingSince.a).toBeUndefined()
  })

  it('forget clears both flags at once', () => {
    const { startRun, startThinking, forget } = useRunningStore.getState()
    startRun('a')
    startThinking('a')
    forget('a')
    expect(isSessionRunning('a')).toBe(false)
    expect(useRunningStore.getState().thinkingSince.a).toBeUndefined()
  })

  it('records when a run started, and keeps it while the run carries on', () => {
    // The sidebar's elapsed time: a second startRun on a run already going is
    // the CLI's own follow-up turn, not a new start.
    const { startRun } = useRunningStore.getState()
    startRun('a')
    const started = useRunningStore.getState().startedAt.a
    expect(started).toBeTypeOf('number')
    startRun('a')
    expect(useRunningStore.getState().startedAt.a).toBe(started)
  })

  it('forgets the start when the run ends', () => {
    const { startRun, endRun } = useRunningStore.getState()
    startRun('a')
    endRun('a')
    expect(useRunningStore.getState().startedAt.a).toBeUndefined()
  })

  it('isSessionRunning tolerates a null id', () => {
    expect(isSessionRunning(null)).toBe(false)
    expect(isSessionRunning(undefined)).toBe(false)
  })

  it('anyRunning answers the sidebar spinner question', () => {
    // A collapsed project shows a spinner when any of its chats is running.
    useRunningStore.getState().startRun('chat-2')
    const { running } = useRunningStore.getState()
    expect(anyRunning(running, ['chat-1', 'chat-2'])).toBe(true)
    expect(anyRunning(running, ['chat-1', 'chat-3'])).toBe(false)
    expect(anyRunning(running, [])).toBe(false)
  })
})
