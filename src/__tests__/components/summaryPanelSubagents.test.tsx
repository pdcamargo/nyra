import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SummaryPanel from '@renderer/components/SummaryPanel'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore, type Agent } from '@renderer/store/sessions'
import { useWorkspaceStore, workspaceFor } from '@renderer/store/workspace'
import { useUiStore } from '@renderer/store/ui'
import { useBrowserStore } from '@renderer/store/browser'
import { useProcessesStore } from '@renderer/store/processes'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'

const agent = (over: Partial<Agent> = {}): Agent => ({
  toolId: 't1',
  name: 'Explore the streaming pipeline',
  subagentType: 'Explore',
  status: 'running',
  startedAt: 0,
  ...over
})

const seed = (agents: Agent[]): void => {
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, cwd: '/repo', messages: [], agents }] as never,
    projects: []
  } as never)
}

beforeEach(() => {
  useWorkspaceStore.setState({ bySession: {} })
  useBrowserStore.setState({ bySession: {}, cdpUrl: null, install: null })
  useProcessesStore.setState({ bySession: {} } as never)
  useUiStore.setState({ summaryOpen: true, rightPanelOpen: false })
  vi.restoreAllMocks()
})

describe('the Subagents section of the summary', () => {
  it('is still a line each with what it is doing — that part did not change', () => {
    seed([agent({ activity: 'Reading claude.rs' })])
    render(<SummaryPanel />)

    expect(screen.getByText('Subagents')).toBeInTheDocument()
    expect(screen.getByText('Explore the streaming pipeline')).toBeInTheDocument()
    expect(screen.getByText('Reading claude.rs')).toBeInTheDocument()
  })

  it('is absent entirely when the chat has spawned none', () => {
    seed([])
    render(<SummaryPanel />)
    expect(screen.queryByText('Subagents')).not.toBeInTheDocument()
  })

  it('opens the tab focused on the agent whose row you clicked', async () => {
    seed([agent()])
    render(<SummaryPanel />)

    await userEvent.click(screen.getByText('Explore the streaming pipeline'))

    const tabs = workspaceFor(useWorkspaceStore.getState(), SID).tabs
    expect(tabs).toEqual([{ kind: 'subagents', id: expect.any(String), focus: 't1' }])
    // Opening it has to open the panel, or the click does nothing visible.
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('opens the list from "See all", not one agent', async () => {
    seed([agent(), agent({ toolId: 't2', name: 'Explore the tab system' })])
    render(<SummaryPanel />)

    await userEvent.click(screen.getByLabelText('See all subagents'))

    const tabs = workspaceFor(useWorkspaceStore.getState(), SID).tabs
    expect(tabs).toEqual([{ kind: 'subagents', id: expect.any(String), focus: null }])
  })

  it('reuses the one row when you click a second agent', async () => {
    seed([agent(), agent({ toolId: 't2', name: 'Explore the tab system' })])
    render(<SummaryPanel />)

    await userEvent.click(screen.getByText('Explore the streaming pipeline'))
    await userEvent.click(screen.getByText('Explore the tab system'))

    const tabs = workspaceFor(useWorkspaceStore.getState(), SID).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ focus: 't2' })
  })

  it('no longer opens a modal over the conversation', async () => {
    seed([agent({ status: 'done' })])
    render(<SummaryPanel />)

    await userEvent.click(screen.getByText('Explore the streaming pipeline'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
