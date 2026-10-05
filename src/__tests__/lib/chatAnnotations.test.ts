import { describe, it, expect } from 'vitest'
import {
  annotationContext,
  annotationsBody,
  byReadingOrder,
  clampToRoot,
  offsetsOf,
  rangeAt,
  snapToWords,
  type ChatAnnotation
} from '../../renderer/src/lib/chatAnnotations'

function annotation(over: Partial<ChatAnnotation>): ChatAnnotation {
  return {
    id: 'a',
    messageId: 'm1',
    source: 'assistant',
    start: 0,
    end: 4,
    quote: 'text',
    comment: '',
    order: 0,
    ...over
  }
}

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('offsets and ranges', () => {
  it('round-trips a selection that spans elements', () => {
    const root = rootWith('<p>Failed sends <strong>now retry</strong> once.</p><ul><li>Second</li></ul>')
    const range = document.createRange()
    range.setStart(root.querySelector('p')!.firstChild!, 7)
    range.setEnd(root.querySelector('strong')!.firstChild!, 3)
    const { start, end } = offsetsOf(root, range)
    expect(range.toString()).toBe('sends now')
    expect(rangeAt(root, start, end)?.toString()).toBe('sends now')
  })

  it('finds a range starting in a later block', () => {
    const root = rootWith('<p>One</p><p>Two three</p>')
    expect(rangeAt(root, 7, 12)?.toString()).toBe('three')
  })

  it('gives up when the text no longer reaches the end', () => {
    const root = rootWith('<p>Short</p>')
    expect(rangeAt(root, 2, 40)).toBeNull()
    expect(rangeAt(root, 3, 3)).toBeNull()
  })
})

describe('clampToRoot', () => {
  it('cuts a triple-click that ends in the next element back to the message', () => {
    const root = rootWith('<p>Whole paragraph.</p>')
    const after = document.createElement('div')
    after.textContent = 'Copy'
    document.body.appendChild(after)
    const range = document.createRange()
    range.setStart(root.querySelector('p')!.firstChild!, 0)
    range.setEnd(after, 0)
    expect(clampToRoot(root, range)?.toString()).toBe('Whole paragraph.')
  })
})

describe('snapToWords', () => {
  function snapped(text: string, start: number, end: number): string {
    const root = rootWith(`<p>${text}</p>`)
    const node = root.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    snapToWords(range)
    return range.toString()
  }

  it('widens a cut word at either end', () => {
    expect(snapped('count through 10 again', 7, 19)).toBe('through 10 again')
    expect(snapped('count through 10 again', 0, 9)).toBe('count through')
  })

  it('leaves a range already on word boundaries alone', () => {
    expect(snapped('count through 10', 6, 13)).toBe('through')
    expect(snapped('one, two', 3, 8)).toBe(', two')
  })
})

describe('byReadingOrder', () => {
  it('sorts by message, then by position in it', () => {
    const list = [
      annotation({ id: 'c', order: 2, start: 0 }),
      annotation({ id: 'b', order: 1, start: 30 }),
      annotation({ id: 'a', order: 1, start: 5 })
    ].sort(byReadingOrder)
    expect(list.map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('annotationsBody', () => {
  it('numbers each entry, quotes every line, and leaves an empty comment out', () => {
    const body = annotationsBody([
      annotation({ source: 'user', quote: 'Keep the order.', comment: 'Prioritise this.' }),
      annotation({ quote: 'Line one\nLine two', comment: '  ' })
    ])
    expect(body).toBe(
      [
        '<annotations>',
        '[1] On my earlier message:',
        '> Keep the order.',
        'Prioritise this.',
        '',
        '[2] On your reply:',
        '> Line one',
        '> Line two',
        '</annotations>'
      ].join('\n')
    )
  })
})

describe('annotationContext', () => {
  it('labels the receipt and keeps only what the receipt needs', () => {
    const ctx = annotationContext([annotation({ id: 'x', order: 3 }), annotation({ id: 'y', start: 9, end: 12 })])
    expect(ctx.kind).toBe('chat-annotation')
    expect(ctx.label).toBe('2 annotations')
    expect(ctx.ref?.annotations?.[0]).toEqual({
      messageId: 'm1',
      source: 'assistant',
      start: 0,
      end: 4,
      quote: 'text',
      comment: ''
    })
  })
})
