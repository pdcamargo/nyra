import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The app used to say "this is secondary" by putting an alpha on a token that
 * was already the muted ramp — `text-muted-foreground/40` and friends. On white
 * that composites to about 1.7:1: the elapsed times in the summary, the working
 * directory under it, the values column and the "+N more" were all effectively
 * invisible, and the same trick made the selected title-bar button
 * indistinguishable from the unselected ones.
 *
 * Muting a muted token is the mistake, and it is the kind that comes back one
 * component at a time, so it is cheaper to fail the build than to re-run the
 * sweep. `--muted-foreground` is tuned to clear AA on both surfaces; reach for a
 * different token if you need a second tier, not for a fraction of this one.
 */
const RENDERER = resolve(__dirname, '../../renderer/src')

/** Every alpha below full on a token that is already dim. */
const MUTED_ALPHA = /\btext-(?:muted-foreground|info|danger|success|warning|merged)\/(?:[0-9]|[1-6][0-9]|7[0-9])(?![0-9[])/g

/** --foreground is not dim to begin with, so it keeps a second tier with a floor. */
const FOREGROUND_ALPHA = /\btext-foreground\/(?:[0-9]|[1-7][0-9])(?![0-9[])/g

/**
 * `data-selected:` matches the attribute's *presence*, and cmdk writes
 * `data-selected="false"` on every row it is not on — so the variant fired on
 * all of them at once. In the file picker that painted all fifty rows the
 * selected colour, which happened to equal the surface underneath, so nothing
 * looked selected, hover did nothing, and the arrow keys looked dead.
 *
 * The value form is the one that means "this row". Everything else in the same
 * class string was already written that way (`data-[disabled=true]:`); this
 * variant was the odd one out.
 */
const BARE_DATA_SELECTED = /\bdata-selected:/g

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(full) ? [full] : []
  })
}

function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of walk(RENDERER)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const hit of line.match(new RegExp(pattern.source, 'g')) ?? []) {
          found.push(`${relative(RENDERER, file)}:${i + 1}  ${hit}`)
        }
      })
  }
  return found
}

describe('text contrast', () => {
  it('never puts an alpha on an already-muted token', () => {
    expect(offenders(MUTED_ALPHA)).toEqual([])
  })

  // `text-foreground/[0.07]` — the watermark behind an empty chat — is an
  // arbitrary value rather than a scale step, and deliberately almost invisible.
  // The lookahead leaves it alone.
  it('keeps --foreground text at 80% or above', () => {
    expect(offenders(FOREGROUND_ALPHA)).toEqual([])
  })
})

describe('selected state', () => {
  it('matches data-selected by value, not by the attribute being there', () => {
    expect(offenders(BARE_DATA_SELECTED)).toEqual([])
  })
})
