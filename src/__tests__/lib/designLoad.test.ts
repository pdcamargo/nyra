import { afterEach, describe, expect, it, vi } from 'vitest'
import { FORMAT_VERSION } from '@nyra/design'
import { formatBytes, loadDesign, type DesignLoadPhase } from '../../renderer/src/lib/designLoad'
import type { DesignReadResult } from '../../renderer/src/lib/api-types'

const doc = {
  schema: FORMAT_VERSION,
  name: 'Tiny',
  artboards: [{ id: 'a', name: 'A', size: { width: 200, height: 'auto' }, root: { id: 'r', type: 'box' } }]
}

function serve(result: DesignReadResult): void {
  const design = (window.api as unknown as { design?: Record<string, unknown> }).design ?? {}
  ;(window.api as unknown as { design: Record<string, unknown> }).design = {
    ...design,
    read: vi.fn(async (_path: string, opts?: { onProgress?: (l: number, t: number) => void }) => {
      if (result.kind === 'text') {
        opts?.onProgress?.(0, result.totalBytes)
        opts?.onProgress?.(result.totalBytes, result.totalBytes)
      }
      return result
    })
  }
}

const text = (content: string): DesignReadResult => ({
  kind: 'text',
  content,
  totalBytes: content.length,
  mtimeMs: 1,
  ino: 1
})

afterEach(() => vi.restoreAllMocks())

describe('loadDesign', () => {
  it('reads, then checks, then hands back a drawable design', async () => {
    serve(text(JSON.stringify(doc)))
    const phases: DesignLoadPhase['phase'][] = []
    const out = await loadDesign('/d/tiny.nyui.json', { onPhase: (p) => phases.push(p.phase) })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.doc.artboards.map((a) => a.id)).toEqual(['a'])
    expect(out.upgrade).toBeNull()
    expect(phases[0]).toBe('reading')
    expect(phases.at(-1)).toBe('checking')
  })

  it('says a file from a newer Nyra is from a newer Nyra', async () => {
    serve(text(JSON.stringify({ ...doc, schema: FORMAT_VERSION + 1 })))
    const out = await loadDesign('/d/future.nyui.json')
    expect(out.kind).toBe('newer')
    if (out.kind === 'newer') expect(out.message).toMatch(/Update Nyra/)
  })

  it('keeps "not JSON" and "did not validate" apart', async () => {
    serve(text('{ "schema": 1, '))
    const broken = await loadDesign('/d/cut.nyui.json')
    expect(broken.kind).toBe('invalid')
    if (broken.kind === 'invalid') expect(broken.message).toMatch(/not valid JSON/)

    serve(text(JSON.stringify({ ...doc, artboards: [] })))
    const empty = await loadDesign('/d/empty.nyui.json')
    expect(empty.kind).toBe('invalid')
    if (empty.kind === 'invalid') expect(empty.issues.length).toBeGreaterThan(0)
  })

  it('passes missing and cancelled straight through', async () => {
    serve({ kind: 'missing' })
    expect((await loadDesign('/d/soon.nyui.json')).kind).toBe('missing')
    serve({ kind: 'cancelled' })
    expect((await loadDesign('/d/stopped.nyui.json')).kind).toBe('cancelled')
  })
})

describe('formatBytes', () => {
  it('reads the way the loading card says it', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(830 * 1024)).toBe('830 KB')
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB')
    expect(formatBytes(40 * 1024 * 1024)).toBe('40 MB')
  })
})
