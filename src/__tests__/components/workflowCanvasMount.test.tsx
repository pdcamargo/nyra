import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import WorkflowCanvas from '@renderer/components/WorkflowCanvas'
import { useWorkflowStore } from '@renderer/store/workflow'
import { useSessionsStore } from '@renderer/store/sessions'
import type { WorkflowDefinition } from '@shared/workflow-types'

/**
 * Opening a flow used to white-screen.
 *
 * `WorkflowCanvas` returns the templates view early when no flow is open, and a
 * `usePanelSizesStore` call had been added *below* that return. So the component
 * ran 57 hooks with no flow and 58 with one, and React tore the tree down the
 * moment you clicked a flow — with no error boundary, that is a blank window.
 *
 * The bug lives entirely in the transition, so the guard has to be the
 * transition: render with no flow, then set one on the same mount.
 */

const flow = (): WorkflowDefinition =>
  ({
    id: 'wf1',
    name: 'Seeded flow',
    description: 'a loop with a body',
    nodes: [
      { id: 'seed', position: { x: 0, y: 0 }, data: { type: 'prompt', label: 'Seed', prompt: 'go' } },
      { id: 'loop', position: { x: 0, y: 116 }, data: { type: 'loop', label: 'Refine', condition: 'true', maxIterations: 3 } },
      { id: 'refine', position: { x: 20, y: 48 }, data: { type: 'prompt', label: 'Refine', prompt: 'again' } },
      { id: 'done', position: { x: 0, y: 420 }, data: { type: 'prompt', label: 'Done', prompt: 'end' } }
    ],
    edges: [
      { id: 'e1', source: 'seed', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'refine', sourceHandle: 'body' },
      { id: 'e3', source: 'loop', target: 'done', sourceHandle: 'exit' }
    ],
    createdAt: 0,
    updatedAt: 0
  }) as unknown as WorkflowDefinition

const mount = (): void => {
  render(
    <TooltipProvider>
      <WorkflowCanvas />
    </TooltipProvider>
  )
}

describe('WorkflowCanvas', () => {
  beforeEach(() => {
    useWorkflowStore.setState({
      currentWorkflow: null,
      selectedNodeId: null,
      execution: null,
      workflows: [],
      executions: [],
      reviewQueue: []
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('pitches the feature when there are no flows at all', () => {
    mount()
    expect(screen.getByText('Run Claude more than once')).toBeInTheDocument()
  })

  it('survives opening a flow on an existing mount', () => {
    // React logs the hook-order violation via console.error before it throws,
    // so a silent pass is not proof — fail on it too.
    const errors: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0])
    })

    mount()
    // Inside act(), so the store change actually flushes a re-render. Without
    // it the assertion runs before React has re-rendered and the test passes
    // against the bug it exists to catch.
    expect(() => {
      act(() => {
        useWorkflowStore.getState().setCurrentWorkflow(flow())
      })
    }).not.toThrow()

    const hookOrder = errors.filter(
      (e) => typeof e === 'string' && e.includes('change in the order of Hooks')
    )
    expect(hookOrder).toEqual([])
  })

  it('shows no back arrow at the top of Flow mode', () => {
    // Only reachable with at least one saved flow: with none, the empty state
    // renders instead and never had a header. That is why this regressed
    // unnoticed — the arrow appeared exactly once you had something to lose.
    useWorkflowStore.setState({ workflows: [flow()] })
    mount()
    expect(screen.getByText('Flows')).toBeInTheDocument()
    // An arrow beside "Flows" read as "up one level" and dropped you into Chat.
    // The sidebar's Chat/Flow toggle is how you leave the mode.
    expect(screen.queryByLabelText('Back to chats')).toBeNull()
  })
})

/**
 * Every node type's inspector, mounted.
 *
 * The panels were hand-rolled one at a time and drifted: `Field` and the shared
 * control classes existed but were used twice and zero times respectively, and
 * three panels still had bare `<select>` elements. Converting them to the
 * shared primitives is only safe if something actually renders each one — a
 * Radix Select in particular throws rather than degrades when misconfigured
 * (an item whose value is the empty string, for instance).
 */
describe('node inspectors', () => {
  const NODE_TYPES = [
    ['prompt', { type: 'prompt', label: 'Seed Draft', prompt: 'write', model: 'sonnet' }],
    ['condition', { type: 'condition', label: 'Good?', expression: 'true' }],
    ['script', { type: 'script', label: 'Tests', command: 'npm test' }],
    ['parallel', { type: 'parallel', label: 'Fork' }],
    ['join', { type: 'join', label: 'Join', separator: '---' }],
    ['loop', { type: 'loop', label: 'Refine', condition: 'true', maxIterations: 5 }],
    ['humanReview', { type: 'humanReview', label: 'Gate', message: 'ok?' }],
    ['subworkflow', { type: 'subworkflow', label: 'Audit', workflowId: '', inputMapping: {} }]
  ] as const

  beforeEach(() => {
    useWorkflowStore.setState({ currentWorkflow: null, selectedNodeId: null, execution: null })
  })

  afterEach(cleanup)

  for (const [name, data] of NODE_TYPES) {
    it(`renders the ${name} inspector without crashing`, () => {
      const errors: unknown[] = []
      vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args[0]))

      const wf = {
        ...flow(),
        nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data }]
      } as unknown as WorkflowDefinition

      useWorkflowStore.setState({ currentWorkflow: wf })
      mount()
      act(() => {
        useWorkflowStore.getState().setSelectedNodeId('n1')
      })

      // The shared Name field is on every panel, so its absence means the
      // inspector did not render at all.
      expect(screen.getByText('Name')).toBeInTheDocument()
      expect(errors).toEqual([])
    })
  }

  it('uses no bare select elements', () => {
    // A native select draws its dropdown with the OS: a light system menu over
    // a dark app, which cannot be themed or carry per-option descriptions.
    const wf = {
      ...flow(),
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, data: { type: 'prompt', label: 'Seed', prompt: 'x' } }
      ]
    } as unknown as WorkflowDefinition
    useWorkflowStore.setState({ currentWorkflow: wf })
    const { container } = render(
      <TooltipProvider>
        <WorkflowCanvas />
      </TooltipProvider>
    )
    act(() => {
      useWorkflowStore.getState().setSelectedNodeId('n1')
    })
    // Prove the panel is actually on screen first: with no inspector rendered
    // this assertion would pass on an empty document and mean nothing.
    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })
})

/**
 * The six toolbar panels.
 *
 * They were written one at a time and drifted: four different hardcoded widths,
 * none resizable, and each with its own header markup — so they neither matched
 * each other nor the node inspector beside them. One shell fixed all three, and
 * these assert the shell is actually what they render.
 */
describe('toolbar panels', () => {
  // [event suffix, panel title]. The title is also the toolbar button's label:
  // the tooltip you clicked and the header you land on have to say the same
  // thing, and two of them did not until this test noticed.
  const PANELS = [
    ['details', 'Flow details'],
    ['inputs', 'Flow inputs'],
    ['vars', 'Variables'],
    ['history', 'Execution history'],
    ['metrics', 'Metrics'],
    ['triggers', 'Triggers']
  ] as const

  beforeEach(() => {
    useWorkflowStore.setState({
      currentWorkflow: flow(),
      selectedNodeId: null,
      execution: null
    })
  })

  afterEach(cleanup)

  for (const [event, title] of PANELS) {
    it(`${title} opens with a resize handle and a close button`, () => {
      const errors: unknown[] = []
      vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a[0]))

      mount()
      act(() => {
        window.dispatchEvent(new Event(`nyra:flow-panel-${event}`))
      })

      // Every panel is the same shell: titled, closable, and draggable.
      expect(screen.getByLabelText(`Close ${title}`)).toBeInTheDocument()
      expect(screen.getByLabelText(`Resize ${title}`)).toBeInTheDocument()
      expect(errors).toEqual([])
    })
  }

  it('shares one width across panels, since they are alternatives', () => {
    // Sizing one is a statement about how much room this kind of panel gets,
    // not about that panel in particular.
    mount()
    act(() => window.dispatchEvent(new Event('nyra:flow-panel-details')))
    const first = screen.getByLabelText('Close Flow details').closest('div')?.parentElement
    const width = first?.style.width
    expect(width).toBeTruthy()

    act(() => window.dispatchEvent(new Event('nyra:flow-panel-metrics')))
    const second = screen.getByLabelText('Close Metrics').closest('div')?.parentElement
    expect(second?.style.width).toBe(width)
  })
})

describe('Variables panel', () => {
  const withCapture = (): WorkflowDefinition =>
    ({
      ...flow(),
      nodes: [
        {
          id: 'sec',
          label: 'Security',
          position: { x: 0, y: 0 },
          data: {
            type: 'prompt',
            prompt: 'audit',
            setVars: [{ name: 'security_report', extractor: 'json:findings' }]
          }
        }
      ]
    }) as unknown as WorkflowDefinition

  afterEach(cleanup)

  it('shows what the flow saves even though it has never run', () => {
    // The complaint this fixes: the panel rendered `execution.vars` alone, so
    // outside a run it said "No variables set yet" and offered nothing at all.
    useWorkflowStore.setState({
      currentWorkflow: withCapture(),
      execution: null,
      selectedNodeId: null
    })
    mount()
    act(() => window.dispatchEvent(new Event('nyra:flow-panel-vars')))

    expect(screen.getByText('{{vars.security_report}}')).toBeInTheDocument()
    expect(screen.getByText(/saved by Security/)).toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
    expect(screen.getByText(/run the flow to fill it/i)).toBeInTheDocument()
  })

  it('says what to do when the flow saves nothing', () => {
    useWorkflowStore.setState({ currentWorkflow: flow(), execution: null, selectedNodeId: null })
    mount()
    act(() => window.dispatchEvent(new Event('nyra:flow-panel-vars')))
    expect(screen.getByText(/saves nothing yet/i)).toBeInTheDocument()
    expect(screen.getByText(/pass its result to/i)).toBeInTheDocument()
  })

  it('jumps to the node that saves a variable', () => {
    useWorkflowStore.setState({
      currentWorkflow: withCapture(),
      execution: null,
      selectedNodeId: null
    })
    mount()
    act(() => window.dispatchEvent(new Event('nyra:flow-panel-vars')))
    fireEvent.click(screen.getByText(/saved by Security/))
    expect(useWorkflowStore.getState().selectedNodeId).toBe('sec')
  })
})

describe('the run panel', () => {
  const twoNodes = (): WorkflowDefinition =>
    ({
      ...flow(),
      nodes: [
        { id: 'a', label: 'Gather', position: { x: 0, y: 0 }, data: { type: 'script', command: 'ls' } },
        { id: 'b', label: 'Summarise', position: { x: 0, y: 116 }, data: { type: 'prompt', prompt: 'x' } }
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }]
    }) as unknown as WorkflowDefinition

  const midRun = (): void => {
    useWorkflowStore.setState({
      currentWorkflow: twoNodes(),
      selectedNodeId: null,
      execution: {
        id: 'e',
        workflowId: 'wf1',
        status: 'running',
        nodeStates: {
          a: { nodeId: 'a', status: 'done', output: 'three files changed' },
          b: { nodeId: 'b', status: 'running', output: '' }
        },
        vars: {},
        startedAt: Date.now()
      } as never
    })
  }

  afterEach(cleanup)

  it('summarises the run in one row, showing the step it is on', () => {
    // One entry that replaces itself, not a growing list. Per-step detail is
    // behind that step's own timeline row.
    midRun()
    mount()
    expect(screen.getByLabelText('Show Summarise output')).toBeInTheDocument()
    // The running step has no output of its own yet — the engine sends it on
    // completion — so the row carries the last thing the run said.
    expect(screen.getByText('three files changed')).toBeInTheDocument()
    expect(screen.queryByText('working…')).toBeNull()
  })

  it('falls back to the last step that spoke once nothing is running', () => {
    useWorkflowStore.setState({
      currentWorkflow: twoNodes(),
      selectedNodeId: null,
      execution: {
        id: 'e',
        workflowId: 'wf1',
        status: 'done',
        nodeStates: {
          a: { nodeId: 'a', status: 'done', output: 'three files changed' },
          b: { nodeId: 'b', status: 'done', output: 'looks routine\nplus detail' }
        },
        vars: {},
        startedAt: Date.now()
      } as never
    })
    mount()
    // The last result, and only its opening line.
    expect(screen.getByText('looks routine')).toBeInTheDocument()
    expect(screen.queryByText('plus detail')).toBeNull()
  })

  it('opens a step in place for the full text', () => {
    midRun()
    mount()
    const before = screen.getAllByText('three files changed').length
    fireEvent.click(screen.getByLabelText('Show Gather output'))
    expect(screen.getAllByText('three files changed').length).toBe(before + 1)

    fireEvent.click(screen.getByLabelText('Hide Gather output'))
    expect(screen.getAllByText('three files changed').length).toBe(before)
  })

  it('offers no timeline disclosure on a row that has said nothing', () => {
    // A chevron on a row with no output promises something it has not produced.
    // The summary row above carries the same label, so the count is what tells
    // them apart: one means the timeline row did not add a second.
    midRun()
    mount()
    expect(screen.getAllByLabelText(/Summarise output/)).toHaveLength(1)
    // …whereas the step that has spoken does get one in the timeline.
    expect(screen.getAllByLabelText(/Gather output/)).toHaveLength(1)
  })

  it('offers a way back to the run after opening a node from the timeline', () => {
    // Clicking a timeline row swaps this panel for that node's config, and
    // deselecting was the only way back — which nobody guesses.
    midRun()
    mount()
    act(() => useWorkflowStore.getState().setSelectedNodeId('a'))

    const back = screen.getByLabelText('Back to the run')
    fireEvent.click(back)
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull()
  })

  it('has no back arrow when there is no run behind it', () => {
    useWorkflowStore.setState({
      currentWorkflow: twoNodes(),
      execution: null,
      selectedNodeId: 'a'
    })
    mount()
    expect(screen.queryByLabelText('Back to the run')).toBeNull()
  })
})
