import { z } from 'zod'
import { colorLit, fontLit } from './registry/scalars'
import { value, type Value } from './value'

/**
 * Inline runs.
 *
 * The first version of this was `Value<string>[]`, an array of forms that
 * concatenated to one string. It looked like it supported
 * `["Read the ", { bold: "docs" }]` and could not: one emphasised word inside a
 * sentence was not expressible at all, and the workaround — three text nodes in
 * a row stack — breaks wrapping, which makes it not a workaround.
 *
 * A run is a span. Plain strings stay plain strings, so interpolation still
 * reads the way it did, and an array of only plain forms still collapses to one
 * string rather than a pile of spans.
 */
export type TextRun = {
  text: Value<string>
  font?: Value<string | { family: string; size: number; weight: number; lineHeight: number; letterSpacing?: number }>
  color?: Value<string>
  weight?: Value<number>
  transform?: Value<'none' | 'uppercase' | 'lowercase' | 'capitalize'>
}

export type TextValue = Value<string> | Array<Value<string> | TextRun>

export const runSchema: z.ZodType<TextRun, TextRun> = z.strictObject({
  text: value(z.string()),
  font: value(fontLit).optional(),
  color: value(colorLit).optional(),
  weight: value(z.number().int().min(100).max(900)).optional(),
  transform: value(z.enum(['none', 'uppercase', 'lowercase', 'capitalize'])).optional()
}) as unknown as z.ZodType<TextRun, TextRun>

/**
 * Run form first: a run is `{ text: … }` and a prop reference is `{ prop: … }`,
 * both strict, so they are disjoint — but order is load-bearing everywhere else
 * in this file's neighbourhood and consistency is cheaper than a surprise.
 */
export const textValueSchema: z.ZodType<TextValue, TextValue> = z.union([
  z.array(z.union([runSchema, value(z.string())])),
  value(z.string())
]) as unknown as z.ZodType<TextValue, TextValue>

export const isRun = (v: unknown): v is TextRun =>
  typeof v === 'object' && v !== null && 'text' in v && !('prop' in v) && !('match' in v)

/** A resolved run: every form substituted away, ready for a span. */
export type ResolvedRun = {
  text: string
  font?: unknown
  color?: string
  weight?: number
  transform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
}
