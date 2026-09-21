/**
 * What a chat is serving, as something you can click.
 *
 * `npm run dev` is a row in a Processes tab; `:5173` is a link to the thing you
 * asked for. The ports come from the process registry, which reads them out of
 * the kernel — so a pill exists exactly while something is listening, and
 * clicking it cannot land on a server that has since died.
 *
 * Unlike a PR, this goes to Nyra's own browser: it is a local page, the panel is
 * right there, and a dev server is the case that panel was built for.
 */
import React from 'react'
import { Radio } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSessionsStore } from '../store/sessions'
import { EMPTY_PROCESSES, useProcessesStore, type BgProcess } from '../store/processes'
import { startBrowserTab } from './browser/useBrowserSession'
import { useUiStore } from '../store/ui'

export type LivePort = { port: number; process: BgProcess }

/**
 * Every port this chat is serving, lowest first.
 *
 * Only running shells: a port on an exited process is a number nobody can
 * reach. Deduped across processes, because two shells in one chat occasionally
 * both report a port they share through a proxy, and one pill per port is what
 * the composer has room for.
 */
export function livePorts(processes: readonly BgProcess[]): LivePort[] {
  const seen = new Map<number, BgProcess>()
  for (const proc of processes) {
    if (proc.status !== 'running') continue
    for (const port of proc.ports ?? []) {
      if (!seen.has(port)) seen.set(port, proc)
    }
  }
  return [...seen.entries()]
    .map(([port, process]) => ({ port, process }))
    .sort((a, b) => a.port - b.port)
}

/** `localhost`, not `127.0.0.1` — the CDP path needs the name form. */
export function portUrl(port: number): string {
  return `http://localhost:${port}`
}

export function openPort(sessionId: string, port: number): void {
  useUiStore.getState().setRightPanelOpen(true)
  void startBrowserTab(sessionId, portUrl(port))
}

export function usePorts(sessionId: string | null): LivePort[] {
  const processes = useProcessesStore((s) =>
    sessionId ? (s.bySession[sessionId] ?? EMPTY_PROCESSES) : EMPTY_PROCESSES
  )
  return livePorts(processes)
}

/** Same bargain as the PR pills: on a narrow bar, one pill and a count. */
const INLINE_LIMIT = 2
const INLINE_LIMIT_COMPACT = 1

/** One row per port, for the collapsed popover. */
function PortRows({
  sessionId,
  ports
}: {
  sessionId: string
  ports: readonly LivePort[]
}): React.JSX.Element {
  return (
    <>
      {ports.map(({ port, process }) => (
        <button
          key={port}
          type="button"
          onClick={() => openPort(sessionId, port)}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50"
        >
          <Radio className="size-3.5 shrink-0 text-success" />
          <span className="shrink-0 font-mono text-[11px] text-foreground/80">:{port}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {process.description ?? process.command}
          </span>
        </button>
      ))}
    </>
  )
}

/** The composer's port pills, beside the PR pills. */
export function ComposerPortPills({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const ports = usePorts(activeSessionId)
  if (!activeSessionId || ports.length === 0) return null

  if (ports.length > (compact ? INLINE_LIMIT_COMPACT : INLINE_LIMIT)) {
    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground">
              <Radio className="size-3.5 shrink-0 text-success" />
              {ports.length} ports
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{`${ports.length} ports this chat is serving`}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" className="w-80 p-1.5">
          <PortRows sessionId={activeSessionId} ports={ports} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      {ports.map(({ port, process }) => (
        <Tooltip key={port}>
          <TooltipTrigger
            onClick={() => openPort(activeSessionId, port)}
            className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Radio className="size-3.5 shrink-0 text-success" />
            <span className="font-mono">:{port}</span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">
            {`Open ${portUrl(port)}\n${process.description ?? process.command}`}
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  )
}

/** The trailing mark on a Running row in the Pinned Summary. */
export function PortBadges({
  sessionId,
  process
}: {
  sessionId: string
  process: BgProcess
}): React.JSX.Element | null {
  const ports = process.ports ?? []
  if (ports.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {ports.map((port) => (
        <Tooltip key={port}>
          <TooltipTrigger
            onClick={(e) => {
              e.stopPropagation()
              openPort(sessionId, port)
            }}
            className="rounded px-1 font-mono text-[10px] text-success transition-colors hover:bg-accent/50"
          >
            :{port}
          </TooltipTrigger>
          <TooltipContent>{`Open ${portUrl(port)}`}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}
