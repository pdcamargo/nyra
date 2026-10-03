import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverProject, installDesignDiscovery, resetDesignDiscovery } from '../../renderer/src/lib/designDiscovery'
import { useSessionsStore, type Project } from '../../renderer/src/store/sessions'

const project = (path: string): Project => ({ id: path, name: path, path, workspaceId: 'w' })

let asked: string[]
let release: (() => void) | null

beforeEach(() => {
  resetDesignDiscovery()
  asked = []
  release = null
  const api = window.api as unknown as { designSystem: Record<string, unknown> }
  api.designSystem = {
    ...(api.designSystem ?? {}),
    discover: vi.fn(
      (path: string) =>
        new Promise((done) => {
          asked.push(path)
          release = () => done({ systems: [], designs: 0 })
        })
    )
  }
})

afterEach(() => {
  vi.useRealTimers()
  useSessionsStore.setState({ projects: [] })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('finding a project’s designs', () => {
  it('asks once per project per launch, one project at a time', async () => {
    discoverProject('/a')
    discoverProject('/b')
    discoverProject('/a')
    await settle()
    expect(asked).toEqual(['/a'])
    release?.()
    await settle()
    expect(asked).toEqual(['/a', '/b'])
    release?.()
  })

  it('waits for startup to settle, then covers every project and each one added later', async () => {
    vi.useFakeTimers()
    useSessionsStore.setState({ projects: [project('/one')] })
    const stop = installDesignDiscovery()
    await vi.advanceTimersByTimeAsync(1000)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(3000)
    expect(asked).toEqual(['/one'])
    release?.()
    useSessionsStore.setState({ projects: [project('/one'), project('/two')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['/one', '/two'])
    stop()
  })
})
