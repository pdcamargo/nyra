import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import Sidebar from '@renderer/components/Sidebar'
import { useWorkflowStore } from '@renderer/store/workflow'
import { sortProjects, useSessionsStore } from '@renderer/store/sessions'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '@renderer/store/workspaces'

const project = (id: string, name: string, order: number): unknown => ({
  id,
  name,
  path: `/repos/${name}`,
  order,
  workspaceId: DEFAULT_WORKSPACE_ID
})

const order = (): string[] => sortProjects(useSessionsStore.getState().projects).map((p) => p.name)

const mount = (): void => {
  render(
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>
  )
}

describe('project order dialog', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ isCanvasOpen: false })
    useWorkspacesStore.setState({ activeId: DEFAULT_WORKSPACE_ID })
    useSessionsStore.setState({
      projects: [project('a', 'nyra', 0), project('b', 'shard', 1), project('c', 'risen', 2)] as never,
      sessions: [],
      activeSessionId: null
    })
  })

  afterEach(cleanup)

  it('lists the projects in their order', () => {
    mount()
    fireEvent.click(screen.getByLabelText('Reorder projects'))
    const handles = screen.getAllByLabelText(/^Move /).map((b) => b.getAttribute('aria-label'))
    expect(handles).toEqual(['Move nyra', 'Move shard', 'Move risen'])
  })

  it('moves a project with the arrow keys, and saves it', () => {
    mount()
    fireEvent.click(screen.getByLabelText('Reorder projects'))
    fireEvent.keyDown(screen.getByLabelText('Move risen'), { key: 'ArrowUp' })
    expect(order()).toEqual(['nyra', 'risen', 'shard'])
    fireEvent.keyDown(screen.getByLabelText('Move nyra'), { key: 'ArrowDown' })
    expect(order()).toEqual(['risen', 'nyra', 'shard'])
  })

  it('does nothing past either end', () => {
    mount()
    fireEvent.click(screen.getByLabelText('Reorder projects'))
    fireEvent.keyDown(screen.getByLabelText('Move nyra'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByLabelText('Move risen'), { key: 'ArrowDown' })
    expect(order()).toEqual(['nyra', 'shard', 'risen'])
  })

  describe('dragging', () => {
    // jsdom lays nothing out, so each row is given a 30px box, one pixel apart.
    const ROW = 30
    beforeEach(() => {
      HTMLElement.prototype.setPointerCapture = () => {}
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const list = this.tagName === 'OL'
        const index = list ? 0 : Array.from(this.parentElement?.children ?? []).indexOf(this)
        const top = list ? 0 : index * (ROW + 1)
        const height = list ? 3 * ROW + 2 : ROW
        return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }
      })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    const grab = (name: string): HTMLElement => {
      mount()
      fireEvent.click(screen.getByLabelText('Reorder projects'))
      return screen.getByLabelText(`Move ${name}`)
    }

    it('drops a project past the one it was dragged over, and saves it', () => {
      const handle = grab('nyra')
      fireEvent.pointerDown(handle, { button: 0, clientY: 15, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientY: 15 + ROW + 5, pointerId: 1 })
      fireEvent.pointerUp(handle, { clientY: 15 + ROW + 5, pointerId: 1 })
      expect(order()).toEqual(['shard', 'nyra', 'risen'])
    })

    it('slides the rows it passes aside while it moves, before anything is saved', () => {
      const handle = grab('nyra')
      fireEvent.pointerDown(handle, { button: 0, clientY: 15, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientY: 15 + ROW + 5, pointerId: 1 })
      const shard = screen.getByLabelText('Move shard').closest('li')!
      expect(shard.style.transform).toBe(`translateY(-${ROW + 1}px)`)
      expect(order()).toEqual(['nyra', 'shard', 'risen'])
    })

    it('puts everything back on Escape, and keeps the dialog open', () => {
      const handle = grab('nyra')
      fireEvent.pointerDown(handle, { button: 0, clientY: 15, pointerId: 1 })
      fireEvent.pointerMove(handle, { clientY: 15 + 2 * ROW, pointerId: 1 })
      fireEvent.keyDown(window, { key: 'Escape' })
      fireEvent.pointerUp(handle, { clientY: 15 + 2 * ROW, pointerId: 1 })
      expect(order()).toEqual(['nyra', 'shard', 'risen'])
      expect(screen.getByLabelText('Move nyra')).toBeInTheDocument()
    })
  })

  it('has nothing to reorder with one project', () => {
    useSessionsStore.setState({ projects: [project('a', 'nyra', 0)] as never })
    mount()
    expect(screen.queryByLabelText('Reorder projects')).not.toBeInTheDocument()
  })
})
