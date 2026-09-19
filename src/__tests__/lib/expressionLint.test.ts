import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { expressionProblems } from '../../renderer/src/lib/expressionLint'

/**
 * These assertions mirror `evaluate_condition` in `workflow/helpers.rs`, which
 * pastes the text into `Boolean(<expression>)` and turns any error into
 * `false`. Anything that would not parse in that position has to be reported
 * here, because the engine will never mention it.
 */
const problems = (doc: string): string[] =>
  expressionProblems(
    EditorState.create({ doc, extensions: [javascript()] })
  ).map((p) => p.message)

describe('expressionProblems', () => {
  it.each([
    ['true'],
    ['false'],
    ["output.includes('PASS')"],
    ['(vars.score | 0) < 8'],
    ['iteration < 5 && !output.includes("FAIL")'],
    ['vars.status === "ok" ? true : false'],
    ['output.length > 0']
  ])('accepts %s', (expr) => {
    expect(problems(expr)).toEqual([])
  })

  it('accepts an empty expression', () => {
    // Boolean() is false, which is a fair "not configured yet" rather than a
    // mistake to shout about while the field is still blank.
    expect(problems('')).toEqual([])
    expect(problems('   ')).toEqual([])
  })

  it('flags a trailing semicolon, which looks harmless and is not', () => {
    // Boolean(true;) does not parse, so the condition is always false.
    expect(problems('true;')[0]).toMatch(/semicolon/i)
  })

  it('flags a variable declaration', () => {
    expect(problems('const ok = output.length > 0')[0]).toMatch(/`const` cannot go here/)
  })

  it('flags a return statement', () => {
    // Natural to write, since the engine wraps it in a function — but the
    // wrapper already returns, so this lands inside Boolean(...).
    expect(problems('return true').length).toBeGreaterThan(0)
  })

  it('flags an if statement', () => {
    expect(problems('if (output) true').length).toBeGreaterThan(0)
  })

  it('flags unparseable text', () => {
    expect(problems('output.includes(')[0]).toMatch(/not a valid expression/i)
  })

  it('reports one problem rather than piling on', () => {
    // Everything downstream of a broken parse is noise; one clear message beats
    // three speculative ones.
    expect(problems('output ===')).toHaveLength(1)
  })

  // Regression guards. Each of these was flagged by the first version of this
  // check, which parsed the expression on its own instead of parsing what the
  // engine builds around it.
  it.each([
    ['a leading comment', '// only if it passed\noutput.includes("PASS")'],
    ['an object literal', '{ a: 1 }'],
    ['a bracket key', 'vars["my-key"] === "x"'],
    ['optional chaining', 'output?.length > 0'],
    ['a multi-line expression', "output.includes('a') &&\n  output.includes('b')"]
  ])('accepts %s', (_name, expr) => {
    expect(problems(expr)).toEqual([])
  })

  it('flags a trailing line comment, which looks fine and is not', () => {
    // The engine builds one line, so the comment eats the `); }})` after it.
    // Asserted against the real engine in workflow/helpers.rs.
    expect(problems('true // looks fine')[0]).toMatch(/comments out the rest of the line/i)
  })

  it('accepts a block comment, which is what that warning recommends', () => {
    expect(problems('true /* fine */')).toEqual([])
  })

  it('points at the offending text, not the whole field', () => {
    const [p] = expressionProblems(
      EditorState.create({ doc: 'const ok = 1', extensions: [javascript()] })
    )
    expect(p.from).toBe(0)
    expect(p.to).toBeGreaterThan(0)
    expect(p.to).toBeLessThanOrEqual('const ok = 1'.length)
  })
})
