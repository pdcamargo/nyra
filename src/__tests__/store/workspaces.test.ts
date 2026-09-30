import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_ID,
  configDirOf,
  sanitizeWorkspaces,
  useWorkspacesStore,
  type Workspace
} from '@renderer/store/workspaces'
import {
  configDirForSession,
  projectsInWorkspace,
  sessionsInWorkspace,
  useSessionsStore,
  workspaceIdOf,
  type Project,
  type Session
} from '@renderer/store/sessions'
import { backfillWorkspaces } from '@renderer/store/projects-migration'
import {
  chatToOpen,
  createWorkspace,
  initials,
  installWorkspaceFollowers,
  moveProjectToWorkspace,
  switchWorkspace
} from '@renderer/lib/workspaces'
import { runCommand } from '@renderer/commands/registry'

const session = (over: Partial<Session> & { id: string }): Session => ({
  claudeSessionId: null,
  title: 'chat',
  cwd: '/repo',
  createdAt: 0,
  messages: [{ id: `m-${over.id}`, role: 'user', text: 'hi', timestamp: 0 } as Session['messages'][number]],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const project = (over: Partial<Project> & { id: string; workspaceId: string }): Project => ({
  name: over.id,
  path: `/repo/${over.id}`,
  ...over
})

const WORK: Workspace = { id: 'work', name: 'Work', configDir: '/h/.nyra/workspaces/work/.claude' }
const PERSONAL: Workspace = { id: 'personal', name: 'Personal', configDir: '/h/.nyra/workspaces/personal/.claude' }

const reset = (): void => {
  useWorkspacesStore.setState({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null }, WORK, PERSONAL],
    activeId: DEFAULT_WORKSPACE_ID,
    lastSessionById: {}
  })
  useSessionsStore.setState({ sessions: [], projects: [], activeSessionId: null, pendingAction: null })
}

describe('initials', () => {
  it('takes one letter from each of the first two words', () => {
    expect(initials('Default')).toBe('D')
    expect(initials('Media Valet')).toBe('MV')
    expect(initials('shard engine team')).toBe('SE')
  })

  it('ignores the spacing it was typed with', () => {
    expect(initials('  media   valet ')).toBe('MV')
    expect(initials('   ')).toBe('')
  })

  it('splits on graphemes, not UTF-16 units', () => {
    // A surrogate pair and a combining accent each stay whole.
    expect(initials('🦊 Den')).toBe('🦊D')
    expect(initials('école Normale')).toBe('ÉN')
  })
})

describe('the workspaces store', () => {
  beforeEach(reset)

  it('always has Default, first, pointing at ~/.claude', () => {
    const clean = sanitizeWorkspaces({
      workspaces: [
        WORK,
        { id: DEFAULT_WORKSPACE_ID, name: 'Mine', configDir: '/somewhere/else' },
        { id: 'broken', name: '', configDir: '/x' } as Workspace
      ],
      activeId: 'nope'
    })
    expect(clean.workspaces.map((w) => w.id)).toEqual([DEFAULT_WORKSPACE_ID, 'work'])
    expect(clean.workspaces[0]).toMatchObject({ name: 'Mine', configDir: null })
    expect(clean.activeId).toBe(DEFAULT_WORKSPACE_ID)
  })

  it('starts on Default with nothing stored', () => {
    const clean = sanitizeWorkspaces(undefined)
    expect(clean.workspaces).toEqual([{ id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null }])
    expect(clean.activeId).toBe(DEFAULT_WORKSPACE_ID)
  })

  it('remembers the active one across launches', () => {
    expect(sanitizeWorkspaces({ workspaces: [WORK], activeId: 'work' }).activeId).toBe('work')
  })

  it('never removes Default', () => {
    useWorkspacesStore.getState().remove(DEFAULT_WORKSPACE_ID)
    expect(useWorkspacesStore.getState().workspaces[0].id).toBe(DEFAULT_WORKSPACE_ID)
  })

  it('maps an unknown workspace to Default’s config: none', () => {
    expect(configDirOf('work')).toBe(WORK.configDir)
    expect(configDirOf('deleted')).toBeNull()
    expect(configDirOf(DEFAULT_WORKSPACE_ID)).toBeNull()
  })
})

describe('migration into Default', () => {
  it('puts every project and every project-less chat into Default', () => {
    const { sessions, projects } = backfillWorkspaces(
      [session({ id: 'loose' }), session({ id: 'in-project', projectId: 'p1' })],
      [{ id: 'p1', name: 'one', path: '/repo/one' } as Project]
    )
    expect(projects[0].workspaceId).toBe(DEFAULT_WORKSPACE_ID)
    expect(sessions.find((s) => s.id === 'loose')?.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
    // A project's chat follows its project, so it needs nothing of its own.
    expect(sessions.find((s) => s.id === 'in-project')?.workspaceId).toBeUndefined()
  })

  it('leaves anything already assigned alone', () => {
    const sessions = [session({ id: 'a', workspaceId: 'work' })]
    const projects = [project({ id: 'p', workspaceId: 'work' })]
    const result = backfillWorkspaces(sessions, projects)
    expect(result.sessions).toBe(sessions)
    expect(result.projects).toBe(projects)
  })
})

describe('which workspace a chat belongs to', () => {
  beforeEach(reset)

  it('is its project’s, or its own when it has none', () => {
    const state = { projects: [project({ id: 'p', workspaceId: 'work' })] }
    expect(workspaceIdOf(state, session({ id: 'a', projectId: 'p', workspaceId: 'personal' }))).toBe('work')
    expect(workspaceIdOf(state, session({ id: 'b', workspaceId: 'personal' }))).toBe('personal')
    expect(workspaceIdOf(state, session({ id: 'c' }))).toBe(DEFAULT_WORKSPACE_ID)
  })

  it('filters projects and chats to one workspace', () => {
    const projects = [project({ id: 'w', workspaceId: 'work' }), project({ id: 'p', workspaceId: 'personal' })]
    const sessions = [
      session({ id: 'in-w', projectId: 'w' }),
      session({ id: 'in-p', projectId: 'p' }),
      session({ id: 'loose-w', workspaceId: 'work' })
    ]
    expect(projectsInWorkspace(projects, 'work').map((p) => p.id)).toEqual(['w'])
    expect(sessionsInWorkspace({ projects }, sessions, 'work').map((s) => s.id)).toEqual(['in-w', 'loose-w'])
  })

  it('stamps a new project-less chat with the active workspace', () => {
    useWorkspacesStore.setState({ activeId: 'work' })
    const id = useSessionsStore.getState().createSession('/home/test', null)
    const created = useSessionsStore.getState().sessions.find((s) => s.id === id)!
    expect(created.workspaceId).toBe('work')
    expect(configDirForSession(useSessionsStore.getState(), id)).toBe(WORK.configDir)
  })

  it('lets one folder be a project in two workspaces', () => {
    useWorkspacesStore.setState({ activeId: 'work' })
    const inWork = useSessionsStore.getState().createProject('/repo/app')
    useWorkspacesStore.setState({ activeId: 'personal' })
    const inPersonal = useSessionsStore.getState().createProject('/repo/app')
    expect(inPersonal).not.toBe(inWork)
    // Within one workspace it is still the same project.
    expect(useSessionsStore.getState().createProject('/repo/app')).toBe(inPersonal)
  })

  it('keeps a removed project’s chats in its workspace', () => {
    useSessionsStore.setState({
      projects: [project({ id: 'p', workspaceId: 'work' })],
      sessions: [session({ id: 'a', projectId: 'p' })]
    })
    useSessionsStore.getState().removeProject('p')
    const chat = useSessionsStore.getState().sessions[0]
    expect(chat.projectId).toBeNull()
    expect(chat.workspaceId).toBe('work')
  })

  it('reassigns a whole workspace', () => {
    useSessionsStore.setState({
      projects: [project({ id: 'p', workspaceId: 'work' }), project({ id: 'q', workspaceId: 'personal' })],
      sessions: [session({ id: 'a', projectId: 'p' }), session({ id: 'b', workspaceId: 'work' }), session({ id: 'c', projectId: 'q' })]
    })
    useSessionsStore.getState().reassignWorkspace('work', DEFAULT_WORKSPACE_ID)
    const state = useSessionsStore.getState()
    expect(state.projects.map((p) => p.workspaceId)).toEqual([DEFAULT_WORKSPACE_ID, 'personal'])
    expect(sessionsInWorkspace(state, state.sessions, DEFAULT_WORKSPACE_ID).map((s) => s.id)).toEqual(['a', 'b'])
    expect(sessionsInWorkspace(state, state.sessions, 'personal').map((s) => s.id)).toEqual(['c'])
  })
})

describe('switching workspaces', () => {
  beforeEach(reset)

  const seed = (): void => {
    useSessionsStore.setState({
      projects: [project({ id: 'w', workspaceId: 'work' }), project({ id: 'd', workspaceId: DEFAULT_WORKSPACE_ID })],
      // Newest first, the order chats are made in.
      sessions: [
        session({ id: 'w-new', projectId: 'w' }),
        session({ id: 'w-old', projectId: 'w' }),
        session({ id: 'd-1', projectId: 'd' })
      ],
      activeSessionId: 'd-1'
    })
  }

  it('opens the chat the workspace last had open', () => {
    seed()
    useWorkspacesStore.getState().rememberSession('work', 'w-old')
    switchWorkspace('work')
    expect(useWorkspacesStore.getState().activeId).toBe('work')
    expect(useSessionsStore.getState().activeSessionId).toBe('w-old')
  })

  it('falls back to its newest chat, then to none', () => {
    seed()
    expect(chatToOpen('work')).toBe('w-new')
    switchWorkspace('personal')
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
  })

  it('follows a chat opened from another workspace', () => {
    seed()
    const stop = installWorkspaceFollowers()
    // The palette's search, a fork — anything that sets the active chat.
    useSessionsStore.getState().setActiveSession('w-old')
    expect(useWorkspacesStore.getState().activeId).toBe('work')
    expect(useWorkspacesStore.getState().lastSessionById.work).toBe('w-old')
    stop()
  })

  it('does not follow a project it moved away', () => {
    seed()
    const stop = installWorkspaceFollowers()
    moveProjectToWorkspace('d', 'work')
    expect(useWorkspacesStore.getState().activeId).toBe(DEFAULT_WORKSPACE_ID)
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
    expect(useSessionsStore.getState().projects.find((p) => p.id === 'd')?.workspaceId).toBe('work')
    stop()
  })

  it('cycles chats without leaving the workspace', () => {
    seed()
    useWorkspacesStore.setState({ activeId: 'work' })
    useSessionsStore.setState({ activeSessionId: 'w-new' })
    runCommand('session.next')
    expect(useSessionsStore.getState().activeSessionId).toBe('w-old')
    runCommand('session.next')
    expect(useSessionsStore.getState().activeSessionId).toBe('w-new')
  })

  it('creates a workspace, makes its directory and switches to it', async () => {
    const created = await createWorkspace('  Media Valet ')
    expect(created.name).toBe('Media Valet')
    expect(created.configDir).toBe(`/home/test/.nyra/workspaces/${created.id}/.claude`)
    expect(useWorkspacesStore.getState().activeId).toBe(created.id)
  })
})
