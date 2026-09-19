/**
 * A flow edge that shows execution moving along it.
 *
 * Orthogonal like every other edge, with one addition: while the node it feeds
 * is running, a lit segment travels from source to target. Only those edges
 * animate. If every edge moved, motion would stop meaning anything and the
 * canvas would be a screensaver; one moving line reads as "the run is here".
 *
 * The travelling segment is a second path stacked on the first rather than a
 * dash pattern on the edge itself, so the edge keeps its own colour underneath
 * and the animation can be disabled without the line disappearing.
 */
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

export function FlowPulseEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
  style,
  markerEnd
}: EdgeProps): React.JSX.Element {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 10
  })
  const active = Boolean(data?.active)

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {active ? <path d={path} className="nyra-flow-pulse" pathLength={1} /> : null}
      {label ? (
        <EdgeLabelRenderer>
          <div
            // `nodrag nopan` or the label swallows a drag on the canvas beneath it.
            className="nodrag nopan pointer-events-none absolute rounded bg-background px-1 py-px font-mono text-[9.5px] text-muted-foreground"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
