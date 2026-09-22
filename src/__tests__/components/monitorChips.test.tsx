import { describe, it, expect } from 'vitest'
import { liveMonitors, isMonitor, monitorLabel } from '../../renderer/src/components/MonitorChips'
import type { BgProcess } from '../../renderer/src/store/processes'

const proc = (partial: Partial<BgProcess>): BgProcess =>
  ({
    shellId: 's1',
    taskId: null,
    description: null,
    command: 'npm run dev',
    outputFile: null,
    startedAt: 1000,
    endedAt: null,
    pid: null,
    status: 'running',
    exitCode: null,
    lastOutput: null,
    lastOutputAt: null,
    ports: [],
    ...partial
  }) as BgProcess

describe('isMonitor', () => {
  it('reads a row with no kind as a shell', () => {
    // Persisted before monitors were tracked. Those rows were all shells, and
    // calling them monitors would put a watch icon on every old dev server.
    expect(isMonitor(proc({}))).toBe(false)
  })

  it('recognises a monitor', () => {
    expect(isMonitor(proc({ kind: 'monitor' }))).toBe(true)
  })

  it('does not claim a backgrounded shell', () => {
    expect(isMonitor(proc({ kind: 'shell' }))).toBe(false)
  })
})

describe('liveMonitors', () => {
  it('keeps only running monitors', () => {
    const rows = [
      proc({ shellId: 'a', kind: 'monitor', status: 'running' }),
      proc({ shellId: 'b', kind: 'monitor', status: 'exited' }),
      proc({ shellId: 'c', kind: 'shell', status: 'running' })
    ]
    expect(liveMonitors(rows).map((p) => p.shellId)).toEqual(['a'])
  })

  it('orders by when the watch was armed', () => {
    const rows = [
      proc({ shellId: 'late', kind: 'monitor', startedAt: 3000 }),
      proc({ shellId: 'early', kind: 'monitor', startedAt: 1000 })
    ]
    expect(liveMonitors(rows).map((p) => p.shellId)).toEqual(['early', 'late'])
  })

  it('is empty when nothing is watching', () => {
    expect(liveMonitors([proc({ kind: 'shell' })])).toEqual([])
  })
})

describe('monitorLabel', () => {
  it('prefers the description, which is what the tool asks for', () => {
    expect(monitorLabel(proc({ kind: 'monitor', description: 'errors in deploy.log' }))).toBe(
      'errors in deploy.log'
    )
  })

  it('falls back to the command', () => {
    expect(monitorLabel(proc({ kind: 'monitor', command: 'tail -f x.log' }))).toBe('tail -f x.log')
  })

  it('never renders an empty pill', () => {
    expect(monitorLabel(proc({ kind: 'monitor', description: '   ', command: '' }))).toBe('watching')
  })
})
