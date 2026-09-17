import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalsStore, panelFor, terminalId, NO_PROJECT } from '@renderer/store/terminals'

const reset = (): void => {
  useTerminalsStore.setState({ byProject: {} })
}

describe('terminal ids', () => {
  it('namespaces by project so two projects can never share one', () => {
    const a = terminalId('proj-a')
    const b = terminalId('proj-b')
    expect(a.startsWith('term:proj-a:')).toBe(true)
    expect(b.startsWith('term:proj-b:')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('does not repeat within a project', () => {
    const ids = new Set(Array.from({ length: 100 }, () => terminalId('p')))
    expect(ids.size).toBe(100)
  })
})

describe('terminals store', () => {
  beforeEach(reset)

  it('keeps each project on its own set of tabs', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal('a')
    createTerminal('a')
    createTerminal('b')

    const state = useTerminalsStore.getState()
    expect(panelFor(state, 'a').tabs).toHaveLength(2)
    expect(panelFor(state, 'b').tabs).toHaveLength(1)
  })

  it('numbers tabs within a project, not globally', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal('a')
    createTerminal('b')
    expect(panelFor(useTerminalsStore.getState(), 'b').tabs[0].title).toBe('Terminal 1')
  })

  it('focuses the newest terminal', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal('a')
    const second = createTerminal('a')
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(second)
  })

  it('falls back to the last remaining tab when the active one closes', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const first = createTerminal('a')
    const second = createTerminal('a')
    closeTerminal('a', second)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(first)
  })

  it('falls back to Processes when the last tab closes', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const only = createTerminal('a')
    closeTerminal('a', only)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBeNull()
  })

  it('closing a background tab leaves the focus alone', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const first = createTerminal('a')
    const second = createTerminal('a')
    closeTerminal('a', first)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(second)
  })

  it('dropping a project hands back the ids to kill and forgets it', () => {
    const { createTerminal, dropProject } = useTerminalsStore.getState()
    const a = createTerminal('p')
    const b = createTerminal('p')
    expect(dropProject('p').sort()).toEqual([a, b].sort())
    expect(panelFor(useTerminalsStore.getState(), 'p').tabs).toEqual([])
  })

  it('gives project-less chats a panel of their own', () => {
    useTerminalsStore.getState().createTerminal(NO_PROJECT)
    expect(panelFor(useTerminalsStore.getState(), NO_PROJECT).tabs).toHaveLength(1)
  })
})
