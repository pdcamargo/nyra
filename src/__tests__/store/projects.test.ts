import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useSessionsStore,
  activeProject,
  activeProjectCwd,
  cwdForSession,
  orphanSessions,
  sessionsForProject,
  sortProjects,
  type Project,
  type Session
} from '@renderer/store/sessions'
import { backfillProjects, basename, nameForPath, qualifiedName } from '@renderer/store/projects-migration'
import { attachWorktreeSessions } from '@renderer/store/attachWorktrees'

const session = (over: Partial<Session> & { id: string }): Session => ({
  claudeSessionId: null,
  title: 'chat',
  cwd: '',
  createdAt: 0,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const reset = (): void => {
  useSessionsStore.setState({
    sessions: [],
    projects: [],
    activeSessionId: null,
    pendingAction: null
  })
}

describe('path naming', () => {
  it('reads a basename off a path', () => {
    expect(basename('/Users/me/dev/nyra')).toBe('nyra')
    expect(basename('/Users/me/dev/nyra/')).toBe('nyra')
    expect(basename('/')).toBe('/')
  })

  it('qualifies with the parent directory', () => {
    expect(qualifiedName('/Users/me/work/api')).toBe('work/api')
    expect(qualifiedName('/api')).toBe('api')
  })

  it('disambiguates two checkouts that share a basename', () => {
    expect(nameForPath('/Users/me/work/api', [])).toBe('api')
    expect(nameForPath('/Users/me/oss/api', ['api'])).toBe('oss/api')
    expect(nameForPath('/Users/me/oss/api', ['api', 'oss/api'])).toBe('oss/api (2)')
  })
})

describe('backfillProjects', () => {
  it('gives every pre-projects chat a project, one per distinct cwd', () => {
    const { sessions, projects } = backfillProjects(
      [
        session({ id: 'a', cwd: '/repo/one' }),
        session({ id: 'b', cwd: '/repo/one' }),
        session({ id: 'c', cwd: '/repo/two' })
      ],
      []
    )
    expect(projects).toHaveLength(2)
    expect(sessions[0].projectId).toBe(sessions[1].projectId)
    expect(sessions[2].projectId).not.toBe(sessions[0].projectId)
    expect(projects.map((p) => p.path).sort()).toEqual(['/repo/one', '/repo/two'])
  })

  it('reuses a project that already covers the path', () => {
    const existing: Project = { id: 'p1', name: 'one', path: '/repo/one', order: 0 }
    const { sessions, projects } = backfillProjects([session({ id: 'a', cwd: '/repo/one' })], [existing])
    expect(projects).toHaveLength(1)
    expect(sessions[0].projectId).toBe('p1')
  })

  it('leaves worktree chats alone — their cwd is not a project root', () => {
    const { sessions, projects } = backfillProjects(
      [session({ id: 'a', cwd: '/tmp/.nyra-worktree-feat', worktree: { name: 'feat', branch: 'feat', path: '/tmp/.nyra-worktree-feat' } })],
      []
    )
    expect(projects).toHaveLength(0)
    expect(sessions[0].projectId).toBeUndefined()
  })

  it('leaves chats with no cwd unassigned so they become Recents', () => {
    const { sessions, projects } = backfillProjects([session({ id: 'a', cwd: '' })], [])
    expect(projects).toHaveLength(0)
    expect(sessions[0].projectId).toBeUndefined()
  })

  it('never reassigns a chat that already has a project', () => {
    const existing: Project = { id: 'p1', name: 'one', path: '/repo/one', order: 0 }
    const { sessions, projects } = backfillProjects(
      [session({ id: 'a', cwd: '/repo/two', projectId: 'p1' })],
      [existing]
    )
    expect(projects).toHaveLength(1)
    expect(sessions[0].projectId).toBe('p1')
  })

  it('returns the input untouched when there is nothing to do', () => {
    const input = [session({ id: 'a', cwd: '/repo/one', projectId: 'p1' })]
    const result = backfillProjects(input, [{ id: 'p1', name: 'one', path: '/repo/one' }])
    expect(result.sessions).toBe(input)
  })
})

describe('project actions', () => {
  beforeEach(reset)

  it('adding the same folder twice returns the existing project', () => {
    const { createProject } = useSessionsStore.getState()
    const first = createProject('/repo/one')
    const second = createProject('/repo/one')
    expect(second).toBe(first)
    expect(useSessionsStore.getState().projects).toHaveLength(1)
  })

  it('names a new project after its folder', () => {
    const id = useSessionsStore.getState().createProject('/Users/me/dev/nyra')
    expect(useSessionsStore.getState().projects.find((p) => p.id === id)?.name).toBe('nyra')
  })

  it('removing a project keeps its chats, in Recents', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    const sid = store.createSession('/repo/one', pid)
    useSessionsStore.getState().removeProject(pid)

    const state = useSessionsStore.getState()
    expect(state.projects).toHaveLength(0)
    expect(state.sessions.find((s) => s.id === sid)).toBeDefined()
    expect(orphanSessions(state).map((s) => s.id)).toContain(sid)
  })

  it('moving a project path moves chats that tracked the root, not worktrees', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    const rootChat = store.createSession('/repo/one', pid)
    const wtChat = store.createSession('/wt/feat', pid)
    useSessionsStore.getState().setWorktree(wtChat, { name: 'feat', branch: 'feat', path: '/wt/feat' })

    useSessionsStore.getState().setProjectPath(pid, '/repo/moved')

    const state = useSessionsStore.getState()
    expect(state.sessions.find((s) => s.id === rootChat)?.cwd).toBe('/repo/moved')
    expect(state.sessions.find((s) => s.id === wtChat)?.cwd).toBe('/wt/feat')
  })

  it('a fork stays in its source project', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    const sid = store.createSession('/repo/one', pid)
    const forkId = useSessionsStore.getState().forkSession(sid)
    expect(useSessionsStore.getState().sessions.find((s) => s.id === forkId)?.projectId).toBe(pid)
  })

  it('orders projects by the manual order', () => {
    const store = useSessionsStore.getState()
    const a = store.createProject('/a')
    const b = store.createProject('/b')
    useSessionsStore.getState().reorderProjects([b, a])
    expect(sortProjects(useSessionsStore.getState().projects).map((p) => p.id)).toEqual([b, a])
  })

  it('collapses and expands', () => {
    const pid = useSessionsStore.getState().createProject('/a')
    useSessionsStore.getState().setProjectCollapsed(pid, true)
    expect(useSessionsStore.getState().projects[0].collapsed).toBe(true)
  })
})

describe('selectors', () => {
  beforeEach(reset)

  it('a worktree chat runs in the worktree but belongs to the project', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    const sid = store.createSession('/wt/feat', pid)
    useSessionsStore.getState().setWorktree(sid, { name: 'feat', branch: 'feat', path: '/wt/feat' })

    const state = useSessionsStore.getState()
    expect(cwdForSession(state, sid)).toBe('/wt/feat')
    expect(activeProject(state)?.id).toBe(pid)
    expect(activeProjectCwd(state)).toBe('/repo/one')
  })

  it('falls back to the project path when a chat has no cwd of its own', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    const sid = store.createSession('', pid)
    expect(cwdForSession(useSessionsStore.getState(), sid)).toBe('/repo/one')
  })

  it('groups chats under their project', () => {
    const store = useSessionsStore.getState()
    const pid = store.createProject('/repo/one')
    store.createSession('/repo/one', pid)
    store.createSession('')
    const state = useSessionsStore.getState()
    expect(sessionsForProject(state, pid)).toHaveLength(1)
    expect(orphanSessions(state)).toHaveLength(1)
  })

  it('treats a chat pointing at a deleted project as an orphan', () => {
    useSessionsStore.setState({ sessions: [session({ id: 'a', projectId: 'gone' })], projects: [] })
    expect(orphanSessions(useSessionsStore.getState()).map((s) => s.id)).toEqual(['a'])
  })
})

describe('attachWorktreeSessions', () => {
  beforeEach(reset)

  it('files a worktree chat under the project git reports as its main tree', async () => {
    useSessionsStore.setState({
      sessions: [
        session({ id: 'a', cwd: '/wt/feat', worktree: { name: 'feat', branch: 'feat', path: '/wt/feat' } })
      ],
      projects: [{ id: 'p1', name: 'one', path: '/repo/one', order: 0 }]
    })
    window.api.git.mainWorktreeRoot = vi.fn().mockResolvedValue('/repo/one')

    await attachWorktreeSessions()

    const state = useSessionsStore.getState()
    expect(state.projects).toHaveLength(1)
    expect(state.sessions[0].projectId).toBe('p1')
  })

  it('creates the project when the main tree is not one yet', async () => {
    useSessionsStore.setState({
      sessions: [
        session({ id: 'a', cwd: '/wt/feat', worktree: { name: 'feat', branch: 'feat', path: '/wt/feat' } })
      ],
      projects: []
    })
    window.api.git.mainWorktreeRoot = vi.fn().mockResolvedValue('/repo/new')

    await attachWorktreeSessions()

    const state = useSessionsStore.getState()
    expect(state.projects[0].path).toBe('/repo/new')
    expect(state.sessions[0].projectId).toBe(state.projects[0].id)
  })

  it('looks a shared worktree directory up once', async () => {
    useSessionsStore.setState({
      sessions: [
        session({ id: 'a', cwd: '/wt/feat', worktree: { name: 'feat', branch: 'feat', path: '/wt/feat' } }),
        session({ id: 'b', cwd: '/wt/feat', worktree: { name: 'feat', branch: 'feat', path: '/wt/feat' } })
      ],
      projects: []
    })
    const lookup = vi.fn().mockResolvedValue('/repo/one')
    window.api.git.mainWorktreeRoot = lookup

    await attachWorktreeSessions()

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(useSessionsStore.getState().projects).toHaveLength(1)
  })

  it('leaves a chat in Recents when git cannot answer', async () => {
    useSessionsStore.setState({
      sessions: [
        session({ id: 'a', cwd: '/wt/gone', worktree: { name: 'x', branch: 'x', path: '/wt/gone' } })
      ],
      projects: []
    })
    window.api.git.mainWorktreeRoot = vi.fn().mockRejectedValue(new Error('not a repo'))

    await attachWorktreeSessions()

    expect(useSessionsStore.getState().sessions[0].projectId).toBeUndefined()
    expect(useSessionsStore.getState().projects).toHaveLength(0)
  })
})
