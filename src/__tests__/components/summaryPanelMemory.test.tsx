import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import SummaryPanel from '@renderer/components/SummaryPanel'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore } from '@renderer/store/sessions'
import { useSettingsStore } from '@renderer/store/settings'
import { useUiStore } from '@renderer/store/ui'
import { useBrowserStore } from '@renderer/store/browser'
import { useProcessesStore } from '@renderer/store/processes'

const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const SID = 'chat-1'

const seed = (): void => {
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, cwd: '/repo', messages: [], agents: [] }] as never,
    projects: []
  } as never)
}

beforeEach(() => {
  seed()
  useBrowserStore.setState({ bySession: {}, cdpUrl: null, install: null })
  useProcessesStore.setState({ bySession: {} } as never)
  useUiStore.setState({ summaryOpen: true, rightPanelOpen: false })
  useSettingsStore.setState({ showChatMemory: false })
  vi.restoreAllMocks()
})

describe('the Chat RAM row in the summary', () => {
  it('is absent until the preference is on', () => {
    render(<SummaryPanel />)
    expect(screen.queryByText('Chat RAM')).not.toBeInTheDocument()
  })

  it('reports what the chat is holding, without the word estimated', async () => {
    vi.spyOn(window.api.processes, 'memory').mockResolvedValue({
      bytes: 412 * 1024 * 1024,
      processes: 4
    })
    useSettingsStore.setState({ showChatMemory: true })
    render(<SummaryPanel />)

    expect(screen.getByText('Chat RAM')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('412 MB')).toBeInTheDocument())
  })

  it('says dash rather than 0 B for a chat with nothing running', async () => {
    vi.spyOn(window.api.processes, 'memory').mockResolvedValue({ bytes: 0, processes: 0 })
    useSettingsStore.setState({ showChatMemory: true })
    render(<SummaryPanel />)

    expect(screen.getByText('Chat RAM')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument())
  })
})
