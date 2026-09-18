import type React from 'react'
import type { ChatWidth } from '../../../shared/types'

/**
 * The conversation column's geometry.
 *
 * Lifted out of Chat.tsx, which is two thousand lines, because this part is pure
 * CSS arithmetic and the only part of it worth testing.
 *
 * The column is centred on the *window*, not on its own container, so it holds
 * still when a rail opens instead of jumping. Two constraints bound it: it never
 * slides under the floating summary, and it never touches the left rail. Between
 * those it tracks the window centre, which is what makes it drift left as the
 * window narrows rather than disappearing behind the panel.
 *
 * --rail is the one part of the window geometry CSS cannot work out for itself.
 * App publishes it onto the shell element as the projects rail is dragged, so it
 * is inherited here rather than re-rendered — and it is the rail's real width,
 * not the fixed one it used to assume.
 */
export const COLUMN_OFFSET =
  'clamp(var(--gap),' +
  ' calc((100vw - var(--right, 0px)) / 2 - var(--col-w) / 2 - var(--rail, 0px)),' +
  ' calc(100% - var(--gap) - var(--col-w)))'

/**
 * The measure, per setting — as a multiple of the conversation's own type size.
 *
 * `default` is the 41.4rem the column ran at before this was a setting, and at
 * the default 15px text every rung still resolves to what it used to. The point
 * of the multiple is what happens when you change the text: in `rem` the column
 * stayed put while the words grew, so turning the text up to 17px bought you
 * bigger letters and a narrower-feeling chat. Tied to the type, the measure
 * grows with it and characters-per-line stays where it was.
 */
const COL_MULTIPLE: Record<ChatWidth, number> = {
  compact: 38.4,
  default: 44.2,
  wide: 55.5,
  full: 76.8
}

const measure = (width: ChatWidth): string =>
  `calc(var(--content-font-size, 15px) * ${COL_MULTIPLE[width] ?? COL_MULTIPLE.default})`

export function columnVars(gutterOpen: boolean, width: ChatWidth): React.CSSProperties {
  const max = measure(width)
  return {
    '--col-max': max,
    // The floor cannot exceed the ceiling, or `compact` fights itself.
    '--col-min': `min(34rem, ${max})`,
    // --gutter is the floating column — summary, miniature or both — which is
    // right-aligned to the chat area rather than to the window, so it stays
    // constant however wide the workspace panel is dragged.
    '--gutter': gutterOpen ? '20rem' : '0rem',
    '--gap': '1.5rem',
    // Two gaps, and the last term is the one that matters: the column never
    // exceeds the space minus both of them. It used to be capped at 100%, so a
    // panel dragged past the column's own minimum left it full-width with a
    // 24px offset on top — a column wider than the room it had, spilling under
    // the panel. The minimum is a preference; fitting is not.
    //
    // The gutter is subtracted where there is room to spare and dropped where
    // there is not, which is the floating summary's own rule: it overlaps the
    // conversation on a narrow window rather than squeezing it to nothing.
    '--col-w':
      'min(var(--col-max),' +
      ' max(var(--col-min), calc(100% - 2 * var(--gap) - var(--gutter))),' +
      ' calc(100% - 2 * var(--gap)))'
  } as React.CSSProperties
}
