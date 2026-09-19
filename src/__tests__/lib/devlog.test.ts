import { afterAll, describe, expect, it } from 'vitest'
import { formatConsoleArgs, resetDevLog } from '@renderer/lib/devlog'

// Importing the module patches the console — that is the point of it, and it
// happens at evaluation so a module-level throw anywhere is still caught. Put
// it back before any other suite in this worker sees it.
afterAll(() => resetDevLog())

describe('formatConsoleArgs', () => {
  it('leaves a top-level string alone and quotes a nested one', () => {
    expect(formatConsoleArgs(['loaded', 3, true])).toBe('loaded 3 true')
    expect(formatConsoleArgs([{ path: 'a/b' }])).toBe('{path: "a/b"}')
  })

  it('keeps an Error message, which WebKit’s stack leaves out', () => {
    const err = new Error('the composer never mounted')
    err.stack = 'render@http://localhost:1420/x.js:1:2'

    const line = formatConsoleArgs([err])

    // The bug this pins: taking `stack` alone dropped the message, because
    // unlike V8, WebKit does not prefix the stack with `Name: message`.
    expect(line).toContain('Error: the composer never mounted')
    expect(line).toContain('render@http://localhost:1420/x.js:1:2')
  })

  it('does not repeat the header when the engine already included it', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at render (x.js:1:2)'
    expect(formatConsoleArgs([err])).toBe('Error: boom\n    at render (x.js:1:2)')
  })

  it('survives a cycle instead of throwing inside the logger', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    expect(formatConsoleArgs([node])).toBe('{name: "root", self: [Circular]}')
  })

  it('treats a repeated sibling as a value, not a cycle', () => {
    const shared = { id: 1 }
    expect(formatConsoleArgs([{ a: shared, b: shared }])).toBe('{a: {id: 1}, b: {id: 1}}')
  })

  it('stops descending rather than walking a deep tree', () => {
    expect(formatConsoleArgs([{ a: { b: { c: { d: 1 } } } }])).toBe('{a: {b: [Object]}}')
  })

  it('does not throw on an object that throws when read', () => {
    const hostile = {
      get boom(): never {
        throw new Error('nope')
      }
    }
    expect(() => formatConsoleArgs([hostile])).not.toThrow()
    expect(formatConsoleArgs([hostile])).toBe('[unserializable]')
  })

  it('caps a long value and says how long it was', () => {
    const line = formatConsoleArgs(['x'.repeat(5000)])
    expect(line.length).toBeLessThan(2100)
    expect(line).toContain('(5000 chars)')
  })

  it('caps the number of arguments', () => {
    const line = formatConsoleArgs(Array.from({ length: 12 }, (_, i) => i))
    expect(line).toContain('0 1 2 3 4 5 6 7')
    expect(line).toContain('… 4 more args')
  })

  it('renders a DOM node as a tag, not as its whole subtree', () => {
    const el = document.createElement('div')
    el.id = 'composer'
    el.className = 'rounded border'
    el.innerHTML = '<span>'.repeat(50)
    expect(formatConsoleArgs([el])).toBe('<div#composer.rounded.border>')
  })

  it('names a class instance so the shape is recognisable', () => {
    class Session {
      constructor(readonly id: string) {}
    }
    expect(formatConsoleArgs([new Session('abc')])).toBe('Session {id: "abc"}')
  })
})
