import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import NewChatEnvironment from '@renderer/components/NewChatEnvironment'
import { useSessionsStore, type Session } from '@renderer/store/sessions'
import { useSettingsStore } from '@renderer/store/settings'
import { DEFAULT_SETTINGS } from '../../shared/types'

const chat = (over: Partial<Session> = {}): Session => ({
  id: 's',
  provider: 'claude',
  providerSessionIds: {},
  title: 'New session',
  cwd: '/repo',
  projectId: 'p1',
  createdAt: 1,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const seed = (session: Session): void => {
  useSessionsStore.setState({
    activeSessionId: session.id,
    projects: [{ id: 'p1', name: 'nyra', path: '/repo', order: 0, workspaceId: 'default' }],
    sessions: [session]
  } as never)
}

const pending = (): Session['pendingWorktree'] =>
  useSessionsStore.getState().sessions.find((s) => s.id === 's')?.pendingWorktree

beforeEach(() => {
  vi.restoreAllMocks()
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, worktreeByDefault: true })
  vi.spyOn(window.api.git, 'isRepo').mockResolvedValue(true)
})

describe('starting new chats in a worktree', () => {
  it('picks Worktree for a new chat in a git project', async () => {
    seed(chat())
    render(<NewChatEnvironment sessionId="s" />)
    await waitFor(() => expect(pending()).toMatchObject({ autoNamed: true, seed: true }))
    expect(screen.getByRole('button', { name: 'Where this chat runs' })).toHaveTextContent('Worktree')
  })

  it('leaves a chat that was switched to Local alone', async () => {
    seed(chat({ pendingWorktree: null }))
    render(<NewChatEnvironment sessionId="s" />)
    await screen.findByRole('button', { name: 'Where this chat runs' })
    expect(pending()).toBeNull()
  })

  it('does nothing outside a git project, or with the setting off', async () => {
    vi.spyOn(window.api.git, 'isRepo').mockResolvedValue(false)
    seed(chat())
    const { unmount } = render(<NewChatEnvironment sessionId="s" />)
    await waitFor(() => expect(window.api.git.isRepo).toHaveBeenCalled())
    expect(pending()).toBeUndefined()
    unmount()

    vi.spyOn(window.api.git, 'isRepo').mockResolvedValue(true)
    useSettingsStore.setState({ worktreeByDefault: false })
    seed(chat())
    render(<NewChatEnvironment sessionId="s" />)
    await screen.findByRole('button', { name: 'Where this chat runs' })
    expect(pending()).toBeUndefined()
  })
})
