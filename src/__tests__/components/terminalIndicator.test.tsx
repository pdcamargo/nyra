import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useTerminalsStore } from '@renderer/store/terminals'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '@renderer/store/workspaces'

// The tab strip is what is under test; xterm and the process list are not.
vi.mock('@renderer/components/TerminalPanel', () => ({ default: () => null }))
vi.mock('@renderer/components/ProcessesView', () => ({ default: () => null }))

import BottomPanel from '@renderer/components/BottomPanel'

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [
      { id: DEFAULT_WORKSPACE_ID, name: 'Default', configDir: null },
      { id: 'work', name: 'Work', configDir: '/w/.claude' },
      { id: 'personal', name: 'Personal', configDir: '/p/.claude' }
    ],
    activeId: 'personal',
    lastSessionById: {}
  })
  useTerminalsStore.setState({ byProject: {} })
})

const renderPanel = (workspaceId: string): void => {
  render(
    <TooltipProvider>
      <BottomPanel cwd="/repo/app" projectId="p1" workspaceId={workspaceId} />
    </TooltipProvider>
  )
}

describe('a terminal after its project moved', () => {
  it('says which account it is still on, and is not closed', () => {
    // Opened while the project was Work's; the project is Personal's now.
    useTerminalsStore.getState().createTerminal('p1', 'work')
    renderPanel('personal')
    expect(screen.getByLabelText('Started under Work')).toBeInTheDocument()
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })

  it('shows nothing for a shell started under the project’s own workspace', () => {
    useTerminalsStore.getState().createTerminal('p1', 'personal')
    renderPanel('personal')
    expect(screen.queryByLabelText(/Started under/)).not.toBeInTheDocument()
  })

  it('starts new shells under the project’s workspace', () => {
    renderPanel('personal')
    // The panel seeds a first terminal for a project that has none.
    const tabs = useTerminalsStore.getState().byProject.p1?.tabs ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0].workspaceId).toBe('personal')
  })
})
