/**
 * The tint behind annotated text, painted with the CSS Custom Highlight API.
 *
 * Wrapping the text in elements would mean reaching into the markdown tree and
 * would change what Copy picks up. A highlight paints ranges without touching
 * the DOM, so the message renders exactly as it did. Styled in `index.css`
 * under `::highlight(...)`.
 */

type Layer = 'nyra-annotation' | 'nyra-annotation-draft' | 'nyra-annotation-flash'

const ranges: Record<Layer, Map<string, Range>> = {
  'nyra-annotation': new Map(),
  'nyra-annotation-draft': new Map(),
  'nyra-annotation-flash': new Map()
}

function paint(layer: Layer): void {
  // Absent in an engine without the API: the pins still mark the ranges.
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  const set = ranges[layer]
  if (set.size === 0) CSS.highlights.delete(layer)
  else CSS.highlights.set(layer, new Highlight(...set.values()))
}

export function setHighlight(layer: Layer, key: string, range: Range | null): void {
  if (range) ranges[layer].set(key, range)
  else ranges[layer].delete(key)
  paint(layer)
}

/** A saved annotation's range while its row is mounted — for anchoring its popover. */
export function annotationRange(id: string): Range | null {
  return ranges['nyra-annotation'].get(id) ?? null
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

/** Light a range up briefly — where a receipt row jumped to. */
export function flashRange(range: Range): void {
  clearTimeout(flashTimer)
  setHighlight('nyra-annotation-flash', 'flash', range)
  flashTimer = setTimeout(() => setHighlight('nyra-annotation-flash', 'flash', null), 1400)
}
