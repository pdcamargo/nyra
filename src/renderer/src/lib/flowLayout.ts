/**
 * Layering a flow into rows.
 *
 * A flow reads top to bottom, so everything that can run at the same moment
 * belongs on the same row. That is what a fan-out looks like: `parallel` at one
 * depth, its three branches at the next, `join` below them.
 *
 * Used twice — by the silhouette on a template card, and by top-to-bottom
 * auto-layout on the canvas. Pure, so both can be tested without a renderer.
 */
import type { WorkflowNode, WorkflowEdge } from '../../../shared/workflow-types'

/**
 * Depth of each node: the longest path reaching it from any root.
 *
 * Longest rather than shortest, so a `join` sits below every branch feeding it
 * rather than level with the shortest one. A node in a cycle resolves to the
 * depth it had when the cycle was found, which keeps a malformed graph drawable
 * instead of hanging.
 */
export function nodeDepths(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, number> {
  const parents = new Map<string, string[]>()
  const known = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source])
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  const resolve = (id: string): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    // A cycle: treat this node as a root rather than recursing forever.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const up = parents.get(id) ?? []
    const d = up.length === 0 ? 0 : Math.max(...up.map(resolve)) + 1
    visiting.delete(id)
    depth.set(id, d)
    return d
  }

  for (const n of nodes) resolve(n.id)
  return depth
}

/** The same nodes, grouped into rows and kept in their original order within one. */
export function layerNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[][] {
  if (nodes.length === 0) return []
  const depth = nodeDepths(nodes, edges)
  const rows: WorkflowNode[][] = []
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    while (rows.length <= d) rows.push([])
    rows[d].push(n)
  }
  return rows
}

/** Widest row in the graph. One means a straight chain; more means it forks. */
export function maxWidth(nodes: WorkflowNode[], edges: WorkflowEdge[]): number {
  const rows = layerNodes(nodes, edges)
  return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.length))
}

/**
 * Rendered size of each node type, in canvas units.
 *
 * Layout runs before React Flow has measured anything, so it needs to know how
 * big a node will be. The three shapes are genuinely different heights — a
 * review gate carries its Approve/Reject row and a routing pill is one line — so
 * a single pitch for all of them either wastes space or overlaps. Slightly
 * generous, since spare canvas costs nothing and an overlap is a bug.
 */
export const NODE_SIZE: Record<string, { width: number; height: number }> = {
  prompt: { width: 200, height: 62 },
  script: { width: 200, height: 62 },
  subworkflow: { width: 200, height: 62 },
  humanReview: { width: 200, height: 100 },
  condition: { width: 160, height: 34 },
  parallel: { width: 160, height: 34 },
  join: { width: 160, height: 34 },
  // Only the fallback, for a loop with no body. A loop that holds something is
  // sized by `loopContainerLayout`.
  loop: { width: 240, height: 138 }
}

const DEFAULT_SIZE = { width: 200, height: 62 }
const GAP_X = 30
const GAP_Y = 54

/** How big a node draws, unless something already knows better. */
function sizeOf(
  node: WorkflowNode,
  known?: Map<string, { width: number; height: number }>
): { width: number; height: number } {
  return known?.get(node.id) ?? NODE_SIZE[node.data.type] ?? DEFAULT_SIZE
}

/**
 * Position every node top to bottom.
 *
 * The bundled templates were laid out left to right, so they need re-placing
 * once handles move to top and bottom — otherwise edges leave the bottom of one
 * node and arrive at the top of another sitting beside it, which reads as a
 * tangle. Rows come from `layerNodes`, and each row is centred on the spine so a
 * fan-out opens symmetrically.
 *
 * Each row is as tall as its tallest node rather than a fixed pitch. A loop
 * container is several times the height of a card, so a fixed pitch put whatever
 * followed a loop inside the loop's own box.
 */
export function autoLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  sizes?: Map<string, { width: number; height: number }>
): Map<string, { x: number; y: number }> {
  const rows = layerNodes(nodes, edges)
  const placed = new Map<string, { x: number; y: number }>()
  let y = 0
  for (const row of rows) {
    const dims = row.map((node) => sizeOf(node, sizes))
    const rowWidth = dims.reduce((sum, d) => sum + d.width, 0) + (row.length - 1) * GAP_X
    const rowHeight = Math.max(...dims.map((d) => d.height))
    let x = -rowWidth / 2
    row.forEach((node, i) => {
      // Centred within the row, so a pill beside a card sits on its midline
      // rather than hanging from the top of the band.
      placed.set(node.id, {
        x: Math.round(x),
        y: Math.round(y + (rowHeight - dims[i].height) / 2)
      })
      x += dims[i].width + GAP_X
    })
    y += rowHeight + GAP_Y
  }
  return placed
}

/** The same nodes with `position` replaced by the top-to-bottom layout. */
export function withAutoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const placed = autoLayout(nodes, edges)
  return nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position }))
}

/**
 * The nodes a loop repeats, in the order the engine runs them.
 *
 * Mirrors `run_loop_body` exactly: start at whatever the `body` handle points
 * at, then follow the first outgoing edge each time. That "first" is not a
 * simplification. The engine takes one edge and silently ignores the rest, so a
 * body cannot branch, and walking it any other way would draw a body the engine
 * would not run.
 *
 * One exception, which the engine shares: a nested loop resumes on `exit`, since
 * its `body` belongs to it rather than to this chain.
 *
 * Stops when the chain runs out, or when it arrives back at the loop node. There
 * is no return edge in the bundled templates; the engine returns implicitly when
 * the chain ends, and this handles both.
 */
export function loopBody(
  loopId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, WorkflowEdge[]>()
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e])

  const entry = (out.get(loopId) ?? []).find(isBodyEdge)
  if (!entry) return []

  const chain: WorkflowNode[] = []
  const seen = new Set<string>([loopId])
  let cursor: string | undefined = entry.target
  while (cursor && !seen.has(cursor)) {
    const node = byId.get(cursor)
    if (!node) break
    chain.push(node)
    seen.add(cursor)
    const outs: WorkflowEdge[] = out.get(cursor) ?? []
    // A nested loop owns its own body, so this chain resumes past it on `exit`.
    // Taking the first edge would take `body` and pull the inner loop's nodes up
    // into this one, which is neither how it draws nor how it runs.
    cursor =
      node.data.type === 'loop'
        ? outs.find((x) => (x.sourceHandle ?? x.label) === 'exit')?.target
        : outs[0]?.target
  }
  return chain
}

/** Every node that belongs to some loop's body, so the spine can skip them. */
export function bodyMembership(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Map<string, string> {
  const owner = new Map<string, string>()
  for (const n of nodes) {
    if (n.data.type !== 'loop') continue
    for (const child of loopBody(n.id, nodes, edges)) {
      // First loop to claim a node keeps it; a node in two bodies is malformed
      // and nesting it twice would be worse than picking one.
      if (!owner.has(child.id)) owner.set(child.id, n.id)
    }
  }
  return owner
}

/**
 * Node types a loop body cannot run, mirroring `needs_graph` in the engine.
 *
 * Only these two. `parallel` fans out across every outgoing edge and `join`
 * waits for several to arrive, and a body is a single chain by construction, so
 * there is nothing for either to split or rejoin. The engine now fails the node
 * rather than passing the previous output through, and the canvas says so first
 * to save a run that was going to stop anyway.
 */
const NEEDS_THE_GRAPH = new Set(['parallel', 'join'])

/** Body nodes the engine cannot run, in body order. */
export function inertLoopBodyNodes(
  loopId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  return loopBody(loopId, nodes, edges).filter((n) => NEEDS_THE_GRAPH.has(n.data.type))
}

/** Chrome around a loop container's body, in canvas units. */
export const LOOP_CHROME = { header: 36, footer: 30, padX: 20, padY: 12, bodyGap: 32 }

/**
 * Where each body node sits inside its container, and how big that makes it.
 *
 * One function rather than two so the size and the contents can never disagree —
 * they did while this arithmetic was copied into the canvas, and a container one
 * row too short clips its own footer over the last node it holds.
 */
export function loopContainerLayout(
  loopId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  owner?: Map<string, string>,
  open: Set<string> = new Set()
): {
  body: WorkflowNode[]
  positions: Map<string, { x: number; y: number }>
  size: { width: number; height: number }
} {
  const claimed = owner ?? bodyMembership(nodes, edges)
  const body = loopBody(loopId, nodes, edges).filter((b) => claimed.get(b.id) === loopId)
  const positions = new Map<string, { x: number; y: number }>()
  if (body.length === 0) return { body, positions, size: { ...NODE_SIZE.loop } }

  let y = LOOP_CHROME.header + LOOP_CHROME.padY
  let width = 0
  for (const child of body) {
    // A loop inside a loop is sized by what it holds, the same as this one. The
    // open set stops a malformed graph where two loops enclose each other.
    const s =
      child.data.type === 'loop' && !open.has(child.id)
        ? loopContainerLayout(child.id, nodes, edges, claimed, new Set([...open, loopId])).size
        : sizeOf(child)
    positions.set(child.id, { x: LOOP_CHROME.padX, y })
    width = Math.max(width, s.width)
    y += s.height + LOOP_CHROME.bodyGap
  }
  return {
    body,
    positions,
    size: {
      width: width + LOOP_CHROME.padX * 2,
      height: y - LOOP_CHROME.bodyGap + LOOP_CHROME.padY + LOOP_CHROME.footer
    }
  }
}

/** The edge a loop hands its body, which containment draws instead of a line. */
export function isBodyEdge(edge: WorkflowEdge): boolean {
  return (edge.sourceHandle ?? edge.label) === 'body'
}

/**
 * Lay a flow out with loop bodies nested inside their loop.
 *
 * Body nodes leave the main spine and are placed relative to their container,
 * which React Flow expects from a child node. The loop itself is sized to hold
 * them, so containment is what expresses the cycle and no return edge has to be
 * invented. Sizes are worked out first, because the spine has to leave room for
 * a container that is several node-heights tall.
 */
export function layoutWithContainers(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): {
  positions: Map<string, { x: number; y: number }>
  parents: Map<string, string>
  sizes: Map<string, { width: number; height: number }>
} {
  const parents = bodyMembership(nodes, edges)
  const sizes = new Map<string, { width: number; height: number }>()
  const positions = new Map<string, { x: number; y: number }>()

  for (const loop of nodes.filter((n) => n.data.type === 'loop')) {
    const { positions: inner, size } = loopContainerLayout(loop.id, nodes, edges, parents)
    sizes.set(loop.id, size)
    for (const [id, p] of inner) positions.set(id, p)
  }

  const spine = nodes.filter((n) => !parents.has(n.id))
  const spineEdges = edges.filter(
    (e) => !parents.has(e.source) && !parents.has(e.target) && !isBodyEdge(e)
  )
  for (const [id, p] of autoLayout(spine, spineEdges, sizes)) positions.set(id, p)

  return { positions, parents, sizes }
}

/**
 * Positions for a whole flow, bodies nested inside their loop.
 *
 * What `withAutoLayout` is for a flat graph, this is for one with loops: a body
 * node's position is relative to its container, which is what React Flow expects
 * from a child.
 */
export function laidOut(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const { positions } = layoutWithContainers(nodes, edges)
  return nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position }))
}
