import { describe, expect, it } from 'vitest'
import type { ResolvedArtboard } from '@nyra/design'
import {
  centre,
  clampZoom,
  extent,
  fitZoom,
  frame,
  GUTTER,
  layout,
  TITLE_SPACE,
  zoomAbout,
  ZOOM_MAX,
  ZOOM_MIN
} from '../../renderer/src/components/design/layout'

const board = (
  id: string,
  width: number,
  height: number | 'auto',
  position?: { x: number; y: number }
): ResolvedArtboard =>
  ({
    id,
    name: id,
    size: { width, height },
    position,
    root: { type: 'box', id: 'r', origin: { scope: id, id: 'r' }, children: [] }
  }) as unknown as ResolvedArtboard

describe('layout', () => {
  it('flows unplaced artboards left to right', () => {
    const placed = layout([board('a', 400, 300), board('b', 400, 300)], 2400)
    expect(placed.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [400 + GUTTER, 0]
    ])
  })

  it('wraps when the row is full, leaving room for the next row of titles', () => {
    const placed = layout([board('a', 1000, 200), board('b', 1000, 200), board('c', 1000, 200)], 2400)
    expect(placed[2].x).toBe(0)
    expect(placed[2].y).toBe(200 + GUTTER + TITLE_SPACE)
  })

  it('never wraps the first artboard in a row, however wide it is', () => {
    // Otherwise a 4000px artboard would be pushed off on its own forever.
    const placed = layout([board('wide', 4000, 200)], 2400)
    expect(placed[0].x).toBe(0)
  })

  /**
   * An artboard with a position is placed there, full stop. The document's
   * answer is not something a canvas gets to second-guess on open.
   */
  it('honours an explicit position and does not let it shift the flow origin', () => {
    const placed = layout([board('pinned', 300, 300, { x: 900, y: -200 }), board('flowed', 300, 300)], 2400)
    expect(placed[0]).toMatchObject({ x: 900, y: -200 })
    expect(placed[1]).toMatchObject({ x: 0, y: 0 })
  })

  it('reserves a row height for an auto artboard rather than collapsing it', () => {
    const placed = layout([board('auto', 400, 'auto'), board('next', 400, 300)], 2400)
    expect(placed[0].height).toBeGreaterThan(0)
  })

  it('has an extent of nothing when there is nothing', () => {
    expect(extent([])).toEqual({ width: 0, height: 0 })
  })

  it('measures the extent across a wrapped layout', () => {
    const placed = layout([board('a', 1000, 200), board('b', 1000, 400), board('c', 500, 100)], 2400)
    const box = extent(placed)
    expect(box.width).toBe(2000 + GUTTER)
    expect(box.height).toBe(400 + GUTTER + TITLE_SPACE + 100)
  })
})

describe('zoom', () => {
  it('clamps to the range the buttons can reach', () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(0.5)).toBe(0.5)
  })

  it('fits large content into a small viewport', () => {
    const z = fitZoom({ width: 2000, height: 1000 }, { width: 600, height: 400 })
    expect(z).toBeLessThan(1)
    expect(2000 * z).toBeLessThanOrEqual(600)
  })

  /**
   * Never zooms *in* to fill the panel: a 280px mobile artboard blown up to 3x
   * reads as a design decision and is not one.
   */
  it('does not magnify something that already fits', () => {
    expect(fitZoom({ width: 280, height: 400 }, { width: 1200, height: 900 })).toBe(1)
  })

  it('survives empty content', () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 600, height: 400 })).toBe(1)
  })

  /**
   * The thing people notice about a bad canvas: zooming about the top-left
   * makes it feel like it is fighting you.
   */
  it('keeps the point under the cursor under the cursor', () => {
    const pan = { x: 50, y: 20 }
    const point = { x: 300, y: 200 }
    const before = { x: (point.x - pan.x) / 1, y: (point.y - pan.y) / 1 }
    const next = zoomAbout(pan, 1, 2, point)
    const after = { x: (point.x - next.x) / 2, y: (point.y - next.y) / 2 }
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('is its own inverse when the zoom goes back', () => {
    const pan = { x: 13, y: -7 }
    const point = { x: 410, y: 260 }
    const out = zoomAbout(pan, 1, 0.4, point)
    const back = zoomAbout(out, 0.4, 1, point)
    expect(back.x).toBeCloseTo(pan.x, 6)
    expect(back.y).toBeCloseTo(pan.y, 6)
  })

  it('centres content, allowing for the title strip above it', () => {
    const at = centre({ width: 400, height: 200 }, { width: 1000, height: 600 }, 1)
    expect(at.x).toBe(300)
    expect(at.y).toBe(200 + TITLE_SPACE)
  })
})

describe('measured heights', () => {
  /**
   * The bug this exists for: an `auto` artboard laid out at its assumed height
   * while its content came to 1006px put the next row's titles on top of it.
   * Visible immediately in the panel, invisible in any unit test that did not
   * exercise the second pass.
   */
  it('uses a measured height once it is known', () => {
    const boards = [board('tall', 1000, 'auto'), board('under', 1000, 200)]
    const guessed = layout(boards, 1200)
    const known = layout(boards, 1200, { tall: 1600 })
    expect(known[1].y).toBeGreaterThan(guessed[1].y)
    expect(known[1].y).toBe(1600 + GUTTER + TITLE_SPACE)
  })

  it('falls back to an assumption for anything not measured yet', () => {
    const placed = layout([board('a', 400, 'auto')], 1200, { somethingElse: 900 })
    expect(placed[0].height).toBeGreaterThan(0)
  })

  it('ignores a measurement for a fixed-height artboard', () => {
    // A fixed artboard's height is the document's answer, not the DOM's.
    const placed = layout([board('fixed', 400, 300)], 1200, { fixed: 9999 })
    expect(placed[0].height).toBe(300)
  })
})

describe('framing one artboard', () => {
  /**
   * What a `path#artboard` chip lands on. Without it Claude says "see the
   * Protocol panel" and you have to go and find it — the same friction as the
   * path chip that started all this.
   */
  it('centres the artboard it was pointed at', () => {
    const placed = layout([board('a', 400, 300), board('b', 400, 300)], 2400)
    const viewport = { width: 1000, height: 800 }
    const framed = frame(placed[1], viewport)

    // The artboard's own centre lands on the viewport's centre.
    const centreX = framed.pan.x + (placed[1].x + placed[1].width / 2) * framed.zoom
    expect(centreX).toBeCloseTo(viewport.width / 2, 6)
  })

  it('does not magnify a small artboard to fill the panel', () => {
    const placed = layout([board('phone', 390, 844)], 2400)
    expect(frame(placed[0], { width: 1400, height: 1200 }).zoom).toBe(1)
  })

  it('zooms out for one that does not fit', () => {
    const placed = layout([board('wide', 2400, 1400)], 4000)
    const framed = frame(placed[0], { width: 600, height: 500 })
    expect(framed.zoom).toBeLessThan(1)
    expect(2400 * framed.zoom).toBeLessThanOrEqual(600)
  })
})
