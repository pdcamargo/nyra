import { describe, it, expect } from 'vitest'
import { WORKING_WORDS, nextWorkingWord } from '../../renderer/src/lib/workingWords'

describe('nextWorkingWord', () => {
  it('never repeats the word already on screen', () => {
    // Every draw from the pool, for every possible current word: the one case
    // that matters is the tick where the label appears to have frozen.
    for (const current of WORKING_WORDS) {
      for (let i = 0; i < WORKING_WORDS.length; i++) {
        const picked = nextWorkingWord(current, () => i / WORKING_WORDS.length)
        expect(picked).not.toBe(current)
      }
    }
  })

  it('can reach every word from a cold start', () => {
    const seen = new Set(
      WORKING_WORDS.map((_, i) => nextWorkingWord(undefined, () => i / WORKING_WORDS.length))
    )
    expect(seen.size).toBe(WORKING_WORDS.length)
  })

  it('stays in range at the top of the random interval', () => {
    // Math.random() never returns 1, but a test double or a future source might.
    expect(WORKING_WORDS).toContain(nextWorkingWord(undefined, () => 1))
    expect(WORKING_WORDS).toContain(nextWorkingWord('Pondering', () => 1))
  })

  it('is a list of distinct gerunds', () => {
    expect(new Set(WORKING_WORDS).size).toBe(WORKING_WORDS.length)
    for (const word of WORKING_WORDS) expect(word).toMatch(/^[A-Z][a-z]+ing$/)
  })
})
