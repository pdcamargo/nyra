import type { z } from 'zod'
import type { Value } from '../value'
import type { TextValue } from '../text'
import type { NodeKind } from './define'
import { PROPS } from './props'

export type PropName = keyof typeof PROPS
export type Lit<K extends PropName> = z.output<(typeof PROPS)[K]['schema']>
export type AppliesTo<K extends PropName> = (typeof PROPS)[K]['appliesTo'][number]
export type IsReq<K extends PropName> = (typeof PROPS)[K]['required']
export type IsList<K extends PropName> = (typeof PROPS)[K]['list']

/**
 * Which properties a node kind accepts.
 *
 * The tuple wrapper is not noise. `Kind extends AppliesTo<K>` is distributive,
 * so a union `Kind` yields the *union* of every member's properties — `value`
 * offered on a box. Single kinds agree either way, so no unit test would ever
 * catch it; `[Kind] extends [AppliesTo<K>]` asks the question that was meant.
 */
export type KeysFor<Kind extends NodeKind> = {
  [K in PropName]: [Kind] extends [AppliesTo<K>] ? K : never
}[PropName]

/**
 * Every property is wrapped in the three value forms. `list` marks the one
 * property whose shape is bespoke — `text.value`, which takes inline runs. It
 * is named here rather than generalised because generalising a single case is
 * how a registry grows a mechanism nobody else uses.
 */
export type Wrapped<K extends PropName> = IsList<K> extends true ? TextValue : Value<Lit<K>>

/** Flattens an intersection so hovers and errors read as one object. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}

export type PropsFor<Kind extends NodeKind> = Prettify<
  { [K in KeysFor<Kind> as IsReq<K> extends true ? K : never]: Wrapped<K> } & {
    [K in KeysFor<Kind> as IsReq<K> extends true ? never : K]?: Wrapped<K>
  }
>

/** The outer-layout subset a `use` instance may carry. */
export type OuterPropName = {
  [K in PropName]: (typeof PROPS)[K]['outer'] extends true ? K : never
}[PropName]

/**
 * A node after component and token resolution: every `{ prop }` and
 * `{ match }` has been substituted away, so what remains is literals. The type
 * says so, which is why the emitter never has to consider a reference.
 */
export type LiteralPropsFor<Kind extends NodeKind> = Prettify<
  { [K in KeysFor<Kind> as IsReq<K> extends true ? K : never]: Lit<K> } & {
    [K in KeysFor<Kind> as IsReq<K> extends true ? never : K]?: Lit<K>
  }
>
