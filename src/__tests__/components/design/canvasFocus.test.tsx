import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { defaultTheme, type ResolvedArtboard } from '@nyra/design'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import DesignCanvas from '@renderer/components/design/DesignCanvas'

/** The real artboard measures itself through a shadow root jsdom cannot lay
 *  out. This one reports a height when asked, which is what a first draw does. */
vi.mock('@renderer/components/design/Artboard', () => ({
  default: ({ artboard, onMeasure }: { artboard: ResolvedArtboard; onMeasure: (id: string, h: number) => void }) => (
    <button type="button" onClick={() => onMeasure(artboard.id, 1800)}>
      measure {artboard.id}
    </button>
  )
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
