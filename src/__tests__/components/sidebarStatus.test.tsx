import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import Sidebar from '@renderer/components/Sidebar'
import { useWorkflowStore } from '@renderer/store/workflow'
import { useSessionsStore, type Session } from '@renderer/store/sessions'
import { useRunningStore } from '@renderer/store/running'
import { usePendingPermissionsStore } from '@renderer/store/pendingPermissions'
import { useSettingsStore } from '@renderer/store/settings'
import { useUiStore } from '@renderer/store/ui'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '@renderer/store/workspaces'

const project = (id: string, name: string): unknown => ({
  id,
  name,
  path: `/repos/${name}`,
  collapsed: false,
  workspaceId: DEFAULT_WORKSPACE_ID
})

const said = { id: 'm', role: 'user', text: 'hi', timestamp: 1 } as Session['messages'][number]

const session = (id: string, projectId: string, over: Partial<Session> = {}): Session => ({
  id,
  projectId,
  provider: 'claude',
  providerSessionIds: {},
  title: id,
  cwd: '',
  createdAt: 0,
  messages: [said],
  tasks: [],
  agents: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ...over
})

const mount = (): void => {
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>
  )
}

describe('sidebar status', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ isCanvasOpen: false })
    useUiStore.setState({ mainView: 'chat' })
    useWorkspacesStore.setState({ activeId: DEFAULT_WORKSPACE_ID })
    useSettingsStore.setState({ sidebarStyle: 'spine', needsYouTray: true, dimOtherProjects: true, dimOpacity: 0.4 })
    useSessionsStore.setState({
      projects: [project('p1', 'nyra'), project('p2', 'risen')] as never,
      sessions: [
        session('Open chat', 'p1'),
        session('Running chat', 'p1'),
        session('Stuck on Bash', 'p1'),
        session('Asked a question', 'p2', { needsAnswer: true })
      ],
      activeSessionId: 'Open chat'
    })
    useRunningStore.setState({
      running: { 'Running chat': true, 'Stuck on Bash': true },
      thinkingSince: {},
      startedAt: { 'Running chat': Date.now() - 72_000, 'Stuck on Bash': Date.now() }
    })
    usePendingPermissionsStore.setState({ bySession: { 'Stuck on Bash': 'Bash' } })
  })

  afterEach(cleanup)

  it('names what a chat is waiting on, in its row and in the tray', () => {
    mount()
    expect(screen.getAllByText('Allow Bash')).toHaveLength(2)
    expect(screen.getAllByText('Question')).toHaveLength(2)
    const tray = screen.getByRole('region', { name: 'Needs you' })
    expect(within(tray).getByText('Stuck on Bash')).toBeInTheDocument()
    expect(within(tray).getByText('Asked a question')).toBeInTheDocument()
  })

  it('shows how long a turn has been going, but not on one stopped on you', () => {
    mount()
    expect(screen.getByText('1m 12s')).toBeInTheDocument()
    expect(screen.queryByText('0s')).not.toBeInTheDocument()
  })

  it('sums each project on its header', () => {
    mount()
    expect(screen.getByRole('img', { name: '2 running · 1 waiting on you' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 waiting on you' })).toBeInTheDocument()
  })

  it('fades the projects the open chat is not in, but not their status', () => {
    mount()
    expect(screen.getByText('risen').className).toContain('opacity-(--project-dim)')
    expect(screen.getByText('nyra').className).not.toContain('opacity-(--project-dim)')
    const tray = screen.getByRole('region', { name: 'Needs you' })
    const rowChip = screen.getAllByText('Question').find((el) => !tray.contains(el))!
    expect(rowChip.className).not.toContain('opacity')
  })

  it('fades them as far as the setting says', () => {
    useSettingsStore.setState({ dimOpacity: 0.55 })
    mount()
    const list = screen.getByText('risen').closest<HTMLElement>('[style*="--project-dim"]')!
    expect(list.style.getPropertyValue('--project-dim')).toBe('0.55')
  })

  it('leaves everything at full strength with dimming off', () => {
    useSettingsStore.setState({ dimOtherProjects: false })
    mount()
    expect(screen.getByText('risen').className).not.toContain('opacity-(--project-dim)')
  })

  it('has no tray with the tray turned off', () => {
    useSettingsStore.setState({ needsYouTray: false })
    mount()
    expect(screen.queryByRole('region', { name: 'Needs you' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Allow Bash')).toHaveLength(1)
  })
})
