import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '@renderer/store/workspaces'
import { sessionsInWorkspace, useSessionsStore, type Project, type Session } from '@renderer/store/sessions'
import { useTerminalsStore, noProjectBucket, panelFor } from '@renderer/store/terminals'
import { useRunningStore } from '@renderer/store/running'
import { useRateLimitStore, limitsFor } from '@renderer/store/rateLimit'
import { useAccountsStore } from '@renderer/store/accounts'
import { deleteWorkspace, planDelete } from '@renderer/lib/workspaceDelete'

const session = (over: Partial<Session> & { id: string }): Session => ({
  claudeSessionId: null,
  title: 'chat',
  cwd: '/repo',
  createdAt: 0,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})
const project = (id: string, workspaceId: string): Project => ({ id, name: id, path: `/repo/${id}`, workspaceId })

const WORK = { id: 'work', name: 'Work', configDir: '/h/.nyra/workspaces/work/.claude' }

let terminalIds: { inProject: string; loose: string; elsewhere: string }

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null }, WORK],
    activeId: 'work',
    lastSessionById: {}
  })
  useSessionsStore.setState({
    projects: [project('w', 'work'), project('d', DEFAULT_WORKSPACE_ID)],
    sessions: [
      session({ id: 'in-w', projectId: 'w' }),
      session({ id: 'loose-w', workspaceId: 'work', archivedAt: 1 }),
      session({ id: 'in-d', projectId: 'd' })
    ],
    activeSessionId: 'in-w',
    pendingAction: null
  })
  useTerminalsStore.setState({ byProject: {} })
  const terminals = useTerminalsStore.getState()
  terminalIds = {
    inProject: terminals.createTerminal('w', 'work'),
    loose: terminals.createTerminal(noProjectBucket('work'), 'work'),
    elsewhere: terminals.createTerminal('d', DEFAULT_WORKSPACE_ID)
  }
  useRunningStore.setState({ running: {} })
  useRateLimitStore.setState({ byWorkspace: {} })
  useRateLimitStore.getState().setUnified('work', { five_hour: { resetsAt: 9999999999, utilization: 0.5 } })
  useAccountsStore.setState({
    byWorkspace: {
      work: {
        loggedIn: true,
        loginMethod: 'claude.ai',
        organization: null,
        email: 'me@work.dev',
        displayName: null,
        subscriptionType: null,
        configDirectory: WORK.configDir,
        fetchedAt: 0
      }
    }
  })
})

afterEach(() => vi.restoreAllMocks())

describe('planning a delete', () => {
  it('counts what it would touch', () => {
    expect(planDelete('work')).toEqual({ projects: 1, chats: 2, running: 0, terminals: 2 })
  })
})

describe('deleting a workspace', () => {
  it('never deletes Default', async () => {
    const outcome = await deleteWorkspace(DEFAULT_WORKSPACE_ID, 'work')
    expect(outcome.ok).toBe(false)
    expect(useWorkspacesStore.getState().workspaces.some((w) => w.id === DEFAULT_WORKSPACE_ID)).toBe(true)
  })

  it('refuses while one of its chats is running, and cancels nothing', async () => {
    useRunningStore.setState({ running: { 'in-w': true } })
    const dispose = vi.spyOn(window.api.claude, 'dispose')
    const outcome = await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)
    expect(outcome).toEqual({ ok: false, error: '1 chat is still running.' })
    expect(dispose).not.toHaveBeenCalled()
    expect(useWorkspacesStore.getState().workspaces.some((w) => w.id === 'work')).toBe(true)
  })

  it('aborts with nothing changed when a transcript copy fails', async () => {
    vi.spyOn(window.api.workspace, 'copyTranscripts').mockResolvedValue({ ok: false, error: 'disk full' })
    const logout = vi.spyOn(window.api.workspace, 'logout')
    const remove = vi.spyOn(window.api.workspace, 'delete')
    const kill = vi.spyOn(window.api.terminal, 'kill')
    const before = { sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState().byProject }

    const outcome = await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('disk full')
    expect(useSessionsStore.getState().projects).toBe(before.sessions.projects)
    expect(useSessionsStore.getState().sessions).toBe(before.sessions.sessions)
    expect(useTerminalsStore.getState().byProject).toBe(before.terminals)
    expect(useWorkspacesStore.getState().workspaces.some((w) => w.id === 'work')).toBe(true)
    expect(logout).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('moves its projects and chats to the target, archived ones too', async () => {
    const outcome = await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)
    expect(outcome).toEqual({ ok: true })
    const state = useSessionsStore.getState()
    expect(state.projects.find((p) => p.id === 'w')?.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
    expect(sessionsInWorkspace(state, state.sessions, DEFAULT_WORKSPACE_ID).map((s) => s.id).sort()).toEqual(
      ['in-d', 'in-w', 'loose-w']
    )
  })

  it('runs the steps in order, by id, and lets its idle chats respawn elsewhere', async () => {
    const calls: string[] = []
    vi.spyOn(window.api.workspace, 'copyTranscripts').mockImplementation(async (id, target) => {
      calls.push(`copy ${id} -> ${target}`)
      return { ok: true, projects: 1 }
    })
    vi.spyOn(window.api.claude, 'dispose').mockImplementation(async (id) => {
      calls.push(`dispose ${id}`)
    })
    vi.spyOn(window.api.workspace, 'logout').mockImplementation(async (dir) => {
      calls.push(`logout ${dir}`)
      return { ok: true }
    })
    vi.spyOn(window.api.workspace, 'delete').mockImplementation(async (id) => {
      calls.push(`delete ${id}`)
      return { ok: true }
    })

    await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)

    expect(calls).toEqual([
      'copy work -> null',
      'dispose in-w',
      'dispose loose-w',
      `logout ${WORK.configDir}`,
      'delete work'
    ])
  })

  it('closes every terminal started under it, and only those', async () => {
    const kill = vi.spyOn(window.api.terminal, 'kill')
    await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)
    expect(kill.mock.calls.map(([id]) => id).sort()).toEqual([terminalIds.inProject, terminalIds.loose].sort())
    const terminals = useTerminalsStore.getState()
    expect(panelFor(terminals, 'w').tabs).toEqual([])
    expect(panelFor(terminals, noProjectBucket('work')).tabs).toEqual([])
    expect(panelFor(terminals, 'd').tabs.map((t) => t.id)).toEqual([terminalIds.elsewhere])
  })

  it('forgets its readings and account, and hands the screen to the target', async () => {
    await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual([DEFAULT_WORKSPACE_ID])
    expect(useWorkspacesStore.getState().activeId).toBe(DEFAULT_WORKSPACE_ID)
    // The chat that was open moved with the rest, so it stays open.
    expect(useSessionsStore.getState().activeSessionId).toBe('in-w')
    expect(limitsFor(useRateLimitStore.getState(), 'work').windows).toEqual({})
    expect(useAccountsStore.getState().byWorkspace.work).toBeUndefined()
  })

  it('carries on past a failed sign-out, and says the login may remain', async () => {
    vi.spyOn(window.api.workspace, 'logout').mockResolvedValue({ ok: false, error: 'offline' })
    const outcome = await deleteWorkspace('work', DEFAULT_WORKSPACE_ID)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.warning).toMatch(/login may still be stored/)
    expect(useWorkspacesStore.getState().workspaces.some((w) => w.id === 'work')).toBe(false)
  })
})
