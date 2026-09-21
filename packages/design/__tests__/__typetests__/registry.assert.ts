/**
 * Compiled, never run. These are the guard on the two flat casts in
 * `registry/shapes.ts`: they prove the compile-time mapped type and the
 * runtime-built Zod schema describe the same object.
 *
 * `Equal` distinguishes `{a?: X}` from `{a: X | undefined}`, which is exactly
 * the required/optional flip a plain assignability check would wave through.
 * Everything is exported so `noUnusedLocals` cannot strip it if it is ever on.
 */
import type { z } from 'zod'
import type { Value } from '../../src/value'
import type { TextRun, TextValue } from '../../src/text'
import type { NodeKind, PropDefLike } from '../../src/registry/define'
import type { PROPS } from '../../src/registry/props'
import type { PropName, KeysFor, PropsFor, IsReq, OuterPropName } from '../../src/registry/types'
import type { boxProps, textProps, iconProps, imageProps, useProps } from '../../src/registry/shapes'

export type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T

// The load-bearing four: schema and mapped type agree, per node kind.
export type _BoxAgrees = Expect<Equal<z.infer<typeof boxProps>, PropsFor<'box'>>>
export type _TextAgrees = Expect<Equal<z.infer<typeof textProps>, PropsFor<'text'>>>
export type _IconAgrees = Expect<Equal<z.infer<typeof iconProps>, PropsFor<'icon'>>>
export type _ImageAgrees = Expect<Equal<z.infer<typeof imageProps>, PropsFor<'image'>>>
export type _UseAgrees = Expect<Equal<z.infer<typeof useProps>, PropsFor<'use'>>>

// Adding a property without routing it to any node kind is a build error.
export type _AllPropsRouted = Expect<
  Equal<
    PropName,
    KeysFor<'box'> | KeysFor<'text'> | KeysFor<'icon'> | KeysFor<'image'> | KeysFor<'use'>
  >
>

// `required` must survive `defineProp` as a literal. If it widens to `boolean`,
// `boolean extends true` is false, every property reads optional, and the
// runtime disagrees with the types in silence.
export type _ValueIsRequired = Expect<Equal<IsReq<'value'>, true>>
export type _NameIsRequired = Expect<Equal<IsReq<'name'>, true>>
export type _SrcIsRequired = Expect<Equal<IsReq<'src'>, true>>
export type _PaddingIsOptional = Expect<Equal<IsReq<'padding'>, false>>

// `appliesTo` must stay a literal tuple. If it widens to NodeKind[], every
// property applies to every kind and these two stop differing.
export type _TextHasValue = Expect<Equal<Extract<KeysFor<'text'>, 'value'>, 'value'>>
export type _BoxHasNoValue = Expect<Equal<Extract<KeysFor<'box'>, 'value'>, never>>
export type _BoxHasGap = Expect<Equal<Extract<KeysFor<'box'>, 'gap'>, 'gap'>>
export type _IconHasNoGap = Expect<Equal<Extract<KeysFor<'icon'>, 'gap'>, never>>

// The filter must not distribute: a union kind yields the COMMON properties,
// not the union of them. `value` is on text only, so it must not appear here.
export type _NoDistribution = Expect<Equal<Extract<KeysFor<'box' | 'text'>, 'value'>, never>>

// The outer-layout subset a `use` instance carries.
export type _UseIsOuterOnly = Expect<Equal<KeysFor<'use'>, OuterPropName>>
export type _UseHasGrow = Expect<Equal<Extract<KeysFor<'use'>, 'grow'>, 'grow'>>
export type _UseHasNoPadding = Expect<Equal<Extract<KeysFor<'use'>, 'padding'>, never>>
export type _UseHasNoBackground = Expect<Equal<Extract<KeysFor<'use'>, 'background'>, never>>

// Literal types reach through the registry rather than collapsing to unknown.
type Space = string | number
export type _GapIsWrapped = Expect<
  Equal<PropsFor<'box'>['gap'], Value<Space | [Space, Space]> | undefined>
>
// Runs, not a concatenating array of forms — the structural fix.
export type _TextValueTakesRuns = Expect<Equal<PropsFor<'text'>['value'], TextValue>>
export type _ARunIsASpan = Expect<
  Equal<Extract<TextValue, unknown[]>[number], Value<string> | TextRun>
>

// Masks are exhaustive in both directions.
export const boxMaskShape = { layout: true } satisfies Partial<Record<KeysFor<'box'>, true>>
export type _KindsAreClosed = Expect<Equal<NodeKind, 'box' | 'text' | 'icon' | 'image' | 'use'>>

// The shape check that cannot be a `satisfies` clause on PROPS itself without
// widening every const parameter back to its constraint.
export type _RegistryIsWellFormed = Expect<
  typeof PROPS extends Record<string, PropDefLike> ? true : false
>
