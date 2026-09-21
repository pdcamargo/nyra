import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  type NodeProps,
  Handle,
  Panel,
  Position,
  BackgroundVariant,
  useReactFlow,
  useStore,
  useStoreApi
} from '@xyflow/react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { CommandKbd } from './ui/kbd'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from './ui/select'
import type { CommandId } from '../commands/registry'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from './ui/dropdown-menu'
import { FlowPulseEdge } from './FlowPulseEdge'
import ResizeHandle from './ResizeHandle'
import { handleBinding } from '../store/panelLayout'
import { usePanelSizesStore } from '../store/panelSizes'
import { tokenCount, sumTokens, suggestFix, duration, firstLine } from '../lib/flowRun'
import { triggerSummary } from '../lib/flowGrouping'
import { extractorKind, extractorTemplate } from '../lib/extractors'
import '@xyflow/react/dist/style.css'
import { useWorkflowStore } from '../store/workflow'
import { useSessionsStore, activeCwd, activeProject } from '../store/sessions'
import {
  laidOut,
  bodyMembership,
  loopContainerLayout,
  inertLoopBodyNodes,
  isBodyEdge
} from '../lib/flowLayout'
import { homedir } from '../lib/homedir'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import { useChordLabel } from './ui/kbd'
import { ArrowLeft, Braces, ChartNoAxesColumn, ChevronRight, Info, ChevronDown, Download, Ellipsis, FolderGit2, FolderOpen, LayoutGrid, Play, Upload, Lock, LockOpen, Maximize, Minus, Trash2, X, GitBranch, GitFork, GitMerge, History, Plus, Repeat, SlidersHorizontal, Sparkles, Square, Store, Terminal, Timer, TriangleAlert, UserRoundCheck, Workflow, Zap, type LucideIcon } from 'lucide-react'
import { FlowSilhouette } from './FlowSilhouette'
import { VariableField } from './VariableField'
import {
  templateVariables,
  expressionVariables,
  declaredVars,
  type FlowVariable
} from '../lib/flowVariables'
import { preserveIfSame } from '../lib/stableEqual'
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNodeStatus,
  WorkflowNodeRunState,
  WorkflowInputVar,
  WorkflowNodeData,
  WorkflowExecutionRecord,
  ReviewRequest,
  SetVarSpec,
  WorkflowMetrics,
  WorkflowTrigger,
  MarketplaceIndex,
  MarketplaceEntry
} from '../../../shared/workflow-types'

// --- Constants ---
const AVAILABLE_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
  'Task', 'TaskCreate', 'TaskUpdate'
]

// --- Custom Node Components ---

/**
 * A node's colour, and only its colour.
 *
 * The idle canvas is entirely grey, so anything coloured here is the run
 * talking. Done keeps a neutral border on purpose: a finished flow should not be
 * eight glowing green boxes, so success is a dot. Skipped is opacity rather than
 * a colour, because a branch not taken is not something to act on.
 */
function statusChrome(status: WorkflowNodeStatus, selected?: boolean): string {
  const ring = selected ? ' ring-1 ring-foreground/30' : ''
  switch (status) {
    case 'running':
      return `border-info bg-info/5 shadow-[0_0_22px_-4px_var(--color-info)]${ring}`
    case 'failed':
      return `border-danger bg-danger/5${ring}`
    case 'awaiting_review':
      return `border-warning bg-warning/5${ring}`
    case 'skipped':
      return `border-border opacity-40${ring}`
    default:
      return `border-border${ring}`
  }
}

function statusDot(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'running':
      return 'bg-info'
    case 'done':
      return 'bg-success'
    case 'failed':
      return 'bg-danger'
    case 'awaiting_review':
      return 'bg-warning'
    default:
      return 'bg-muted-foreground/40'
  }
}

function statusText(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'running':
      return 'text-info'
    case 'done':
      return 'text-success'
    case 'failed':
      return 'text-danger'
    case 'awaiting_review':
      return 'text-warning'
    default:
      return 'text-muted-foreground/70'
  }
}

const HANDLE = 'bg-background! border-accent! border! w-[7px]! h-[7px]!'

/**
 * The line under a node's name.
 *
 * Config at rest, runtime facts during a run, in the same row. A node that has
 * run says how long it took and what it cost, which is the only thing worth
 * knowing once it is done.
 */
function nodeMeta(data: Record<string, unknown>, status: WorkflowNodeStatus, fallback: string): string {
  const started = data.startedAt as number | undefined
  const finished = data.finishedAt as number | undefined
  const tokens = data.tokens as { input: number; output: number } | undefined
  if (status === 'running') return started ? `running… ${Math.round((Date.now() - started) / 1000)}s` : 'running…'
  if (status === 'failed') return (data.output as string)?.split('\n')[0]?.slice(0, 34) || 'failed'
  if (status === 'skipped') return 'branch not taken'
  if (status === 'done' && started && finished) {
    const secs = ((finished - started) / 1000).toFixed(1)
    const tok = tokens ? ` · ${Math.round((tokens.input + tokens.output) / 100) / 10}k tok` : ''
    return `${secs}s${tok}`
  }
  return fallback
}

/** Work nodes: a prompt, a shell command, a call into another flow. */
function WorkNode({
  data,
  selected,
  icon: Icon,
  meta
}: NodeProps & { icon: LucideIcon; meta: string }): React.JSX.Element {
  const status: WorkflowNodeStatus = (data.status as WorkflowNodeStatus) || 'idle'
  const line = nodeMeta(data as Record<string, unknown>, status, meta)
  return (
    <div
      className={`w-[200px] rounded-[10px] border bg-card px-3 py-2.5 transition-colors ${statusChrome(status, selected)}`}
    >
      <Handle type="target" position={Position.Top} className={HANDLE} />
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12.5px] font-semibold text-foreground">
          {data.label as string}
        </span>
        <span className={`ml-auto size-1.5 shrink-0 rounded-full ${statusDot(status)}`} />
      </div>
      <div className={`mt-1 truncate font-mono text-[10px] ${statusText(status)}`} title={line}>
        {line}
      </div>
      <Handle type="source" position={Position.Bottom} className={HANDLE} />
    </div>
  )
}

/**
 * Routing nodes: punctuation, not work.
 *
 * Compact on purpose. A uniform card makes control flow invisible — you cannot
 * tell a fan-out from a Claude run without reading the label — so these carry a
 * different silhouette instead. They also show where the flow can go rather than
 * the expression that decides, which never fits and belongs in the inspector.
 */
function RoutingPill({
  data,
  selected,
  icon: Icon,
  meta,
  branches
}: NodeProps & { icon: LucideIcon; meta: string; branches?: [string, string] }): React.JSX.Element {
  const status: WorkflowNodeStatus = (data.status as WorkflowNodeStatus) || 'idle'
  return (
    <div
      className={`flex h-[34px] items-center gap-2 rounded-full border bg-muted px-3.5 transition-colors ${statusChrome(status, selected)}`}
    >
      <Handle type="target" position={Position.Top} className={HANDLE} />
      <Icon className={`size-3 shrink-0 ${statusText(status)}`} />
      <span className="truncate text-[12px] font-semibold text-foreground">
        {data.label as string}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground/70">{meta}</span>
      {branches ? (
        branches.map((id, i) => (
          <Handle
            key={id}
            id={id}
            type="source"
            position={Position.Bottom}
            style={{ left: i === 0 ? '30%' : '70%' }}
            className={HANDLE}
          />
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} className={HANDLE} />
      )}
    </div>
  )
}

/**
 * The only node that stops the run and waits for a person.
 *
 * The answer lives in the node rather than a modal, because the pause and the
 * decision are the same moment. It also sets this node apart without spending
 * one of the four status colours.
 */
function ReviewGate({ data, selected }: NodeProps): React.JSX.Element {
  const status: WorkflowNodeStatus = (data.status as WorkflowNodeStatus) || 'idle'
  const live = status === 'awaiting_review'
  return (
    <div
      className={`w-[200px] overflow-hidden rounded-[10px] border bg-card transition-colors ${statusChrome(status, selected)}`}
    >
      <Handle type="target" position={Position.Top} className={HANDLE} />
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <UserRoundCheck className="size-3.5 shrink-0 text-foreground" />
          <span className="truncate text-[12.5px] font-semibold text-foreground">
            {data.label as string}
          </span>
          <span className={`ml-auto size-1.5 shrink-0 rounded-full ${statusDot(status)}`} />
        </div>
        <div className={`mt-1 truncate font-mono text-[10px] ${statusText(status)}`}>
          {live ? 'waiting for you' : (data.message as string) || 'pauses for you'}
        </div>
      </div>
      <div className="flex gap-1.5 border-t border-border bg-muted px-3 py-2">
        <div
          className={`flex-1 rounded-[5px] py-1 text-center text-[10.5px] font-semibold ${
            live ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground/60'
          }`}
        >
          Approve
        </div>
        <div
          className={`flex-1 rounded-[5px] border border-border py-1 text-center text-[10.5px] font-semibold ${
            live ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
        >
          Reject
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className={HANDLE} />
    </div>
  )
}

/**
 * A loop, drawn as a box around what it repeats.
 *
 * Containment expresses the cycle, so nothing has to draw a return edge — and
 * there is none to draw: the engine returns when the body chain runs out, so any
 * line we drew would be a rendering of execution rather than data.
 *
 * A box holding one column also makes the no-branching rule visible. The engine
 * follows the first outgoing edge out of a body node and drops the rest, and
 * there is nowhere in here for a second branch to go.
 */
function LoopContainer({ data, selected }: NodeProps): React.JSX.Element {
  const status: WorkflowNodeStatus = (data.status as WorkflowNodeStatus) || 'idle'
  const iteration = data.iteration as number | undefined
  const max = (data.maxIterations as number) ?? 10
  const inert = (data.inertBody as string[]) ?? []
  const hasBody = (data.hasBody as boolean) ?? false

  return (
    <div
      className={`flex h-full w-full flex-col rounded-xl border bg-background/40 transition-colors ${statusChrome(status, selected)}`}
    >
      <Handle type="target" position={Position.Top} className={HANDLE} />
      <div className="flex h-9 items-center gap-1.5 px-3">
        <Repeat className={`size-3.5 shrink-0 ${statusText(status)}`} />
        <span className="truncate text-[12.5px] font-semibold text-foreground">
          {data.label as string}
        </span>
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-[1px] font-mono text-[9.5px] ${
            status === 'running' ? 'bg-info text-info-foreground' : 'bg-secondary text-foreground/70'
          }`}
        >
          {iteration ?? 0} / {max}
        </span>
      </div>

      {/* Body nodes are React Flow children, so this is just the well they sit in. */}
      <div className="flex flex-1 items-center justify-center px-3">
        {hasBody ? null : (
          <span className="rounded-md border border-dashed border-border px-3 py-2 text-[10.5px] text-muted-foreground/70">
            Wire a node to the body handle
          </span>
        )}
      </div>

      <div className="flex h-[30px] items-center gap-1.5 rounded-b-[11px] border-t border-border bg-muted px-3">
        {inert.length > 0 ? (
          <>
            <TriangleAlert className="size-3 shrink-0 text-warning" />
            <span className="truncate font-mono text-[9.5px] text-warning" title={inert.join(', ')}>
              {inert.length === 1
                ? `put ${inert[0]} in a subworkflow to fan out`
                : `put ${inert.length} nodes in a subworkflow to fan out`}
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 text-[9.5px] text-muted-foreground/70">while</span>
            <span className="truncate font-mono text-[9.5px] text-foreground/70">
              {(data.condition as string) || 'always'}
            </span>
          </>
        )}
      </div>
      {/* With the body enclosed there is nothing left for a second body edge to
          say, so `exit` takes the spine on its own. An empty loop keeps both, or
          there would be no way to wire one. */}
      {hasBody ? null : (
        <Handle
          id="body"
          type="source"
          position={Position.Bottom}
          style={{ left: '30%' }}
          className={HANDLE}
        />
      )}
      <Handle
        id="exit"
        type="source"
        position={Position.Bottom}
        style={{ left: hasBody ? '50%' : '70%' }}
        className={HANDLE}
      />
    </div>
  )
}

/**
 * What the run is doing, in one line of the header.
 *
 * The canvas shows where a run is; this says how far along it is without you
 * counting boxes, which stops working the moment a flow is taller than the
 * pane. On a failure it names the node that failed, because "something went
 * wrong" is the least useful thing a header can say.
 */
function RunStatusChip({
  status,
  done,
  total,
  startedAt,
  finishedAt,
  runningLabel,
  failedLabel
}: {
  status: 'running' | 'done' | 'failed' | 'aborted'
  done: number
  total: number
  startedAt?: number
  finishedAt?: number
  runningLabel?: string
  failedLabel?: string
}): React.JSX.Element {
  // Re-render once a second while running so the elapsed time actually ticks.
  const [, force] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [status])

  const elapsed = startedAt ? duration((finishedAt ?? Date.now()) - startedAt) : null
  const tone =
    status === 'failed'
      ? 'border-danger/40 bg-danger/10 text-danger'
      : status === 'running'
        ? 'border-info/40 bg-info/10 text-info'
        : status === 'aborted'
          ? 'border-border bg-muted text-muted-foreground'
          : 'border-success/40 bg-success/10 text-success'

  const text =
    status === 'running'
      ? `${runningLabel ? `${runningLabel} · ` : ''}${done} of ${total}`
      : status === 'failed'
        ? `Failed${failedLabel ? ` at ${failedLabel}` : ''}`
        : status === 'aborted'
          ? 'Stopped'
          : `Done · ${done} of ${total}`

  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[0.77em] font-medium ${tone}`}
    >
      {status === 'running' ? (
        <span className="size-1.5 animate-pulse rounded-full bg-info" />
      ) : null}
      <span className="max-w-[180px] truncate">{text}</span>
      {elapsed ? <span className="font-mono opacity-70">{elapsed}</span> : null}
    </div>
  )
}

const edgeTypes: EdgeTypes = { flow: FlowPulseEdge }

const nodeTypes: NodeTypes = {
  prompt: (p: NodeProps) => (
    <WorkNode {...p} icon={Sparkles} meta={(p.data.model as string) || 'default model'} />
  ),
  script: (p: NodeProps) => (
    <WorkNode {...p} icon={Terminal} meta={(p.data.command as string) || 'no command'} />
  ),
  subworkflow: (p: NodeProps) => (
    <WorkNode {...p} icon={Workflow} meta={(p.data.childName as string) || 'no flow chosen'} />
  ),
  condition: (p: NodeProps) => (
    <RoutingPill {...p} icon={GitBranch} meta="yes · no" branches={['yes', 'no']} />
  ),
  parallel: (p: NodeProps) => <RoutingPill {...p} icon={GitFork} meta="fan out" />,
  join: (p: NodeProps) => <RoutingPill {...p} icon={GitMerge} meta="waits for all" />,
  loop: LoopContainer,
  humanReview: ReviewGate
}

// --- Converters between WorkflowDefinition and React Flow format ---

function toFlowNodes(
  wfNodes: WorkflowNode[],
  nodeStates: Record<string, WorkflowNodeRunState>,
  workflowsById?: Map<string, string>,
  wfEdges: WorkflowEdge[] = []
): Node[] {
  // Containment is derived, never stored: a body is whatever the `body` handle
  // reaches, which is the same walk the engine makes.
  const parents = bodyMembership(wfNodes, wfEdges)
  const inertByLoop = new Map<string, string[]>()
  for (const loop of wfNodes.filter((x) => x.data.type === 'loop')) {
    const inert = inertLoopBodyNodes(loop.id, wfNodes, wfEdges).map((x) => x.label)
    if (inert.length > 0) inertByLoop.set(loop.id, inert)
  }
  // Sized by the same function that places the body, so a container can never be
  // a row too short for what it holds.
  const sized = new Map(
    wfNodes
      .filter((x) => x.data.type === 'loop')
      .map((loop) => {
        const { body, size } = loopContainerLayout(loop.id, wfNodes, wfEdges, parents)
        return [loop.id, { size, hasBody: body.length > 0 }] as const
      })
  )

  const ordered = [...wfNodes].sort((a, b) => {
    // React Flow needs a parent before its children in the array.
    const ap = parents.has(a.id) ? 1 : 0
    const bp = parents.has(b.id) ? 1 : 0
    return ap - bp
  })

  return ordered.map((n) => {
    const d = n.data
    const st = nodeStates[n.id]
    const base = {
      label: n.label,
      status: st?.status ?? 'idle',
      output: st?.output ?? '',
      iteration: st?.iteration,
      // Carried so a finished node can say how long it took and what it cost
      // without the node having to reach into the store itself.
      startedAt: st?.startedAt,
      finishedAt: st?.finishedAt,
      tokens: st?.tokens
    }
    let extra: Record<string, unknown> = {}
    if (d.type === 'prompt') {
      extra = {
        prompt: d.prompt,
        model: d.model,
        systemPrompt: d.systemPrompt,
        allowedTools: d.allowedTools,
        setVars: d.setVars
      }
    } else if (d.type === 'condition') extra = { expression: d.expression }
    else if (d.type === 'script') extra = { command: d.command }
    else if (d.type === 'join') extra = { separator: d.separator }
    else if (d.type === 'loop') extra = { condition: d.condition, maxIterations: d.maxIterations }
    else if (d.type === 'humanReview') extra = { message: d.message }
    else if (d.type === 'subworkflow') {
      extra = {
        workflowId: d.workflowId,
        inputMapping: d.inputMapping,
        captureVars: d.captureVars,
        childName: workflowsById?.get(d.workflowId) ?? ''
      }
    }
    const parentId = parents.get(n.id)
    const box = sized.get(n.id)
    return {
      id: n.id,
      type: d.type,
      position: n.position,
      selected: false,
      ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      ...(box ? { style: box.size } : {}),
      data: {
        ...base,
        ...extra,
        ...(box ? { hasBody: box.hasBody } : {}),
        ...(inertByLoop.has(n.id) ? { inertBody: inertByLoop.get(n.id) } : {})
      }
    }
  })
}

/**
 * Edges React Flow should draw.
 *
 * A loop's `body` edge is dropped when the body is nested inside it: the target
 * sits *within* the container, so the line left the box at the bottom and turned
 * back up into its own interior. Containment already says what that edge said,
 * which is the whole reason the container won over drawing the cycle.
 */
function toFlowEdges(wfEdges: WorkflowEdge[], wfNodes: WorkflowNode[] = []): Edge[] {
  const parents = bodyMembership(wfNodes, wfEdges)
  const drawn = wfEdges.filter((e) => !(isBodyEdge(e) && parents.get(e.target) === e.source))
  return drawn.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || undefined,
    label: e.label || undefined,
    // Orthogonal rather than bezier: a fan-out spans far further sideways than
    // it drops, and a curve at that ratio flattens into a horizontal sweep
    // across the row below. An elbow makes the branch point a place instead.
    type: 'flow',
    data: { active: false }
  }))
}

/**
 * Which edges are carrying execution right now, and which lead nowhere.
 *
 * An edge is live when the node it feeds is running: that is exactly the moment
 * output is travelling down it. A fan-out lights all three of its branches,
 * which is honest, because all three really are running.
 */
function withRunState(
  edges: Edge[],
  nodeStates: Record<string, WorkflowNodeRunState>
): Edge[] {
  return edges.map((e) => {
    const active = nodeStates[e.target]?.status === 'running'
    const skipped = nodeStates[e.target]?.status === 'skipped'
    const style = skipped ? { '--flow-edge-stroke': 'var(--color-border)' } : undefined
    const unchanged =
      Boolean(e.data?.active) === active && Boolean(e.style) === Boolean(style)
    return unchanged ? e : { ...e, data: { ...e.data, active }, style: style as React.CSSProperties }
  })
}

function fromFlowNodes(nodes: Node[]): WorkflowNode[] {
  return nodes.map((n) => {
    const t = n.type as string
    let data: WorkflowNodeData
    if (t === 'prompt') {
      data = {
        type: 'prompt',
        prompt: (n.data.prompt as string) || '',
        systemPrompt: (n.data.systemPrompt as string) || undefined,
        model: (n.data.model as string) || undefined,
        allowedTools: (n.data.allowedTools as string[]) || undefined,
        setVars: (n.data.setVars as SetVarSpec[]) || undefined
      }
    } else if (t === 'condition') {
      data = { type: 'condition', expression: (n.data.expression as string) || '' }
    } else if (t === 'script') {
      data = {
        type: 'script',
        command: (n.data.command as string) || '',
        // Carried through explicitly. This rebuilds node data field by field, so
        // anything not named here is dropped on the next save — a flow that
        // waits on a build would quietly go back to the default timeout the
        // first time someone opened it on the canvas.
        timeoutMs: (n.data.timeoutMs as number) || undefined
      }
    } else if (t === 'parallel') {
      data = { type: 'parallel' }
    } else if (t === 'join') {
      data = { type: 'join', separator: (n.data.separator as string) || undefined }
    } else if (t === 'loop') {
      data = {
        type: 'loop',
        condition: (n.data.condition as string) || '',
        maxIterations: (n.data.maxIterations as number) ?? 10
      }
    } else if (t === 'humanReview') {
      data = { type: 'humanReview', message: (n.data.message as string) || undefined }
    } else if (t === 'subworkflow') {
      data = {
        type: 'subworkflow',
        workflowId: (n.data.workflowId as string) || '',
        inputMapping: (n.data.inputMapping as Record<string, string>) || undefined,
        captureVars: (n.data.captureVars as string[]) || undefined
      }
    } else {
      data = { type: 'prompt', prompt: '' }
    }
    return {
      id: n.id,
      label: (n.data.label as string) || n.id,
      position: n.position,
      data
    }
  })
}

function fromFlowEdges(edges: Edge[]): WorkflowEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: (e.sourceHandle as string) || undefined,
    label: (e.label as string) || (e.sourceHandle as string) || undefined
  }))
}

/**
 * The inspector while a run is happening, or once one has finished.
 *
 * At rest the right-hand panel configures a node. During a run it becomes the
 * run: a timeline of every node with its duration, so you know where execution
 * is without scanning a graph that may be taller than the pane. Selecting a node
 * hands the panel back to config for that node.
 */
/**
 * What the run is doing, and what each step said.
 *
 * The output of every node used to be listed under the timeline as well as in
 * it, which meant reading the same thing twice down a narrow panel. Now the top
 * carries only the step in flight, and each timeline row opens to show its own
 * output in place.
 */
function RunPanel(): React.JSX.Element | null {
  const { currentWorkflow, execution, setSelectedNodeId } = useWorkflowStore()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [, force] = useState(0)
  useEffect(() => {
    if (execution?.status !== 'running') return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [execution?.status])

  if (!currentWorkflow || !execution || execution.status === 'idle') return null

  const states = Object.values(execution.nodeStates)
  const total = sumTokens(states)
  const failed = states.find((ns) => ns.status === 'failed')
  const failedNode = failed ? currentWorkflow.nodes.find((n) => n.id === failed.nodeId) : null
  const fix = failed?.error && failedNode ? suggestFix(failed.error, failedNode) : null
  const running = states.find((ns) => ns.status === 'running')
  const live = running ? currentWorkflow.nodes.find((n) => n.id === running.nodeId) : null

  // The step the run is on: whatever is running, or the last thing that spoke
  // once it is over. One row that replaces itself, not a growing list — the
  // per-step detail is behind its own timeline row.
  const withState = currentWorkflow.nodes
    .map((node) => ({ node, state: execution.nodeStates[node.id] }))
    .filter(
      (x): x is { node: (typeof currentWorkflow.nodes)[number]; state: WorkflowNodeRunState } =>
        Boolean(x.state)
    )
  const current =
    withState.find((x) => x.state.status === 'running') ??
    [...withState].reverse().find((x) => x.state.output || x.state.error)
  // The engine sends a node's output when it finishes, not as it goes, so the
  // running step has nothing of its own to show. Carry the last thing the run
  // said rather than a placeholder.
  const lastSaid = [...withState].reverse().find((x) => x.state.output || x.state.error)

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/55 bg-card">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/55 px-4">
        <span className="text-[0.92em] font-semibold text-foreground">Run</span>
        <span className="font-mono text-[0.77em] text-muted-foreground">
          {total > 0 ? `${tokenCount(total)} tok` : ''}
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {failed?.error ? (
          <div className="rounded-md border border-danger/40 bg-danger/5 p-2.5">
            <div className="mb-1 text-[0.77em] font-semibold text-danger">
              {failedNode?.label ?? 'A node'} failed
            </div>
            <pre className="mb-2 max-h-28 overflow-y-auto whitespace-pre-wrap wrap-break-word font-mono text-[0.77em] text-muted-foreground">
              {failed.error}
            </pre>
            {fix ? (
              <button
                onClick={() => setSelectedNodeId(failed.nodeId)}
                className="w-full rounded-[5px] bg-foreground px-2 py-1 text-[0.81em] font-semibold text-background"
              >
                {fix.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Where the run is, in one line. The step's name is already on the
            timeline row this opens, so the row itself is just the output. */}
        {current ? (
          <div>
            <div className="mb-1 text-[0.77em] font-medium text-muted-foreground">Summary</div>
            <button
              type="button"
              onClick={() => toggle(current.node.id)}
              aria-label={`Show ${current.node.label} output`}
              className="flex w-full items-center gap-2 rounded-md border border-border/55 bg-sidebar px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  current.state.status === 'running'
                    ? 'animate-pulse bg-info'
                    : statusDot(current.state.status)
                }`}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.73em] text-muted-foreground">
                {firstLine(current.state.output || current.state.error) ||
                  firstLine(lastSaid?.state.output || lastSaid?.state.error)}
              </span>
            </button>
          </div>
        ) : null}

        <div>
          <div className="mb-1 text-[0.77em] font-medium text-muted-foreground">Timeline</div>
          <div className="space-y-px">
            {currentWorkflow.nodes.map((n) => {
              const st = execution.nodeStates[n.id]
              const status = st?.status ?? 'idle'
              const ms =
                st?.startedAt && (st.finishedAt || status === 'running')
                  ? (st.finishedAt ?? Date.now()) - st.startedAt
                  : null
              const tok = st?.tokens ? sumTokens([st]) : 0
              const text = st?.output || st?.error || ''
              const expanded = open.has(n.id)
              return (
                <div key={n.id}>
                  <div className="flex w-full items-center gap-2 rounded-[5px] px-1.5 py-1 hover:bg-accent/50">
                    <button
                      type="button"
                      onClick={() => (text ? toggle(n.id) : setSelectedNodeId(n.id))}
                      aria-label={text ? `${expanded ? 'Hide' : 'Show'} ${n.label} output` : n.label}
                      aria-expanded={text ? expanded : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {/* The chevron only appears once there is something behind
                          it, so an idle row does not promise output it has not
                          produced. */}
                      {text ? (
                        <ChevronRight
                          className={`size-3 shrink-0 text-muted-foreground/70 transition-transform ${
                            expanded ? 'rotate-90' : ''
                          }`}
                        />
                      ) : (
                        <span className="size-3 shrink-0" />
                      )}
                      <span className={`size-1.5 shrink-0 rounded-full ${statusDot(status)}`} />
                      <span
                        className={`min-w-0 flex-1 truncate text-[0.85em] ${
                          status === 'idle' ? 'text-muted-foreground/60' : 'text-foreground'
                        }`}
                      >
                        {n.label}
                      </span>
                    </button>
                    {tok > 0 ? (
                      <span className="shrink-0 font-mono text-[0.7em] text-muted-foreground/70">
                        {tokenCount(tok)}
                      </span>
                    ) : null}
                    <span className="w-11 shrink-0 text-right font-mono text-[0.73em] text-muted-foreground">
                      {ms !== null ? duration(ms) : ''}
                    </span>
                  </div>
                  {expanded && text ? (
                    <div className="mt-1 mb-1.5 ml-[26px]">
                      <div className="max-h-40 overflow-y-auto rounded-md border border-border/55 bg-sidebar p-2.5">
                        <pre className="whitespace-pre-wrap wrap-break-word font-mono text-[0.77em] text-muted-foreground">
                          {text}
                        </pre>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedNodeId(n.id)}
                        className="mt-1 text-[0.73em] text-muted-foreground transition-colors hover:text-foreground/80"
                      >
                        Open this node
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Node Config Panel ---

/** The uppercase caption over every inspector field. */
function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-1.5 block text-[0.7em] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[0.73em] text-muted-foreground/70">{hint}</p> : null}
    </div>
  )
}

/**
 * An explainer in the inspector.
 *
 * These were loose paragraphs of muted text sitting between form fields, so a
 * long one — the loop's, three sentences about body, exit and branching — read
 * as a wall dropped into the middle of a form. A bordered block with an icon
 * says "this is background, not a control" at a glance, and lets the eye skip
 * it once it has been read.
 *
 * Deliberately achromatic. The canvas spends its accents on run status, and
 * nothing here is a status — an amber panel would imply something is wrong.
 */
function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2 rounded-md border border-border/55 bg-muted/40 px-2.5 py-2">
      <Info className="mt-[2px] size-3 shrink-0 text-muted-foreground/70" />
      <div className="min-w-0 space-y-1.5 text-[0.77em] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  )
}

/**
 * A select for the inspector.
 *
 * The panel used bare `<select>` elements, whose dropdown is drawn by the OS —
 * a light system menu over a dark app, unstyleable and unable to carry the
 * descriptions these options want. This is the repo's own Radix primitive,
 * which was sitting in `ui/select.tsx` unused.
 */
function ChoiceSelect({
  value,
  onChange,
  disabled,
  options,
  mono = false
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  options: { value: string; label: string; hint?: string }[]
  mono?: boolean
}): React.JSX.Element {
  // The trigger shows the label alone. `SelectItem` wraps everything it is
  // given in `ItemText`, and `SelectValue` echoes that into the trigger — so an
  // option with a description underneath rendered both lines inside the closed
  // control, jammed against its edges. Passing children to `SelectValue`
  // overrides that echo; the hint then exists only in the open menu.
  const selected = options.find((o) => o.value === value)

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={`h-7 w-full bg-sidebar text-[0.92em] ${mono ? 'font-mono' : ''}`}
      >
        <SelectValue>{selected?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            className={`py-1.5 ${mono ? 'font-mono' : ''}`}
          >
            <span className="flex flex-col items-start gap-0.5">
              <span className="leading-none">{o.label}</span>
              {o.hint ? (
                <span className="font-sans text-[0.9em] leading-none text-muted-foreground">
                  {o.hint}
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The three names in scope inside a `condition` or `loop` expression.
 *
 * Shown under both, because the expression box is otherwise a blank field with
 * no clue what it may refer to.
 */
function ExpressionVars(): React.JSX.Element {
  return (
    <span className="font-mono">
      In scope: <code className="text-foreground/70">output</code>,{' '}
      <code className="text-foreground/70">vars</code>,{' '}
      <code className="text-foreground/70">iteration</code>
    </span>
  )
}

/**
 * Inspector controls.
 *
 * Neutral focus rather than the blue the old panel used: on this canvas colour
 * means run status, and a focused text box is not a status.
 */
/**
 * What a script node gets, and the most it can ask for.
 *
 * Mirrors `SCRIPT_TIMEOUT` and `SCRIPT_TIMEOUT_MAX` in `workflow/engine.rs`,
 * which is the authority. Duplicated rather than plumbed through because these
 * are copy in a hint, and a hint that drifts by a factor of two is still a
 * better hint than none — a test pins them to the Rust constants.
 */
const SCRIPT_TIMEOUT_SECONDS = 120
const SCRIPT_TIMEOUT_MAX_SECONDS = 3600

const CTL =
  'w-full rounded-md border border-border bg-sidebar px-2.5 py-1.5 text-[0.92em] text-foreground transition-colors focus:border-border-strong focus:outline-hidden disabled:opacity-50'
const CTL_MONO = `${CTL} font-mono resize-none leading-relaxed text-[0.85em]`

function NodeConfigPanel({ onDelete }: { onDelete?: () => void }): React.JSX.Element | null {
  const { selectedNodeId, setSelectedNodeId, currentWorkflow, updateCurrentWorkflow, execution } =
    useWorkflowStore()

  if (!selectedNodeId || !currentWorkflow) return null

  const node = currentWorkflow.nodes.find((n) => n.id === selectedNodeId)
  if (!node) return null

  const nodeState = execution?.nodeStates[selectedNodeId]
  const isRunning = execution?.status === 'running'

  const updateNodeData = (patch: Record<string, unknown>): void => {
    const updatedNodes = currentWorkflow.nodes.map((n) =>
      n.id === selectedNodeId
        ? { ...n, data: { ...n.data, ...patch } as typeof n.data }
        : n
    )
    updateCurrentWorkflow({ nodes: updatedNodes })
  }

  const updateNodeLabel = (label: string): void => {
    const updatedNodes = currentWorkflow.nodes.map((n) =>
      n.id === selectedNodeId ? { ...n, label } : n
    )
    updateCurrentWorkflow({ nodes: updatedNodes })
  }

  const nodeTypeLabel = node.data.type === 'subworkflow' ? 'SUB-FLOW' : node.data.type.toUpperCase()
  const typeColor =
    node.data.type === 'prompt' ? 'bg-info/15 text-info'
      : node.data.type === 'condition' ? 'bg-warning/15 text-warning'
        : node.data.type === 'script' ? 'bg-info/15 text-info'
          : node.data.type === 'parallel' || node.data.type === 'join' ? 'bg-muted-foreground/15 text-muted-foreground'
            : node.data.type === 'loop' ? 'bg-muted-foreground/15 text-muted-foreground'
              : node.data.type === 'subworkflow' ? 'bg-info/15 text-info'
                : 'bg-warning/15 text-warning'

  // A run the panel could return to: anything but idle, including a finished
  // one, because reading outputs after the fact is the common case.
  const duringRun = Boolean(execution && execution.status !== 'idle')

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border/55 bg-card">
      {/* Header */}
      <div className="flex h-11 items-center gap-2 border-b border-border/55 pl-2 pr-4">
        {/* During a run this panel is reached by clicking a timeline row, and
            deselecting was the only way back to the run — which is not a thing
            anyone guesses. With no run in progress there is nothing behind it,
            so the arrow stays away and the title keeps the space. */}
        {duringRun ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setSelectedNodeId(null)}
                aria-label="Back to the run"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
              >
                <ArrowLeft className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Back to the run</TooltipContent>
          </Tooltip>
        ) : null}
        <span
          className={`min-w-0 flex-1 truncate text-[0.92em] font-semibold text-foreground ${
            duringRun ? '' : 'pl-2'
          }`}
        >
          {node.label}
        </span>
        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.62em] font-bold ${typeColor}`}>
          {nodeTypeLabel}
        </span>
        {/* Reached in context rather than from the toolbar, which is where it
            used to sit next to controls that act on the whole flow. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onDelete?.()}
              disabled={isRunning}
              aria-label="Delete this node"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete this node</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setSelectedNodeId(null)}
              aria-label="Close the inspector"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Name */}
        <Field label="Name">
          <input
            value={node.label}
            onChange={(e) => updateNodeLabel(e.target.value)}
            disabled={isRunning}
            className={CTL}
          />
        </Field>

        {/* Prompt-specific fields */}
        {node.data.type === 'prompt' && (
          <PromptNodeConfig
            node={node.data}
            update={updateNodeData}
            disabled={isRunning}
            variables={templateVariables(currentWorkflow)}
          />
        )}

        {/* Condition-specific fields */}
        {node.data.type === 'condition' && (
          <Field label="Expression" hint={<ExpressionVars />}>
            <VariableField
              mode="expression"
              ariaLabel="Expression"
              value={node.data.expression}
              onChange={(expression) => updateNodeData({ expression })}
              variables={expressionVariables(currentWorkflow)}
              disabled={isRunning}
              placeholder="output.includes('PASS')"
              minHeight={56}
              maxHeight={180}
              autoGrow
            />
          </Field>
        )}

        {/* Script-specific fields */}
        {node.data.type === 'script' && (
          <>
            <Field label="Command" hint="Runs through sh -c in the flow's working directory.">
              <VariableField
                mode="shell"
                ariaLabel="Command"
                value={node.data.command}
                onChange={(command) => updateNodeData({ command })}
                variables={templateVariables(currentWorkflow)}
                disabled={isRunning}
                placeholder="npm test"
                minHeight={56}
                maxHeight={200}
                autoGrow
              />
            </Field>
            {/* The field existed in the data and nowhere in this panel, so the
                only way to give a node longer was to hand-edit the JSON. A
                release flow's build node therefore inherited the two-minute
                default meant for a guard, and reported a failure fifteen
                minutes before the build it had started actually finished. */}
            <Field
              label="Timeout"
              hint={`Seconds before the script is stopped. Blank uses ${SCRIPT_TIMEOUT_SECONDS}s, which suits a guard or a summary — anything that waits on a build or a deploy needs more. Up to ${SCRIPT_TIMEOUT_MAX_SECONDS}s.`}
            >
              <input
                type="number"
                min={1}
                max={SCRIPT_TIMEOUT_MAX_SECONDS}
                value={
                  node.data.timeoutMs === undefined ? '' : Math.round(node.data.timeoutMs / 1000)
                }
                onChange={(e) => {
                  const seconds = parseInt(e.target.value, 10)
                  updateNodeData({
                    // Blank means "use the default", which is not the same as
                    // zero and must not become it.
                    timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
                  })
                }}
                disabled={isRunning}
                placeholder={String(SCRIPT_TIMEOUT_SECONDS)}
                className={`${CTL} font-mono`}
              />
            </Field>
          </>
        )}

        {/* Parallel: no config */}
        {node.data.type === 'parallel' && (
          <Note>
            <p>
              Nothing to configure. Every edge leaving this node becomes a branch, and they all
              run at once.
            </p>
            <p>
              Put a <span className="text-foreground/80">Join</span> downstream to wait for them
              and merge their output.
            </p>
          </Note>
        )}

        {/* Join: separator */}
        {node.data.type === 'join' && (
          <Field
            label="Separator"
            hint="Placed between branch outputs. Join waits for every incoming edge, so a branch that gets skipped leaves it waiting."
          >
            <input
              value={node.data.separator ?? ''}
              placeholder={'\\n\\n---\\n\\n'}
              onChange={(e) => updateNodeData({ separator: e.target.value })}
              disabled={isRunning}
              className={`${CTL} font-mono text-[0.85em]`}
            />
          </Field>
        )}

        {/* Loop: condition + maxIterations */}
        {node.data.type === 'loop' && (
          <>
            <Field label="Continue while" hint={<ExpressionVars />}>
              <VariableField
                mode="expression"
                ariaLabel="Continue while"
                value={node.data.condition}
                onChange={(condition) => updateNodeData({ condition })}
                variables={expressionVariables(currentWorkflow)}
                disabled={isRunning}
                placeholder="(vars.score | 0) < 8"
                minHeight={56}
                maxHeight={180}
                autoGrow
              />
            </Field>
            <Field label="Max iterations" hint="The backstop. The loop stops here even if the condition still holds.">
              <input
                type="number"
                min={1}
                max={1000}
                value={node.data.maxIterations}
                onChange={(e) => updateNodeData({ maxIterations: parseInt(e.target.value, 10) || 1 })}
                disabled={isRunning}
                className={`${CTL} font-mono`}
              />
            </Field>
            {/* Describes what the canvas actually draws. The previous copy —
                "body handle (bottom) … exit handle (right)" — survived from the
                left-to-right layout: nothing has a right-hand handle any more,
                and once a loop has a body it is enclosed in the container, so
                there is no body handle on screen at all. */}
            <Note>
              <p>
                Nodes inside the box are the <span className="text-foreground/80">body</span> —
                they run top to bottom, once per iteration.
              </p>
              <p>
                The handle below the box is <span className="text-foreground/80">exit</span>. It
                runs once, after the loop stops.
              </p>
              <p>
                A body is a single chain and cannot branch. To fan out, call a subworkflow from
                inside it.
              </p>
            </Note>
          </>
        )}

        {/* Sub-workflow */}
        {node.data.type === 'subworkflow' && (
          <SubworkflowNodeConfig
            node={node.data}
            currentWorkflowId={currentWorkflow.id}
            update={updateNodeData}
            disabled={isRunning}
          />
        )}

        {/* Human review */}
        {node.data.type === 'humanReview' && (
          <Field
            label="Message for reviewer"
            hint="Pauses the run. Approve continues; Reject ends this branch. Inside a loop body it asks on every iteration."
          >
            <textarea
              value={node.data.message ?? ''}
              onChange={(e) => updateNodeData({ message: e.target.value })}
              disabled={isRunning}
              rows={3}
              placeholder="What should the reviewer check?"
              className={`${CTL} resize-none text-[0.85em] leading-relaxed`}
            />
          </Field>
        )}

        {/* Output display */}
        {nodeState && (nodeState.status === 'done' || nodeState.status === 'failed' || nodeState.status === 'running') && (
          <Field label="Output">
            <div className="bg-sidebar border border-border/55 rounded-md p-2.5 max-h-40 overflow-y-auto">
              {nodeState.status === 'running' && (
                <div className="flex items-center gap-1.5 mb-1">
                  <div className="w-1.5 h-1.5 bg-info rounded-full animate-pulse" />
                  <span className="text-[0.7em] text-info font-mono">Streaming output...</span>
                </div>
              )}
              <pre className="text-[0.77em] text-muted-foreground font-mono whitespace-pre-wrap wrap-break-word">
                {nodeState.output || nodeState.error || '(no output)'}
              </pre>
            </div>
          </Field>
        )}
      </div>
    </div>
  )
}

function PromptNodeConfig({
  node,
  update,
  disabled,
  variables
}: {
  node: Extract<WorkflowNodeData, { type: 'prompt' }>
  update: (patch: Record<string, unknown>) => void
  disabled: boolean
  /** Everything `{{ }}` can name here, gathered from the whole flow. */
  variables: FlowVariable[]
}): React.JSX.Element {
  const allowedTools = node.allowedTools ?? []
  const unusedTools = AVAILABLE_TOOLS.filter((t) => !allowedTools.includes(t))
  const setVars = node.setVars ?? []

  const toggleTool = (tool: string): void => {
    const current = new Set(allowedTools)
    if (current.has(tool)) current.delete(tool)
    else current.add(tool)
    update({ allowedTools: current.size === 0 ? undefined : Array.from(current) })
  }

  const addSetVar = (): void => {
    update({ setVars: [...setVars, { name: '', extractor: '' }] })
  }
  const updateSetVar = (i: number, patch: Partial<SetVarSpec>): void => {
    const next = setVars.map((v, idx) => (idx === i ? { ...v, ...patch } : v))
    update({ setVars: next })
  }
  const removeSetVar = (i: number): void => {
    const next = setVars.filter((_, idx) => idx !== i)
    update({ setVars: next.length === 0 ? undefined : next })
  }

  return (
    <>
      <Field label="Model">
        <ChoiceSelect
          mono
          value={node.model || 'default'}
          onChange={(v) => update({ model: v === 'default' ? undefined : v })}
          disabled={disabled}
          options={[
            { value: 'default', label: 'default', hint: "Whatever the chat is set to" },
            { value: 'opus', label: 'opus', hint: 'Deepest reasoning, slowest' },
            { value: 'sonnet', label: 'sonnet', hint: 'The balanced default' },
            { value: 'haiku', label: 'haiku', hint: 'Fast and cheap, for gathering' }
          ]}
        />
      </Field>
      <Field
        label="Prompt"
        hint={
          <span className="font-mono">
            <code className="text-foreground/70">{'{{prev.output}}'}</code>,{' '}
            <code className="text-foreground/70">{'{{input.key}}'}</code>,{' '}
            <code className="text-foreground/70">{'{{vars.name}}'}</code>
          </span>
        }
      >
        <VariableField
          mode="template"
          ariaLabel="Prompt"
          value={node.prompt}
          onChange={(prompt) => update({ prompt })}
          variables={variables}
          disabled={disabled}
          placeholder="What should this node do?"
          minHeight={148}
          resizable
        />
      </Field>
      <Field label="System prompt" hint="Optional. This node runs with fresh context, so it carries nothing from the chat.">
        <VariableField
          mode="template"
          ariaLabel="System prompt"
          value={node.systemPrompt || ''}
          onChange={(v) => update({ systemPrompt: v || undefined })}
          variables={variables}
          disabled={disabled}
          minHeight={56}
          maxHeight={200}
          autoGrow
        />
      </Field>

      {/* Allowed tools — the chosen ones, as chips you can take off, and a `+`
          for the rest. A grid of every tool made the common case (two or three
          chosen) the hardest one to read. */}
      <Field
        label="Allowed tools"
        hint={
          allowedTools.length === 0
            ? 'Every tool is allowed. Add one to restrict this node to only those.'
            : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-1">
          {allowedTools.map((tool) => (
            <span
              key={tool}
              className="flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.77em] text-foreground/80"
            >
              {tool}
              <button
                type="button"
                onClick={() => toggleTool(tool)}
                disabled={disabled}
                aria-label={`Remove ${tool}`}
                className="text-muted-foreground hover:text-danger disabled:opacity-40"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
          {unusedTools.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={disabled}
                aria-label="Allow another tool"
                className="flex size-5 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground/80 disabled:opacity-40"
              >
                <Plus className="size-2.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {unusedTools.map((tool) => (
                  <DropdownMenuItem key={tool} onSelect={() => toggleTool(tool)}>
                    <span className="font-mono text-[0.85em]">{tool}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </Field>

      {/* One noun for this across the whole app: a variable. The label used to
          say "Capture output" while the panel listing the results said
          "Variables", so the two surfaces named the same thing differently and
          nothing said they were connected. */}
      <Field
        label="Save as variable"
        hint={
          setVars.length === 0 ? (
            'Every node runs with fresh context. Name a variable here and later nodes can read it; without one, only the very next node sees this output.'
          ) : setVars[0]?.name ? (
            <>
              Later nodes read it as{' '}
              <code className="font-mono text-foreground/70">{`{{vars.${setVars[0].name}}}`}</code>
            </>
          ) : (
            'Give it a name to finish it.'
          )
        }
      >
        <div className="space-y-1">
          {setVars.map((v, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                value={v.name}
                placeholder="variable_name"
                onChange={(e) =>
                  updateSetVar(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })
                }
                disabled={disabled}
                className={`${CTL} flex-1 font-mono`}
              />
              <div className="w-[96px] shrink-0">
                <ChoiceSelect
                  mono
                  value={extractorKind(v.extractor)}
                  onChange={(kind) => updateSetVar(i, { extractor: extractorTemplate(kind) })}
                  disabled={disabled}
                  options={[
                    { value: 'raw', label: 'raw', hint: 'The whole output' },
                    { value: 'json', label: 'json', hint: 'A field, by path' },
                    { value: 'regex', label: 'regex', hint: 'First capture group' },
                    { value: 'lines', label: 'lines', hint: 'A line range' }
                  ]}
                />
              </div>
              <button
                type="button"
                onClick={() => removeSetVar(i)}
                disabled={disabled}
                aria-label="Remove this variable"
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-danger disabled:opacity-40"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {setVars.some((v) => extractorKind(v.extractor) !== 'raw') ? (
            setVars.map((v, i) =>
              extractorKind(v.extractor) === 'raw' ? null : (
                <input
                  key={`arg-${i}`}
                  value={v.extractor}
                  onChange={(e) => updateSetVar(i, { extractor: e.target.value })}
                  disabled={disabled}
                  placeholder="json:path.to.field"
                  className={`${CTL_MONO}`}
                />
              )
            )
          ) : null}
          <button
            type="button"
            onClick={addSetVar}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1 text-[0.77em] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground/80 disabled:opacity-40"
          >
            <Plus className="size-2.5" />
            Capture a variable
          </button>
        </div>
      </Field>
    </>
  )
}

/** Radix treats '' as "nothing selected", so an explicit item needs its own value. */
const NONE = '__none__'

function SubworkflowNodeConfig({
  node,
  currentWorkflowId,
  update,
  disabled
}: {
  node: Extract<WorkflowNodeData, { type: 'subworkflow' }>
  currentWorkflowId: string
  update: (patch: Record<string, unknown>) => void
  disabled: boolean
}): React.JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [templates, setTemplates] = useState<WorkflowDefinition[]>([])
  const [childInputs, setChildInputs] = useState<WorkflowInputVar[]>([])

  useEffect(() => {
    Promise.all([
      window.api.workflow.list(),
      window.api.workflow.templates()
    ]).then(([wfs, tpls]) => {
      const wfList = (wfs as WorkflowDefinition[]).filter((w) => w.id !== currentWorkflowId)
      const tplList = (tpls as WorkflowDefinition[]).filter((t) => t.id !== currentWorkflowId)
      setWorkflows(wfList)
      setTemplates(tplList)
    })
  }, [currentWorkflowId])

  useEffect(() => {
    if (!node.workflowId) {
      setChildInputs([])
      return
    }
    window.api.workflow.load(node.workflowId).then((wf) => {
      const w = wf as WorkflowDefinition | null
      if (w) {
        setChildInputs(w.inputs ?? [])
        return
      }
      // Built-in template fallback (not saved on disk but resolvable at run-time)
      const tpl = templates.find((t) => t.id === node.workflowId)
      setChildInputs(tpl?.inputs ?? [])
    })
  }, [node.workflowId, templates])

  const mapping = node.inputMapping ?? {}
  const updateMapping = (key: string, value: string): void => {
    const next = { ...mapping, [key]: value }
    if (!value) delete next[key]
    update({ inputMapping: next })
  }

  const captureVars = node.captureVars ?? []
  const updateCapture = (text: string): void => {
    const list = text.split(',').map((s) => s.trim()).filter(Boolean)
    update({ captureVars: list.length > 0 ? list : undefined })
  }

  return (
    <>
      <Field label="Target flow" hint="Runs as its own graph, with its own join state per call.">
        {/* NONE rather than '', because Radix reserves the empty string to mean
            "no selection" and throws on an item that uses it. */}
        <Select
          value={node.workflowId || NONE}
          onValueChange={(v) => update({ workflowId: v === NONE ? '' : v })}
          disabled={disabled}
        >
          <SelectTrigger className="w-full bg-sidebar text-[0.92em]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>
              <span className="text-muted-foreground">Choose a flow…</span>
            </SelectItem>
            {workflows.length > 0 && (
              <SelectGroup>
                <SelectLabel>Saved flows</SelectLabel>
                {workflows.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {templates.length > 0 && (
              <SelectGroup>
                <SelectLabel>Built-in templates</SelectLabel>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </Field>

      {childInputs.length > 0 && (
        <Field
          label="Input mapping"
          hint={
            <span className="font-mono">
              <code className="text-foreground/70">{'{{input.x}}'}</code>,{' '}
              <code className="text-foreground/70">{'{{vars.y}}'}</code>, or raw text
            </span>
          }
        >
          <div className="space-y-1.5">
            {childInputs.map((inp) => (
              <div key={inp.key}>
                <div className="text-[0.77em] text-foreground/80 font-mono">{inp.key}</div>
                <input
                  value={mapping[inp.key] ?? ''}
                  onChange={(e) => updateMapping(inp.key, e.target.value)}
                  placeholder={inp.placeholder || `{{input.${inp.key}}}`}
                  disabled={disabled}
                  className={`${CTL} font-mono text-[0.77em]`}
                />
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field
        label="Variables to bring back"
        hint="Comma-separated. The child flow has its own variables; these are copied into this one when it finishes. Blank copies all of them."
      >
        <input
          value={captureVars.join(', ')}
          onChange={(e) => updateCapture(e.target.value)}
          placeholder="e.g. draft, score"
          disabled={disabled}
          className={`${CTL} font-mono text-[0.85em]`}
        />
      </Field>
    </>
  )
}

// --- Main Workflow Canvas ---

let nodeCounter = 0

export default function WorkflowCanvas(): React.JSX.Element {
  const {
    currentWorkflow,
    setCurrentWorkflow,
    updateCurrentWorkflow,
    execution,
    setExecution,
    selectedNodeId,
    setSelectedNodeId,
    closeCanvas,
    workflows,
    setWorkflows,
    reviewQueue,
    executions,
    setExecutions
  } = useWorkflowStore()

  const sessionCwd = useSessionsStore(activeCwd)
  const projects = useSessionsStore((st) => st.projects)
  const cwd = sessionCwd || homedir()

  const resolvedTheme = useResolvedTheme()
  // React Flow puts this on a `fill` presentation attribute, which `var()`
  // cannot reach, so the token has to be resolved here rather than in CSS.
  const flowDotColor = resolvedTheme === 'light' ? '#00000038' : '#ffffff2e'
  const minimapMaskColor = resolvedTheme === 'light' ? '#f5f5f5cc' : '#0a0a0a90'
  const minimapNodeColor = resolvedTheme === 'light' ? '#3b82f640' : '#3b82f620'

  const [showTemplates, setShowTemplates] = useState(!currentWorkflow)

  // The rail opens flows now, which sets `currentWorkflow` from outside this
  // component. Without this the templates view stays in front of the flow you
  // just picked, and the click reads as broken.
  useEffect(() => {
    if (currentWorkflow) setShowTemplates(false)
  }, [currentWorkflow?.id])
  const [saveFlash, setSaveFlash] = useState(false)
  const [showRunDialog, setShowRunDialog] = useState(false)
  const [showInputsEditor, setShowInputsEditor] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showVars, setShowVars] = useState(false)
  const [showMetrics, setShowMetrics] = useState(false)
  const [showTriggers, setShowTriggers] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  const [templateDefs, setTemplateDefs] = useState<WorkflowDefinition[]>([])
  useEffect(() => {
    window.api.workflow.templates().then((tpls) => setTemplateDefs(tpls as WorkflowDefinition[]))
  }, [])
  // Keyed on the id→name pairs rather than the arrays. `workflow.list()` hands
  // back a new array every time it is called — which `handleSave` does before
  // every run — and this map is a dependency of the node sync effect, so a
  // fresh array alone used to rebuild the whole canvas.
  const namesKey = useMemo(
    () =>
      [...templateDefs, ...workflows]
        .map((w) => `${w.id}\u0000${w.name}`)
        .sort()
        .join('\u0001'),
    [workflows, templateDefs]
  )
  const workflowsById = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of templateDefs) map.set(t.id, t.name)
    for (const w of workflows) map.set(w.id, w.name)
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey])

  // Convert workflow to React Flow format
  const nodeStates = execution?.nodeStates ?? {}
  const initialNodes = useMemo(
    () => (currentWorkflow ? toFlowNodes(currentWorkflow.nodes, nodeStates, workflowsById, currentWorkflow.edges) : []),
    [currentWorkflow?.id]
  )
  const initialEdges = useMemo(
    () => (currentWorkflow ? toFlowEdges(currentWorkflow.edges, currentWorkflow.nodes) : []),
    [currentWorkflow?.id]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync React Flow state when the workflow changes.
  //
  // `measured` is carried across on purpose. React Flow records each node's real
  // size there once it has been laid out, and routes every edge from it — so
  // handing it freshly built nodes drops the sizes and the connections have
  // nothing to draw between. The nodes are still there; the graph just renders
  // without its edges, and then without much of anything. Re-measuring happens
  // a frame later, which is exactly long enough to look like a bug.
  useEffect(() => {
    if (!currentWorkflow) return
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]))
      return toFlowNodes(
        currentWorkflow.nodes,
        nodeStates,
        workflowsById,
        currentWorkflow.edges
      ).map((n) => (measured.get(n.id) ? { ...n, measured: measured.get(n.id) } : n))
    })
    setEdges(toFlowEdges(currentWorkflow.edges, currentWorkflow.nodes))
  }, [currentWorkflow?.id, currentWorkflow?.nodes, currentWorkflow?.edges, workflowsById])

  // The ring follows the inspector's idea of what is selected, so a node picked
  // from anywhere looks picked.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) =>
        n.selected === (n.id === selectedNodeId) ? n : { ...n, selected: n.id === selectedNodeId }
      )
    )
  }, [selectedNodeId, setNodes])

  // Edges follow the run too, so the canvas shows where output is moving rather
  // than only which boxes have finished.
  useEffect(() => {
    setEdges((prev) => withRunState(prev, execution?.nodeStates ?? {}))
  }, [execution?.nodeStates, setEdges])

  // Update node status during execution
  useEffect(() => {
    if (!execution || !currentWorkflow) return
    setNodes((prev) =>
      prev.map((n) => {
        const ns = execution.nodeStates[n.id]
        if (!ns) return n
        return {
          ...n,
          data: {
            ...n.data,
            status: ns.status,
            output: ns.output || ns.error || '',
            iteration: ns.iteration
          }
        }
      })
    )
  }, [execution?.nodeStates])

  // Subscribe to workflow events
  useEffect(() => {
    const unsub = window.api.workflow.onEvent((event: unknown) => {
      const e = event as WorkflowEvent
      const store = useWorkflowStore.getState()
      // Adopt the execution id from the first event that carries one.
      //
      // `workflow.run()` only resolves once the whole run is over, so its id
      // arrived after the fact — leaving `execution.id` empty for the entire
      // run, and Stop guards on that id. The button was inert for exactly as
      // long as it was the one you wanted.
      const id = (e as { executionId?: string }).executionId
      if (id && store.execution && !store.execution.id) {
        store.setExecution({ ...store.execution, id })
      }
      switch (e.type) {
        case 'node:start':
          store.updateNodeState(e.nodeId, {
            status: 'running',
            startedAt: Date.now(),
            iteration: e.iteration
          })
          break
        case 'node:done':
          store.updateNodeState(e.nodeId, {
            status: 'done',
            output: e.output,
            finishedAt: Date.now(),
            iteration: e.iteration
          })
          break
        case 'node:failed':
          store.updateNodeState(e.nodeId, {
            status: 'failed',
            error: e.error,
            finishedAt: Date.now()
          })
          break
        case 'node:skipped':
          store.updateNodeState(e.nodeId, { status: 'skipped' })
          break
        case 'node:awaiting-review':
          store.updateNodeState(e.nodeId, { status: 'awaiting_review' })
          store.pushReview(e.request)
          break
        case 'variable:set':
          store.setVariable(e.name, e.value)
          break
        case 'loop:iterate':
          store.updateNodeState(e.nodeId, { iteration: e.iteration })
          break
        case 'execution:done': {
          const exec = store.execution
          store.setExecution(exec ? { ...exec, status: 'done', finishedAt: Date.now() } : null)
          if (e.record) {
            store.setExecutions([e.record, ...store.executions.filter((r) => r.id !== e.record!.id)])
          }
          break
        }
        case 'execution:failed': {
          const exec = store.execution
          store.setExecution(exec ? { ...exec, status: 'failed', finishedAt: Date.now() } : null)
          if (e.record) {
            store.setExecutions([e.record, ...store.executions.filter((r) => r.id !== e.record!.id)])
          }
          break
        }
        case 'execution:aborted': {
          const exec = store.execution
          store.setExecution(exec ? { ...exec, status: 'aborted', finishedAt: Date.now() } : null)
          if (e.record) {
            store.setExecutions([e.record, ...store.executions.filter((r) => r.id !== e.record!.id)])
          }
          break
        }
      }
    })
    return unsub
  }, [])

  // Load saved workflows
  useEffect(() => {
    window.api.workflow.list().then((wfs) => setWorkflows(wfs as WorkflowDefinition[]))
  }, [])

  // Load executions for current workflow
  useEffect(() => {
    if (!currentWorkflow) return
    window.api.workflow
      .listExecutions(currentWorkflow.id)
      .then((recs) => setExecutions(recs as WorkflowExecutionRecord[]))
  }, [currentWorkflow?.id])

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges]
  )

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id)
      setShowInputsEditor(false)
      setShowHistory(false)
      setShowVars(false)
      setShowMetrics(false)
      setShowTriggers(false)
    },
    [setSelectedNodeId]
  )

  const onNodeDragStop = useCallback(() => {
    if (!currentWorkflow) return
    const updatedNodes = fromFlowNodes(nodes)
    updateCurrentWorkflow({ nodes: updatedNodes })
  }, [nodes, currentWorkflow])

  const addNode = (
    type: 'prompt' | 'condition' | 'script' | 'parallel' | 'join' | 'loop' | 'humanReview' | 'subworkflow'
  ): void => {
    if (!currentWorkflow) return
    const id = `node-${++nodeCounter}-${Date.now()}`
    const labels: Record<string, string> = {
      prompt: 'New Prompt',
      condition: 'New Condition',
      script: 'New Script',
      parallel: 'Fork',
      join: 'Join',
      loop: 'Loop',
      humanReview: 'Human Review',
      subworkflow: 'Sub-flow'
    }
    let data: WorkflowNodeData
    if (type === 'prompt') data = { type: 'prompt', prompt: '' }
    else if (type === 'condition') data = { type: 'condition', expression: '' }
    else if (type === 'script') data = { type: 'script', command: '' }
    else if (type === 'parallel') data = { type: 'parallel' }
    else if (type === 'join') data = { type: 'join' }
    else if (type === 'loop') data = { type: 'loop', condition: 'iteration < 3', maxIterations: 10 }
    else if (type === 'subworkflow') data = { type: 'subworkflow', workflowId: '' }
    else data = { type: 'humanReview' }

    const newNode: WorkflowNode = {
      id,
      label: labels[type],
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data
    }
    updateCurrentWorkflow({ nodes: [...currentWorkflow.nodes, newNode] })
  }

  const deleteSelectedNode = (): void => {
    if (!selectedNodeId || !currentWorkflow) return
    updateCurrentWorkflow({
      nodes: currentWorkflow.nodes.filter((n) => n.id !== selectedNodeId),
      edges: currentWorkflow.edges.filter(
        (e) => e.source !== selectedNodeId && e.target !== selectedNodeId
      )
    })
    setSelectedNodeId(null)
  }

  const handleSave = async (): Promise<void> => {
    if (!currentWorkflow) return
    // Keep the existing arrays when the canvas has not actually changed. A save
    // runs before every execution, and replacing `nodes` each time handed React
    // Flow a fresh object graph — losing every node's measured size, which is
    // what the edges are routed from. Hit Run twice and the connections went
    // missing; the graph was intact the whole time.
    const updatedNodes = preserveIfSame(fromFlowNodes(nodes), currentWorkflow.nodes)
    const updatedEdges = preserveIfSame(fromFlowEdges(edges), currentWorkflow.edges)
    const unchanged =
      updatedNodes === currentWorkflow.nodes && updatedEdges === currentWorkflow.edges
    const wf = unchanged ? currentWorkflow : { ...currentWorkflow, nodes: updatedNodes, edges: updatedEdges }
    await window.api.workflow.save(wf)
    if (!unchanged) {
      setCurrentWorkflow(wf)
      const wfs = await window.api.workflow.list()
      setWorkflows(wfs as WorkflowDefinition[])
    }
    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 2000)
  }

  const [runTargetCwd, setRunTargetCwd] = useState<string>('')

  const handleRun = (targetCwd?: string): void => {
    if (!currentWorkflow) return
    const effective = targetCwd || cwd
    if (!effective) {
      alert('No working directory set. Please select a folder in your session first.')
      return
    }
    setRunTargetCwd(effective)
    if (currentWorkflow.inputs && currentWorkflow.inputs.length > 0) {
      setShowRunDialog(true)
    } else {
      startExecution({}, effective)
    }
  }

  const startExecution = async (inputValues: Record<string, string>, targetCwd?: string): Promise<void> => {
    if (!currentWorkflow) return
    const effective = targetCwd || runTargetCwd || cwd
    if (!effective) {
      alert('No working directory set. Please select a folder in your session first.')
      return
    }
    setShowRunDialog(false)
    await handleSave()
    const nodeStatesInit: Record<string, { nodeId: string; status: WorkflowNodeStatus }> = {}
    for (const n of currentWorkflow.nodes) {
      nodeStatesInit[n.id] = { nodeId: n.id, status: 'idle' }
    }
    setExecution({
      id: '',
      workflowId: currentWorkflow.id,
      status: 'running',
      nodeStates: nodeStatesInit,
      vars: {},
      startedAt: Date.now()
    })
    const result = await window.api.workflow.run(currentWorkflow.id, effective, inputValues)
    if (result.executionId) {
      const current = useWorkflowStore.getState().execution
      if (current) setExecution({ ...current, id: result.executionId })
    }
    // Only `recentCwds` can have changed — the engine records where it ran.
    //
    // This used to swap the whole workflow for the copy on disk, which cost two
    // things. React Flow got a brand new `nodes` array, so every node lost its
    // measured size and the edges between them had nothing to route around
    // until a re-measure; and any edit made since the last save was silently
    // replaced by the saved version. Patching one field keeps the `nodes` and
    // `edges` references identical, so the sync effect does not fire at all.
    const refreshed = (await window.api.workflow.load(currentWorkflow.id)) as
      | WorkflowDefinition
      | null
    if (refreshed) updateCurrentWorkflow({ recentCwds: refreshed.recentCwds })
  }

  const pickCwdAndRun = async (): Promise<void> => {
    const picked = await window.api.dialog.pickFolder()
    if (picked) handleRun(picked)
  }

  // `flow.run` and `flow.stop` live in the registry so they get a palette entry
  // and a rebindable chord; the work itself is here, so they arrive as events.
  useEffect(() => {
    const run = (): void => {
      if (!isRunning && currentWorkflow && currentWorkflow.nodes.length > 0) handleRun()
    }
    const stop = (): void => {
      if (isRunning) handleAbort()
    }
    const arrange = (): void => {
      if (!isRunning && currentWorkflow) arrangeNodes()
    }
    const panels: [string, () => void][] = [
      ['details', () => setShowDetails(true)],
      ['inputs', () => setShowInputsEditor(true)],
      ['vars', () => setShowVars(true)],
      ['history', () => setShowHistory(true)],
      ['metrics', () => setShowMetrics(true)],
      ['triggers', () => setShowTriggers(true)]
    ]
    const panelHandlers = panels.map(([name, show]) => {
      const handler = (): void => {
        closeSidePanels()
        show()
      }
      window.addEventListener(`nyra:flow-panel-${name}`, handler)
      return () => window.removeEventListener(`nyra:flow-panel-${name}`, handler)
    })
    window.addEventListener('nyra:flow-run', run)
    window.addEventListener('nyra:flow-stop', stop)
    window.addEventListener('nyra:flow-arrange', arrange)
    return () => {
      window.removeEventListener('nyra:flow-run', run)
      window.removeEventListener('nyra:flow-stop', stop)
      window.removeEventListener('nyra:flow-arrange', arrange)
      for (const off of panelHandlers) off()
    }
  })

  // What was last written to disk. A flow is dirty when it no longer matches,
  // which is what decides whether the toolbar shows Save at all.
  const savedRef = useRef<string>('')
  useEffect(() => {
    savedRef.current = currentWorkflow ? JSON.stringify(currentWorkflow) : ''
  }, [currentWorkflow?.id])
  const dirty = Boolean(currentWorkflow) && JSON.stringify(currentWorkflow) !== savedRef.current

  const handleAbort = (): void => {
    // By flow, not by execution id. `workflow_run` only returns an id once the
    // run has finished, so for the whole time Stop matters the renderer may not
    // have one — which is precisely why the button did nothing. The flow id is
    // on screen.
    if (currentWorkflow) void window.api.workflow.abortFlow(currentWorkflow.id)
    // Belt and braces for a sub-flow that reported its id through an event.
    const id = useWorkflowStore.getState().execution?.id
    if (id) void window.api.workflow.abort(id)
  }

  const createNew = (): void => {
    const id = `wf-${Date.now()}`
    const wf: WorkflowDefinition = {
      id,
      name: 'New Workflow',
      nodes: [],
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setCurrentWorkflow(wf)
    setShowTemplates(false)
    setExecution(null)
  }

  const useTemplate = (tpl: WorkflowDefinition): void => {
    const id = `wf-${Date.now()}`
    const wf: WorkflowDefinition = {
      ...tpl,
      id,
      isTemplate: false,
      // The bundled templates carry left-to-right positions. Handles are on the
      // top and bottom now, so a template keeping its old coordinates would draw
      // edges sideways between nodes sitting in a row. Re-place on the way in.
      nodes: laidOut(tpl.nodes, tpl.edges),
      projectId: activeProject(useSessionsStore.getState())?.id ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setCurrentWorkflow(wf)
    setShowTemplates(false)
    setExecution(null)
  }

  /**
   * Leaving a flow means going back to the flow list, not out of Flow mode.
   *
   * `closeCanvas` used to be the only way out because the canvas was an overlay
   * over the chat. It is a view mode now, so closing it drops you into Chats,
   * which is not what an arrow labelled "back" should do.
   */
  const backToList = useCallback((): void => {
    setCurrentWorkflow(null)
    setExecution(null)
    setShowTemplates(true)
  }, [setCurrentWorkflow, setExecution])

  /**
   * Re-place every node in rows, top to bottom, with loop bodies back inside
   * their loop. For a flow whose nodes have been dragged out of shape, and for
   * one saved before containers existed, where a loop overlaps what follows it.
   */
  const arrangeNodes = useCallback((): void => {
    if (!currentWorkflow) return
    updateCurrentWorkflow({
      nodes: laidOut(currentWorkflow.nodes, currentWorkflow.edges)
    })
  }, [currentWorkflow, updateCurrentWorkflow])

  const openWorkflow = async (id: string): Promise<void> => {
    const wf = (await window.api.workflow.load(id)) as WorkflowDefinition | null
    if (wf) {
      setCurrentWorkflow(wf)
      setShowTemplates(false)
      setExecution(null)
    }
  }

  const handleImport = async (): Promise<void> => {
    const result = await window.api.workflow.importWorkflow()
    if (result.canceled) return
    if (result.error) {
      alert(`Import failed: ${result.error}`)
      return
    }
    if (result.workflow) {
      const wf = result.workflow as WorkflowDefinition
      setCurrentWorkflow(wf)
      setShowTemplates(false)
      setExecution(null)
      const wfs = await window.api.workflow.list()
      setWorkflows(wfs as WorkflowDefinition[])
    }
  }

  const handleExport = async (): Promise<void> => {
    if (!currentWorkflow) return
    const updatedNodes = fromFlowNodes(nodes)
    const updatedEdges = fromFlowEdges(edges)
    const wf = { ...currentWorkflow, nodes: updatedNodes, edges: updatedEdges }
    const result = await window.api.workflow.exportWorkflow(wf)
    if (result.error) alert(`Export failed: ${result.error}`)
  }

  const isRunning = execution?.status === 'running'

  // Above the early return, because everything below it is skipped while the
  // templates view is showing. A hook after that return runs only once a flow
  // is open, which changes the hook count between renders and takes the whole
  // view down the moment you click a flow.
  const inspectorWidth = usePanelSizesStore((st) => st.flowInspectorWidth)

  if (showTemplates || !currentWorkflow) {
    return (
      <TemplatesView
        onUseTemplate={useTemplate}
        onCreateNew={createNew}
        onImport={handleImport}
        workflows={workflows}
        onOpenWorkflow={openWorkflow}
        onWorkflowsChanged={async () => {
          const wfs = await window.api.workflow.list()
          setWorkflows(wfs as WorkflowDefinition[])
        }}
      />
    )
  }

  const runningNodeCount = currentWorkflow.nodes.length
  const doneCount = Object.values(nodeStates).filter(
    (ns) => ns.status === 'done' || ns.status === 'skipped'
  ).length
  const currentRunning = Object.values(nodeStates).find((ns) => ns.status === 'running')
  const currentRunningNode = currentRunning
    ? currentWorkflow.nodes.find((n) => n.id === currentRunning.nodeId)
    : null
  const failed = Object.values(nodeStates).find((ns) => ns.status === 'failed')
  const failedNode = failed ? currentWorkflow.nodes.find((n) => n.id === failed.nodeId) : null
  const sidePanelOpen =
    showInputsEditor || showHistory || showVars || showMetrics || showTriggers || showDetails
  const inspectorOpen =
    !sidePanelOpen && (Boolean(selectedNodeId) || Boolean(execution && execution.status !== 'idle'))
  const flowProjectName =
    projects.find((pr) => pr.id === currentWorkflow.projectId)?.name ?? 'Any project'
  const headerTrigger = triggerSummary(currentWorkflow)
  const varsCount = execution?.vars ? Object.keys(execution.vars).length : 0

  const closeSidePanels = (): void => {
    setSelectedNodeId(null)
    setShowInputsEditor(false)
    setShowHistory(false)
    setShowVars(false)
    setShowMetrics(false)
    setShowTriggers(false)
    setShowDetails(false)
  }

  return (
    // Flow chrome follows the UI type size setting, which until now reached only
    // the projects rail. The nodes themselves stay fixed: their size is measured
    // by the layout, so scaling their text would desync drawing from placement.
    <div className="flex h-full flex-col" style={{ fontSize: 'var(--ui-font-size, 13px)' }}>
      {/* Toolbar — breadcrumb left, run right. The flow's own controls are
          icon-only, so the one thing you press most is the only filled button. */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border/55 bg-card px-3">
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground/70" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={backToList}
              className="shrink-0 text-[0.96em] text-muted-foreground hover:text-foreground"
            >
              {flowProjectName}
            </button>
          </TooltipTrigger>
          <TooltipContent>Back to flows</TooltipContent>
        </Tooltip>
        <span className="shrink-0 text-[0.96em] text-muted-foreground/40">/</span>
        <input
          value={currentWorkflow.name}
          onChange={(e) => updateCurrentWorkflow({ name: e.target.value })}
          aria-label="Flow name"
          className="min-w-0 max-w-[260px] flex-1 border-b border-transparent bg-transparent text-[0.96em] font-semibold text-foreground focus:border-border-strong focus:outline-hidden"
        />
        {headerTrigger ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-[2px] font-mono text-[0.73em] text-muted-foreground">
            <Timer className="size-2.5" />
            {headerTrigger}
          </span>
        ) : null}

        <div className="min-w-1 flex-1" />

        {execution && execution.status !== 'idle' ? (
          <RunStatusChip
            status={execution.status}
            done={doneCount}
            total={runningNodeCount}
            startedAt={execution.startedAt}
            finishedAt={execution.finishedAt}
            runningLabel={currentRunningNode?.label}
            failedLabel={failedNode?.label}
          />
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          <PanelIconButton
            label="Flow details"
            command="flow.panel.details"
            icon={Info}
            active={showDetails}
            onClick={() => {
              closeSidePanels()
              setShowDetails(true)
            }}
          />
          <PanelIconButton
            label="Flow inputs"
            command="flow.panel.inputs"
            icon={SlidersHorizontal}
            count={currentWorkflow.inputs?.length}
            active={showInputsEditor}
            onClick={() => {
              closeSidePanels()
              setShowInputsEditor(true)
            }}
          />
          <PanelIconButton
            label="Variables"
            command="flow.panel.vars"
            icon={Braces}
            count={varsCount}
            active={showVars}
            onClick={() => {
              closeSidePanels()
              setShowVars(true)
            }}
          />
          <PanelIconButton
            label="Execution history"
            command="flow.panel.history"
            icon={History}
            count={executions.length}
            active={showHistory}
            onClick={() => {
              closeSidePanels()
              setShowHistory(true)
            }}
          />
          <PanelIconButton
            label="Execution metrics"
            command="flow.panel.metrics"
            icon={ChartNoAxesColumn}
            active={showMetrics}
            onClick={() => {
              closeSidePanels()
              setShowMetrics(true)
            }}
          />
          <PanelIconButton
            label="Triggers — cron, file watcher, webhook"
            command="flow.panel.triggers"
            icon={Zap}
            count={currentWorkflow.triggers?.length}
            active={showTriggers}
            onClick={() => {
              closeSidePanels()
              setShowTriggers(true)
            }}
          />
        </div>

        <OverflowMenu
          onImport={handleImport}
          onExport={handleExport}
          onShareToMarketplace={async () => {
            await handleSave()
            await window.api.workflow.marketplaceShare(currentWorkflow)
          }}
          onTidy={arrangeNodes}
          disabled={isRunning}
        />

        {/* Only when there is something to save. A button that is always there
            and usually a no-op teaches you to ignore it. */}
        {dirty || saveFlash ? (
          <button
            onClick={handleSave}
            disabled={isRunning}
            className={`shrink-0 rounded-sm px-2.5 py-1 text-[0.77em] font-medium transition-colors disabled:opacity-40 ${
              saveFlash ? 'bg-success/15 text-success' : 'bg-muted text-foreground/80 hover:bg-accent'
            }`}
          >
            {saveFlash ? 'Saved' : 'Save'}
          </button>
        ) : null}

        {isRunning ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleAbort}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-[0.85em] font-semibold text-danger-foreground hover:opacity-90"
              >
                <Square className="size-2.5 fill-current" />
                Stop
              </button>
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-1.5">
              Stop the run
              <CommandKbd id="flow.stop" />
            </TooltipContent>
          </Tooltip>
        ) : (
          <RunButton
            disabled={currentWorkflow.nodes.length === 0}
            currentCwd={cwd}
            recentCwds={currentWorkflow.recentCwds ?? []}
            onRun={handleRun}
            onPickCwd={pickCwdAndRun}
          />
        )}
      </div>

      {/* Canvas + side panel */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // React Flow starts dragging after 1px by default, so the hand
            // tremor in an ordinary click nudged the node and swallowed the
            // click. Four pixels is below anything anyone means as a drag.
            nodeDragThreshold={4}
            fitView
            proOptions={{ hideAttribution: true }}
            className="nyra-flow-canvas"
          >
            <Background color={flowDotColor} variant={BackgroundVariant.Dots} gap={20} size={1.4} />
            <Panel position="top-left">
              <AddNodeMenu onAdd={addNode} disabled={isRunning} />
            </Panel>
            <Panel position="bottom-left">
              <ZoomPill />
            </Panel>
            {/* A minimap on an eight-node flow is chrome over an empty corner.
                It earns its place once the graph outgrows the pane, which is
                where fit-to-screen stops being readable. */}
            {currentWorkflow.nodes.length > 12 ? (
              <MiniMap
                pannable
                zoomable
                nodeColor={minimapNodeColor}
                maskColor={minimapMaskColor}
                className="rounded-lg! border-border! bg-card!"
              />
            ) : null}
          </ReactFlow>
        </div>

        {/* The inspector is where a prompt gets written, so it has to be as wide
            as the person writing one wants. Double-click the handle to reset. */}
        {inspectorOpen ? (
          <>
            <ResizeHandle
              side="right"
              label="Resize the inspector"
              {...handleBinding('flowInspectorWidth')}
              onSize={(px) => usePanelSizesStore.getState().setSize('flowInspectorWidth', px)}
              onReset={() => usePanelSizesStore.getState().resetSize('flowInspectorWidth')}
            />
            <div className="flex shrink-0" style={{ width: inspectorWidth }}>
              {selectedNodeId ? (
                <NodeConfigPanel onDelete={deleteSelectedNode} />
              ) : (
                // Nothing selected during a run: the panel becomes the run
                // itself rather than an empty card.
                <RunPanel />
              )}
            </div>
          </>
        ) : null}
        {showInputsEditor && (
          <InputsEditor
            inputs={currentWorkflow.inputs ?? []}
            onChange={(inputs) => updateCurrentWorkflow({ inputs })}
            onClose={() => setShowInputsEditor(false)}
          />
        )}
        {showVars && (
          <VarsPanel
            workflow={currentWorkflow}
            vars={execution?.vars ?? {}}
            onSelectNode={(id) => {
              setShowVars(false)
              setSelectedNodeId(id)
            }}
            onClose={() => setShowVars(false)}
          />
        )}
        {showHistory && currentWorkflow && (
          <HistoryPanel
            workflowId={currentWorkflow.id}
            onClose={() => setShowHistory(false)}
          />
        )}
        {showMetrics && currentWorkflow && (
          <MetricsPanel
            workflowId={currentWorkflow.id}
            executions={executions}
            onClose={() => setShowMetrics(false)}
          />
        )}
        {showDetails && (
          <FlowDetailsPanel
            workflow={currentWorkflow}
            onChange={updateCurrentWorkflow}
            onClose={() => setShowDetails(false)}
          />
        )}
        {showTriggers && currentWorkflow && (
          <TriggersPanel
            workflow={currentWorkflow}
            currentCwd={cwd}
            onChange={(triggers) => updateCurrentWorkflow({ triggers })}
            onSave={handleSave}
            onClose={() => setShowTriggers(false)}
          />
        )}
      </div>

      {/* Run dialog */}
      {showRunDialog && currentWorkflow.inputs && (
        <RunDialog
          inputs={currentWorkflow.inputs}
          onRun={startExecution}
          onCancel={() => setShowRunDialog(false)}
        />
      )}

      {/* Human review dialog */}
      {reviewQueue.length > 0 && <ReviewDialog request={reviewQueue[0]} />}
    </div>
  )
}

// --- Toolbar helpers ---

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node | null)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

type AddKind = 'prompt' | 'condition' | 'script' | 'parallel' | 'join' | 'loop' | 'humanReview' | 'subworkflow'

function AddNodeMenu({
  onAdd,
  disabled
}: {
  onAdd: (type: AddKind) => void
  disabled: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  // `flow.addNode` is a registered command, so the chord and the palette open
  // this menu rather than guessing which node type you wanted.
  useEffect(() => {
    const show = (): void => {
      if (!disabled) setOpen(true)
    }
    window.addEventListener('nyra:flow-add-node', show)
    return () => window.removeEventListener('nyra:flow-add-node', show)
  }, [disabled])

  const groups: { group: string; nodes: { type: AddKind; label: string; desc: string; icon: LucideIcon }[] }[] = [
    {
      group: 'Does work',
      nodes: [
        { type: 'prompt', label: 'Prompt', desc: 'Run Claude with a prompt', icon: Sparkles },
        { type: 'script', label: 'Script', desc: 'Run a shell command', icon: Terminal },
        { type: 'subworkflow', label: 'Sub-flow', desc: 'Call another flow', icon: Workflow }
      ]
    },
    {
      group: 'Routes',
      nodes: [
        { type: 'condition', label: 'Condition', desc: 'Branch yes / no', icon: GitBranch },
        { type: 'parallel', label: 'Fork', desc: 'Fan out to every branch', icon: GitFork },
        { type: 'join', label: 'Join', desc: 'Wait for all branches', icon: GitMerge },
        { type: 'loop', label: 'Loop', desc: 'Repeat while a condition holds', icon: Repeat }
      ]
    },
    {
      group: 'Waits on you',
      nodes: [
        { type: 'humanReview', label: 'Review', desc: 'Pause until you approve', icon: UserRoundCheck }
      ]
    }
  ]

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-lg border border-border/55 bg-card px-3 py-1.5 text-[0.85em] font-semibold text-foreground/80 shadow-sm transition-colors hover:bg-accent/50 disabled:opacity-40 data-[state=open]:border-border-strong data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <Plus className="size-3" />
        <span>Add node</span>
        <CommandKbd id="flow.addNode" className="ml-0.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {groups.map((g, gi) => (
          <React.Fragment key={g.group}>
            {gi > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-[0.7em] uppercase tracking-wider text-muted-foreground/70">
              {g.group}
            </DropdownMenuLabel>
            {g.nodes.map((n) => (
              <DropdownMenuItem key={n.type} onSelect={() => onAdd(n.type)}>
                <n.icon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span>{n.label}</span>
                  <span className="truncate text-[0.77em] text-muted-foreground">{n.desc}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One of the flow's side panels, as an icon.
 *
 * Five labelled segments ate half the toolbar and made every control look
 * equally important, which left no room for the one you actually press. The
 * count rides on the icon so "Triggers · 2" survives losing its word.
 */
/**
 * Zoom, fit and lock, as one pill.
 *
 * React Flow's stock `Controls` is a vertical stack of four bordered squares in
 * its own visual language. This says the same things in a row, in the app's,
 * and shows the zoom level, which the stock control never does.
 */
function ZoomPill(): React.JSX.Element {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const zoom = useStore((st) => st.transform[2])
  const locked = useStore((st) => !st.nodesDraggable)
  const setOptions = useStoreApi().setState

  const btn =
    'flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border/55 bg-card p-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => zoomOut()} aria-label="Zoom out" className={btn}>
            <Minus className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>
      <span className="w-9 text-center font-mono text-[0.77em] text-muted-foreground">
        {Math.round(zoom * 100)}%
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={() => zoomIn()} aria-label="Zoom in" className={btn}>
            <Plus className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Zoom in</TooltipContent>
      </Tooltip>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => fitView({ duration: 200 })}
            aria-label="Fit to screen"
            className={btn}
          >
            <Maximize className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Fit to screen</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() =>
              setOptions({
                nodesDraggable: locked,
                nodesConnectable: locked,
                elementsSelectable: true
              })
            }
            aria-label={locked ? 'Unlock the canvas' : 'Lock the canvas'}
            className={`${btn} ${locked ? 'text-foreground' : ''}`}
          >
            {locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent>{locked ? 'Unlock the canvas' : 'Lock the canvas'}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function PanelIconButton({
  label,
  icon: Icon,
  command,
  count,
  active,
  onClick
}: {
  label: string
  icon: LucideIcon
  /** Its registered command, so the tooltip shows whatever it is bound to. */
  command: CommandId
  count?: number
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={label}
          className={`relative flex size-7 items-center justify-center rounded-md transition-colors ${
            active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground/80'
          }`}
        >
          <Icon className="size-3.5" />
          {count ? (
            <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-muted px-[3px] text-center font-mono text-[0.62em] leading-3 text-muted-foreground">
              {count}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        <CommandKbd id={command} />
      </TooltipContent>
    </Tooltip>
  )
}


function OverflowMenu({
  onImport,
  onExport,
  onShareToMarketplace,
  onTidy,
  disabled
}: {
  onImport: () => void
  onExport: () => void
  onShareToMarketplace: () => void
  onTidy: () => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            aria-label="More actions"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground/80 disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <Ellipsis className="size-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={onTidy}>
          <LayoutGrid />
          <span className="flex flex-col">
            <span>Arrange nodes</span>
            <span className="text-[0.77em] text-muted-foreground">
              Re-stack the flow top to bottom
            </span>
          </span>
          <DropdownMenuShortcut>
            <CommandKbd id="flow.arrange" />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onImport}>
          <Download />
          Import flow…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExport}>
          <Upload />
          Export flow…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShareToMarketplace}>
          <Store />
          Share to marketplace…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RunButton({
  disabled,
  currentCwd,
  recentCwds,
  onRun,
  onPickCwd
}: {
  disabled: boolean
  currentCwd: string
  recentCwds: string[]
  onRun: (cwd?: string) => void
  onPickCwd: () => void
}): React.JSX.Element {
  const recents = recentCwds.filter((c) => c !== currentCwd).slice(0, 5)
  const short = (path: string): string => {
    if (!path) return ''
    const parts = path.split('/').filter(Boolean)
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
  }

  // Filled with the foreground, not green. Every other colour on this canvas
  // means a run status, and a button that is always green competes with the one
  // node that has actually succeeded.
  const filled =
    'bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-40'

  return (
    <div className="flex shrink-0 items-stretch">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onRun()}
            disabled={disabled}
            className={`flex items-center gap-1.5 rounded-l-md py-1.5 pl-2.5 pr-2 text-[0.85em] font-semibold ${filled}`}
          >
            <Play className="size-3 fill-current" />
            Run
            <CommandKbd id="flow.run" className="ml-0.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          {currentCwd ? `Run in ${short(currentCwd)}` : 'Run this flow'}
          <CommandKbd id="flow.run" />
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              disabled={disabled}
              aria-label="Run somewhere else"
              className={`flex items-center rounded-r-md border-l border-background/25 px-1.5 ${filled}`}
            >
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Run somewhere else</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          {currentCwd ? (
            <>
              <DropdownMenuLabel className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                Current
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onRun(currentCwd)}>
                <FolderGit2 className="text-muted-foreground" />
                <span className="truncate font-mono text-[11px]">{short(currentCwd)}</span>
              </DropdownMenuItem>
            </>
          ) : null}
          {recents.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                Ran here before
              </DropdownMenuLabel>
              {recents.map((dir) => (
                <DropdownMenuItem key={dir} onSelect={() => onRun(dir)}>
                  <FolderGit2 className="text-muted-foreground" />
                  <span className="truncate font-mono text-[11px]">{short(dir)}</span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onPickCwd}>
            <FolderOpen className="text-muted-foreground" />
            Choose a folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * The shell every toolbar panel sits in.
 *
 * The six panels were written one at a time and drifted: four different
 * hardcoded widths, none resizable, and each with its own header markup and
 * body padding — so moving between them felt like moving between apps, and none
 * of them matched the node inspector beside them.
 *
 * One shell fixes all three. The width is the same persisted, draggable size
 * for every panel, because they are alternatives to each other: sizing one is a
 * statement about how much room this kind of panel gets.
 */
function SidePanel({
  title,
  onClose,
  actions,
  children
}: {
  title: string
  onClose: () => void
  /** Buttons for the header, left of the close control. */
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const width = usePanelSizesStore((st) => st.flowPanelWidth)
  return (
    <>
      <ResizeHandle
        side="right"
        label={`Resize ${title}`}
        {...handleBinding('flowPanelWidth')}
        onSize={(px) => usePanelSizesStore.getState().setSize('flowPanelWidth', px)}
        onReset={() => usePanelSizesStore.getState().resetSize('flowPanelWidth')}
      />
      <div
        className="flex shrink-0 flex-col overflow-hidden border-l border-border/55 bg-card"
        style={{ width }}
      >
        {/* Same height and padding as the node inspector's header, so switching
            between them does not shift the title. */}
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/55 pl-4 pr-2">
          <span className="min-w-0 flex-1 truncate text-[0.92em] font-semibold text-foreground">
            {title}
          </span>
          {actions}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
              >
                <X className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
      </div>
    </>
  )
}

// --- Flow Details Panel ---

/**
 * The flow itself: what it is called, what it does, and whose it is.
 *
 * The name was editable in the breadcrumb and the project only from the rail's
 * context menu, and a description could not be set at all — despite being what
 * the Saved and Templates cards show, and what the rail puts in a row's hover.
 * So a flow you made had a blank card forever, with nowhere to fix it.
 */
function FlowDetailsPanel({
  workflow,
  onChange,
  onClose
}: {
  workflow: WorkflowDefinition
  onChange: (patch: Partial<WorkflowDefinition>) => void
  onClose: () => void
}): React.JSX.Element {
  const projects = useSessionsStore((s) => s.projects)
  const nodes = workflow.nodes.length
  const prompts = workflow.nodes.filter((n) => n.data.type === 'prompt').length

  return (
    <SidePanel title="Flow details" onClose={onClose}>
      <>
        <Field label="Name">
          <input
            value={workflow.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className={CTL}
          />
        </Field>

        <Field
          label="Description"
          hint="Shown on the flow's card and when you hover it in the sidebar."
        >
          <textarea
            value={workflow.description ?? ''}
            onChange={(e) => onChange({ description: e.target.value || undefined })}
            rows={3}
            placeholder="What does this flow do?"
            className={`${CTL} resize-none text-[0.85em] leading-relaxed`}
          />
        </Field>

        <Field
          label="Belongs to"
          hint={
            workflow.projectId
              ? 'Runs in this project, and never asks where.'
              : 'Picks a working directory each time it runs.'
          }
        >
          <ChoiceSelect
            value={workflow.projectId ?? NONE}
            onChange={(v) => onChange({ projectId: v === NONE ? null : v })}
            options={[
              { value: NONE, label: 'Any project', hint: 'Not about one repo' },
              ...projects.map((pr) => ({ value: pr.id, label: pr.name }))
            ]}
          />
        </Field>

        <Note>
          <p>
            {nodes === 0
              ? 'Nothing in it yet — add a node to get started.'
              : `${nodes} ${nodes === 1 ? 'node' : 'nodes'}${
                  prompts > 0
                    ? `, ${prompts} of which ${prompts === 1 ? 'is a real Claude turn' : 'are real Claude turns'}`
                    : ''
                }.`}
          </p>
        </Note>
      </>
    </SidePanel>
  )
}

// --- Vars Panel ---

/**
 * The flow's variables: what it captures, who captures it, and the last value.
 *
 * Was a readout of `execution.vars` alone, which only exist while a run is in
 * flight — so at rest it said "No variables set yet" and gave you nothing to do
 * or learn. It now leads with what the flow *declares*, so it is useful while
 * building, and folds the live value in when there is one.
 */
function VarsPanel({
  workflow,
  vars,
  onSelectNode,
  onClose
}: {
  workflow: WorkflowDefinition
  vars: Record<string, string>
  onSelectNode: (nodeId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const declared = declaredVars(workflow)
  const declaredNames = new Set(declared.map((d) => d.name))
  // A run can carry a name nothing declares — a capture row that has since been
  // renamed or deleted. Worth showing rather than silently dropping.
  const orphans = Object.entries(vars).filter(([name]) => !declaredNames.has(name))

  return (
    <SidePanel title="Variables" onClose={onClose}>
      <>
        <Note>
          <p>
            A variable is output one node saved so later nodes can use it — each node runs with
            fresh context and cannot see the others.
          </p>
          <p>
            Made by the <span className="text-foreground/80">Save as variable</span> row on a
            prompt node. Read one anywhere with{' '}
            <code className="font-mono text-foreground/70">{'{{vars.name}}'}</code>.
          </p>
        </Note>

        {declared.length === 0 && orphans.length === 0 ? (
          <p className="text-[0.8em] leading-relaxed text-muted-foreground/70">
            This flow saves nothing yet. Select a prompt node and add a{' '}
            <span className="text-foreground/70">Save as variable</span> row to pass its result to
            a later node.
          </p>
        ) : null}

        {declared.map((d) => {
          const value = vars[d.name]
          return (
            <div key={d.name} className="rounded-md border border-border/55 bg-muted/30 p-2.5">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[0.8em] text-foreground/80">
                  {`{{vars.${d.name}}}`}
                </code>
                <span className="shrink-0 rounded-sm border border-border/70 px-1 py-px font-mono text-[0.65em] uppercase tracking-wide text-muted-foreground">
                  {d.kind}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onSelectNode(d.nodeId)}
                className="mt-1 flex max-w-full items-center gap-1 text-[0.77em] text-muted-foreground transition-colors hover:text-foreground/80"
              >
                <Sparkles className="size-[0.85em] shrink-0" />
                <span className="truncate">saved by {d.nodeLabel}</span>
              </button>
              {value !== undefined ? (
                <pre className="mt-1.5 max-h-32 overflow-y-auto rounded-sm bg-sidebar p-2 font-mono text-[0.77em] whitespace-pre-wrap wrap-break-word text-foreground/80">
                  {value || '(empty)'}
                </pre>
              ) : (
                <p className="mt-1.5 text-[0.77em] text-muted-foreground/60">
                  No value yet — run the flow to fill it.
                </p>
              )}
            </div>
          )
        })}

        {orphans.length > 0 && (
          <>
            <p className="pt-1 text-[0.7em] font-semibold uppercase tracking-wider text-muted-foreground/60">
              From this run only
            </p>
            {orphans.map(([name, value]) => (
              <div key={name} className="rounded-md border border-border/55 bg-muted/30 p-2.5">
                <code className="font-mono text-[0.8em] text-foreground/80">{`{{vars.${name}}}`}</code>
                <pre className="mt-1.5 max-h-32 overflow-y-auto rounded-sm bg-sidebar p-2 font-mono text-[0.77em] whitespace-pre-wrap wrap-break-word text-foreground/80">
                  {value || '(empty)'}
                </pre>
              </div>
            ))}
          </>
        )}
      </>
    </SidePanel>
  )
}

// --- Metrics Panel ---

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 1000) return `${ms}ms`
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return `${mins}m ${rem}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function MetricsPanel({
  workflowId,
  executions,
  onClose
}: {
  workflowId: string
  executions: WorkflowExecutionRecord[]
  onClose: () => void
}): React.JSX.Element {
  const [metrics, setMetrics] = useState<WorkflowMetrics | null>(null)

  useEffect(() => {
    window.api.workflow.metrics(workflowId).then((m) => setMetrics(m as WorkflowMetrics | null))
  }, [workflowId, executions.length])

  const successRate = metrics && metrics.totalRuns > 0
    ? Math.round((metrics.successRuns / metrics.totalRuns) * 100)
    : 0

  const tokens = metrics?.totalTokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const totalTok = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation

  return (
    <SidePanel title="Metrics" onClose={onClose}>
      <>
        {!metrics || metrics.totalRuns === 0 ? (
          <div className="text-[0.85em] text-muted-foreground leading-relaxed">
            No executions yet. Run this workflow to start collecting metrics.
          </div>
        ) : (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Total runs" value={String(metrics.totalRuns)} />
              <StatCard
                label="Success"
                value={`${successRate}%`}
                accent={successRate >= 80 ? 'green' : successRate >= 50 ? 'amber' : 'red'}
              />
              <StatCard label="Avg duration" value={formatDuration(metrics.avgDurationMs)} />
              <StatCard
                label="Total tokens"
                value={formatTokens(totalTok)}
                accent="blue"
              />
            </div>

            {/* Status breakdown */}
            <div>
              <div className="text-[0.77em] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                Status breakdown
              </div>
              <div className="bg-sidebar border border-border/55 rounded-sm p-2 space-y-1">
                <BreakdownRow label="Success" count={metrics.successRuns} total={metrics.totalRuns} color="bg-success" />
                <BreakdownRow label="Failed" count={metrics.failedRuns} total={metrics.totalRuns} color="bg-danger" />
                <BreakdownRow label="Aborted" count={metrics.abortedRuns} total={metrics.totalRuns} color="bg-warning" />
              </div>
            </div>

            {/* Tokens detail */}
            {totalTok > 0 && (
              <div>
                <div className="text-[0.77em] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                  Token usage
                </div>
                <div className="bg-sidebar border border-border/55 rounded-sm p-2 space-y-1 text-[0.85em] font-mono">
                  <div className="flex justify-between"><span className="text-foreground/80">Input</span><span className="text-foreground">{formatTokens(tokens.input)}</span></div>
                  <div className="flex justify-between"><span className="text-foreground/80">Output</span><span className="text-foreground">{formatTokens(tokens.output)}</span></div>
                  <div className="flex justify-between"><span className="text-foreground/80">Cache read</span><span className="text-foreground/80">{formatTokens(tokens.cacheRead)}</span></div>
                  <div className="flex justify-between"><span className="text-foreground/80">Cache write</span><span className="text-foreground/80">{formatTokens(tokens.cacheCreation)}</span></div>
                </div>
              </div>
            )}

            {/* Top failing nodes */}
            {metrics.topFailingNodes.length > 0 && (
              <div>
                <div className="text-[0.77em] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                  Most failing nodes
                </div>
                <div className="bg-sidebar border border-border/55 rounded-sm p-2 space-y-1">
                  {metrics.topFailingNodes.map((n) => (
                    <div key={n.nodeId} className="flex items-center justify-between text-[0.85em]">
                      <span className="text-foreground truncate flex-1">{n.nodeLabel}</span>
                      <span className="text-danger font-mono ml-2">{n.failures}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Last run */}
            {metrics.lastRunAt && (
              <div className="text-[0.77em] text-muted-foreground font-mono pt-1 border-t border-border/55">
                Last run: {new Date(metrics.lastRunAt).toLocaleString()} · {metrics.lastStatus}
              </div>
            )}
          </>
        )}
      </>
    </SidePanel>
  )
}

function StatCard({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent?: 'green' | 'amber' | 'red' | 'blue'
}): React.JSX.Element {
  const tone =
    accent === 'green' ? 'text-success'
      : accent === 'amber' ? 'text-warning'
        : accent === 'red' ? 'text-danger'
          : accent === 'blue' ? 'text-info'
            : 'text-foreground'
  return (
    <div className="bg-sidebar border border-border/55 rounded-sm p-2.5">
      <div className="text-[0.7em] font-mono uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${tone}`}>{value}</div>
    </div>
  )
}

function BreakdownRow({
  label,
  count,
  total,
  color
}: {
  label: string
  count: number
  total: number
  color: string
}): React.JSX.Element {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[0.85em]">
      <div className="w-16 text-foreground/80">{label}</div>
      <div className="flex-1 bg-muted/40 h-1.5 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-12 text-right font-mono text-foreground/80">{count} ({pct}%)</div>
    </div>
  )
}

// --- Triggers Panel ---

function TriggersPanel({
  workflow,
  currentCwd,
  onChange,
  onSave,
  onClose
}: {
  workflow: WorkflowDefinition
  currentCwd: string
  onChange: (triggers: WorkflowTrigger[]) => void
  onSave: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const triggers = workflow.triggers ?? []

  const addTrigger = async (kind: 'cron' | 'fileWatcher' | 'webhook'): Promise<void> => {
    const id = `trg-${Date.now()}`
    let next: WorkflowTrigger
    if (kind === 'cron') {
      next = {
        id,
        type: 'cron',
        enabled: false,
        schedule: '0 * * * *',
        cwd: currentCwd
      }
    } else if (kind === 'fileWatcher') {
      next = {
        id,
        type: 'fileWatcher',
        enabled: false,
        paths: ['**/*'],
        cwd: currentCwd,
        events: ['change'],
        debounceMs: 1000
      }
    } else {
      const { token } = await window.api.workflow.generateTriggerToken()
      next = {
        id,
        type: 'webhook',
        enabled: false,
        token,
        cwd: currentCwd
      }
    }
    onChange([...triggers, next])
  }

  const updateTrigger = (id: string, patch: Partial<WorkflowTrigger>): void => {
    onChange(triggers.map((t) => (t.id === id ? { ...t, ...patch } as WorkflowTrigger : t)))
  }

  const removeTrigger = (id: string): void => {
    onChange(triggers.filter((t) => t.id !== id))
  }

  const testTrigger = async (id: string): Promise<void> => {
    await onSave()
    const result = await window.api.workflow.testTrigger(workflow.id, id)
    if (!result.ok) alert(`Test failed: ${result.error ?? 'unknown'}`)
  }

  return (
    <SidePanel title="Triggers" onClose={onClose}>
      <>
        <div className="flex gap-1.5">
          <button
            onClick={() => addTrigger('cron')}
            className="flex-1 text-[0.77em] text-foreground/80 bg-muted/40 border border-border rounded-sm px-2 py-1.5 hover:bg-accent"
          >
            + Schedule
          </button>
          <button
            onClick={() => addTrigger('fileWatcher')}
            className="flex-1 text-[0.77em] text-foreground/80 bg-muted/40 border border-border rounded-sm px-2 py-1.5 hover:bg-accent"
          >
            + File watch
          </button>
          <button
            onClick={() => addTrigger('webhook')}
            className="flex-1 text-[0.77em] text-foreground/80 bg-muted/40 border border-border rounded-sm px-2 py-1.5 hover:bg-accent"
          >
            + Webhook
          </button>
        </div>

        {triggers.length === 0 && (
          <div className="text-[0.85em] text-muted-foreground leading-relaxed">
            No triggers configured. Add a schedule, file watcher, or webhook to fire this workflow
            automatically. Changes take effect after Save.
          </div>
        )}

        {triggers.map((t) => (
          <TriggerCard
            key={t.id}
            workflowId={workflow.id}
            trigger={t}
            onUpdate={(patch) => updateTrigger(t.id, patch)}
            onRemove={() => removeTrigger(t.id)}
            onTest={() => testTrigger(t.id)}
          />
        ))}

        <p className="text-[0.7em] text-muted-foreground/70 leading-relaxed pt-2 border-t border-border/55">
          Triggers require this app to stay running. Changes are applied on Save.
        </p>
      </>
    </SidePanel>
  )
}

function TriggerCard({
  workflowId,
  trigger,
  onUpdate,
  onRemove,
  onTest
}: {
  workflowId: string
  trigger: WorkflowTrigger
  onUpdate: (patch: Partial<WorkflowTrigger>) => void
  onRemove: () => void
  onTest: () => void
}): React.JSX.Element {
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)

  useEffect(() => {
    if (trigger.type !== 'webhook') return
    window.api.workflow
      .webhookUrl(workflowId, trigger.id, trigger.token)
      .then((r) => setWebhookUrl(r.url))
  }, [trigger, workflowId])

  const typeColor =
    trigger.type === 'cron' ? 'text-muted-foreground bg-muted-foreground/10'
      : trigger.type === 'fileWatcher' ? 'text-success bg-success/10'
        : 'text-info bg-info/10'
  const typeLabel =
    trigger.type === 'cron' ? 'SCHEDULE'
      : trigger.type === 'fileWatcher' ? 'FILE WATCHER'
        : 'WEBHOOK'

  const copyUrl = (): void => {
    if (webhookUrl) navigator.clipboard.writeText(webhookUrl).catch(() => {})
  }

  return (
    <div className="bg-sidebar border border-border rounded-md p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[0.62em] font-bold tracking-wider font-mono px-1.5 py-0.5 rounded-sm ${typeColor}`}>
          {typeLabel}
        </span>
        <input
          value={trigger.name ?? ''}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Label (optional)"
          className="flex-1 bg-transparent text-[0.85em] text-foreground focus:outline-hidden min-w-0"
        />
        <label className="flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={trigger.enabled}
            onChange={(e) => onUpdate({ enabled: e.target.checked })}
            className="accent-success w-3 h-3"
          />
          <span className="text-[0.77em] text-foreground/80">on</span>
        </label>
      </div>

      {trigger.type === 'cron' && (
        <>
          <div>
            <label className="text-[0.7em] text-muted-foreground block mb-0.5">Cron schedule</label>
            <input
              value={trigger.schedule}
              onChange={(e) => onUpdate({ schedule: e.target.value })}
              placeholder="*/15 * * * *"
              className="w-full bg-card border border-border rounded-sm px-2 py-1 text-[0.85em] text-foreground font-mono focus:border-muted-foreground/40 focus:outline-hidden"
            />
            <p className="text-[0.7em] text-muted-foreground/70 mt-0.5 font-mono">
              e.g. <span className="text-muted-foreground/70">0 9 * * 1-5</span> (9am weekdays)
            </p>
          </div>
          <CwdField cwd={trigger.cwd} onChange={(cwd) => onUpdate({ cwd })} />
        </>
      )}

      {trigger.type === 'fileWatcher' && (
        <>
          <div>
            <label className="text-[0.7em] text-muted-foreground block mb-0.5">Paths (glob, one per line)</label>
            <textarea
              value={trigger.paths.join('\n')}
              onChange={(e) => onUpdate({ paths: e.target.value.split('\n').map((p) => p.trim()).filter(Boolean) })}
              rows={2}
              placeholder="src/**/*.ts"
              className="w-full bg-card border border-border rounded-sm px-2 py-1 text-[0.85em] text-foreground font-mono resize-none focus:border-success/40 focus:outline-hidden"
            />
          </div>
          <CwdField cwd={trigger.cwd} onChange={(cwd) => onUpdate({ cwd })} />
          <div className="flex gap-3">
            {(['add', 'change', 'unlink'] as const).map((ev) => (
              <label key={ev} className="flex items-center gap-1 text-[0.77em] text-foreground/80 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trigger.events?.includes(ev) ?? false}
                  onChange={(e) => {
                    const current = new Set(trigger.events ?? [])
                    if (e.target.checked) current.add(ev)
                    else current.delete(ev)
                    onUpdate({ events: Array.from(current) })
                  }}
                  className="accent-success w-3 h-3"
                />
                {ev}
              </label>
            ))}
          </div>
          <div>
            <label className="text-[0.7em] text-muted-foreground block mb-0.5">Debounce (ms)</label>
            <input
              type="number"
              min={0}
              value={trigger.debounceMs ?? 1000}
              onChange={(e) => onUpdate({ debounceMs: parseInt(e.target.value, 10) || 0 })}
              className="w-24 bg-card border border-border rounded-sm px-2 py-1 text-[0.85em] text-foreground font-mono focus:outline-hidden"
            />
          </div>
        </>
      )}

      {trigger.type === 'webhook' && (
        <>
          <CwdField cwd={trigger.cwd} onChange={(cwd) => onUpdate({ cwd })} />
          <div>
            <label className="text-[0.7em] text-muted-foreground block mb-0.5">URL (local only)</label>
            <div className="flex gap-1">
              <input
                value={webhookUrl ?? 'Server not running'}
                readOnly
                className="flex-1 bg-card border border-border rounded-sm px-2 py-1 text-[0.77em] text-foreground/80 font-mono focus:outline-hidden"
              />
              <button
                onClick={copyUrl}
                disabled={!webhookUrl}
                className="text-[0.77em] text-foreground/80 bg-accent/50 border border-border rounded-sm px-2 py-1 hover:bg-secondary disabled:opacity-40"
              >
                Copy
              </button>
            </div>
            <p className="text-[0.7em] text-muted-foreground/70 mt-0.5">
              POST to fire. JSON body becomes input values. Token-gated.
            </p>
          </div>
        </>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onTest}
          className="text-[0.77em] text-info/80 hover:text-info px-2 py-0.5"
        >
          Test now
        </button>
        <button
          onClick={onRemove}
          className="text-[0.77em] text-danger/60 hover:text-danger px-2 py-0.5"
        >
          Remove
        </button>
      </div>
    </div>
  )
}

function CwdField({
  cwd,
  onChange
}: {
  cwd: string
  onChange: (cwd: string) => void
}): React.JSX.Element {
  const pick = async (): Promise<void> => {
    const picked = await window.api.dialog.pickFolder()
    if (picked) onChange(picked)
  }
  return (
    <div>
      <label className="text-[0.7em] text-muted-foreground block mb-0.5">Working directory</label>
      <div className="flex gap-1">
        <input
          value={cwd}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/path/to/project"
          className="flex-1 bg-card border border-border rounded-sm px-2 py-1 text-[0.85em] text-foreground font-mono focus:outline-hidden min-w-0"
        />
        <button
          onClick={pick}
          className="text-[0.77em] text-foreground/80 bg-accent/50 border border-border rounded-sm px-2 py-1 hover:bg-secondary"
        >
          Pick…
        </button>
      </div>
    </div>
  )
}

// --- History Panel ---

function HistoryPanel({
  workflowId,
  onClose
}: {
  workflowId: string
  onClose: () => void
}): React.JSX.Element {
  const { executions, setExecutions } = useWorkflowStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = executions.find((r) => r.id === selectedId)

  const refresh = async (): Promise<void> => {
    const recs = (await window.api.workflow.listExecutions(workflowId)) as WorkflowExecutionRecord[]
    setExecutions(recs)
  }
  useEffect(() => {
    refresh()
  }, [workflowId])

  const del = async (id: string): Promise<void> => {
    await window.api.workflow.deleteExecution(id)
    if (selectedId === id) setSelectedId(null)
    refresh()
  }

  return (
    <SidePanel title="Execution history" onClose={onClose}>
      <>
        {executions.length === 0 && (
          <p className="text-[10px] text-muted-foreground/70 italic">No past executions.</p>
        )}
        {executions.map((rec) => (
          <div
            key={rec.id}
            onClick={() => setSelectedId(rec.id)}
            className={`bg-sidebar border rounded-md p-2.5 cursor-pointer transition-colors ${
              selectedId === rec.id
                ? 'border-info/40'
                : 'border-border/55 hover:border-border-strong'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                    rec.status === 'done'
                      ? 'bg-success/15 text-success'
                      : rec.status === 'failed'
                        ? 'bg-danger/15 text-danger'
                        : 'bg-warning/15 text-warning'
                  }`}
                >
                  {rec.status}
                </span>
                <span className="text-[10px] text-foreground/80 font-mono">
                  {new Date(rec.startedAt).toLocaleString()}
                </span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); del(rec.id) }}
                className="text-[10px] text-danger/60 hover:text-danger"
              >
                ×
              </button>
            </div>
            <div className="text-[9px] text-muted-foreground mt-1 font-mono">
              {Math.round((rec.finishedAt - rec.startedAt) / 1000)}s ·{' '}
              {Object.keys(rec.nodeStates).length} nodes
              {Object.keys(rec.finalVars).length > 0
                ? ` · ${Object.keys(rec.finalVars).length} vars`
                : ''}
            </div>
            {rec.error && (
              <div className="text-[9px] text-danger/70 mt-1 truncate">{rec.error}</div>
            )}
          </div>
        ))}

        {selected && (
          <div className="mt-3 bg-sidebar border border-border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-foreground">Details</span>
              <button
                onClick={() => replayIntoCurrent(selected)}
                className="text-[9px] text-info/80 hover:text-info font-mono"
              >
                load inputs/vars →
              </button>
            </div>
            {Object.keys(selected.inputValues).length > 0 && (
              <div>
                <div className="text-[9px] text-muted-foreground mb-1">Inputs</div>
                {Object.entries(selected.inputValues).map(([k, v]) => (
                  <div key={k} className="text-[9px] font-mono text-foreground/80">
                    <span className="text-info">{k}</span>={v.slice(0, 60)}
                    {v.length > 60 ? '…' : ''}
                  </div>
                ))}
              </div>
            )}
            {Object.keys(selected.finalVars).length > 0 && (
              <div>
                <div className="text-[9px] text-muted-foreground mb-1">Final Variables</div>
                {Object.entries(selected.finalVars).map(([k, v]) => (
                  <div key={k} className="text-[9px] font-mono text-foreground/80">
                    <span className="text-success">{k}</span>=
                    {v.slice(0, 60)}
                    {v.length > 60 ? '…' : ''}
                  </div>
                ))}
              </div>
            )}
            <div>
              <div className="text-[9px] text-muted-foreground mb-1">Nodes</div>
              {Object.values(selected.nodeStates).map((ns) => (
                <div key={ns.nodeId} className="text-[9px] font-mono text-foreground/80 flex gap-2">
                  <span
                    className={
                      ns.status === 'done'
                        ? 'text-success'
                        : ns.status === 'failed'
                          ? 'text-danger'
                          : ns.status === 'skipped'
                            ? 'text-warning/60'
                            : 'text-muted-foreground'
                    }
                  >
                    {ns.status}
                  </span>
                  <span>{ns.nodeId}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    </SidePanel>
  )
}

function replayIntoCurrent(rec: WorkflowExecutionRecord): void {
  const { currentWorkflow, setExecution } = useWorkflowStore.getState()
  if (!currentWorkflow || currentWorkflow.id !== rec.workflowId) return
  setExecution({
    id: rec.id,
    workflowId: rec.workflowId,
    status: rec.status === 'done' ? 'done' : rec.status === 'failed' ? 'failed' : 'aborted',
    nodeStates: rec.nodeStates,
    vars: rec.finalVars,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt
  })
}

function RunDialog({
  inputs,
  onRun,
  onCancel
}: {
  inputs: WorkflowInputVar[]
  onRun: (values: Record<string, string>) => void
  onCancel: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const input of inputs) init[input.key] = input.defaultValue ?? ''
    return init
  })

  const hasEmptyInputs = inputs.some((inp) => !values[inp.key]?.trim())

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (hasEmptyInputs) return
    onRun(values)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <form
        onSubmit={handleSubmit}
        className="bg-card border border-border-strong rounded-xl w-[440px] max-h-[80vh] flex flex-col shadow-2xl"
      >
        <div className="px-5 py-4 border-b border-border/55">
          <h2 className="text-sm font-semibold text-foreground">Run Workflow</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">Fill in the inputs before running</p>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
          {inputs.map((input) => (
            <div key={input.key}>
              <label className="text-[11px] font-medium text-foreground/80 block mb-1.5">
                {input.label}
              </label>
              <textarea
                value={values[input.key] ?? ''}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [input.key]: e.target.value }))
                }
                placeholder={input.placeholder}
                rows={2}
                className="w-full bg-sidebar border border-border-strong rounded-lg px-3 py-2 text-xs text-foreground placeholder-muted-foreground/70 font-mono resize-none focus:border-info/40 focus:outline-hidden"
              />
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-border/55 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-[11px] text-foreground/80 bg-accent/50 px-4 py-1.5 rounded-md hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={hasEmptyInputs}
            className="text-[11px] font-semibold text-success-foreground bg-success px-4 py-1.5 rounded-md hover:bg-success disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ▶ Run
          </button>
        </div>
      </form>
    </div>
  )
}

function ReviewDialog({ request }: { request: ReviewRequest }): React.JSX.Element {
  const { popReview } = useWorkflowStore()

  const respond = async (approved: boolean): Promise<void> => {
    await window.api.workflow.reviewResponse(request.executionId, request.nodeId, approved)
    popReview(request.nodeId)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-warning/30 rounded-xl w-[560px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="px-5 py-4 border-b border-border/55">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 bg-warning rounded-full animate-pulse" />
            <h2 className="text-sm font-semibold text-foreground">Human Review Needed</h2>
            <span className="text-[9px] font-mono text-warning/70">{request.label}</span>
          </div>
          {request.message && (
            <p className="text-[11px] text-foreground/80 mt-1 leading-relaxed">{request.message}</p>
          )}
        </div>
        <div className="px-5 py-3 border-b border-border/55 space-y-2 overflow-y-auto flex-1 max-h-[50vh]">
          <div>
            <div className="text-[10px] font-medium text-muted-foreground mb-1">Previous Node Output</div>
            <pre className="bg-sidebar border border-border/55 rounded-md p-3 text-[11px] text-foreground/80 font-mono whitespace-pre-wrap wrap-break-word max-h-60 overflow-y-auto">
              {request.prevOutput || '(empty)'}
            </pre>
          </div>
          {Object.keys(request.vars).length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground mb-1">Workflow Variables</div>
              <div className="bg-sidebar border border-border/55 rounded-md p-3">
                {Object.entries(request.vars).map(([k, v]) => (
                  <div key={k} className="text-[10px] font-mono text-foreground/80">
                    <span className="text-success">{k}</span>={v.slice(0, 120)}
                    {v.length > 120 ? '…' : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2">
          <button
            onClick={() => respond(false)}
            className="text-[11px] text-danger bg-danger/15 border border-danger/30 px-4 py-1.5 rounded-md hover:bg-danger/25"
          >
            ✕ Reject
          </button>
          <button
            onClick={() => respond(true)}
            className="text-[11px] font-semibold text-success-foreground bg-success px-4 py-1.5 rounded-md hover:bg-success"
          >
            ✓ Approve
          </button>
        </div>
      </div>
    </div>
  )
}

function InputsEditor({
  inputs,
  onChange,
  onClose
}: {
  inputs: WorkflowInputVar[]
  onChange: (inputs: WorkflowInputVar[]) => void
  onClose: () => void
}): React.JSX.Element {
  const addInput = (): void => {
    onChange([...inputs, { key: '', label: '', placeholder: '' }])
  }
  const updateInput = (index: number, patch: Partial<WorkflowInputVar>): void => {
    onChange(inputs.map((inp, i) => (i === index ? { ...inp, ...patch } : inp)))
  }
  const removeInput = (index: number): void => {
    onChange(inputs.filter((_, i) => i !== index))
  }

  return (
    <SidePanel
      title="Flow inputs"
      onClose={onClose}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={addInput}
              aria-label="Add an input"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
            >
              <Plus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Add an input</TooltipContent>
        </Tooltip>
      }
    >
      <>
        <Note>
          <p>
            Filled in when the flow is run. Reference one with{' '}
            <code className="font-mono text-foreground/70">{'{{input.key}}'}</code> in any prompt.
          </p>
        </Note>

        {inputs.length === 0 ? (
          <p className="text-[0.8em] leading-relaxed text-muted-foreground/70">
            No inputs. Without any, the flow runs straight away rather than asking you anything
            first.
          </p>
        ) : null}

        {inputs.map((inp, i) => (
          // Keyed by index because the key field is what is being edited — a
          // key-based React key would remount the input on every keystroke and
          // lose focus after one character.
          <div
            key={i}
            className="space-y-2.5 rounded-md border border-border/55 bg-muted/30 p-2.5"
          >
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[0.8em] text-muted-foreground">
                {inp.key ? `{{input.${inp.key}}}` : 'Name it to use it'}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => removeInput(i)}
                    aria-label={`Remove ${inp.label || inp.key || 'this input'}`}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-danger"
                  >
                    <X className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove</TooltipContent>
              </Tooltip>
            </div>

            <Field label="Name">
              <input
                value={inp.key}
                placeholder="company"
                onChange={(e) =>
                  updateInput(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })
                }
                className={`${CTL} font-mono text-[0.85em]`}
              />
            </Field>

            <Field label="Asks for">
              <input
                value={inp.label}
                placeholder="Company name or URL"
                onChange={(e) => updateInput(i, { label: e.target.value })}
                className={CTL}
              />
            </Field>

            <Field label="Placeholder">
              <input
                value={inp.placeholder ?? ''}
                placeholder="acme.com"
                onChange={(e) => updateInput(i, { placeholder: e.target.value })}
                className={CTL}
              />
            </Field>
          </div>
        ))}
      </>
    </SidePanel>
  )
}

// --- Templates View ---

type TemplatesTab = 'builtin' | 'marketplace' | 'saved'

/** What drives a flow, for the line under its description. */
function templateDriver(tpl: WorkflowDefinition): string {
  const parallel = tpl.nodes.filter((n) => n.data.type === 'parallel').length
  const loops = tpl.nodes.filter((n) => n.data.type === 'loop').length
  const cron = (tpl.triggers ?? []).some((t) => t.type === 'cron')
  const review = tpl.nodes.some((n) => n.data.type === 'humanReview')
  const bits = [`${tpl.nodes.length} nodes`]
  if (parallel) bits.push('runs in parallel')
  else if (loops) bits.push('loops')
  else if (cron) bits.push('cron')
  if (review) bits.push('pauses for you')
  return bits.join(' · ')
}

/**
 * One card, used by every flow grid.
 *
 * Built-in, saved and marketplace each had their own card, so three lists that
 * do the same job looked like three features. Same shell, same columns: a
 * picture of the graph on the left, name and description in the middle, one
 * mono line of meta underneath.
 */
const FLOW_CARD = 'flex gap-3.5 rounded-lg border border-border/55 bg-card p-3.5 text-left'

function FlowCard({
  art,
  title,
  description,
  meta,
  trailing,
  footer,
  onClick
}: {
  art: React.ReactNode
  title: string
  description?: string
  meta?: string
  trailing?: React.ReactNode
  footer?: React.ReactNode
  onClick?: () => void
}): React.JSX.Element {
  const body = (
    <>
      <div className="flex w-[52px] shrink-0 items-start justify-center pt-0.5">{art}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[1em] font-semibold text-foreground">{title}</span>
          {trailing}
        </div>
        {description ? (
          <span className="text-[0.85em] leading-relaxed text-muted-foreground">{description}</span>
        ) : null}
        {meta ? (
          <span className="truncate font-mono text-[0.7em] text-muted-foreground/70">{meta}</span>
        ) : null}
        {footer}
      </div>
    </>
  )

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${FLOW_CARD} transition-colors hover:border-border-strong hover:bg-accent/30`}
    >
      {body}
    </button>
  ) : (
    <div className={FLOW_CARD}>{body}</div>
  )
}

/** Node count, what wakes the flow, and when it last ran. */
function savedFlowMeta(wf: WorkflowDefinition): string {
  const bits = [`${wf.nodes.length} node${wf.nodes.length === 1 ? '' : 's'}`]
  const trigger = triggerSummary(wf)
  if (trigger) bits.push(trigger)
  bits.push(`updated ${new Date(wf.updatedAt).toLocaleDateString()}`)
  return bits.join(' · ')
}

function TemplateCard({
  tpl,
  onUse
}: {
  tpl: WorkflowDefinition
  onUse: () => void
}): React.JSX.Element {
  return (
    <FlowCard
      art={<FlowSilhouette nodes={tpl.nodes} edges={tpl.edges} />}
      title={tpl.name}
      description={tpl.description}
      meta={templateDriver(tpl)}
      onClick={onUse}
    />
  )
}

/**
 * What you see before you have made anything.
 *
 * Deliberately the pitch, not a shrug: one line on what a flow is, then real
 * templates with their shape drawn, so the structure is legible before the
 * words. Starting blank comes last, because a blank canvas teaches nothing.
 */
function FlowsEmptyState({
  templates,
  onUseTemplate,
  onCreateNew,
  onBrowseMarketplace,
  onImport
}: {
  templates: WorkflowDefinition[]
  onUseTemplate: (tpl: WorkflowDefinition) => void
  onCreateNew: () => void
  onBrowseMarketplace: () => void
  onImport: () => void
}): React.JSX.Element {
  // Four is what fits two rows without scrolling; the rest are a click away.
  const featured = templates.slice(0, 4)

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-background px-10 py-8">
      <div className="flex w-full max-w-[760px] flex-col items-center gap-7">
        <div className="flex flex-col items-center gap-2.5">
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
            Run Claude more than once
          </h1>
          <p className="max-w-[540px] text-center text-[0.96em] leading-relaxed text-muted-foreground">
            A flow wires prompts, shell commands and conditions into a graph. Run it yourself, on a
            schedule, when a file changes, or from a webhook.
          </p>
        </div>

        {featured.length > 0 && (
          <div className="grid w-full grid-cols-2 gap-3">
            {featured.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} onUse={() => onUseTemplate(tpl)} />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2 text-[0.88em] text-muted-foreground/70">
          <span>or</span>
          <button
            type="button"
            onClick={onCreateNew}
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Plus className="size-3" />
            start from blank
          </button>
          <span>and drag nodes in yourself,</span>
          <button
            type="button"
            onClick={templates.length > 4 ? onBrowseMarketplace : onImport}
            className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
          >
            {templates.length > 4 ? 'browse all templates' : 'import a flow file'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TemplatesView({
  onUseTemplate,
  onCreateNew,
  onImport,
  workflows,
  onOpenWorkflow,
  onWorkflowsChanged
}: {
  onUseTemplate: (tpl: WorkflowDefinition) => void
  onCreateNew: () => void
  onImport: () => void
  workflows: WorkflowDefinition[]
  onOpenWorkflow: (id: string) => void
  onWorkflowsChanged: () => void
}): React.JSX.Element {
  const [templates, setTemplates] = useState<WorkflowDefinition[]>([])
  const [tab, setTab] = useState<TemplatesTab>('builtin')

  useEffect(() => {
    window.api.workflow.templates().then((t) => setTemplates(t as WorkflowDefinition[]))
  }, [])

  // Nothing saved anywhere is the state this app has always been in, and the
  // feature's problem is that nobody knows what it does. So that case gets the
  // pitch rather than an empty grid behind three tabs.
  if (workflows.length === 0 && tab === 'builtin') {
    return (
      <FlowsEmptyState
        templates={templates}
        onUseTemplate={onUseTemplate}
        onCreateNew={onCreateNew}
        onBrowseMarketplace={() => setTab('marketplace')}
        onImport={onImport}
      />
    )
  }

  return (
    <div
      className="nyra-flow-canvas flex h-full flex-col"
      style={{ fontSize: 'var(--ui-font-size, 13px)' }}
    >
      <div className="flex h-[46px] shrink-0 items-center gap-3 border-b border-border/55 bg-card px-4">
        {/* No back arrow here. This is the top of Flow mode, so an arrow beside
            the title reads as "up one level" and instead dropped you into Chat.
            Leaving the mode is the sidebar's Chat/Flow toggle, which is always
            visible and says which mode you are in. */}
        <span className="text-[1.08em] font-semibold text-foreground">Flows</span>
        {/* Same pill as the Chat/Flow toggle, so a segmented control means one
            thing across the app. No colour per tab: colour is for run status. */}
        <div className="ml-3 flex shrink-0 items-center rounded-full border border-border/70 bg-background/60 p-[2px]">
          {(
            [
              ['builtin', `Built-in${templates.length ? ` · ${templates.length}` : ''}`],
              ['marketplace', 'Marketplace'],
              ['saved', `Saved${workflows.length ? ` · ${workflows.length}` : ''}`]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-full px-2.5 py-[3px] text-[0.85em] transition-colors ${
                tab === id
                  ? 'bg-secondary font-semibold text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground/80'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          onClick={onImport}
          className="rounded-sm border border-border bg-muted px-3 py-1 text-[0.77em] text-foreground/80 hover:bg-accent"
        >
          Import…
        </button>
        <button
          onClick={onCreateNew}
          className="rounded-sm bg-foreground px-3 py-1 text-[0.77em] font-semibold text-background hover:opacity-90"
        >
          + New flow
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'builtin' && (
          <div className="grid grid-cols-2 gap-3">
            {templates.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} onUse={() => onUseTemplate(tpl)} />
            ))}
          </div>
        )}

        {tab === 'marketplace' && (
          <MarketplaceTab installedWorkflows={workflows} onInstalled={onWorkflowsChanged} />
        )}

        {tab === 'saved' &&
          (workflows.length === 0 ? (
            <div className="text-[0.92em] text-muted-foreground">
              No saved flows yet. Start from a template, the marketplace, or a blank canvas.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {workflows.map((wf) => (
                <FlowCard
                  key={wf.id}
                  art={<FlowSilhouette nodes={wf.nodes} edges={wf.edges} />}
                  title={wf.name}
                  description={wf.description}
                  meta={savedFlowMeta(wf)}
                  trailing={
                    wf.marketplaceId ? (
                      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.7em] text-muted-foreground">
                        v{wf.marketplaceVersion ?? '?'}
                      </span>
                    ) : undefined
                  }
                  onClick={() => onOpenWorkflow(wf.id)}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

// --- Marketplace Tab ---

function MarketplaceTab({
  installedWorkflows,
  onInstalled
}: {
  installedWorkflows: WorkflowDefinition[]
  onInstalled: () => void
}): React.JSX.Element {
  const [state, setState] = useState<{
    loading: boolean
    error?: string
    index?: MarketplaceIndex
  }>({ loading: true })
  const [installing, setInstalling] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = async (force = false): Promise<void> => {
    setState({ loading: true })
    const result = await window.api.workflow.marketplaceList(force)
    setState({ loading: false, index: result.index, error: result.error })
  }

  useEffect(() => { load(false) }, [])

  // Map: marketplaceId → installed version (so we can show "installed / update")
  const installedById = useMemo(() => {
    const m = new Map<string, string>()
    for (const wf of installedWorkflows) {
      if (wf.marketplaceId) m.set(wf.marketplaceId, wf.marketplaceVersion ?? '0.0.0')
    }
    return m
  }, [installedWorkflows])

  const install = async (entry: MarketplaceEntry): Promise<void> => {
    setInstalling(entry.id)
    const result = await window.api.workflow.marketplaceInstall(entry)
    setInstalling(null)
    if (result.error) {
      alert(`Install failed: ${result.error}`)
      return
    }
    onInstalled()
  }

  const filteredEntries = useMemo(() => {
    if (!state.index) return []
    const q = query.trim().toLowerCase()
    if (!q) return state.index.templates
    return state.index.templates.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [state.index, query])

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, tag, or author…"
          className="flex-1 rounded-md border border-border bg-sidebar px-3 py-1.5 text-[0.92em] text-foreground focus:border-border-strong focus:outline-hidden"
        />
        <button
          onClick={() => load(true)}
          disabled={state.loading}
          className="text-[0.77em] text-foreground/80 bg-accent/50 border border-border px-3 py-1.5 rounded-sm hover:bg-accent disabled:opacity-40"
        >
          {state.loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => window.api.workflow.marketplaceOpen()}
              className="text-[0.77em] text-foreground/80 hover:text-foreground px-2"
            >
              Open repo ↗
            </button>
          </TooltipTrigger>
          <TooltipContent>Open the marketplace repo on GitHub</TooltipContent>
        </Tooltip>
      </div>

      {state.error && (
        <div className="bg-warning/10 border border-warning/20 text-[0.85em] text-warning rounded-md px-3 py-2 mb-4">
          {state.error}
        </div>
      )}

      {state.loading && !state.index && (
        <div className="text-[0.92em] text-muted-foreground">Loading marketplace…</div>
      )}

      {state.index && filteredEntries.length === 0 && !state.loading && (
        <div className="text-[0.92em] text-muted-foreground">
          {query ? `No templates match "${query}".` : 'No templates available.'}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {filteredEntries.map((entry) => {
          const installedVersion = installedById.get(entry.id)
          const upToDate = installedVersion === entry.version
          const updateAvailable = installedVersion && installedVersion !== entry.version
          return (
            <FlowCard
              key={entry.id}
              // A marketplace entry is metadata; its graph only arrives on
              // install, so there is no silhouette to draw yet.
              art={<Store className="mt-0.5 size-5 text-muted-foreground/50" />}
              title={entry.name}
              description={entry.description}
              meta={`by ${entry.author}${entry.tags.length ? ` · ${entry.tags.slice(0, 3).join(' · ')}` : ''}`}
              trailing={
                <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.7em] text-muted-foreground">
                  v{entry.version}
                </span>
              }
              footer={
                <button
                  onClick={() => install(entry)}
                  disabled={installing === entry.id || upToDate}
                  className={`mt-1.5 rounded-[5px] py-1 text-[0.81em] font-semibold ${
                    upToDate
                      ? 'cursor-default border border-border text-muted-foreground'
                      : updateAvailable
                        ? 'bg-warning text-warning-foreground hover:opacity-90'
                        : 'bg-foreground text-background hover:opacity-90'
                  } disabled:opacity-60`}
                >
                  {installing === entry.id
                    ? 'Installing…'
                    : upToDate
                      ? `Installed v${installedVersion}`
                      : updateAvailable
                        ? `Update to v${entry.version}`
                        : 'Install'}
                </button>
              }
            />
          )
        })}
      </div>

      {state.index && (
        <div className="text-[0.7em] text-muted-foreground/70 font-mono mt-6 text-right">
          Updated {state.index.updatedAt}
        </div>
      )}
    </div>
  )
}
