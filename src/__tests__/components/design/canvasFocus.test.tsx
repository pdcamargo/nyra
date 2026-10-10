import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { defaultTheme, type ResolvedArtboard } from '@nyra/design'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import DesignCanvas, { keepDrawn, nearestFirst } from '@renderer/components/design/DesignCanvas'

/** The real artboard measures itself through a shadow root jsdom cannot lay
 *  out. This one reports a height when asked, which is what a first draw does. */
vi.mock('@renderer/components/design/Artboard', () => ({
  default: ({ artboard, onMeasure }: { artboard: ResolvedArtboard; onMeasure: (id: string, h: number) => void }) => (
    <button type="button" onClick={() => onMeasure(artboard.id, 1800)}>
      measure {artboard.id}
    </button>
  )
}))

/** Bitmaps need an SVG decoder jsdom does not have; this one marks where one would be. */
vi.mock('@renderer/components/design/BoardBitmap', () => ({
  default: ({ artboard }: { artboard: ResolvedArtboard }) => <span data-testid={`bitmap ${artboard.id}`} />
}))

const board = (id: string): ResolvedArtboard =>
  ({
    id,
    name: id,
    size: { width: 400, height: 'auto' },
    root: { type: 'box', id: 'r', origin: { scope: id, id: 'r' }, children: [] }
  }) as unknown as ResolvedArtboard

const original = globalThis.ResizeObserver
beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(): void {
      this.cb([{ contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this as never)
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  globalThis.ResizeObserver = original
})

const artboards = [board('a'), board('b'), board('c')]
const transform = (container: HTMLElement): string =>
  (container.querySelector('.origin-top-left') as HTMLElement).style.transform

const canvas = (focus: string): React.ReactElement => (
  <TooltipProvider>
    <DesignCanvas artboards={artboards} theme={defaultTheme} selected={[]} onSelect={vi.fn()} focus={focus} />
  </TooltipProvider>
)

describe('a focused canvas', () => {
  it('keeps a pan when an artboard is measured on its first draw', () => {
    const { container } = render(canvas('b'))
    const viewport = container.querySelector('.cursor-grab') as HTMLElement
    const framed = transform(container)

    fireEvent.wheel(viewport, { deltaX: 0, deltaY: 300 })
    const panned = transform(container)
    expect(panned).not.toBe(framed)

    act(() => screen.getByRole('button', { name: 'measure c' }).click())
    expect(transform(container)).toBe(panned)
  })

  it('refines the framing while nobody has moved it', () => {
    const { container } = render(canvas('b'))
    const before = transform(container)
    act(() => screen.getByRole('button', { name: 'measure b' }).click())
    expect(transform(container)).not.toBe(before)
  })

  it('still frames a new focus after a pan', () => {
    const { container, rerender } = render(canvas('b'))
    fireEvent.wheel(container.querySelector('.cursor-grab') as HTMLElement, { deltaX: 0, deltaY: 300 })
    const panned = transform(container)
    rerender(canvas('c'))
    expect(transform(container)).not.toBe(panned)
  })
})

describe('artboards kept live', () => {
  const near = (...ids: string[]): Set<string> => new Set(ids)

  it('keeps what scrolled away until newer ones push it out', () => {
    let drawn = keepDrawn([], near('a', 'b'), 3)
    drawn = keepDrawn(drawn, near('c'), 3)
    expect(drawn).toEqual(['a', 'b', 'c'])
    drawn = keepDrawn(drawn, near('d'), 3)
    expect(drawn).toEqual(['b', 'c', 'd'])
  })

  it('never drops something near, however many there are', () => {
    expect(keepDrawn(['x'], near('a', 'b', 'c', 'd'), 2)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('hands back the same list when nothing changed, so nothing re-renders', () => {
    const drawn = keepDrawn([], near('a', 'b'), 3)
    expect(keepDrawn(drawn, near('a', 'b'), 3)).toBe(drawn)
  })
})

describe('artboards waiting to be drawn', () => {
  it('start from the middle of the view', () => {
    const placed = new Map([
      ['far', { x: 2000, y: 0, width: 100, height: 100 }],
      ['mid', { x: 0, y: 0, width: 100, height: 100 }],
      ['next', { x: 300, y: 0, width: 100, height: 100 }]
    ])
    expect(nearestFirst(['far', 'next', 'mid'], placed, { x: 50, y: 50 })).toEqual(['mid', 'next', 'far'])
  })
})

describe('a canvas zoomed too far out to read', () => {
  it('draws every board as its bitmap and none live', () => {
    const wide = ['x', 'y'].map((id) => ({ ...board(id), size: { width: 40000, height: 20000 } }) as ResolvedArtboard)
    render(
      <TooltipProvider>
        <DesignCanvas artboards={wide} theme={defaultTheme} selected={[]} onSelect={vi.fn()} />
      </TooltipProvider>
    )
    expect(screen.queryByRole('button', { name: /^measure/ })).toBeNull()
    expect(screen.getByTestId('bitmap x')).toBeTruthy()
    expect(screen.getByTestId('bitmap y')).toBeTruthy()
  })
})
