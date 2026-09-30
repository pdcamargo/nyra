import type { ResolvedArtboard } from '@nyra/design'
import { layout } from './layout'

/**
 * The orders an export can start from.
 *
 * `selection` is the order you clicked in, `canvas` is reading order on the
 * canvas (rows top to bottom, then left to right), `document` is the order the
 * file lists them. `custom` is whatever a drag or Alt+arrow made of any of
 * those, and there is no way back to it except by reordering again.
 */
export type PageOrder = 'selection' | 'canvas' | 'document' | 'custom'

/**
 * `ids` rearranged into `order`. Only reorders — never adds or drops a page —
 * so switching modes cannot undo an "Add artboard" or a remove.
 */
export function arrange(
  ids: string[],
  order: Exclude<PageOrder, 'custom'>,
  artboards: ResolvedArtboard[],
  picked: string[]
): string[] {
  const rank = rankFor(order, artboards, picked)
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
}

function rankFor(
  order: Exclude<PageOrder, 'custom'>,
  artboards: ResolvedArtboard[],
  picked: string[]
): Map<string, number> {
  if (order === 'selection') return new Map(picked.map((id, i) => [id, i]))
  if (order === 'document') return new Map(artboards.map((a, i) => [a.id, i]))
  // Reading order off the same layout the canvas draws. Rows share a y, so a
  // small tolerance keeps a row from splitting over a one-pixel difference.
  const placed = layout(artboards)
  const sorted = [...placed].sort((a, b) =>
    Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x
  )
  return new Map(sorted.map((p, i) => [p.artboard.id, i]))
}

/** `id` moved to `to`, clamped. Used by both the drag and Alt+↑/↓. */
export function moveTo(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const target = Math.max(0, Math.min(ids.length - 1, to))
  if (target === from) return ids
  const next = ids.filter((x) => x !== id)
  next.splice(target, 0, id)
  return next
}

/** A file name from a design name: what the save dialog offers first. */
export function pdfFileName(designName: string): string {
  const slug = designName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return `${slug || 'design'}.pdf`
}
