import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archivedSessions,
  liveSessions,
  useSessionsStore,
  type Session
} from '../../renderer/src/store/sessions'
import { archiveChat, openArchivedChats, unarchiveChat } from '../../renderer/src/lib/archive'
import { useBrowserStore } from '../../renderer/src/store/browser'
import { useProcessesStore } from '../../renderer/src/store/processes'
import { useResourceDockStore } from '../../renderer/src/store/resourceDock'
import { useRunningStore } from '../../renderer/src/store/running'
import { useUiStore } from '../../renderer/src/store/ui'
import { useWorkspaceStore } from '../../renderer/src/store/workspace'

const CHAT = 'chat-1'
const OTHER = 'chat-2'

const session = (over: Partial<Session> = {}): Session => ({
  id: CHAT,
  claudeSessionId: null,
  title: 'Fix the sidebar',
  cwd: '/repo',
  projectId: 'p1',
  createdAt: 1,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const seed = (sessions: Session[], activeSessionId: string | null = null): void => {
  useSessionsStore.setState({
    sessions,
    projects: [{ id: 'p1', name: 'Repo', path: '/repo', order: 0 }] as never,
    activeSessionId
  } as never)
}

const stored = (): Session => useSessionsStore.getState().sessions.find((s) => s.id === CHAT)!

beforeEach(() => {
  vi.restoreAllMocks()
  seed([])
  useRunningStore.setState({ running: {}, thinkingSince: {} })
  useBrowserStore.setState({ bySession: {} } as never)
  useProcessesStore.setState({ bySession: {} } as never)
  useWorkspaceStore.setState({ bySession: {} } as never)
  useResourceDockStore.setState({ bySession: {} })
  useUiStore.setState({ summaryOpen: false, archivedProjectId: null, mainView: 'chat' })
})

describe('archiving a chat', () => {
  it('stops the work, unpins it and files it away', async () => {
    seed(
      [
        session({
          favorite: true,
          worktree: { name: 'nyra/x', branch: 'nyra/x', path: '/repo/.worktrees/x' }
        }),
        session({ id: OTHER, title: 'Other' })
      ],
      CHAT
    )
    useRunningStore.setState({ running: { [CHAT]: true }, thinkingSince: { [CHAT]: 1 } })
    useProcessesStore.setState({
      bySession: {
        [CHAT]: [{ shellId: 'sh1', status: 'running', pid: 42 }]
      }
    } as never)
    useBrowserStore.setState({ bySession: { [CHAT]: { phase: 'ready', tabs: [] } } } as never)

    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)
    const kill = vi.spyOn(window.api.processes, 'kill').mockResolvedValue({ ok: true })
    const closeChat = vi
      .spyOn(window.api.browser, 'closeChat')
      .mockResolvedValue({ ok: true, closed: true })
    const snapshot = vi
      .spyOn(window.api.git, 'worktreeSnapshot')
      .mockResolvedValue({ success: true })
    const remove = vi.spyOn(window.api.git, 'worktreeRemove').mockResolvedValue({ success: true })

    const result = await archiveChat(CHAT)

    expect(result).toEqual({ ok: true })
    expect(dispose).toHaveBeenCalledWith(CHAT)
    expect(kill).toHaveBeenCalledWith(CHAT, 'sh1')
    expect(closeChat).toHaveBeenCalledWith(CHAT)
    expect(snapshot).toHaveBeenCalledWith('/repo/.worktrees/x', 'nyra/x', CHAT)
    expect(remove).toHaveBeenCalled()
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(snapshot.mock.invocationCallOrder[0])

    const after = stored()
    expect(typeof after.archivedAt).toBe('number')
    expect(after.favorite).toBe(false)
    expect(after.worktree).toBeNull()
    expect(after.worktreeSnapshotted).toBe(true)
    // Nothing of it is left running, and it is no longer what is on screen.
    expect(useRunningStore.getState().running[CHAT]).toBeUndefined()
    expect(useProcessesStore.getState().bySession[CHAT]).toBeUndefined()
    expect(useBrowserStore.getState().bySession[CHAT]).toBeUndefined()
    expect(useSessionsStore.getState().activeSessionId).toBe(OTHER)
  })

  it('leaves the chat unarchived when the worktree could not be saved', async () => {
    seed([session({ worktree: { name: 'nyra/x', branch: 'nyra/x', path: '/wt' } })], CHAT)
    const snapshot = vi
      .spyOn(window.api.git, 'worktreeSnapshot')
      .mockResolvedValue({ success: false, error: 'No space left on device' })
    const remove = vi.spyOn(window.api.git, 'worktreeRemove').mockResolvedValue({ success: true })
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)

    const result = await archiveChat(CHAT)

    expect(result).toEqual({ ok: false, error: 'No space left on device' })
    expect(remove).not.toHaveBeenCalled()
    // It is stopped before a snapshot is attempted, but remains visible and
    // keeps the worktree record so the user can retry.
    expect(dispose).toHaveBeenCalledWith(CHAT)
    expect(stored().archivedAt).toBeUndefined()
    expect(stored().worktree).toEqual({ name: 'nyra/x', branch: 'nyra/x', path: '/wt' })
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('leaves the chat unarchived when the worktree could not be removed', async () => {
    seed([session({ worktree: { name: 'nyra/x', branch: 'nyra/x', path: '/wt' } })], CHAT)
    vi.spyOn(window.api.git, 'worktreeSnapshot').mockResolvedValue({ success: true })
    vi.spyOn(window.api.git, 'worktreeRemove').mockResolvedValue({
      success: false,
      error: 'Directory not empty'
    })
    const dispose = vi.spyOn(window.api.claude, 'dispose').mockResolvedValue(undefined)

    const result = await archiveChat(CHAT)

    expect(result).toEqual({ ok: false, error: 'Directory not empty' })
    expect(dispose).toHaveBeenCalledWith(CHAT)
    expect(stored().archivedAt).toBeUndefined()
    expect(stored().worktreeSnapshotted).toBeUndefined()
  })

  it('leaves a permanent worktree where it is', async () => {
    seed(
      [
        session({
          worktree: { name: 'shared', branch: 'shared', path: '/wt', permanent: true }
        })
      ],
      CHAT
    )
    const snapshot = vi.spyOn(window.api.git, 'worktreeSnapshot')
    const remove = vi.spyOn(window.api.git, 'worktreeRemove')

    expect(await archiveChat(CHAT)).toEqual({ ok: true })
    expect(snapshot).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(stored().worktree?.permanent).toBe(true)
    expect(typeof stored().archivedAt).toBe('number')
  })

  it('is a no-op for a chat that is already archived', async () => {
    seed([session({ archivedAt: 123 })], CHAT)
    const dispose = vi.spyOn(window.api.claude, 'dispose')
    expect(await archiveChat(CHAT)).toEqual({ ok: true })
    expect(dispose).not.toHaveBeenCalled()
    expect(stored().archivedAt).toBe(123)
  })
})

describe('unarchiving a chat', () => {
  it('brings the worktree back before it clears the flag', async () => {
    seed([session({ archivedAt: 123, worktreeSnapshotted: true })], null)
    const restore = vi.spyOn(window.api.git, 'worktreeRestore').mockResolvedValue({
      success: true,
      path: '/repo/.worktrees/x',
      branch: 'nyra/x'
    })
    const discard = vi.spyOn(window.api.git, 'snapshotDiscard').mockResolvedValue(undefined)

    expect(await unarchiveChat(CHAT)).toEqual({ ok: true })

    const after = stored()
    expect(after.archivedAt).toBeNull()
    expect(after.worktree).toEqual({
      name: 'nyra/x',
      branch: 'nyra/x',
      path: '/repo/.worktrees/x'
    })
    expect(after.cwd).toBe('/repo/.worktrees/x')
    expect(after.worktreeSnapshotted).toBe(false)
    expect(restore).toHaveBeenCalledWith('/repo', CHAT)
    expect(discard).toHaveBeenCalledWith(CHAT)
  })

  it('stays archived and retryable when the worktree cannot come back', async () => {
    seed([session({ archivedAt: 123, worktreeSnapshotted: true })], null)
    const restore = vi
      .spyOn(window.api.git, 'worktreeRestore')
      .mockResolvedValue({ success: false, error: 'Branch is checked out elsewhere' })

    expect(await unarchiveChat(CHAT)).toEqual({
      ok: false,
      error: 'Branch is checked out elsewhere'
    })
    expect(stored().archivedAt).toBe(123)
    // Still marked snapshotted, which is what makes the second attempt work.
    expect(stored().worktreeSnapshotted).toBe(true)

    restore.mockResolvedValue({
      success: true,
      path: '/repo/.worktrees/x',
      branch: 'nyra/x'
    })
    expect(await unarchiveChat(CHAT)).toEqual({ ok: true })
    expect(stored().archivedAt).toBeNull()
    expect(stored().worktree?.path).toBe('/repo/.worktrees/x')
  })

  it('comes straight back when there was no worktree to save', async () => {
    seed([session({ archivedAt: 123 })], null)
    const restore = vi.spyOn(window.api.git, 'worktreeRestore')
    expect(await unarchiveChat(CHAT)).toEqual({ ok: true })
    expect(restore).not.toHaveBeenCalled()
    expect(stored().archivedAt).toBeNull()
  })
})

describe('the archived list', () => {
  it('keeps archived chats out of the rail, newest first on the page', () => {
    const live = session({ id: 'live' })
    const older = session({ id: 'older', archivedAt: 100 })
    const newer = session({ id: 'newer', archivedAt: 200 })

    expect(liveSessions([live, older, newer]).map((s) => s.id)).toEqual(['live'])
    expect(archivedSessions([live, older, newer]).map((s) => s.id)).toEqual(['newer', 'older'])
  })
})

describe('opening the Archived page', () => {
  it('opens it on the project whose menu asked for it', () => {
    openArchivedChats('p1')
    expect(useUiStore.getState().mainView).toBe('archived')
    expect(useUiStore.getState().archivedProjectId).toBe('p1')

    // The rail's own row asks for no project in particular.
    openArchivedChats(null)
    expect(useUiStore.getState().archivedProjectId).toBeNull()
    expect(useUiStore.getState().mainView).toBe('archived')
  })
})
