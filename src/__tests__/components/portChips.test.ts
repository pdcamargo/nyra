import { describe, expect, it } from 'vitest'
import { livePorts, portUrl } from '@renderer/components/PortChips'
import type { BgProcess } from '@renderer/store/processes'

const proc = (over: Partial<BgProcess>): BgProcess => ({
  shellId: over.shellId ?? 's1',
  taskId: null,
  description: null,
  command: 'npm run dev',
  outputFile: null,
  startedAt: 0,
  endedAt: null,
  pid: 500,
  status: 'running',
  exitCode: null,
  lastOutput: null,
  lastOutputAt: null,
  ports: [],
  ...over
})

describe('livePorts', () => {
  it('lists the ports of running shells, lowest first', () => {
    const ports = livePorts([
      proc({ shellId: 'a', ports: [8787] }),
      proc({ shellId: 'b', ports: [5173, 24678] })
    ])
    expect(ports.map((p) => p.port)).toEqual([5173, 8787, 24678])
  })

  it('drops a port whose shell has stopped — nobody can reach it', () => {
    // The registry keeps the last ports on a dead shell so its row does not
    // flicker; a clickable pill for a dead server is a different matter.
    const ports = livePorts([
      proc({ shellId: 'a', ports: [3000], status: 'exited' }),
      proc({ shellId: 'b', ports: [3001], status: 'killed' }),
      proc({ shellId: 'c', ports: [3002], status: 'running' })
    ])
    expect(ports.map((p) => p.port)).toEqual([3002])
  })

  it('shows one pill per port when two shells report the same one', () => {
    const ports = livePorts([
      proc({ shellId: 'a', ports: [4000] }),
      proc({ shellId: 'b', ports: [4000] })
    ])
    expect(ports).toHaveLength(1)
    expect(ports[0].process.shellId).toBe('a')
  })

  it('keeps each port attached to the shell serving it, for the tooltip', () => {
    const ports = livePorts([
      proc({ shellId: 'web', command: 'npm run dev', ports: [5173] }),
      proc({ shellId: 'api', command: 'cargo run', ports: [8080] })
    ])
    expect(ports.find((p) => p.port === 8080)?.process.command).toBe('cargo run')
  })

  it('tolerates a process from before ports existed', () => {
    // `ports` is serde-defaulted in Rust, but a row that predates the field
    // must not throw on the way to the composer.
    const legacy = { ...proc({}), ports: undefined } as unknown as BgProcess
    expect(livePorts([legacy])).toEqual([])
  })

  it('answers nothing for a chat with no processes', () => {
    expect(livePorts([])).toEqual([])
  })
})

describe('portUrl', () => {
  it('uses the name form, which is what the CDP path needs', () => {
    // 127.0.0.1 and localhost are not interchangeable here — see lib/browser/cdp.ts.
    expect(portUrl(5173)).toBe('http://localhost:5173')
  })
})
