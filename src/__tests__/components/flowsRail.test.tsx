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

const flow = (id: string, name: string, projectId: string | null): unknown => ({
  id,
  name,
  projectId,
  nodes: [],
  edges: [],
  createdAt: 0,
  updatedAt: 0
})

const mount = (): void => {
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>
  )
}

/** The rail reloads from `workflow.list` on mount and overwrites whatever the
 *  store was seeded with, so a row only survives if the API hands it back. */
const mountWithFlow = async (): Promise<HTMLElement> => {
  window.api.workflow.list = () => Promise.resolve([flow('w1', 'Release Nyra', 'p1')] as never)
  mount()
  return await screen.findByText('Release Nyra')
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

  it('opens its own menu on a right-click, not the browser one', async () => {
    // Both triggers put `asChild` on the same button, and for three versions the
    // ContextMenuTrigger wrapped <Tooltip> — a Radix Root, which renders no DOM
    // and forwards nothing. onContextMenu never reached the button, so the row
    // answered with WebKit's native menu, and delete was only reachable there.
    const row = await mountWithFlow()

    fireEvent.contextMenu(row)

    expect(await screen.findByText('Delete flow')).toBeInTheDocument()
    expect(screen.getByText('Duplicate')).toBeInTheDocument()
  })

  it('arms the delete before doing it, since a drawn graph has no undo', async () => {
    const row = await mountWithFlow()

    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByText('Delete flow'))

    expect(await screen.findByText('Really delete it?')).toBeInTheDocument()
  })
})
