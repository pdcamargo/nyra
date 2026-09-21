import { z } from 'zod'
import { value, type Value } from '../value'
import { textValueSchema, type TextValue } from '../text'
import type { NodeKind } from './define'
import { PROPS } from './props'
import type { IsList, IsReq, KeysFor, Lit, PropName } from './types'

type ValueSchema<T> = z.ZodType<Value<T>, Value<T>>
type ListSchema = z.ZodType<TextValue, TextValue>

type SchemaFor<K extends PropName> = IsList<K> extends true ? ListSchema : ValueSchema<Lit<K>>

type AllShape = {
  [K in PropName]: IsReq<K> extends true ? SchemaFor<K> : z.ZodOptional<SchemaFor<K>>
}

/**
 * One flat cast, over a shape record with no nesting in it, fully covered by
 * the `Equal<z.infer<typeof boxProps>, PropsFor<'box'>>` assertions in
 * __typetests__. Notably NOT a cast to `z.ZodType<PropsFor<K>>`: erasing to
 * ZodType also erases `_zod.propValues`, which `z.discriminatedUnion` requires
 * of its members, so that version does not compile at all.
 */
const ALL_SHAPE = Object.fromEntries(
  Object.entries(PROPS).map(([name, def]) => {
    const wrapped = def.list ? textValueSchema : value(def.schema)
    return [name, def.required ? wrapped : wrapped.optional()]
  })
) as AllShape

export const ALL = z.object(ALL_SHAPE)

export type MaskFor<K extends NodeKind> = { [P in KeysFor<K>]: true }

/** `appliesTo` read in the other direction. The registry stays the one source. */
export function maskFor<K extends NodeKind>(kind: K): MaskFor<K> {
  return Object.fromEntries(
    Object.entries(PROPS)
      .filter(([, def]) => (def.appliesTo as readonly NodeKind[]).includes(kind))
      .map(([name]) => [name, true])
  ) as MaskFor<K>
}

/**
 * `.pick` keeps a real ZodObject with a precise shape, which is what lets the
 * node union below be a discriminated one.
 */
export const boxProps = ALL.pick(maskFor('box'))
export const textProps = ALL.pick(maskFor('text'))
export const iconProps = ALL.pick(maskFor('icon'))
export const imageProps = ALL.pick(maskFor('image'))
export const useProps = ALL.pick(maskFor('use'))

export const PROPS_BY_KIND = {
  box: boxProps,
  text: textProps,
  icon: iconProps,
  image: imageProps,
  use: useProps
} as const

/** Property names that apply to a kind, at runtime. */
export function propNamesFor(kind: NodeKind): PropName[] {
  return (Object.keys(PROPS) as PropName[]).filter((n) =>
    (PROPS[n].appliesTo as readonly NodeKind[]).includes(kind)
  )
}
