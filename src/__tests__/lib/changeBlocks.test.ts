import { describe, expect, it } from 'vitest'
import {
  byChurn,
  changeTotals,
  extractChangeBlocks,
  parseChangeBlock
} from '@renderer/lib/changeBlocks'

const block = (body: string): string => '```nyra-changes\n' + body + '\n```'

describe('parseChangeBlock', () => {
  it('reads the base sha and the rows', () => {
    const parsed = parseChangeBlock(
      'base: 50cb2a4\nsrc/a.tsx | +212 -23\nsrc-tauri/src/git.rs | +33 -2'
    )
    expect(parsed.base).toBe('50cb2a4')
    expect(parsed.files).toEqual([
      { path: 'src/a.tsx', insertions: 212, deletions: 23 },
      { path: 'src-tauri/src/git.rs', insertions: 33, deletions: 2 }
    ])
  })

  it('takes a deletion count written with a unicode minus', () => {
    expect(parseChangeBlock('a.ts | +1 −9').files[0].deletions).toBe(9)
  })

  it('treats a missing count as zero rather than dropping the row', () => {
    expect(parseChangeBlock('a.ts | +18').files).toEqual([
      { path: 'a.ts', insertions: 18, deletions: 0 }
    ])
  })

  it('survives a block with no base — the card still draws', () => {
    const parsed = parseChangeBlock('a.ts | +1 -1')
    expect(parsed.base).toBe('')
    expect(parsed.files).toHaveLength(1)
  })

  it('does not turn an unparseable base line into a file row', () => {
    // `zzz` is not a sha, so the BASE rule rejects it. It must not then fall
    // through and be filed as a path.
    expect(parseChangeBlock('base: zzz\na.ts | +1').files).toEqual([
      { path: 'a.ts', insertions: 1, deletions: 0 }
    ])
  })

  it('keeps paths that contain spaces', () => {
    expect(parseChangeBlock('docs/my notes.md | +4').files[0].path).toBe('docs/my notes.md')
  })
})

describe('extractChangeBlocks', () => {
  it('lifts the block out of the reply', () => {
    const { text, changes } = extractChangeBlocks(
      'Wired it up.\n\n' + block('base: abc1234\nsrc/a.ts | +2 -1') + '\n\nTests pass.'
    )
    expect(text).toBe('Wired it up.\n\nTests pass.')
    expect(changes?.base).toBe('abc1234')
    expect(changes?.files).toHaveLength(1)
  })

  it('is null when the reply had no block at all', () => {
    expect(extractChangeBlocks('just prose').changes).toBeNull()
  })

  it('is null for a block that parsed to nothing, rather than an empty card', () => {
    const { changes } = extractChangeBlocks(block('base: abc1234'))
    expect(changes).toBeNull()
  })

  it('merges several blocks, keeping the most recent base', () => {
    const { changes } = extractChangeBlocks(
      block('base: aaa1111\na.ts | +1') + '\n' + block('base: bbb2222\nb.ts | +2')
    )
    expect(changes?.base).toBe('bbb2222')
    expect(changes?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('tolerates a block the model never closed', () => {
    const { changes } = extractChangeBlocks('```nyra-changes\nbase: abc1234\na.ts | +5 -1')
    expect(changes?.files).toEqual([{ path: 'a.ts', insertions: 5, deletions: 1 }])
  })
})

describe('ordering', () => {
  it('sorts by churn so a read-more cut hides the trivia', () => {
    const files = [
      { path: 'small.ts', insertions: 1, deletions: 0 },
      { path: 'big.ts', insertions: 200, deletions: 12 },
      { path: 'mid.ts', insertions: 20, deletions: 0 }
    ]
    expect(byChurn(files).map((f) => f.path)).toEqual(['big.ts', 'mid.ts', 'small.ts'])
  })

  it('breaks ties on path so the order is stable', () => {
    const files = [
      { path: 'b.ts', insertions: 5, deletions: 0 },
      { path: 'a.ts', insertions: 5, deletions: 0 }
    ]
    expect(byChurn(files).map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('totals both columns', () => {
    expect(
      changeTotals([
        { path: 'a', insertions: 2, deletions: 3 },
        { path: 'b', insertions: 4, deletions: 5 }
      ])
    ).toEqual({ insertions: 6, deletions: 8 })
  })
})

describe('duplicate rows', () => {
  // A model restating a path is a slip; two rows for one file would draw twice
  // and both click to the same diff, which reads as a rendering bug.
  it('keeps one row per path', () => {
    const parsed = parseChangeBlock(
      'base: abc1234\nsrc/a.ts | +10 -1\nsrc/b.ts | +5\nsrc/a.ts | +12 -2'
    )
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('lets the later row win, since it is most likely a correction', () => {
    const parsed = parseChangeBlock('src/a.ts | +10 -1\nsrc/a.ts | +12 -2')
    expect(parsed.files[0]).toEqual({ path: 'src/a.ts', insertions: 12, deletions: 2 })
  })

  it('dedupes across two blocks in one reply', () => {
    const { changes } = extractChangeBlocks(
      block('base: aaa1111\na.ts | +1') + '\n' + block('base: bbb2222\na.ts | +9')
    )
    expect(changes?.files).toEqual([{ path: 'a.ts', insertions: 9, deletions: 0 }])
  })

  it('does not collapse the totals twice', () => {
    const parsed = parseChangeBlock('a.ts | +10\na.ts | +10')
    expect(changeTotals(parsed.files)).toEqual({ insertions: 10, deletions: 0 })
  })
})
