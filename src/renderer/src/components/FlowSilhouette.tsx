/**
 * A flow's shape, small enough to read before you read its name.
 *
 * Drawn from the graph rather than picked from a set of pictures, so a template
 * that changes shape changes here too. What it is for: on a template card you
 * can tell a straight chain from a three-way fan-out from a loop without
 * parsing any words, which is most of what the eight node types mean.
 */
import React from 'react'
import { layerNodes } from '../lib/flowLayout'
import type { WorkflowNode, WorkflowEdge } from '../../../shared/workflow-types'

const NODE_W = 18
const NODE_H = 5
const GAP_X = 4
const ROW_H = 13

/** Structural nodes read as a narrow tick; the work nodes are the wide bars. */
function isRouting(node: WorkflowNode): boolean {
  return ['condition', 'parallel', 'join'].includes(node.data.type)
}

export function FlowSilhouette({
  nodes,
  edges,
  className = ''
}: {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  className?: string
}): React.JSX.Element {
  const rows = layerNodes(nodes, edges)
  const widest = rows.length === 0 ? 1 : Math.max(...rows.map((r) => r.length))
  const width = widest * NODE_W + (widest - 1) * GAP_X
  const height = Math.max(rows.length * ROW_H - (ROW_H - NODE_H), NODE_H)

  return (
    <svg
      viewBox={`0 0 ${Math.max(width, NODE_W)} ${height}`}
      width={Math.max(width, NODE_W)}
      height={height}
      className={`shrink-0 overflow-visible ${className}`}
      aria-hidden
    >
      {rows.map((row, r) => {
        const rowW = row.length * NODE_W + (row.length - 1) * GAP_X
        const offset = (width - rowW) / 2
        const y = r * ROW_H
        return (
          <g key={r}>
            {r > 0 && (
              // One connector per row rather than one per edge: at this size a
              // faithful edge tangle reads as noise, and the rows already say
              // what runs together.
              <line
                x1={width / 2}
                y1={y - (ROW_H - NODE_H)}
                x2={width / 2}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
              />
            )}
            {row.map((node, i) => {
              const routing = isRouting(node)
              const w = routing ? NODE_W * 0.55 : NODE_W
              const x = offset + i * (NODE_W + GAP_X) + (routing ? (NODE_W - w) / 2 : 0)
              return (
                <rect
                  key={node.id}
                  x={x}
                  y={y}
                  width={w}
                  height={NODE_H}
                  rx={2}
                  className={routing ? 'fill-muted-foreground/30' : 'fill-muted-foreground/55'}
                />
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}
