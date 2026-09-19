import { describe, it, expect } from 'vitest'
import {
  nodeDepths,
  layerNodes,
  maxWidth,
  autoLayout,
  withAutoLayout,
  loopBody,
  bodyMembership,
  inertLoopBodyNodes,
  layoutWithContainers,

  isBodyEdge,
  NODE_SIZE,
  LOOP_CHROME
} from '../../renderer/src/lib/flowLayout'
import type { WorkflowNode, WorkflowEdge } from '../../shared/workflow-types'

const n = (id: string): WorkflowNode => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  data: { type: 'prompt', prompt: '' }
})
const e = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle
})

describe('nodeDepths', () => {
  it('puts a root at zero', () => {
    expect(nodeDepths([n('a')], []).get('a')).toBe(0)
  })

  it('walks a straight chain', () => {
    const d = nodeDepths([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')])
    expect([d.get('a'), d.get('b'), d.get('c')]).toEqual([0, 1, 2])
  })

  it('puts every branch of a fan-out on one row', () => {
    const d = nodeDepths(
      [n('fork'), n('x'), n('y'), n('z')],
      [e('fork', 'x'), e('fork', 'y'), e('fork', 'z')]
    )
    expect([d.get('x'), d.get('y'), d.get('z')]).toEqual([1, 1, 1])
  })

  it('sinks a join below its deepest branch, not its shallowest', () => {
    // fork -> short -> join, and fork -> a -> b -> join. The join belongs under b.
    const d = nodeDepths(
      [n('fork'), n('short'), n('a'), n('b'), n('join')],
      [e('fork', 'short'), e('fork', 'a'), e('a', 'b'), e('short', 'join'), e('b', 'join')]
    )
    expect(d.get('join')).toBe(3)
  })

  it('ignores an edge pointing at a node that is not there', () => {
    const d = nodeDepths([n('a')], [e('ghost', 'a')])
    expect(d.get('a')).toBe(0)
  })

  it('stays finite on a cycle instead of recursing forever', () => {
    const d = nodeDepths([n('a'), n('b')], [e('a', 'b'), e('b', 'a')])
    expect(Number.isFinite(d.get('a'))).toBe(true)
    expect(Number.isFinite(d.get('b'))).toBe(true)
  })
})

describe('layerNodes', () => {
  it('returns nothing for an empty flow', () => {
    expect(layerNodes([], [])).toEqual([])
  })

  it('groups a fan-out into three rows', () => {
    const rows = layerNodes(
      [n('fork'), n('x'), n('y'), n('join')],
      [e('fork', 'x'), e('fork', 'y'), e('x', 'join'), e('y', 'join')]
    )
    expect(rows.map((r) => r.map((node) => node.id))).toEqual([['fork'], ['x', 'y'], ['join']])
  })

  it('keeps a disconnected node on the top row', () => {
    const rows = layerNodes([n('a'), n('b'), n('loose')], [e('a', 'b')])
    expect(rows[0].map((x) => x.id)).toEqual(['a', 'loose'])
  })

  it('lays the loop template out the way the engine runs it', () => {
    // seed -> loop, loop --body--> refine -> score, loop --exit--> finalize.
    // body and exit leave the same node, so refine and finalize share a row.
    const rows = layerNodes(
      [n('seed'), n('loop'), n('refine'), n('score'), n('finalize')],
      [
        e('seed', 'loop'),
        e('loop', 'refine', 'body'),
        e('refine', 'score'),
        e('loop', 'finalize', 'exit')
      ]
    )
    expect(rows.map((r) => r.map((x) => x.id))).toEqual([
      ['seed'],
      ['loop'],
      ['refine', 'finalize'],
      ['score']
    ])
  })
})

describe('maxWidth', () => {
  it('is one for a straight chain', () => {
    expect(maxWidth([n('a'), n('b')], [e('a', 'b')])).toBe(1)
  })

  it('counts the widest fan-out', () => {
    expect(
      maxWidth([n('f'), n('x'), n('y'), n('z')], [e('f', 'x'), e('f', 'y'), e('f', 'z')])
    ).toBe(3)
  })

  it('is zero for an empty flow', () => {
    expect(maxWidth([], [])).toBe(0)
  })
})

describe('autoLayout', () => {
  it('stacks a chain down the same column', () => {
    const placed = autoLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')])
    const xs = ['a', 'b', 'c'].map((id) => placed.get(id)!.x)
    expect(new Set(xs).size).toBe(1)
    expect(placed.get('a')!.y).toBeLessThan(placed.get('b')!.y)
    expect(placed.get('b')!.y).toBeLessThan(placed.get('c')!.y)
  })

  it('centres a fan-out on the spine so it opens symmetrically', () => {
    const placed = autoLayout(
      [n('f'), n('x'), n('y'), n('z')],
      [e('f', 'x'), e('f', 'y'), e('f', 'z')]
    )
    const branchXs = ['x', 'y', 'z'].map((id) => placed.get(id)!.x)
    expect(branchXs[1]).toBe(placed.get('f')!.x)
    expect(branchXs[0] + branchXs[2]).toBe(2 * branchXs[1])
  })

  it('puts a whole row at one height', () => {
    const placed = autoLayout([n('f'), n('x'), n('y')], [e('f', 'x'), e('f', 'y')])
    expect(placed.get('x')!.y).toBe(placed.get('y')!.y)
  })
})

describe('withAutoLayout', () => {
  it('replaces the left-to-right positions a template ships with', () => {
    const nodes = [
      { ...n('a'), position: { x: 50, y: 160 } },
      { ...n('b'), position: { x: 320, y: 160 } }
    ]
    const out = withAutoLayout(nodes, [e('a', 'b')])
    expect(out[0].position.y).toBeLessThan(out[1].position.y)
    expect(out[0].position.x).toBe(out[1].position.x)
  })

  it('leaves everything except position alone', () => {
    const out = withAutoLayout([n('a')], [])
    expect(out[0].label).toBe('a')
    expect(out[0].data).toEqual({ type: 'prompt', prompt: '' })
  })
})

const loopNode = (id: string): WorkflowNode => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  data: { type: 'loop', condition: '', maxIterations: 5 }
})
const gateNode = (id: string): WorkflowNode => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  data: { type: 'humanReview', message: '' }
})

describe('loopBody', () => {
  it('is empty when nothing is wired to the body handle', () => {
    expect(loopBody('loop', [loopNode('loop'), n('after')], [e('loop', 'after', 'exit')])).toEqual(
      []
    )
  })

  it('walks the chain the engine walks', () => {
    // seed -> loop, loop --body--> refine -> score, loop --exit--> finalize
    const body = loopBody(
      'loop',
      [n('seed'), loopNode('loop'), n('refine'), n('score'), n('finalize')],
      [
        e('seed', 'loop'),
        e('loop', 'refine', 'body'),
        e('refine', 'score'),
        e('loop', 'finalize', 'exit')
      ]
    )
    expect(body.map((b) => b.id)).toEqual(['refine', 'score'])
  })

  it('never follows a second edge out of a body node, because the engine does not', () => {
    // `run_loop_body` takes the first outgoing edge and drops the rest.
    const body = loopBody(
      'loop',
      [loopNode('loop'), n('a'), n('b'), n('dropped')],
      [e('loop', 'a', 'body'), e('a', 'b'), e('a', 'dropped')]
    )
    expect(body.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('stops when an explicit return edge arrives back at the loop', () => {
    const body = loopBody(
      'loop',
      [loopNode('loop'), n('a')],
      [e('loop', 'a', 'body'), e('a', 'loop')]
    )
    expect(body.map((x) => x.id)).toEqual(['a'])
  })

  it('does not hang on a cycle inside the body', () => {
    const body = loopBody(
      'loop',
      [loopNode('loop'), n('a'), n('b')],
      [e('loop', 'a', 'body'), e('a', 'b'), e('b', 'a')]
    )
    expect(body.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('reads the label when no sourceHandle was saved', () => {
    const edge = { id: 'x', source: 'loop', target: 'a', label: 'body' }
    expect(loopBody('loop', [loopNode('loop'), n('a')], [edge]).map((x) => x.id)).toEqual(['a'])
  })
})

describe('bodyMembership', () => {
  it('maps each body node to the loop that owns it', () => {
    const owner = bodyMembership(
      [loopNode('loop'), n('a'), n('b'), n('outside')],
      [e('loop', 'a', 'body'), e('a', 'b'), e('loop', 'outside', 'exit')]
    )
    expect(owner.get('a')).toBe('loop')
    expect(owner.get('b')).toBe('loop')
    expect(owner.has('outside')).toBe(false)
  })

  it('gives a nested loop its own body rather than absorbing it', () => {
    // The inner loop runs its own body, so `deep` belongs to `inner`, and
    // `inner` belongs to `outer`. Walking into the inner `body` edge from the
    // outer chain would draw one flat body and, in the engine, run `deep` twice.
    const owner = bodyMembership(
      [loopNode('outer'), n('first'), loopNode('inner'), n('deep')],
      [e('outer', 'first', 'body'), e('first', 'inner'), e('inner', 'deep', 'body')]
    )
    expect(owner.get('first')).toBe('outer')
    expect(owner.get('inner')).toBe('outer')
    expect(owner.get('deep')).toBe('inner')
  })

  it('resumes the outer chain past a nested loop on its exit edge', () => {
    const body = loopBody(
      'outer',
      [loopNode('outer'), loopNode('inner'), n('deep'), n('after')],
      [
        e('outer', 'inner', 'body'),
        e('inner', 'deep', 'body'),
        e('inner', 'after', 'exit')
      ]
    )
    expect(body.map((x) => x.id)).toEqual(['inner', 'after'])
  })

  it('ends the outer chain at a nested loop with no exit edge', () => {
    const body = loopBody(
      'outer',
      [loopNode('outer'), loopNode('inner'), n('deep')],
      [e('outer', 'inner', 'body'), e('inner', 'deep', 'body')]
    )
    expect(body.map((x) => x.id)).toEqual(['inner'])
  })

  it('is empty when there are no loops', () => {
    expect(bodyMembership([n('a'), n('b')], [e('a', 'b')]).size).toBe(0)
  })
})

describe('inertLoopBodyNodes', () => {
  const typed = (id: string, type: string): WorkflowNode => ({
    id,
    label: id,
    position: { x: 0, y: 0 },
    data: { type, prompt: '', condition: '', maxIterations: 5 } as never
  })

  it('passes a body of prompts and scripts', () => {
    const inert = inertLoopBodyNodes(
      'loop',
      [loopNode('loop'), typed('a', 'prompt'), typed('b', 'script')],
      [e('loop', 'a', 'body'), e('a', 'b')]
    )
    expect(inert).toEqual([])
  })

  it('passes a humanReview, a subworkflow and a nested loop, which the engine now runs', () => {
    const inert = inertLoopBodyNodes(
      'loop',
      [
        loopNode('loop'),
        typed('gate', 'humanReview'),
        typed('sub', 'subworkflow'),
        loopNode('inner')
      ],
      [e('loop', 'gate', 'body'), e('gate', 'sub'), e('sub', 'inner')]
    )
    expect(inert).toEqual([])
  })

  it('flags a parallel, which has no fan-out to split in a single chain', () => {
    const inert = inertLoopBodyNodes(
      'loop',
      [loopNode('loop'), typed('a', 'prompt'), typed('fork', 'parallel')],
      [e('loop', 'a', 'body'), e('a', 'fork')]
    )
    expect(inert.map((x) => x.id)).toEqual(['fork'])
  })

  it('flags a join, which has nothing to wait for in a single chain', () => {
    const inert = inertLoopBodyNodes(
      'loop',
      [loopNode('loop'), typed('j', 'join')],
      [e('loop', 'j', 'body')]
    )
    expect(inert.map((x) => x.id)).toEqual(['j'])
  })
})

describe('layoutWithContainers', () => {
  const refinerNodes = [n('seed'), loopNode('loop'), n('refine'), n('score'), n('finalize')]
  const refinerEdges = [
    e('seed', 'loop'),
    e('loop', 'refine', 'body'),
    e('refine', 'score'),
    e('loop', 'finalize', 'exit')
  ]

  it('makes body nodes children of their loop', () => {
    const { parents } = layoutWithContainers(refinerNodes, refinerEdges)
    expect(parents.get('refine')).toBe('loop')
    expect(parents.get('score')).toBe('loop')
    expect(parents.has('finalize')).toBe(false)
    expect(parents.has('seed')).toBe(false)
  })

  it('keeps body nodes off the main spine', () => {
    const { positions } = layoutWithContainers(refinerNodes, refinerEdges)
    // seed, loop and finalize are the spine; the body is positioned relative to
    // the container, so its coordinates restart near the origin.
    expect(positions.get('seed')!.y).toBeLessThan(positions.get('loop')!.y)
    expect(positions.get('loop')!.y).toBeLessThan(positions.get('finalize')!.y)
    expect(positions.get('refine')!.x).toBe(LOOP_CHROME.padX)
  })

  it('stacks the body inside the container', () => {
    const { positions } = layoutWithContainers(refinerNodes, refinerEdges)
    expect(positions.get('refine')!.y).toBeLessThan(positions.get('score')!.y)
    expect(positions.get('refine')!.y).toBeGreaterThanOrEqual(LOOP_CHROME.header)
  })

  it('sizes the loop to hold its body', () => {
    const { sizes } = layoutWithContainers(refinerNodes, refinerEdges)
    const box = sizes.get('loop')!
    expect(box.height).toBeGreaterThan(LOOP_CHROME.header + LOOP_CHROME.footer)
    expect(box.width).toBeGreaterThan(200)
  })

  it('still sizes a loop with an empty body, so it does not collapse', () => {
    const { sizes } = layoutWithContainers([loopNode('loop')], [])
    expect(sizes.get('loop')).toEqual(NODE_SIZE.loop)
  })

  it('leaves room below a loop for the whole container', () => {
    // The bug this guards: a fixed row pitch put `finalize` at y=232 while the
    // container ran from 116 to 384, so the next node rendered inside the box
    // it was supposed to follow.
    const { positions, sizes } = layoutWithContainers(refinerNodes, refinerEdges)
    const loopBottom = positions.get('loop')!.y + sizes.get('loop')!.height
    expect(positions.get('finalize')!.y).toBeGreaterThanOrEqual(loopBottom)
  })

  it('fits the container to its last body node rather than guessing', () => {
    const { positions, sizes } = layoutWithContainers(refinerNodes, refinerEdges)
    const lastBottom = positions.get('score')!.y + NODE_SIZE.prompt.height
    expect(sizes.get('loop')!.height).toBe(lastBottom + LOOP_CHROME.padY + LOOP_CHROME.footer)
  })

  it('grows the container for a body node that is taller', () => {
    const withGate = [n('seed'), loopNode('loop'), n('refine'), gateNode('gate'), n('finalize')]
    const gateEdges = [
      e('seed', 'loop'),
      e('loop', 'refine', 'body'),
      e('refine', 'gate'),
      e('loop', 'finalize', 'exit')
    ]
    const plain = layoutWithContainers(refinerNodes, refinerEdges).sizes.get('loop')!
    const taller = layoutWithContainers(withGate, gateEdges).sizes.get('loop')!
    expect(taller.height - plain.height).toBe(
      NODE_SIZE.humanReview.height - NODE_SIZE.prompt.height
    )
  })
})

describe('isBodyEdge', () => {
  it('reads the handle a loop hands its body', () => {
    expect(isBodyEdge(e('loop', 'a', 'body'))).toBe(true)
    expect(isBodyEdge(e('loop', 'a', 'exit'))).toBe(false)
    expect(isBodyEdge(e('a', 'b'))).toBe(false)
  })

  it('falls back to the label, which is how the templates are wired', () => {
    expect(isBodyEdge({ id: 'x', source: 'loop', target: 'a', label: 'body' })).toBe(true)
  })

  it('leaves a flow with no loops laid out flat', () => {
    const { parents, sizes } = layoutWithContainers([n('a'), n('b')], [e('a', 'b')])
    expect(parents.size).toBe(0)
    expect(sizes.size).toBe(0)
  })
})
