import type { z } from 'zod'
import type { Theme, ScaleName } from '../theme/types'

export const NODE_KINDS = ['box', 'text', 'icon', 'image', 'use'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const CATEGORIES = ['layout', 'size', 'position', 'surface', 'typography', 'content'] as const
export type PropCategory = (typeof CATEGORIES)[number]

/** What an emitter returns. Kept as a plain style object so the same records
 *  can later feed a rule-based stylesheet for shadow DOM without rewriting. */
export type Style = Record<string, string | number>

export type PropDef<
  S extends z.ZodType = z.ZodType,
  A extends readonly NodeKind[] = readonly NodeKind[],
  R extends boolean = boolean,
  L extends boolean = boolean,
  O extends boolean = boolean
> = {
  schema: S
  css: (value: z.output<S>, theme: Theme) => Style
  appliesTo: A
  required: R
  list: L
  category: PropCategory
  /** Scales this property's values may reference. Empty means never
   *  token-resolved — which is what keeps a label reading "$5.00" intact. */
  tokens: readonly ScaleName[]
  /**
   * How token paths are found inside this property's value. The default walks
   * everything when `tokens` is non-empty. `text.value` overrides it, because
   * a run's colour must resolve while the run's *text* must not — a label
   * reading "$space.2" is content, not a token.
   */
  resolve?: (value: unknown, resolveDeep: (v: unknown) => unknown) => unknown
  /**
   * Sub-node styling this property implies — inline runs inside a text value.
   * A property that styles *parts* of its own value owns that here, so the
   * emitter still never branches on node kind to find it.
   */
  spans?: (value: unknown, theme: Theme) => { text: string; style: Style }[] | undefined
  /** Layout-in-parent, so a `use` instance may carry it and the resolver
   *  merges it onto the component's root. Not an appearance override. */
  outer: O
  doc: string
  examples: readonly z.output<S>[]
  invalid: readonly unknown[]
}

/**
 * The constraint the registry is checked against. `css` takes `never` on
 * purpose: under strictFunctionTypes a parameter of `unknown` rejects every
 * concrete emitter contravariantly (TS1360).
 */
export type PropDefLike = {
  schema: z.ZodType
  css: (value: never, theme: Theme) => Style
  appliesTo: readonly NodeKind[]
  required: boolean
  list: boolean
  category: PropCategory
  tokens: readonly ScaleName[]
  resolve?: (value: never, resolveDeep: (v: unknown) => unknown) => unknown
  spans?: (value: never, theme: Theme) => { text: string; style: Style }[] | undefined
  outer: boolean
  doc: string
  // `never` is correct for `css` (a parameter, so contravariant) and wrong
  // here: `examples` is covariant, and `readonly never[]` would reject every
  // real example. `unknown` is the accepting end of the same asymmetry.
  examples: readonly unknown[]
  invalid: readonly unknown[]
}

/**
 * One record per property. Everything — the Zod schema, the TS type, the CSS
 * emitter, the generated vocabulary, and later the inspector's field list —
 * derives from these.
 *
 * The `const` parameters are load-bearing, not decoration. Without `const A`,
 * `appliesTo` widens to `NodeKind[]` and every property silently applies to
 * every node. Without `const R`, `required` comes back `boolean | undefined`,
 * `boolean extends true` is false, and every property reads as optional at the
 * type level while the runtime correctly makes `text.value` required — type and
 * runtime disagreeing with no diagnostic anywhere.
 */
export function defineProp<
  S extends z.ZodType,
  const A extends readonly NodeKind[],
  const R extends boolean = false,
  const L extends boolean = false,
  const O extends boolean = false
>(def: {
  schema: S
  css: (value: z.output<S>, theme: Theme) => Style
  appliesTo: A
  required?: R
  list?: L
  category: PropCategory
  tokens?: readonly ScaleName[]
  resolve?: (value: unknown, resolveDeep: (v: unknown) => unknown) => unknown
  spans?: (value: unknown, theme: Theme) => { text: string; style: Style }[] | undefined
  outer?: O
  doc: string
  examples: readonly z.output<S>[]
  invalid?: readonly unknown[]
}): PropDef<S, A, R, L, O> {
  return {
    schema: def.schema,
    css: def.css,
    appliesTo: def.appliesTo,
    required: (def.required ?? false) as R,
    list: (def.list ?? false) as L,
    category: def.category,
    tokens: def.tokens ?? [],
    resolve: def.resolve,
    spans: def.spans,
    outer: (def.outer ?? false) as O,
    doc: def.doc,
    examples: def.examples,
    invalid: def.invalid ?? []
  }
}

export type NodeDef = {
  kind: NodeKind
  children: 'many' | 'none'
  doc: string
  /**
   * The one thing a flat property registry cannot express: a style on the
   * parent caused by a child's property. v0 has exactly one — a box containing
   * an absolutely positioned child becomes a positioning context. Declared
   * here so it stays registry-driven instead of becoming an `if` in the
   * emitter, and so the provenance test can account for what it emits.
   */
  derive?: (childStyles: readonly Style[]) => Style
}

export function defineNode(kind: NodeKind, def: Omit<NodeDef, 'kind'>): NodeDef {
  return { kind, ...def }
}
