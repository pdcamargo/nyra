import { describe, it, expect } from 'vitest'
import { sameValue, preserveIfSame } from '../../renderer/src/lib/stableEqual'

/**
 * The bug this guards: the flow canvas saves React Flow's state back into the
 * store, and a save runs before every execution. Replacing `nodes` each time
 * handed React Flow a fresh object graph, which drops every node's measured
 * size — and the edges are routed from those measurements, so the connections
 * vanished from a graph that was completely intact.
 */
describe('sameValue', () => {
  it('ignores key order, because the two sides are built differently', () => {
    // One side comes from `fromFlowNodes`, the other was parsed from JSON on
    // disk. They agree on content and disagree on ordering.
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it('ignores key order deep inside', () => {
    expect(
      sameValue(
        { id: 'n', data: { type: 'prompt', prompt: 'hi', model: 'haiku' } },
        { data: { model: 'haiku', prompt: 'hi', type: 'prompt' }, id: 'n' }
      )
    ).toBe(true)
  })

  it('treats an absent key and an undefined one as the same', () => {
    // `fromFlowNodes` writes `systemPrompt: undefined`; the disk copy omits it.
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })

  it('respects array order, which is node order', () => {
    expect(sameValue([1, 2], [2, 1])).toBe(false)
  })

  it('notices a real edit', () => {
    expect(sameValue({ prompt: 'a' }, { prompt: 'b' })).toBe(false)
    expect(sameValue([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toBe(false)
  })

  it('notices a moved node', () => {
    expect(
      sameValue({ position: { x: 0, y: 0 } }, { position: { x: 0, y: 116 } })
    ).toBe(false)
  })
})

describe('preserveIfSame', () => {
  it('hands back the original reference when nothing changed', () => {
    // Identity is the whole point: effects downstream key off it.
    const prev = [{ id: 'a', data: { type: 'script', command: 'ls' } }]
    const next = [{ data: { command: 'ls', type: 'script' }, id: 'a' }]
    expect(preserveIfSame(next, prev)).toBe(prev)
  })

  it('hands back the new one when something did', () => {
    const prev = [{ id: 'a', data: { type: 'script', command: 'ls' } }]
    const next = [{ id: 'a', data: { type: 'script', command: 'ls -la' } }]
    expect(preserveIfSame(next, prev)).toBe(next)
  })
})
