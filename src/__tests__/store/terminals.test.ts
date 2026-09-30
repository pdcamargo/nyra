import { beforeEach, describe, expect, it } from 'vitest'
import {
  useTerminalsStore,
  panelFor,
  terminalId,
  noProjectBucket,
  terminalBucket
} from '@renderer/store/terminals'

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
    createTerminal('a', 'w1')
    createTerminal('a', 'w1')
    createTerminal('b', 'w1')

    const state = useTerminalsStore.getState()
    expect(panelFor(state, 'a').tabs).toHaveLength(2)
    expect(panelFor(state, 'b').tabs).toHaveLength(1)
  })

  it('numbers tabs within a project, not globally', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal('a', 'w1')
    createTerminal('b', 'w1')
    expect(panelFor(useTerminalsStore.getState(), 'b').tabs[0].title).toBe('Terminal 1')
  })

  it('focuses the newest terminal', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal('a', 'w1')
    const second = createTerminal('a', 'w1')
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(second)
  })

  it('falls back to the last remaining tab when the active one closes', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const first = createTerminal('a', 'w1')
    const second = createTerminal('a', 'w1')
    closeTerminal('a', second)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(first)
  })

  it('falls back to Processes when the last tab closes', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const only = createTerminal('a', 'w1')
    closeTerminal('a', only)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBeNull()
  })

  it('closing a background tab leaves the focus alone', () => {
    const { createTerminal, closeTerminal } = useTerminalsStore.getState()
    const first = createTerminal('a', 'w1')
    const second = createTerminal('a', 'w1')
    closeTerminal('a', first)
    expect(panelFor(useTerminalsStore.getState(), 'a').activeTabId).toBe(second)
  })

  it('dropping a project hands back the ids to kill and forgets it', () => {
    const { createTerminal, dropProject } = useTerminalsStore.getState()
    const a = createTerminal('p', 'w1')
    const b = createTerminal('p', 'w1')
    expect(dropProject('p').sort()).toEqual([a, b].sort())
    expect(panelFor(useTerminalsStore.getState(), 'p').tabs).toEqual([])
  })

  it('gives project-less chats a panel of their own, one per workspace', () => {
    const { createTerminal } = useTerminalsStore.getState()
    createTerminal(noProjectBucket('work'), 'work')
    createTerminal(noProjectBucket('work'), 'work')
    createTerminal(noProjectBucket('personal'), 'personal')
    const state = useTerminalsStore.getState()
    // Switching workspaces must never show a shell signed in to the other account.
    expect(panelFor(state, noProjectBucket('work')).tabs).toHaveLength(2)
    expect(panelFor(state, noProjectBucket('personal')).tabs).toHaveLength(1)
    expect(terminalBucket(null, 'work')).toBe(noProjectBucket('work'))
    expect(terminalBucket('p1', 'work')).toBe('p1')
  })

  it('records the workspace each shell was started under', () => {
    const id = useTerminalsStore.getState().createTerminal('p1', 'work')
    const tab = panelFor(useTerminalsStore.getState(), 'p1').tabs.find((t) => t.id === id)
    expect(tab?.workspaceId).toBe('work')
  })

  it('closes every shell started under a workspace, in every bucket', () => {
    const { createTerminal, closeStartedUnder } = useTerminalsStore.getState()
    const inProject = createTerminal('p1', 'gone')
    const loose = createTerminal(noProjectBucket('gone'), 'gone')
    // A project that moved away from it: the old shell goes, the new one stays.
    const moved = createTerminal('p2', 'gone')
    const kept = createTerminal('p2', 'other')

    expect(closeStartedUnder('gone').sort()).toEqual([inProject, loose, moved].sort())
    const state = useTerminalsStore.getState()
    expect(panelFor(state, 'p1').tabs).toEqual([])
    expect(panelFor(state, noProjectBucket('gone')).tabs).toEqual([])
    expect(panelFor(state, 'p2').tabs.map((t) => t.id)).toEqual([kept])
    expect(panelFor(state, 'p2').activeTabId).toBe(kept)
  })
})
