import { describe, it, expect } from 'vitest'
import { extractorKind, extractorTemplate } from '../../renderer/src/lib/extractors'

describe('extractorKind', () => {
  it('reads the prefix the engine parses', () => {
    expect(extractorKind('json:result.score')).toBe('json')
    expect(extractorKind('regex:score: (\\d+)')).toBe('regex')
    expect(extractorKind('lines:1-5')).toBe('lines')
  })

  it('treats an empty or unprefixed extractor as the raw output', () => {
    expect(extractorKind('')).toBe('raw')
    expect(extractorKind('raw')).toBe('raw')
    // A colon that is not one of the three prefixes is still raw text, not a
    // fourth kind — guessing otherwise would silently change what is captured.
    expect(extractorKind('http://example.com')).toBe('raw')
  })
})

describe('extractorTemplate', () => {
  it('leaves something editable behind when you pick a kind', () => {
    expect(extractorTemplate('json')).toBe('json:')
    expect(extractorTemplate('regex')).toBe('regex:')
    expect(extractorTemplate('lines')).toBe('lines:1-5')
  })

  it('clears the extractor for raw, since a prefix would be read as one', () => {
    expect(extractorTemplate('raw')).toBe('')
  })

  it('round-trips: every template reports the kind it came from', () => {
    for (const kind of ['raw', 'json', 'regex', 'lines']) {
      expect(extractorKind(extractorTemplate(kind))).toBe(kind)
    }
  })
})
