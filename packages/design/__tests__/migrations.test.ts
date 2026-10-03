import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FORMAT_VERSION,
  MIGRATIONS,
  NewerFormatError,
  formatVersionOf,
  missingMigrations,
  serializeDocument,
  upgrade,
  type Migration
} from '../src/migrations'
import { compile } from '../src/pipeline'
import { PipelineError } from '../src/pipeline/types'

/** A pretend three-version history, so the chain is exercised before the
 *  real format has more than one version. */
const history: Migration[] = [
  {
    from: 1,
    summary: 'title became name',
    migrate: (doc) => {
      const { title, ...rest } = doc
      return { doc: { ...rest, name: title ?? 'Untitled' } }
    }
  },
  {
    from: 2,
    summary: 'theme is dropped',
    migrate: (doc) => {
      const { theme, ...rest } = doc
      return { doc: rest, notes: theme && theme !== 'default' ? [`theme "${String(theme)}" was dropped`] : [] }
    }
  }
]

describe('the migration chain', () => {
  // The guard that makes "the format may break" safe: a version bump with no
  // step fails here, before it can strand a single file.
  it('has exactly one step for every version below the current one', () => {
    expect(missingMigrations()).toEqual([])
    expect(missingMigrations(history, 3)).toEqual([])
    expect(missingMigrations(history.slice(1), 3)).toEqual([1])
    expect(missingMigrations([...history, history[0]], 3)).toEqual([1])
  })

  it('every step reads the version before it, in order', () => {
    const froms = MIGRATIONS.map((m) => m.from)
    expect(froms).toEqual([...froms].sort((a, b) => a - b))
    expect(froms.every((v) => v >= 1 && v < FORMAT_VERSION)).toBe(true)
  })

  it('walks a file up every step and says what each one did', () => {
    const old = { schema: 1, title: 'Billing', theme: 'brand', artboards: [] }
    const out = upgrade(old, 'design', history, 3)
    expect(out).not.toBeNull()
    expect(out!.from).toBe(1)
    expect(out!.to).toBe(3)
    expect(out!.doc).toEqual({ schema: 3, name: 'Billing', artboards: [] })
    expect(out!.notes).toEqual([
      'v1 → v2: title became name',
      'v2 → v3: theme is dropped',
      'theme "brand" was dropped'
    ])
  })

  it('never touches the document it was given', () => {
    const old = { schema: 1, title: 'Billing', nested: { a: [1, 2] } }
    const before = JSON.stringify(old)
    upgrade(old, 'design', history, 3)
    expect(JSON.stringify(old)).toBe(before)
  })

  it('leaves a current file, and one with no usable version, to validation', () => {
    expect(upgrade({ schema: 3 }, 'design', history, 3)).toBeNull()
    expect(upgrade({ name: 'x' }, 'design', history, 3)).toBeNull()
    expect(upgrade('nope', 'design', history, 3)).toBeNull()
    expect(formatVersionOf({ schema: 0 })).toBeNull()
    expect(formatVersionOf({ schema: 1.5 })).toBeNull()
    expect(formatVersionOf({ schema: 2 })).toBe(2)
  })

  it('refuses a file from a newer Nyra by name', () => {
    expect(() => upgrade({ schema: 9 }, 'design', history, 3)).toThrow(NewerFormatError)
    try {
      compile({ schema: FORMAT_VERSION + 1, name: 'x', artboards: [] })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineError)
      expect((e as PipelineError).issues[0].code).toBe('schema-newer')
      expect((e as PipelineError).message).toMatch(/newer version of Nyra Design/)
    }
  })

  it('a gap in the chain is an error, never a half-upgraded file', () => {
    expect(() => upgrade({ schema: 1 }, 'design', history.slice(1), 3)).toThrow(/no migration from format v1/)
  })

  it('writes the result pretty-printed, so Claude can read it in pieces', () => {
    const text = serializeDocument({ schema: 1, a: { b: 1 } })
    expect(text.split('\n').length).toBeGreaterThan(3)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('the examples', () => {
  const dir = resolve(__dirname, '../examples')
  const files = readdirSync(dir).filter((f) => f.endsWith('.nyui.json'))

  // Examples are what the skill and the tests teach from, so they are always
  // written in the current format rather than relying on the upgrade.
  it.each(files)('%s is at the current format', (f) => {
    const doc = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
    expect(formatVersionOf(doc)).toBe(FORMAT_VERSION)
    expect(compile(doc).upgrade).toBeNull()
  })
})
