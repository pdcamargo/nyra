import { describe, it, expect } from 'vitest'
import {
  templateVariables,
  expressionVariables,
  templateSpans,
  scopeSpans,
  declaredVars
} from '../../renderer/src/lib/flowVariables'
import type { WorkflowDefinition } from '../../shared/workflow-types'

const wf = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  ({
    id: 'w',
    name: 'w',
    nodes: [],
    edges: [],
    createdAt: 0,
    updatedAt: 0,
    ...over
  }) as unknown as WorkflowDefinition

const promptNode = (id: string, label: string, setVars: { name: string }[]): unknown => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { type: 'prompt', prompt: '', setVars: setVars.map((v) => ({ ...v, extractor: '' })) }
})

describe('templateVariables', () => {
  it('always offers the previous node output', () => {
    expect(templateVariables(wf()).map((v) => v.insert)).toEqual(['prev.output'])
  })

  it('offers flow inputs by key, labelled by their prompt', () => {
    const v = templateVariables(
      wf({ inputs: [{ key: 'company', label: 'Company name or URL' }] } as Partial<WorkflowDefinition>)
    )
    expect(v[1]).toMatchObject({ insert: 'input.company', detail: 'Company name or URL' })
  })

  it('gathers captures from every node and says which one made them', () => {
    const v = templateVariables(
      wf({
        nodes: [
          promptNode('a', 'Security', [{ name: 'security_report' }]),
          promptNode('b', 'Style', [{ name: 'style_report' }])
        ] as never
      })
    )
    expect(v.map((x) => x.insert)).toEqual([
      'prev.output',
      'vars.security_report',
      'vars.style_report'
    ])
    expect(v[1].detail).toBe('captured by Security')
  })

  it('skips half-typed and duplicate capture names', () => {
    // A capture row starts life with an empty name, and `9lives` is not a legal
    // identifier — offering either would insert something that cannot resolve.
    const v = templateVariables(
      wf({
        nodes: [
          promptNode('a', 'A', [{ name: '' }, { name: '9lives' }, { name: 'ok' }]),
          promptNode('b', 'B', [{ name: 'ok' }])
        ] as never
      })
    )
    expect(v.map((x) => x.insert)).toEqual(['prev.output', 'vars.ok'])
  })

  it('is empty with no flow rather than throwing', () => {
    expect(templateVariables(null)).toEqual([])
  })
})

describe('expressionVariables', () => {
  it('offers the three bare identifiers, not the template forms', () => {
    const v = expressionVariables(wf()).map((x) => x.insert)
    expect(v).toEqual(['output', 'vars', 'iteration'])
    expect(v).not.toContain('prev.output')
  })

  it('adds captured vars so a condition can test one', () => {
    const v = expressionVariables(
      wf({ nodes: [promptNode('a', 'Score', [{ name: 'score' }])] as never })
    )
    expect(v.map((x) => x.insert)).toContain('vars.score')
  })
})

describe('templateSpans', () => {
  const known = templateVariables(
    wf({ nodes: [promptNode('a', 'A', [{ name: 'score' }])] as never })
  )

  it('marks a resolving reference known', () => {
    const [s] = templateSpans('use {{vars.score}} here', known)
    expect(s).toMatchObject({ name: 'vars.score', known: true, from: 4, to: 18 })
  })

  it('marks a typo unknown, which is the whole point', () => {
    // Indistinguishable from a working reference until the run produces an
    // empty string, which is why it gets its own colour.
    const [s] = templateSpans('use {{vars.scor}} here', known)
    expect(s.known).toBe(false)
  })

  it('tolerates whitespace inside the braces', () => {
    const [s] = templateSpans('{{  vars.score  }}', known)
    expect(s).toMatchObject({ name: 'vars.score', known: true })
  })

  it('treats a bare namespace as known so typing does not flash a warning', () => {
    expect(templateSpans('{{vars}}', known)[0].known).toBe(true)
    expect(templateSpans('{{prev}}', known)[0].known).toBe(true)
  })

  it('finds every span in a multi-reference prompt', () => {
    const spans = templateSpans('{{prev.output}} then {{vars.score}}', known)
    expect(spans.map((s) => s.name)).toEqual(['prev.output', 'vars.score'])
  })

  it('ignores a single brace pair', () => {
    expect(templateSpans('{not a var}', known)).toEqual([])
  })
})

describe('scopeSpans', () => {
  const names = (t: string): string[] => scopeSpans(t).map((s) => s.name)

  it('marks the whole vars path, not just the root', () => {
    // Colouring only `vars` left `.score` — the half that names the value —
    // looking like plain text.
    expect(names('vars.score > 8')).toEqual(['vars.score'])
  })

  it('does not swallow a method call on output', () => {
    // `output` is a string, so `.includes` is a method, not a variable. The
    // first version of this matched `output.includes` and claimed it was one.
    expect(names("output.includes('PASS')")).toEqual(['output'])
  })

  it('leaves iteration bare for the same reason', () => {
    expect(names('iteration.toFixed(0) > 2')).toEqual(['iteration'])
  })

  it('finds each identifier in a real condition', () => {
    expect(names('(parseInt(vars.score) || 0) < 8 && iteration < 5')).toEqual([
      'vars.score',
      'iteration'
    ])
  })

  it('ignores identifiers that merely start with one of the names', () => {
    expect(names('outputs + iterations + varsity')).toEqual([])
  })

  it('reports ranges that cover exactly the identifier', () => {
    const [s] = scopeSpans('x && vars.a.b')
    expect('x && vars.a.b'.slice(s.from, s.to)).toBe('vars.a.b')
  })
})

describe('declaredVars', () => {
  const promptWith = (id: string, label: string, setVars: unknown[]): unknown => ({
    id,
    label,
    position: { x: 0, y: 0 },
    data: { type: 'prompt', prompt: '', setVars }
  })

  const wfWith = (nodes: unknown[]): WorkflowDefinition =>
    ({ id: 'w', name: 'w', nodes, edges: [], createdAt: 0, updatedAt: 0 }) as unknown as WorkflowDefinition

  it('finds captures the flow has never run', () => {
    // The whole point: the panel used to show only what a run produced, so a
    // flow you were still building had nothing in it.
    const d = declaredVars(
      wfWith([promptWith('a', 'Security', [{ name: 'report', extractor: '' }])])
    )
    expect(d).toEqual([{ name: 'report', nodeId: 'a', nodeLabel: 'Security', kind: 'raw' }])
  })

  it('reports how each value is extracted', () => {
    const d = declaredVars(
      wfWith([
        promptWith('a', 'A', [
          { name: 'j', extractor: 'json:a.b' },
          { name: 'r', extractor: 'regex:\\d+' },
          { name: 'l', extractor: 'lines:1-5' },
          { name: 'p', extractor: '' }
        ])
      ])
    )
    expect(d.map((x) => x.kind)).toEqual(['json', 'regex', 'lines', 'raw'])
  })

  it('falls back to the node id when a node has no label', () => {
    const d = declaredVars(wfWith([promptWith('n7', '', [{ name: 'x', extractor: '' }])]))
    expect(d[0].nodeLabel).toBe('n7')
  })

  it('skips blank and duplicate names, as the completion list does', () => {
    const d = declaredVars(
      wfWith([
        promptWith('a', 'A', [{ name: '', extractor: '' }, { name: 'ok', extractor: '' }]),
        promptWith('b', 'B', [{ name: 'ok', extractor: '' }])
      ])
    )
    expect(d.map((x) => x.name)).toEqual(['ok'])
    expect(d[0].nodeId).toBe('a')
  })

  it('is empty for a flow with no captures', () => {
    expect(declaredVars(wfWith([promptWith('a', 'A', [])]))).toEqual([])
    expect(declaredVars(null)).toEqual([])
  })
})
