import { describe, it, expect } from 'vitest'
import { fuzzyScore, fuzzyFilter, highlightSegments } from '../../renderer/src/lib/fuzzy'

/** Rank `paths` for `query` and return them best-first. */
const rank = (paths: string[], query: string): string[] =>
  fuzzyFilter(paths, query, (p) => p).map((r) => r.item)

/** Where in `path` the query characters landed. */
const hits = (path: string, query: string): number[] => fuzzyScore(path, query)?.positions ?? []

describe('fuzzyScore', () => {
  it('matches a scattered subsequence, which a substring search cannot', () => {
    // The bar from the plan: this is exactly what `.includes()` and the Rust
    // base-name scorer both miss.
    expect(fuzzyScore('src/components/CommandPalette.tsx', 'cmdpal')).not.toBeNull()
  })

  it('rejects a query whose characters are out of order', () => {
    expect(fuzzyScore('CommandPalette.tsx', 'palcmd')).toBeNull()
  })

  it('rejects a query with a character that is not there', () => {
    expect(fuzzyScore('CommandPalette.tsx', 'cmdxyz')).toBeNull()
  })

  it('rejects a query longer than the text', () => {
    expect(fuzzyScore('a.ts', 'aaaaaaaa')).toBeNull()
  })

  it('treats an empty query as a match with no highlights', () => {
    expect(fuzzyScore('anything', '')).toEqual({ score: 0, positions: [] })
  })

  // Regression: the boundary preference used to jump greedily. In this path the
  // `t` of `regis·t·ry` was abandoned for the `t` of `.ts` because a `.` precedes
  // it, stranding `r` and `y` — so a string that plainly contains the query was
  // reported as no match at all.
  it('does not strand the rest of the query chasing a boundary', () => {
    expect(fuzzyScore('src/registry.ts', 'registry')).not.toBeNull()
    expect(fuzzyScore('src/registryHelpers.ts', 'registry')).not.toBeNull()
    expect(fuzzyScore('src/commands/registry.ts', 'registry')).not.toBeNull()
  })

  it('finds a match that only exists without the boundary preference', () => {
    // The only `y` is mid-word; the only way to match is to keep `t` where it is.
    const m = fuzzyScore('a/tty.ts', 'tty')
    expect(m).not.toBeNull()
    expect(m!.positions.map((i) => 'a/tty.ts'[i]).join('')).toBe('tty')
  })

  it('reports positions that actually spell the query', () => {
    const path = 'src/lib/fuzzy.ts'
    const positions = hits(path, 'fuzzy')
    expect(positions.map((i) => path[i]).join('')).toBe('fuzzy')
  })
})

describe('ranking', () => {
  it('puts the file you meant first for an abbreviation', () => {
    const paths = [
      'src/components/ComposerBar.tsx',
      'src/components/CommandPalette.tsx',
      'src/lib/cachedMediaPaths.ts'
    ]
    expect(rank(paths, 'cmdpal')[0]).toBe('src/components/CommandPalette.tsx')
  })

  it('prefers the basename over the same word in a directory', () => {
    const paths = ['src/commands/registry.ts', 'src/registry/helpers.ts']
    expect(rank(paths, 'registry')[0]).toBe('src/commands/registry.ts')
  })

  it('prefers a consecutive run to scattered characters', () => {
    const tight = fuzzyScore('fuzzy.ts', 'fuzzy')!
    const loose = fuzzyScore('f-u-z-z-y.ts', 'fuzzy')!
    expect(tight.score).toBeGreaterThan(loose.score)
  })

  it('prefers word boundaries to mid-word letters', () => {
    const boundary = fuzzyScore('file_tree.rs', 'ft')!
    const midWord = fuzzyScore('shafted.rs', 'ft')!
    expect(boundary.score).toBeGreaterThan(midWord.score)
  })

  it('reads camelCase humps as boundaries', () => {
    const paths = ['src/IconButton.tsx', 'src/inbox.ts']
    expect(rank(paths, 'ib')[0]).toBe('src/IconButton.tsx')
  })

  it('breaks a tie toward the shorter, more specific name', () => {
    const paths = ['src/registryHelpers.ts', 'src/registry.ts']
    expect(rank(paths, 'registry')[0]).toBe('src/registry.ts')
  })

  it('matches case-insensitively but rewards the exact case', () => {
    const exact = fuzzyScore('Command.ts', 'C')!
    const folded = fuzzyScore('command.ts', 'C')!
    expect(exact.score).toBeGreaterThan(folded.score)
  })
})

describe('fuzzyFilter', () => {
  it('keeps input order and returns everything for an empty query', () => {
    const paths = ['b.ts', 'a.ts', 'c.ts']
    expect(rank(paths, '')).toEqual(paths)
    expect(rank(paths, '   ')).toEqual(paths)
  })

  it('drops non-matches entirely', () => {
    expect(rank(['a.ts', 'b.ts'], 'zzz')).toEqual([])
  })

  it('honours the limit', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `file${i}.ts`)
    expect(fuzzyFilter(paths, 'file', (p) => p, 10)).toHaveLength(10)
    expect(fuzzyFilter(paths, '', (p) => p, 10)).toHaveLength(10)
  })

  it('takes the match key off the item, not the item itself', () => {
    const commands = [{ id: 'panel.right.file', label: 'New file tab' }]
    expect(fuzzyFilter(commands, 'nft', (c) => c.label)).toHaveLength(1)
    expect(fuzzyFilter(commands, 'prf', (c) => c.id)).toHaveLength(1)
  })
})

describe('highlightSegments', () => {
  it('splits into matched and unmatched runs that rebuild the original', () => {
    const segments = highlightSegments('registry.ts', [0, 1, 2])
    expect(segments).toEqual([
      { text: 'reg', match: true },
      { text: 'istry.ts', match: false }
    ])
    expect(segments.map((s) => s.text).join('')).toBe('registry.ts')
  })

  it('handles a match that is not at the start', () => {
    expect(highlightSegments('abc', [1])).toEqual([
      { text: 'a', match: false },
      { text: 'b', match: true },
      { text: 'c', match: false }
    ])
  })

  it('returns one unmatched run when nothing matched', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }])
  })

  it('never loses characters, whatever the positions', () => {
    const path = 'src/components/CommandPalette.tsx'
    const { positions } = fuzzyScore(path, 'cmdpal')!
    expect(highlightSegments(path, positions).map((s) => s.text).join('')).toBe(path)
  })
})
