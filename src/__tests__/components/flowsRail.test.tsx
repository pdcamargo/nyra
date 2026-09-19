import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import Sidebar from '@renderer/components/Sidebar'
import { useWorkflowStore } from '@renderer/store/workflow'
import { useSessionsStore } from '@renderer/store/sessions'

const project = (id: string, name: string): unknown => ({
  id,
  name,
  path: `/repos/${name}`,
  collapsed: false
})

const mount = (): void => {
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>
  )
}

describe('Flow mode rail', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ isCanvasOpen: true, workflows: [], currentWorkflow: null })
    useSessionsStore.setState({
      projects: [project('p1', 'nyra'), project('p2', 'other')] as never
    })
  })

  afterEach(cleanup)

  it('offers a way to make a flow in each project, even with none yet', () => {
    // The gap this covers: with zero flows the rail showed only a "No flows yet"
    // note, so there was nowhere to pick which project a new flow belonged to.
    mount()
    expect(screen.getByLabelText('New flow in nyra')).toBeInTheDocument()
    expect(screen.getByLabelText('New flow in other')).toBeInTheDocument()
  })

  it('always offers an unscoped flow, since that section has nothing to list', () => {
    mount()
    expect(screen.getByLabelText('New flow in any project')).toBeInTheDocument()
  })

  it('creates the flow already owned by the project that was clicked', () => {
    mount()
    fireEvent.click(screen.getByLabelText('New flow in other'))
    expect(useWorkflowStore.getState().currentWorkflow?.projectId).toBe('p2')
  })

  it('creates an unowned flow from the Any project button', () => {
    mount()
    fireEvent.click(screen.getByLabelText('New flow in any project'))
    expect(useWorkflowStore.getState().currentWorkflow?.projectId).toBeNull()
  })
})
