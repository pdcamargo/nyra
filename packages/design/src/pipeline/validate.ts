import { z } from 'zod'
import type { Address } from '../ids'
import { PROPS } from '../registry/props'
import { propNamesFor } from '../registry/shapes'
import type { NodeKind } from '../registry/define'
import type { PropName } from '../registry/types'
import {
  childrenOf,
  documentSchema,
  isUseNode,
  SCHEMA_VERSION,
  type ComponentDef,
  type DesignDocument,
  type DocNode
} from '../schema'
import { isMatch, isPropRef, type Match, type PropRef } from '../value'
import { isTokenPath } from '../theme/resolve'
import { err, warn, type Issue } from './types'

export type ValidateResult =
  | { ok: true; doc: DesignDocument; issues: Issue[] }
  | { ok: false; issues: Issue[] }

const kindOf = (n: DocNode): NodeKind => (isUseNode(n) ? 'use' : n.type)

/** Walks a node's property values, ignoring `id`, `type`, `use`, `children`. */
function* propEntries(n: DocNode): Generator<[PropName, unknown]> {
  const skip = new Set(['id', 'type', 'use', 'children', 'props'])
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k) || v === undefined) continue
    yield [k as PropName, v]
  }
}

/** Every literal buried in the three value forms, with its path. */
function* literals(v: unknown, path: (string | number)[] = []): Generator<[unknown, (string | number)[]]> {
  if (isPropRef(v)) return
  if (isMatch(v)) {
    const m = v as Match<unknown>
    for (const [k, c] of Object.entries(m.cases)) yield* literals(c, [...path, 'cases', k])
    if (m.default !== undefined) yield* literals(m.default, [...path, 'default'])
    return
  }
  yield [v, path]
}

function* refs(v: unknown, path: (string | number)[] = []): Generator<[PropRef, (string | number)[]]> {
  if (isPropRef(v)) {
    yield [v, path]
    return
  }
  if (isMatch(v)) {
    const m = v as Match<unknown>
    yield [m.match, [...path, 'match']]
    for (const [k, c] of Object.entries(m.cases)) yield* refs(c, [...path, 'cases', k])
    if (m.default !== undefined) yield* refs(m.default, [...path, 'default'])
  }
}

/**
 * Structural validation is Zod's. What follows is everything Zod cannot see:
 * references between parts of one document, and cross-property combinations
 * that parse but mean nothing.
 */
export function validate(input: unknown): ValidateResult {
  const parsed = documentSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) =>
        err('schema', i.message, undefined, i.path as (string | number)[])
      )
    }
  }
  const doc = parsed.data

  const issues: Issue[] = []
  if (doc.schema !== SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        err(
          'schema-version',
          `document is schema ${doc.schema}; this build understands ${SCHEMA_VERSION}. The loader migrates or refuses — it never renders a file it does not understand.`
        )
      ]
    }
  }

  const components = doc.components ?? {}

  const seenArtboards = new Set<string>()
  for (const a of doc.artboards) {
    if (seenArtboards.has(a.id)) issues.push(err('duplicate-artboard', `two artboards share the id "${a.id}"`))
    seenArtboards.add(a.id)
  }

  // A `{ prop }` outside a component has no scope to resolve against. That is
  // not a structural error, so it lands here rather than in the schema.
  for (const a of doc.artboards) checkTree(a.root, a.id, null, components, issues)
  for (const [name, def] of Object.entries(components)) {
    checkTree(def.root, name, def, components, issues)
  }

  const errors = issues.filter((i) => i.severity === 'error')
  return errors.length > 0 ? { ok: false, issues } : { ok: true, doc, issues }
}

function checkTree(
  root: DocNode,
  scope: string,
  owner: ComponentDef | null,
  components: Record<string, ComponentDef>,
  issues: Issue[]
): void {
  const seen = new Set<string>()

  const visit = (n: DocNode): void => {
    const at: Address = { scope, id: n.id }
    if (seen.has(n.id)) {
      issues.push(err('duplicate-id', `two nodes in "${scope}" share the id "${n.id}"`, at))
    }
    seen.add(n.id)

    const kind = kindOf(n)
    const allowed = new Set<string>(propNamesFor(kind))

    for (const [prop, value] of propEntries(n)) {
      if (!allowed.has(prop)) {
        // Unreachable through the strict schema, but the registry is the
        // authority and a second opinion here costs nothing.
        issues.push(err('prop-not-applicable', `"${prop}" does not apply to a ${kind}`, at))
        continue
      }
      checkValue(prop, value, at, owner, issues)
    }

    if (isUseNode(n)) {
      checkInstance(n.use, n.props ?? {}, at, owner, components, issues)
    } else {
      lintCombination(n, at, issues)
    }

    for (const c of childrenOf(n)) visit(c)
  }

  visit(root)
}

function checkValue(
  prop: PropName,
  value: unknown,
  at: Address,
  owner: ComponentDef | null,
  issues: Issue[]
): void {
  for (const [ref, path] of refs(value)) {
    if (!owner) {
      issues.push(
        err(
          'prop-ref-outside-component',
          `"${prop}" references the prop "${ref.prop}", but this node is in an artboard, which has no props`,
          at,
          [prop, ...path]
        )
      )
      continue
    }
    const declared = owner.props?.[ref.prop]
    if (!declared) {
      issues.push(
        err('unknown-prop-ref', `"${prop}" references undeclared component prop "${ref.prop}"`, at, [
          prop,
          ...path
        ])
      )
    }
  }

  // A match over an enum prop should cover it, or say what happens otherwise.
  if (isMatch(value) && owner) {
    const m = value as Match<unknown>
    const declared = owner.props?.[m.match.prop]
    if (declared?.type === 'enum') {
      const missing = declared.of.filter((c) => !(c in m.cases))
      if (missing.length > 0 && m.default === undefined) {
        issues.push(
          err(
            'match-not-exhaustive',
            `"${prop}" matches on "${m.match.prop}" but has no case for ${missing.map((c) => `"${c}"`).join(', ')} and no default`,
            at,
            [prop]
          )
        )
      }
      const extra = Object.keys(m.cases).filter((c) => !declared.of.includes(c))
      if (extra.length > 0) {
        issues.push(
          err(
            'match-unknown-case',
            `"${prop}" has case(s) ${extra.map((c) => `"${c}"`).join(', ')} that "${m.match.prop}" can never be`,
            at,
            [prop]
          )
        )
      }
    }
  }

  // The spec's lint: a raw literal where a token exists.
  //
  // Skipped for a property that owns its own token resolution. `text.value`
  // declares colour and font scales so its *runs* resolve, and every literal
  // inside it is content — without this, every heading in every design gets
  // told that "Welcome back" should have been a token.
  const def = PROPS[prop]
  if (def.tokens.length > 0 && !def.resolve) {
    for (const [lit, path] of literals(value)) {
      if (typeof lit === 'string' && isTokenPath(lit)) continue
      if (lit === undefined || lit === null) continue
      if (typeof lit === 'object') continue
      // Theme-invariant values are not raw literals in the sense that matters.
      // `shadow: "none"` is offered by the property's own schema, and zero is
      // zero in every theme — objecting to either makes the lint contradict
      // the vocabulary, which is how a warning channel gets ignored.
      if (lit === 0 || THEME_INVARIANT.has(lit as string)) continue
      issues.push(
        warn(
          'raw-literal',
          `"${prop}" is ${JSON.stringify(lit)}; a ${def.tokens.map((t) => `$${t}.*`).join(' or ')} token would survive a theme change`,
          at,
          [prop, ...path]
        )
      )
    }
  }
}

function checkInstance(
  name: string,
  props: Record<string, unknown>,
  at: Address,
  owner: ComponentDef | null,
  components: Record<string, ComponentDef>,
  issues: Issue[]
): void {
  const target = components[name]
  if (!target) {
    issues.push(err('unknown-component', `no component named "${name}"`, at))
    return
  }
  const declared = target.props ?? {}

  for (const [k, v] of Object.entries(props)) {
    const d = declared[k]
    if (!d) {
      issues.push(
        err(
          'unknown-instance-prop',
          `"${name}" has no prop "${k}" (it declares ${Object.keys(declared).map((p) => `"${p}"`).join(', ') || 'none'})`,
          at
        )
      )
      continue
    }
    // The value may itself be a reference into the *enclosing* component.
    for (const [ref] of refs(v)) {
      if (!owner) {
        issues.push(
          err('prop-ref-outside-component', `prop "${k}" references "${ref.prop}" from an artboard, which has no props`, at)
        )
      } else if (!owner.props?.[ref.prop]) {
        issues.push(err('unknown-prop-ref', `prop "${k}" references undeclared prop "${ref.prop}"`, at))
      }
    }
    if (!isPropRef(v) && !isMatch(v)) {
      const lit = literalSchemaFor(d).safeParse(v)
      if (!lit.success) {
        issues.push(err('bad-instance-prop', `"${k}" on "${name}": ${lit.error.issues[0]?.message}`, at))
      }
    }
  }

  for (const [k, d] of Object.entries(declared)) {
    if (!(k in props) && d.default === undefined) {
      issues.push(err('missing-instance-prop', `"${name}" needs "${k}", which has no default`, at))
    }
  }
}

function literalSchemaFor(d: { type: string; of?: string[] }): z.ZodType {
  switch (d.type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'boolean':
      return z.boolean()
    default:
      return z.enum((d.of ?? []) as [string, ...string[]])
  }
}

/**
 * Values that mean the same thing under every theme, and so are never a
 * missing token. These are the keyword alternatives the scalar schemas offer
 * deliberately — a lint that objects to `shadow: "none"` is arguing with the
 * schema that allows it.
 */
const THEME_INVARIANT = new Set(['none', 'full', 'fit', 'transparent', 'currentColor'])

/**
 * Cross-property combinations that parse but mean nothing. These are warnings,
 * not errors: they are reported back to Claude, which is the loop the whole
 * tool exists to run.
 */
function lintCombination(n: Exclude<DocNode, { use: string }>, at: Address, issues: Issue[]): void {
  if (n.type !== 'box') return
  const layout = typeof n.layout === 'string' ? n.layout : undefined
  const has = (k: string): boolean => k in n && (n as Record<string, unknown>)[k] !== undefined

  const says = layout ? `"${layout}"` : 'unset, which is "none"'
  // `align` and `justify` are box-alignment properties: they work on a grid
  // container as well as a flex one, and centring cells in a row is the main
  // reason to reach for grid at all.
  for (const k of ['direction', 'wrap']) {
    if (layout !== 'stack' && has(k)) {
      issues.push(warn('no-effect', `"${k}" needs layout: "stack" — this box is ${says}`, at, [k]))
    }
  }
  for (const k of ['align', 'justify']) {
    if (layout !== 'stack' && layout !== 'grid' && has(k)) {
      issues.push(
        warn('no-effect', `"${k}" needs layout: "stack" or "grid" — this box is ${says}`, at, [k])
      )
    }
  }
  if (layout !== 'grid' && has('columns')) {
    issues.push(warn('no-effect', `"columns" needs layout: "grid"`, at, ['columns']))
  }
  if (layout === 'none' && has('gap')) {
    issues.push(warn('no-effect', `"gap" needs layout: "stack" or "grid"`, at, ['gap']))
  }
  // CSS resolves a padding percentage against the containing block's WIDTH on
  // every side, including top and bottom. That is real CSS and so it is
  // allowed, but a design whose vertical rhythm silently tracks its width is
  // the kind of surprise a mock exists to avoid.
  const pad = (n as { padding?: unknown }).padding
  const vertical =
    Array.isArray(pad) ? [pad[0], pad[2]] : typeof pad === 'string' ? [pad] : []
  if (vertical.some((x) => typeof x === 'string' && x.endsWith('%'))) {
    issues.push(
      warn(
        'percent-padding',
        `a percentage in "padding" resolves against the container's WIDTH even on the top and bottom edges — use a $space.* token unless that is what you meant`,
        at,
        ['padding']
      )
    )
  }

  const pos = typeof n.position === 'string' ? n.position : undefined
  if (has('inset') && pos !== 'absolute') {
    issues.push(warn('no-effect', `"inset" needs position: "absolute"`, at, ['inset']))
  }
  // Only children that actually paint can square off a rounded corner. Warning
  // on every rounded box with a text child inside padding — a button — makes
  // the lint noise, and a lint Claude learns to ignore is worse than none.
  // An absolutely positioned child overhanging a rounded box is the badge
  // pattern — deliberate, and clipping it would be the bug.
  const paints = (c: DocNode): boolean =>
    !isUseNode(c) &&
    c.position !== 'absolute' &&
    (c.type === 'image' || 'background' in c || 'border' in c)
  // Padding keeps children off the corner too, so only an unpadded box is at risk.
  if (has('radius') && !has('overflow') && !has('padding') && childrenOf(n).some(paints)) {
    issues.push(
      warn(
        'clipping',
        `this box has a radius and a child that paints to its edge, but no overflow: "hidden" — the child will square off the corners`,
        at,
        ['overflow']
      )
    )
  }
}
