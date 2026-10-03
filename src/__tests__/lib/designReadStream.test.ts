import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The streamed read, against a fake channel.
 *
 * Two things the real transport does that a naive reader gets wrong: the
 * command's reply can land before the channel's last chunk, and a chunk
 * boundary can fall in the middle of a multi-byte character.
 */
type Script = (send: (msg: unknown) => void) => Promise<unknown>

let script: Script
const invoked: { command: string; args: Record<string, unknown> }[] = []

vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> {
    onmessage: (msg: T) => void = () => {}
  }
  return {
    Channel,
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
      invoked.push({ command, args })
      if (command !== 'design_read') return undefined
      const channel = args.onChunk as { onmessage: (m: unknown) => void }
      return script((m) => channel.onmessage(m))
    })
  }
})
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

const { api } = await import('../../renderer/src/lib/tauri-api')

const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

beforeEach(() => {
  invoked.length = 0
})

describe('design.read', () => {
  it('reassembles the file and reports progress against its size', async () => {
    const body = '{"name":"Résumé — ✓"}'
    const all = new TextEncoder().encode(body)
    // Split inside "é" (two bytes) and inside "✓" (three).
    const cut1 = body.indexOf('é') + 1
    const cut2 = new TextEncoder().encode(body.slice(0, body.indexOf('✓'))).length + 1
    script = async (send) => {
      send({ total: all.length })
      send(all.slice(0, cut1).buffer)
      send(all.slice(cut1, cut2).buffer)
      send(all.slice(cut2).buffer)
      return { kind: 'done', totalBytes: all.length, mtimeMs: 7, ino: 9 }
    }
    const progress: [number, number][] = []
    const out = await api.design.read('/d/r.nyui.json', { onProgress: (l, t) => progress.push([l, t]) })
    expect(out).toEqual({ kind: 'text', content: body, totalBytes: all.length, mtimeMs: 7, ino: 9 })
    expect(progress[0]).toEqual([0, all.length])
    expect(progress.at(-1)).toEqual([all.length, all.length])
  })

  it('waits for chunks still in flight when the reply lands first', async () => {
    script = async (send) => {
      send({ total: 6 })
      send(bytes('abc'))
      setTimeout(() => send(bytes('def')), 5)
      return { kind: 'done', totalBytes: 6, mtimeMs: 1, ino: 1 }
    }
    const out = await api.design.read('/d/late.nyui.json')
    expect(out.kind === 'text' && out.content).toBe('abcdef')
  })

  it('passes a missing file through, and cancels by id when aborted', async () => {
    script = async () => ({ kind: 'missing' })
    expect(await api.design.read('/d/none.nyui.json')).toEqual({ kind: 'missing' })

    const controller = new AbortController()
    script = async (send) => {
      send({ total: 10 })
      controller.abort()
      await new Promise((r) => setTimeout(r, 0))
      return { kind: 'cancelled' }
    }
    expect(await api.design.read('/d/big.nyui.json', { signal: controller.signal })).toEqual({ kind: 'cancelled' })
    const read = invoked.find((c) => c.command === 'design_read' && c.args.filePath === '/d/big.nyui.json')
    const cancel = invoked.find((c) => c.command === 'design_read_cancel')
    expect(cancel?.args.id).toBe(read?.args.id)
  })
})
