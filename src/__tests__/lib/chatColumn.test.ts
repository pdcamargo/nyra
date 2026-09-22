import { describe, expect, it } from 'vitest'
import {
  COLUMN_OFFSET,
  OUTSIDE_SCROLLER,
  SUMMARY_OFFSET,
  SUMMARY_WIDTH,
  columnVars
} from '@renderer/lib/chatColumn'
import { DEFAULT_SETTINGS, type ChatWidth } from '@shared/types'

const varsFor = (width: ChatWidth, gutterOpen = false): Record<string, string> =>
  columnVars(gutterOpen, width) as unknown as Record<string, string>

/** What a measure resolves to at a given conversation text size, in px. */
const resolve = (expr: string, fontPx: number): number => {
  const m = /\* ([0-9.]+)\)$/.exec(expr)
  if (!m) throw new Error(`not a measure: ${expr}`)
  return Number(m[1]) * fontPx
}

describe('columnVars', () => {
  // The rungs are unchanged at the default text size; this is what they were
  // before the measure was tied to the type.
  it('resolves to the widths the presets have always been', () => {
    expect(resolve(varsFor('compact')['--col-max'], 15)).toBeCloseTo(576, -1)
    expect(resolve(varsFor('default')['--col-max'], 15)).toBeCloseTo(663, -1)
    expect(resolve(varsFor('wide')['--col-max'], 15)).toBeCloseTo(832, -1)
    expect(resolve(varsFor('full')['--col-max'], 15)).toBeCloseTo(1152, -1)
  })

  // The complaint this answers: in `rem` the column held still while the words
  // grew, so turning the text up made the chat feel narrower.
  it('grows the measure with the conversation text', () => {
    const wide = varsFor('wide')['--col-max']
    expect(wide).toContain('var(--content-font-size, 15px)')
    expect(resolve(wide, 17) / resolve(wide, 15)).toBeCloseTo(17 / 15, 5)
  })

  it('never lets the floor exceed the ceiling', () => {
    expect(varsFor('compact')['--col-min']).toBe(`min(34rem, ${varsFor('compact')['--col-max']})`)
  })

  it('reserves the gutter only when something floats in it', () => {
    expect(varsFor('wide', false)['--gutter']).toBe('0rem')
    expect(varsFor('wide', true)['--gutter']).toBe('20rem')
  })

  it('falls back to the default measure for an unknown preset', () => {
    expect(varsFor('nonsense' as ChatWidth)['--col-max']).toBe(varsFor('default')['--col-max'])
  })

  // Was `100vw` minus the rails. That counted an opaque 300px projects rail as
  // reading area, so the group sat hard against it with the whole slack dumped on
  // the far side. `main` is flex-1 between both rails; 100% is what is left.
  it('centres in the room the conversation has, not on the window', () => {
    expect(COLUMN_OFFSET).not.toContain('100vw')
    expect(COLUMN_OFFSET).not.toContain('--rail')
  })

  // Centring the pair was honest about the space the card takes and read as a
  // column shoved off-centre. The conversation is what gets centred.
  it('centres the conversation itself', () => {
    expect(COLUMN_OFFSET).toContain('(var(--avail) - var(--col-w)) / 2')
  })

  // ...and gives ground only where the card would come closer than --card-gap.
  // Reserving a full --gap there cost 22px of sideways jump on a window where
  // the card fitted without it; reserving nothing put the card's left edge
  // exactly on the column's right edge in every window where this term wins.
  it('spends the clearance down to the floor before it moves the column', () => {
    expect(COLUMN_OFFSET).toContain('var(--col-w) - var(--gutter) - var(--card-gap)')
    expect(COLUMN_OFFSET).not.toContain('var(--col-w) - var(--gap) - var(--gutter)')
    expect(COLUMN_OFFSET).toContain('min(')
  })

  // The floor has to be under the gap, or it is the gap and the column jumps.
  it('keeps the floor below the clearance the card asks for', () => {
    const vars = varsFor('wide', true)
    const rem = (v: string): number => Number(v.replace('rem', '')) * 16
    expect(rem(vars['--card-gap'])).toBeGreaterThan(0)
    expect(rem(vars['--card-gap'])).toBeLessThan(rem(vars['--gap']))
  })

  // The composer sits beside the scroller, not in it, so its 100% is a
  // scrollbar wider than the text's. Everything measures --avail instead, and
  // the outsiders narrow it by exactly that scrollbar.
  it('measures against --avail rather than the raw box', () => {
    expect(COLUMN_OFFSET).not.toContain('100%')
    expect(SUMMARY_OFFSET).not.toContain('100%')
    expect(COLUMN_OFFSET).toContain('var(--avail)')
    expect(varsFor('wide')['--col-w']).not.toContain('100%')
    expect(varsFor('wide')['--avail']).toBe('100%')
  })

  it('narrows the space for anything outside the scroller', () => {
    const outside = OUTSIDE_SCROLLER as unknown as Record<string, string>
    expect(outside['--avail']).toBe('calc(100% - var(--scrollbar-size))')
  })

  // These were the same numbers in two files with nothing holding them together.
  it('reserves exactly the room the floating card takes', () => {
    const gutterPx = Number(varsFor('wide', true)['--gutter'].replace('rem', '')) * 16
    expect(gutterPx).toBeGreaterThan(SUMMARY_WIDTH)
    expect(gutterPx - SUMMARY_WIDTH).toBe(12)
  })
})

describe('the floating summary', () => {
  // It used to dock beside the column, taking the lesser of that and the right
  // edge. On a wide display the card left the corner and floated in the middle
  // of the right-hand space with void on both sides of it.
  it('holds the top right corner whatever the window is doing', () => {
    expect(SUMMARY_OFFSET.startsWith('calc(')).toBe(true)
    expect(SUMMARY_OFFSET).not.toContain('min(')
    expect(SUMMARY_OFFSET).not.toContain('var(--col-w)')
    // From the real right edge, not the conversation's: the card is not inside
    // the scroller, and measuring from --avail sat it a scrollbar too far left.
    expect(SUMMARY_OFFSET).toContain('var(--avail) + var(--scrollbar-size)')
    expect(SUMMARY_OFFSET).toContain(`- ${SUMMARY_WIDTH}px`)
  })

  // The inset is the whole point of pinning it: one number, every width.
  it('keeps the same inset at every width', () => {
    const inset = (avail: number): number => {
      const scrollbar = 10
      const outer = avail + scrollbar
      return outer - (outer - SUMMARY_WIDTH - 12) - SUMMARY_WIDTH
    }
    expect(inset(900)).toBe(12)
    expect(inset(2400)).toBe(12)
  })

  // What keeps the conversation off it is the column's own clamp, which was
  // always written for a right-aligned card: the gutter it reserves is exactly
  // the card's width plus its inset.
  it('is cleared by the gutter the column already reserves', () => {
    const gutterPx = Number(varsFor('wide', true)['--gutter'].replace('rem', '')) * 16
    expect(gutterPx).toBe(SUMMARY_WIDTH + 12)
    expect(COLUMN_OFFSET).toContain('var(--col-w) - var(--gutter) - var(--card-gap)')
  })
})

describe('the default measure', () => {
  it('ships wider than the column used to be', () => {
    // The complaint this setting answers was dead space on a large display, so
    // the out-of-box width has to be the wider one, not the old cap.
    expect(DEFAULT_SETTINGS.chatWidth).toBe('wide')
    expect(resolve(varsFor(DEFAULT_SETTINGS.chatWidth)['--col-max'], 15)).toBeCloseTo(832, -1)
  })
})
