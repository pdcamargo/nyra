import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import WorkspaceDialog from '@renderer/components/WorkspaceDialog'
import { useUiStore } from '@renderer/store/ui'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '@renderer/store/workspaces'
import { useAccountsStore } from '@renderer/store/accounts'

const signedIn = (email: string): never =>
  ({
    loggedIn: true,
    loginMethod: 'claude.ai',
    organization: null,
    email,
    displayName: null,
    subscriptionType: null,
    configDirectory: null,
    fetchedAt: Date.now()
  }) as never

const mount = (): void => {
  render(
    <TooltipProvider>
      <WorkspaceDialog />
    </TooltipProvider>
  )
}

describe('new workspace sign-in', () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null },
        { id: 'work', name: 'Work', configDir: '/h/.nyra/workspaces/work/.claude' }
      ],
      activeId: DEFAULT_WORKSPACE_ID,
      lastSessionById: {}
    })
    useAccountsStore.setState({ byWorkspace: { work: signedIn('me@work.dev') } })
    // The dialog asks every workspace who it is signed in as; keep what was seeded.
    vi.spyOn(useAccountsStore.getState(), 'refresh').mockResolvedValue(null)
    useUiStore.setState({ workspaceDialog: { mode: 'create' } as never })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('offers only workspaces that have a Claude sign-in to share', () => {
    mount()
    const claude = screen.getAllByRole('combobox')[0]
    const labels = [...claude.querySelectorAll('option')].map((o) => o.textContent)
    expect(labels).toEqual(['Sign in separately', 'Same as Work — me@work.dev'])
  })

  it("borrows the chosen sign-ins, and opens no sign-in window for Claude's", async () => {
    const create = vi.spyOn(window.api.workspace, 'create')
    const login = vi.fn()
    window.addEventListener('nyra:open-login', login)
    mount()
    fireEvent.change(screen.getByPlaceholderText('Work, Personal, a client…'), { target: { value: 'Side' } })
    const [claude, codex] = screen.getAllByRole('combobox')
    fireEvent.change(claude, { target: { value: 'work' } })
    fireEvent.change(codex, { target: { value: DEFAULT_WORKSPACE_ID } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][1]).toEqual({ claude: 'work', codex: DEFAULT_WORKSPACE_ID })
    expect(login).not.toHaveBeenCalled()
    window.removeEventListener('nyra:open-login', login)
  })

  it('signs in separately by default', async () => {
    const create = vi.spyOn(window.api.workspace, 'create')
    const login = vi.fn()
    window.addEventListener('nyra:open-login', login)
    mount()
    fireEvent.change(screen.getByPlaceholderText('Work, Personal, a client…'), { target: { value: 'Side' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(login).toHaveBeenCalled())
    expect(create.mock.calls[0][1]).toEqual({})
    window.removeEventListener('nyra:open-login', login)
  })
})

describe("sharing Default's skills", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null },
        { id: 'work', name: 'Work', configDir: '/h/.nyra/workspaces/work/.claude' }
      ],
      activeId: DEFAULT_WORKSPACE_ID,
      lastSessionById: {}
    })
    useAccountsStore.setState({ byWorkspace: {} })
    vi.spyOn(useAccountsStore.getState(), 'refresh').mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const toggle = (): HTMLElement => screen.getByRole('switch', { name: "Use Default's skills and instructions" })

  it('is on for a new workspace, and can start off', async () => {
    const create = vi.spyOn(window.api.workspace, 'create')
    useUiStore.setState({ workspaceDialog: { mode: 'create' } as never })
    mount()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByPlaceholderText('Work, Personal, a client…'), { target: { value: 'Side' } })
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][2]).toBe(false)
  })

  it('shows what an existing workspace has, and saves only a change', async () => {
    vi.spyOn(window.api.workspace, 'share').mockResolvedValue({ enabled: false })
    const setShare = vi.spyOn(window.api.workspace, 'setShare')
    useUiStore.setState({ workspaceDialog: { mode: 'edit', workspaceId: 'work' } as never })
    mount()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setShare).toHaveBeenCalledWith('work', true))
  })

  it('leaves sharing alone when only the name changed', async () => {
    const setShare = vi.spyOn(window.api.workspace, 'setShare')
    useUiStore.setState({ workspaceDialog: { mode: 'edit', workspaceId: 'work' } as never })
    mount()
    fireEvent.change(screen.getByPlaceholderText('Work, Personal, a client…'), { target: { value: 'Job' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(useWorkspacesStore.getState().workspaces[1].name).toBe('Job'))
    expect(setShare).not.toHaveBeenCalled()
  })

  it('is not offered for Default itself', () => {
    useUiStore.setState({ workspaceDialog: { mode: 'edit', workspaceId: DEFAULT_WORKSPACE_ID } as never })
    mount()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
