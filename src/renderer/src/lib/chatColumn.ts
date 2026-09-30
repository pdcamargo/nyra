import type React from 'react'
import type { ChatWidth } from '../../../shared/types'

/**
 * The conversation column's geometry.
 *
 * Lifted out of Chat.tsx, which is two thousand lines, because this part is pure
 * CSS arithmetic and the only part of it worth testing.
 *
 * What gets centred is the conversation. Centring the conversation *and* the
 * gutter as one group is honest about the space the card takes, but it reads as
 * a column that has been shoved off-centre — the composer sits visibly left of
 * the middle of the window it is in, which is the thing a person notices.
 *
 * The second term is the concession, and --card-gap is how much of one. Reserve
 * the full --gap there and the column jumps 22px sideways on a window where the
 * card would have fitted anyway. Reserve nothing and the arithmetic does
 * something worse: the term puts the column's right edge *exactly* on the card's
 * left edge, so in every window narrow enough for it to win — which is most of
 * them — the card sits flush against the text with no air at all.
 *
 * --card-gap is the floor under that. The clearance spends itself down from
 * --gap to --card-gap before the column moves, and past that the column gives
 * ground a pixel at a time, never more than the card needs. 12px buys visible
 * air in a tight window for at most 12px of movement, and only inside the band
 * where avail is between --col-w + 2 * --gutter and that plus 2 * --card-gap;
 * wider than the band nothing moves, narrower than it the column was moving
 * regardless. Closed gutter, the term is inert and the column is always centred.
 *
 * Everything is written against --avail rather than 100% directly. The column
 * lives inside the transcript's scroller and the composer, the jump pill and the
 * floating summary live beside it, so their 100% is a scrollbar wider than the
 * text's — ten pixels, which is enough to see as a misalignment between a
 * paragraph and the box you answer it in. The three outsiders set --avail to
 * 100% minus that scrollbar (see OUTSIDE_SCROLLER) and every expression here
 * lands on the same edges. The scroller is overflow-y:scroll rather than auto
 * for the same reason: `auto` reserves the gutter only once the chat is long
 * enough to scroll, and the column cannot shift sideways the moment a
 * conversation outgrows one screen.
 *
 * And it centres in the space the conversation actually has, not on the window.
 * The window version held still when a rail opened, which was the point, but it
 * counted an opaque 300px rail as if it were part of the reading area: on a
 * 1920pt window that left 28px of margin on one side of the group and 316px of
 * void on the other. A rail opening genuinely changes how much room the text
 * has, so the text moving is honest — `main` is already flex-1 between both
 * rails, so `100%` here is exactly what is left over.
 */
/**
 * The full width of the area the floating card is positioned in.
 *
 * --avail is the conversation's width — the scroller's content box, a scrollbar
 * narrower than the box it sits in. The card is not in the scroller, so its
 * right edge measures from the real edge, and asking it to measure from --avail
 * pushed it a scrollbar clear of where it should sit: 22px of margin down the
 * right against the 12px above it, which is a thing you can see.
 *
 * Both frames share a left edge, so adding the scrollbar back to --avail names
 * the same number in either one: the column can say where the card's left edge
 * falls, and the card can say where the window's right edge is.
 */
const OUTER = 'calc(var(--avail) + var(--scrollbar-size))'

/**
 * The two percentage-bearing terms of --col-w. Written once, because --col-w and
 * every expression that measures against it (see `withColumn`) have to agree.
 */
const FILL = '(var(--avail) - 2 * var(--gap) - var(--gutter))'
const CAP = '(var(--avail) - 2 * var(--gap))'

/**
 * `k ± var(--col-w) * factor`, spelled out so WebKit gets it right under zoom.
 *
 * WebKit mis-scales a min() or max() that holds a percentage when it is an
 * operand of arithmetic: at 125% page zoom `(100% - min(400px, 100%)) / 2`
 * lands 375px from the edge rather than 300, and the error grows with the zoom.
 * --col-w is exactly such a min(), and every offset here used to subtract it, so
 * on a zoomed Mac the column slid right until it sat against the summary.
 * Chromium never had the bug, which is why Windows never showed it.
 *
 * The same min() is fine used whole — as a width, or with calc() inside it — so
 * the arithmetic is distributed into its arguments instead of applied to it:
 *
 *   k - min(a, max(b, c), d) = max(k - a, min(k - b, k - c), k - d)
 *   k + min(a, max(b, c), d) = min(k + a, max(k + b, k + c), k + d)
 *
 * --col-min stays nested: it is a min() of plain lengths, which WebKit resolves
 * before zoom can get at it.
 */
function withColumn(k: string, sign: 1 | -1, factor = 1): string {
  const op = sign === 1 ? '+' : '-'
  const scaled = factor === 1 ? '' : ` * ${factor}`
  const term = (w: string): string => `calc(${k} ${op} ${w}${scaled})`
  const outer = sign === 1 ? 'min' : 'max'
  const inner = sign === 1 ? 'max' : 'min'
  return (
    `${outer}(${term('var(--col-max)')},` +
    ` ${inner}(${term('var(--col-min)')}, ${term(FILL)}),` +
    ` ${term(CAP)})`
  )
}

/** Where the column's right edge may come to, short of the floating card. */
const CARD_EDGE = `${OUTER} - var(--gutter) - var(--card-gap)`

export const COLUMN_OFFSET =
  'clamp(var(--gap),' +
  ` min(${withColumn('var(--avail) / 2', -1, 0.5)},` +
  ` ${withColumn(CARD_EDGE, -1)}),` +
  ` ${withColumn('var(--avail) - var(--gap)', -1)})`

/**
 * The column's midline: COLUMN_OFFSET plus half of --col-w, for the jump pill.
 *
 * Not `calc(${COLUMN_OFFSET} + var(--col-w) / 2)`, which is the same WebKit bug
 * twice over. Adding a constant to a clamp() adds it to each of its three
 * arguments, and the centred term's halves cancel to a plain `--avail / 2`.
 */
export const COLUMN_CENTER =
  `clamp(${withColumn('var(--gap)', 1, 0.5)},` +
  ` min(calc(var(--avail) / 2), ${withColumn(CARD_EDGE, -1, 0.5)}),` +
  ` ${withColumn('var(--avail) - var(--gap)', -1, 0.5)})`

/**
 * For the three things that sit beside the scroller rather than in it.
 *
 * Spread after columnVars, which defaults --avail to the plain 100% the column
 * itself wants.
 */
export const OUTSIDE_SCROLLER = {
  '--avail': 'calc(100% - var(--scrollbar-size))'
} as React.CSSProperties

/**
 * The floating column's own width, and its inset from the edge it falls back to.
 *
 * These two and --gutter were the same three numbers written in two files: 308
 * and 12 in Chat.tsx, 20rem here, with nothing to keep them agreeing. --gutter is
 * derived from them now, so the space reserved for the card is by construction
 * the space the card takes.
 */
export const SUMMARY_WIDTH = 308
const SUMMARY_INSET = 12

/**
 * Where the summary sits: the top right corner, always.
 *
 * It used to take the lesser of pinned-right and docked-beside-the-column, on
 * the theory that a card several hundred pixels clear of the text it describes
 * reads as a margin rather than as a panel. On a wide display that is visibly
 * the wrong call: the card leaves the corner it belongs in and floats in the
 * middle of the right-hand space, anchored to nothing, with void on both sides
 * of it. An inset that never changes is the thing a corner is for.
 *
 * Nothing else has to move for it. The column's own second clamp term keeps the
 * conversation clear of the gutter this reserves, and that term was always
 * written for a right-aligned card. On a window too narrow to hold both, the
 * card overlaps the conversation from the right edge, which is --gutter's own
 * "dropped where there is not room" rule.
 */
export const SUMMARY_OFFSET = `calc(${OUTER} - ${SUMMARY_WIDTH}px - ${SUMMARY_INSET}px)`

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
    // constant however wide the side panel is dragged.
    '--gutter': gutterOpen ? `${(SUMMARY_WIDTH + SUMMARY_INSET) / 16}rem` : '0rem',
    '--gap': '1.5rem',
    // The air the floating card may never close below. Not --gap: that is what
    // the card *wants*, and insisting on it moves the conversation.
    '--card-gap': '0.75rem',
    // The width every other expression here measures against. Plain 100% for
    // the column, which is inside the scroller; OUTSIDE_SCROLLER overrides it
    // for the three elements that are not.
    '--avail': '100%',
    // Two gaps, and the last term is the one that matters: the column never
    // exceeds the space minus both of them. It used to be capped at 100%, so a
    // panel dragged past the column's own minimum left it full-width with a
    // 24px offset on top — a column wider than the room it had, spilling under
    // the panel. The minimum is a preference; fitting is not.
    //
    // The gutter is subtracted where there is room to spare and dropped where
    // there is not, which is the floating summary's own rule: it overlaps the
    // conversation on a narrow window rather than squeezing it to nothing.
    '--col-w': `min(var(--col-max), max(var(--col-min), calc${FILL}), calc${CAP})`
  } as React.CSSProperties
}
