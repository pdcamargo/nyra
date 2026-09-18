import { describe, expect, it } from 'vitest'
import { COLUMN_OFFSET, columnVars } from '@renderer/lib/chatColumn'
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

  it('centres on the window rather than the container', () => {
    expect(COLUMN_OFFSET).toContain('100vw')
    expect(COLUMN_OFFSET).toContain('var(--rail, 0px)')
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
