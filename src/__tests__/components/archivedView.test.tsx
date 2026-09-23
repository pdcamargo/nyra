import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ArchivedView from '@renderer/components/views/ArchivedView'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore, type Session } from '@renderer/store/sessions'
import { useUiStore } from '@renderer/store/ui'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const archived = (over: Partial<Session>): Session => ({
  id: 's',
  claudeSessionId: null,
  title: 'A chat',
  cwd: '/repo',
  createdAt: 1,
  messages: [],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  archivedAt: 1_700_000_000_000,
  ...over
})

const seed = (): void => {
  useSessionsStore.setState({
    activeSessionId: null,
    projects: [
      { id: 'p1', name: 'nyra', path: '/repo', order: 0 },
      { id: 'p2', name: 'helix', path: '/other', order: 1 }
    ],
    sessions: [
      archived({ id: 'loose', title: 'No project chat', projectId: null, cwd: '/Users/me' }),
      archived({ id: 'in-p1', title: 'Repo chat', projectId: 'p1' }),
      archived({
        id: 'in-p2',
        title: 'Other chat',
        projectId: 'p2',
        worktreeSnapshotted: true
      }),
      { ...archived({ id: 'live', title: 'Still working', projectId: 'p1' }), archivedAt: null }
    ]
  } as never)
}

beforeEach(() => {
  vi.restoreAllMocks()
  seed()
  useUiStore.setState({ archivedProjectId: 'p1', mainView: 'archived' })
})

describe('the Archived page', () => {
  it('groups the way the other library pages do: Global, then By project', () => {
    render(<ArchivedView />)

    expect(screen.getByRole('heading', { name: 'Archived' })).toBeInTheDocument()
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.getByText('By project')).toBeInTheDocument()
    // Global is the chats with no project — the same bucket the Commands page
    // calls global — and By project is the project the selection names.
    expect(screen.getByText('No project chat')).toBeInTheDocument()
    expect(screen.getByText('Repo chat')).toBeInTheDocument()
    expect(screen.queryByText('Other chat')).not.toBeInTheDocument()
  })

  it('never shows a chat that is still in the rail', () => {
    render(<ArchivedView />)
    expect(screen.queryByText('Still working')).not.toBeInTheDocument()
  })

  it('follows the project the menu that opened it named', () => {
    useUiStore.setState({ archivedProjectId: 'p2' })
    render(<ArchivedView />)
    expect(screen.getByText('Other chat')).toBeInTheDocument()
    expect(screen.queryByText('Repo chat')).not.toBeInTheDocument()
  })

  it('filters on the title and on where the chat ran', async () => {
    const user = userEvent.setup()
    render(<ArchivedView />)

    await user.type(screen.getByPlaceholderText('Search archived chats'), 'no project')
    expect(screen.getByText('No project chat')).toBeInTheDocument()
    expect(screen.queryByText('Repo chat')).not.toBeInTheDocument()
  })

  it('keeps the row inert and restores only from its named icon', async () => {
    const user = userEvent.setup()
    render(<ArchivedView />)

    await user.click(screen.getByText('Repo chat'))
    expect(useSessionsStore.getState().sessions.find((s) => s.id === 'in-p1')?.archivedAt).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Restore Repo chat' }))

    await waitFor(() => expect(screen.queryByText('Repo chat')).not.toBeInTheDocument())
    const session = useSessionsStore.getState().sessions.find((s) => s.id === 'in-p1')!
    expect(session.archivedAt).toBeNull()
  })

  it('confirms before deleting an archived chat', async () => {
    const user = userEvent.setup()
    render(<ArchivedView />)

    await user.click(screen.getByRole('button', { name: 'Delete Repo chat' }))
    expect(screen.getByText('Delete “Repo chat”?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useSessionsStore.getState().sessions.some((s) => s.id === 'in-p1')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Delete Repo chat' }))
    await user.click(screen.getByRole('button', { name: 'Delete chat' }))
    expect(useSessionsStore.getState().sessions.some((s) => s.id === 'in-p1')).toBe(false)
  })
})
