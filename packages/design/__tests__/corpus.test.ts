import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, validate } from '../src/pipeline'
import type { Issue } from '../src/pipeline/types'

const dir = resolve(__dirname, '../examples')
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.nyui.json'))
  .sort()

const load = (f: string): unknown => JSON.parse(readFileSync(resolve(dir, f), 'utf8'))

describe('the example corpus', () => {
  it('has the eight designs the spike is judged on, plus the spec worked example', () => {
    expect(files.length).toBeGreaterThanOrEqual(9)
  })

  it.each(files)('%s validates', (f) => {
    const r = validate(load(f))
    expect(r.ok, r.ok ? '' : JSON.stringify(r.issues.slice(0, 3), null, 2)).toBe(true)
  })

  it.each(files)('%s compiles and renders every artboard', (f) => {
    const { doc } = compile(load(f))
    expect(doc.artboards.length).toBeGreaterThan(0)
  })

  /**
   * The regression guard on lints.
   *
   * Both cross-property lints in the first pass were wrong on first contact
   * with a real design, in the same direction — too eager. `align` on a grid
   * container is valid CSS and was banned; the clipping warning fired on every
   * rounded button. Each fired four to six times across eight designs.
   *
   * That matters more than it sounds, because these warnings go back to Claude:
   * a lint that is wrong a third of the time trains the model to ignore the
   * channel. A new lint now has to be checked against the corpus before it can
   * ship, and anything it flags here has to be a real defect in the design.
   */
  it.each(files)('%s produces no warnings', (f) => {
    const { issues } = compile(load(f))
    const warnings = issues.filter((i: Issue) => i.severity === 'warning')
    expect(
      warnings,
      warnings.map((w) => `${w.code}: ${w.message} @ ${w.at?.scope}#${w.at?.id}`).join('\n')
    ).toHaveLength(0)
  })
})
