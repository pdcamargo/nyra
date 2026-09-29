import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BackgroundChip from '../../renderer/src/components/BackgroundChip'
import { useSessionsStore, type ToolCallMessage } from '../../renderer/src/store/sessions'
import { useProcessesStore, type BgProcess } from '../../renderer/src/store/processes'
import {
  announceBackgroundEnd,
  endedBetween,
  isBackgroundCall
} from '../../renderer/src/lib/backgroundCalls'

const SID = 'chat-1'

const bash = (id: string, input: Record<string, unknown>): ToolCallMessage => ({
  id: `m-${id}`,
  role: 'tool_call',
  tool_id: id,
  tool_name: 'Bash',
  input
})

const row = (shellId: string, over: Partial<BgProcess> = {}): BgProcess => ({
  shellId,
  kind: 'shell',
  taskId: null,
  description: null,
  command: 'npm test',
  outputFile: null,
  startedAt: 0,
  endedAt: null,
  pid: 1,
  status: 'running',
  exitCode: null,
  lastOutput: null,
  lastOutputAt: null,
  ports: [],
  ...over
})

beforeEach(() => {
  useProcessesStore.setState({ bySession: {} })
  useSessionsStore.setState({
    activeSessionId: SID,
    sessions: [{ id: SID, messages: [] } as never]
  })
})

describe('isBackgroundCall', () => {
  it('takes a backgrounded Bash and any Monitor, not a foreground Bash', () => {
    expect(isBackgroundCall(bash('a', { command: 'x', run_in_background: true }))).toBe(true)
    expect(isBackgroundCall(bash('a', { command: 'x' }))).toBe(false)
    expect(isBackgroundCall({ ...bash('a', {}), tool_name: 'Monitor' })).toBe(true)
  })
})

describe('BackgroundChip', () => {
  it('shimmers while the registry has the shell running', () => {
    useProcessesStore.setState({ bySession: { [SID]: [row('a')] } })
    render(<BackgroundChip message={bash('a', { command: 'npm test', description: 'Full suite', run_in_background: true })} />)
    const text = screen.getByText('Full suite running in the background')
    expect(text.className).toContain('nyra-shimmer')
  })

  it('goes quiet once it has exited', () => {
    useProcessesStore.setState({ bySession: { [SID]: [row('a', { status: 'exited', exitCode: 0 })] } })
    render(<BackgroundChip message={bash('a', { command: 'npm test', description: 'Full suite', run_in_background: true })} />)
    expect(screen.getByText('Full suite ran in the background').className).not.toContain('nyra-shimmer')
  })

  it('names a server by its port and does not shimmer forever', () => {
    useProcessesStore.setState({ bySession: { [SID]: [row('a', { ports: [8787] })] } })
    render(<BackgroundChip message={bash('a', { command: 'npm run dev', description: 'Dev server', run_in_background: true })} />)
    expect(screen.getByText('Dev server serving :8787').className).not.toContain('nyra-shimmer')
  })

  it('says what a monitor is watching', () => {
    useProcessesStore.setState({ bySession: { [SID]: [row('m', { kind: 'monitor' })] } })
    render(<BackgroundChip message={{ ...bash('m', { description: 'CI run 42' }), tool_name: 'Monitor' }} />)
    expect(screen.getByText('Watching CI run 42')).toBeTruthy()
  })
})

describe('announceBackgroundEnd', () => {
  const start = bash('a', { command: 'npm test', description: 'Full suite', run_in_background: true })

  it('writes one end line, with the exit code when it failed', () => {
    useSessionsStore.setState({ sessions: [{ id: SID, messages: [start] } as never] })
    const ended = endedBetween([row('a')], [row('a', { status: 'exited', exitCode: 1 })])
    expect(ended).toHaveLength(1)
    announceBackgroundEnd(SID, ended[0])
    announceBackgroundEnd(SID, ended[0])

    const messages = useSessionsStore.getState().sessions[0].messages as ToolCallMessage[]
    const ends = messages.filter((m) => m.tool_name === 'BackgroundEnded')
    expect(ends).toHaveLength(1)
    render(<BackgroundChip message={ends[0]} />)
    expect(screen.getByText('Full suite failed · exit 1')).toBeTruthy()
  })

  it('corrects a "finished" line once the exit code arrives', () => {
    useSessionsStore.setState({ sessions: [{ id: SID, messages: [start] } as never] })
    const failed = row('a', { status: 'exited' })
    announceBackgroundEnd(SID, endedBetween([row('a')], [failed])[0])
    const coded = row('a', { status: 'exited', exitCode: 3 })
    const later = endedBetween([failed], [coded])
    expect(later).toHaveLength(1)
    announceBackgroundEnd(SID, later[0])

    const messages = useSessionsStore.getState().sessions[0].messages as ToolCallMessage[]
    const ends = messages.filter((m) => m.tool_name === 'BackgroundEnded')
    expect(ends).toHaveLength(1)
    expect(ends[0].input.exitCode).toBe(3)
  })

  it('ignores a row that was never seen running, like one restored at launch', () => {
    expect(endedBetween([], [row('a', { status: 'exited' })])).toEqual([])
  })
})
