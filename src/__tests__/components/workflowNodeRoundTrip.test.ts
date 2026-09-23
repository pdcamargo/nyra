import { describe, expect, it } from 'vitest'
import { fromFlowNodes, toFlowNodes } from '../../renderer/src/components/WorkflowCanvas'
import type { WorkflowNode } from '../../shared/workflow-types'

/**
 * Save, drag and export all rebuild the flow from the canvas's own copy of each
 * node, so anything one direction forgets is quietly dropped. The script
 * node's timeout was: the inspector showed 3600 s and said saved, and the file
 * went back to the 120 s default.
 */
describe('a node through the canvas and back', () => {
  it('keeps a script timeout', () => {
    const node: WorkflowNode = {
      id: 'build',
      label: 'Build',
      position: { x: 0, y: 0 },
      data: { type: 'script', command: 'npm run build', timeoutMs: 3_600_000 }
    }
    const [back] = fromFlowNodes(toFlowNodes([node], {}))
    expect(back.data).toEqual(node.data)
  })

  it('leaves an unset timeout unset, so the engine default applies', () => {
    const node: WorkflowNode = {
      id: 'lint',
      label: 'Lint',
      position: { x: 0, y: 0 },
      data: { type: 'script', command: 'npm run lint' }
    }
    const [back] = fromFlowNodes(toFlowNodes([node], {}))
    expect(back.data).toMatchObject({ type: 'script', command: 'npm run lint' })
    expect((back.data as { timeoutMs?: number }).timeoutMs).toBeUndefined()
  })
})
