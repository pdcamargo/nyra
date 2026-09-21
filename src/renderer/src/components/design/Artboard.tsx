import { useEffect, useRef } from 'react'
import { artboardMarkup, type ResolvedArtboard, type Theme } from '@nyra/design'

/**
 * One artboard, drawn live.
 *
 * Inside a shadow root, for two reasons that both matter. The artboard's reset
 * opens with `*{…}` — in the page that would reset Nyra itself. And Nyra's own
 * stylesheet must not reach in, or a design would render differently here than
 * in the PNG and the mock would be lying about the thing it exists to show.
 *
 * `innerHTML` of the same string the rasteriser wraps, rather than React into a
 * portal, so the panel and the PNG come from one code path. The artboard is
 * derived and read-only, so there is nothing for reconciliation to buy yet —
 * and `data-node` is already in the markup, so hit testing for a future
 * inspector works without it.
 */
export default function Artboard({
  artboard,
  theme,
  onMeasure
}: {
  artboard: ResolvedArtboard
  theme: Theme
  /** The rendered height, for an `auto` artboard whose size nothing knows
   *  until the content has laid out. */
  onMeasure?: (id: string, height: number) => void
}): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const shadow = useRef<ShadowRoot | null>(null)

  useEffect(() => {
    const node = host.current
    if (!node) return
    // One shadow root per host for its whole life: attachShadow throws on a
    // second call, and React may re-run this effect for a new artboard.
    if (!shadow.current) shadow.current = node.attachShadow({ mode: 'open' })
    shadow.current.innerHTML = artboardMarkup(artboard, theme)

    if (artboard.size.height !== 'auto' || !onMeasure) return
    // An `auto` artboard's height is whatever its content came to, and the
    // canvas has to know it or the next row of titles lands on top of it.
    const inner = shadow.current.querySelector('[data-artboard]')
    const height = inner instanceof HTMLElement ? inner.offsetHeight : 0
    if (height > 0) onMeasure(artboard.id, height)
  }, [artboard, theme, onMeasure])

  return (
    <div
      ref={host}
      data-artboard-host={artboard.id}
      style={{
        width: artboard.size.width,
        // An `auto` artboard is measured by its content, so the host must not
        // pin it. The shadow content carries its own height.
        height: artboard.size.height === 'auto' ? undefined : artboard.size.height
      }}
    />
  )
}
