/**
 * Subsequence matching with ranking, for the quick-open and the command palette.
 *
 * Both used to filter with `.includes()`, which is a different question from the
 * one people are asking. Typing "cmdpal" means `CommandPalette.tsx`; typing
 * "srccmp" means something under `src/.../components/`. A substring test answers
 * neither, and the repo had no matcher of any kind — the closest thing was a
 * base-name-weighted `find()` in Rust (`file_tree.rs`), which is still substring.
 *
 * The score is the interesting half. Any subsequence matcher will *find*
 * `CommandPalette.tsx` for "cmdpal"; what makes a picker feel right is that the
 * file you meant is first. So the bonuses are all about where a character landed
 * rather than that it landed at all:
 *
 * - **Consecutive runs** compound. Four characters in a row beat four scattered
 *   ones by a lot, because a run is evidence you are typing a word rather than
 *   hitting letters that happen to appear in that order.
 * - **Boundaries** — after `/`, `_`, `-`, `.`, ` `, or at a camelCase hump — score
 *   like the start of a word, which is how people abbreviate: "cmdpal" is
 *   `Command` + `Palette`, not letters 1,2,3 of something.
 * - **The basename outranks the directory.** You are looking for a file, and its
 *   name is the part you remember. `src/commands/registry.ts` should not beat
 *   `registry.ts` for "registry".
 * - **Earlier is better**, mildly, as a tie-break.
 *
 * Case: a lowercase query matches case-insensitively, but an exact-case hit still
 * scores higher, so "IB" prefers `IconButton` to `isbn`. A query with an
 * uppercase letter in it is a deliberate act and is not folded away.
 */

/** Where a query character landed, so the UI can bold it. */
export type FuzzyMatch = { score: number; positions: number[] }

const BOUNDARY_BEFORE = new Set(['/', '\\', '_', '-', '.', ' '])

const SCORE = {
  /** Base for any matched character, so longer queries outrank shorter ones. */
  match: 16,
  /** Added per character of an unbroken run, compounding: 0, 8, 16, 24… */
  consecutive: 8,
  /** Landed just after a separator, or on a camelCase hump. */
  boundary: 18,
  /** Landed in the basename rather than the directory part. */
  basename: 12,
  /** The very first character of the basename. */
  basenameStart: 16,
  /** Same character, same case — a weak nudge, not a gate. */
  exactCase: 4,
  /** Per character skipped before the first match. Mild: a tie-break. */
  leading: -0.5,
  /** Per character skipped mid-match, so scattered hits lose to tight ones. */
  gap: -1
} as const

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if (BOUNDARY_BEFORE.has(prev)) return true
  // camelCase hump: a lower-to-upper step is a word start in the only naming
  // convention this codebase actually uses for files.
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && text[i] === text[i].toUpperCase()
}

/**
 * Score `query` against `text`, or `null` if it is not a subsequence.
 *
 * Two passes, because one is not safe. The forward pass wants to pull each
 * character onto a word boundary — that is what makes "cmdpal" rank
 * `CommandPalette` first — but a greedy jump can strand the rest of the query:
 * in `src/registry.ts`, the `t` of `regis·t·ry` would jump to the `t` of `.ts`
 * because a `.` precedes it, and then `r` and `y` have nowhere left to go. The
 * match was reported as "no match" for a string that plainly contains it.
 *
 * So the backward pass runs first and records, for each query character, the
 * rightmost index it could occupy while the remainder still fits. The forward
 * pass may then improve a position freely up to that bound and no further.
 * Feasibility is settled before any preference is applied, which also makes the
 * backward pass the cheap rejection path for the overwhelming majority of rows.
 */
export function fuzzyScore(text: string, query: string): FuzzyMatch | null {
  if (query === '') return { score: 0, positions: [] }
  if (query.length > text.length) return null

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()

  // Backward: the last index each query character may take. Doubles as the
  // rejection test — if any character has nowhere to go, nothing else matters.
  const latest = new Array<number>(lowerQuery.length)
  let bound = text.length - 1
  for (let q = lowerQuery.length - 1; q >= 0; q--) {
    const found = lowerText.lastIndexOf(lowerQuery[q], bound)
    if (found === -1) return null
    latest[q] = found
    bound = found - 1
  }

  // Everything after the last separator is the name; the rest is where it lives.
  const sep = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  const nameStart = sep + 1

  const positions: number[] = []
  let score = 0
  let run = 0
  let at = 0

  for (let q = 0; q < lowerQuery.length; q++) {
    const want = lowerQuery[q]
    let found = lowerText.indexOf(want, at)
    if (found === -1 || found > latest[q]) return null

    // Pull onto a boundary if one is reachable without stranding the rest.
    if (!isBoundary(text, found)) {
      for (let i = found + 1; i <= latest[q]; i++) {
        if (lowerText[i] === want && isBoundary(text, i)) {
          found = i
          break
        }
      }
    }

    if (positions.length === 0) {
      score += found * SCORE.leading
    } else {
      const skipped = found - positions[positions.length - 1] - 1
      if (skipped > 0) score += skipped * SCORE.gap
    }

    run = positions.length > 0 && found === positions[positions.length - 1] + 1 ? run + 1 : 0

    score += SCORE.match
    score += run * SCORE.consecutive
    if (isBoundary(text, found)) score += SCORE.boundary
    if (found >= nameStart) score += SCORE.basename
    if (found === nameStart) score += SCORE.basenameStart
    if (text[found] === query[q]) score += SCORE.exactCase

    positions.push(found)
    at = found + 1
  }

  return { score, positions }
}

export type FuzzyResult<T> = { item: T; score: number; positions: number[] }

/**
 * Rank `items` by how well `key(item)` matches `query`, best first.
 *
 * An empty query keeps the input order rather than returning nothing — a picker
 * opens showing the list, not a blank.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit = Infinity
): FuzzyResult<T>[] {
  const q = query.trim()
  if (q === '') {
    const head = limit === Infinity ? items : items.slice(0, limit)
    return head.map((item) => ({ item, score: 0, positions: [] }))
  }

  const out: FuzzyResult<T>[] = []
  for (const item of items) {
    const m = fuzzyScore(key(item), q)
    if (m) out.push({ item, score: m.score, positions: m.positions })
  }

  // Shorter wins ties: with equal evidence, the more specific string is the one
  // that was meant — `registry.ts` over `registryHelpers.ts`.
  out.sort((a, b) => b.score - a.score || key(a.item).length - key(b.item).length)
  return limit === Infinity ? out : out.slice(0, limit)
}

/**
 * Split `text` into runs, flagging which are matched, for rendering.
 *
 * Returning segments rather than HTML keeps this usable from anything — the
 * caller decides whether a match is bold, tinted, or both.
 */
export function highlightSegments(
  text: string,
  positions: readonly number[]
): { text: string; match: boolean }[] {
  if (positions.length === 0) return [{ text, match: false }]

  const hit = new Set(positions)
  const segments: { text: string; match: boolean }[] = []
  let buffer = ''
  let bufferMatch = hit.has(0)

  for (let i = 0; i < text.length; i++) {
    const m = hit.has(i)
    if (m !== bufferMatch && buffer !== '') {
      segments.push({ text: buffer, match: bufferMatch })
      buffer = ''
    }
    bufferMatch = m
    buffer += text[i]
  }
  if (buffer !== '') segments.push({ text: buffer, match: bufferMatch })
  return segments
}
