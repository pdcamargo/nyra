import { describe, expect, it } from 'vitest'
import type { ResolvedArtboard } from '@nyra/design'
import { nextSelection } from '@renderer/components/design/DesignCanvas'
import { arrange, moveTo, pdfFileName } from '@renderer/components/design/pageOrder'

const board = (id: string, position?: { x: number; y: number }): ResolvedArtboard =>
  ({ id, name: id, size: { width: 100, height: 100 }, position, root: {} }) as unknown as ResolvedArtboard

describe('selecting artboards on the canvas', () => {
  it('replaces on a plain click, adds on shift, toggles on cmd/ctrl', () => {
    expect(nextSelection(['a'], 'b', 'replace')).toEqual(['b'])
    expect(nextSelection(['a'], 'b', 'add')).toEqual(['a', 'b'])
    expect(nextSelection(['a', 'b'], 'b', 'add')).toEqual(['a', 'b'])
    expect(nextSelection(['a', 'b'], 'a', 'toggle')).toEqual(['b'])
    expect(nextSelection(['a'], 'c', 'toggle')).toEqual(['a', 'c'])
  })

  it('keeps click order, because that is the default page order', () => {
    let s: string[] = []
    for (const id of ['c', 'a', 'b']) s = nextSelection(s, id, 'add')
    expect(s).toEqual(['c', 'a', 'b'])
  })

  it('clears on the background', () => {
    expect(nextSelection(['a', 'b'], null, 'replace')).toEqual([])
  })
})

describe('page order', () => {
  // Document order a, b, c; on the canvas c sits top-left and b below a.
  const boards = [board('a', { x: 200, y: 0 }), board('b', { x: 200, y: 400 }), board('c', { x: 0, y: 0 })]

  it('arranges by selection, canvas reading order, or the document', () => {
    const ids = ['b', 'c', 'a']
    expect(arrange(ids, 'selection', boards, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(arrange(ids, 'canvas', boards, [])).toEqual(['c', 'a', 'b'])
    expect(arrange(ids, 'document', boards, [])).toEqual(['a', 'b', 'c'])
  })

  it('only reorders — a removed page stays removed', () => {
    expect(arrange(['c', 'a'], 'document', boards, [])).toEqual(['a', 'c'])
  })

  it('moves one page and clamps at the ends', () => {
    expect(moveTo(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveTo(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
    const same = ['a', 'b']
    expect(moveTo(same, 'a', -1)).toBe(same)
  })

  it('names the file after the design', () => {
    expect(pdfFileName('PDF Export')).toBe('pdf-export.pdf')
    expect(pdfFileName('Aether: Panorama / Recursos')).toBe('aether-panorama-recursos.pdf')
    expect(pdfFileName('   ')).toBe('design.pdf')
  })
})
