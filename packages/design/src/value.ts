import { z } from 'zod'

/**
 * The entire expression language: a literal, a prop reference, or a match.
 *
 * There is no fourth form. No template strings, no parser, no escaping — which
 * is what lets a design document render in chat without a sandbox, because
 * there is nothing in it to execute.
 */
export type PropRef = { prop: string }

export type Match<T> = {
  match: PropRef
  cases: Record<string, Value<T>>
  default?: Value<T>
}

/**
 * `null` means "this property is not set here".
 *
 * Not a fourth value form — a literal, and one JSON already has. It exists
 * because a `match` otherwise cannot express *absence*, and absence is a real
 * design state: a vertical divider must NOT set a height, because an explicit
 * cross-axis size makes `align-self: stretch` a no-op and `height: 100%`
 * against an auto-height parent computes to zero. Measured, not reasoned.
 *
 * Resolution drops the key entirely, so the emitter never sees it.
 */
export type Unset = null

export type Value<T> = T | Unset | PropRef | Match<T>

/**
 * `prop` and `match` are reserved. No property's object literal may use either
 * as a key, or a reference becomes ambiguous with a literal. Enforced by the
 * `z.xor` sweep in the registry tests rather than by anyone remembering.
 */
export const RESERVED_KEYS = ['prop', 'match'] as const

export const propRefSchema = z.strictObject({ prop: z.string().min(1) })

export function isPropRef(v: unknown): v is PropRef {
  return typeof v === 'object' && v !== null && 'prop' in v && !('match' in v)
}

export function isMatch<T>(v: unknown): v is Match<T> {
  return typeof v === 'object' && v !== null && 'match' in v
}

/**
 * Wraps a property's literal schema in the three value forms.
 *
 * Union member order is load-bearing, not stylistic. Zod returns the first
 * member that parses without issues (`v4/core/schemas.js:1241`), and a
 * non-strict object literal placed before `propRefSchema` will happily accept
 * `{ prop: 'x' }`, strip the unknown key, and hand back `{}` — a silently
 * deleted reference behind a validator that reported success. Reference forms
 * go first, and every object-shaped literal is declared with `z.strictObject`.
 *
 * Both type parameters are supplied: Zod 4 defaults `Input` to `unknown`, so a
 * single-parameter annotation poisons `z.input` of anything this is nested in.
 */
export function value<S extends z.ZodType>(
  inner: S
): z.ZodType<Value<z.output<S>>, Value<z.input<S>>> {
  const v: z.ZodType<Value<z.output<S>>, Value<z.input<S>>> = z.lazy(() =>
    z.union(
      [
        propRefSchema,
        z.strictObject({
          match: propRefSchema,
          cases: z.record(z.string(), v),
          default: v.optional()
        }),
        z.null(),
        inner
      ],
      {
        // Without this, one bad value yields three nested error trees and the
        // useful line is buried. This format is hand-authored; the message is
        // the product.
        error: () =>
          'expected a literal value, null, a { prop } reference, or a { match, cases } expression'
      }
    )
  )
  return v
}

/** Mixed text: an array of forms concatenated, or a single form. */
export function valueOrList<S extends z.ZodType>(
  inner: S
): z.ZodType<Value<z.output<S>> | Value<z.output<S>>[], Value<z.input<S>> | Value<z.input<S>>[]> {
  const single = value(inner)
  return z.union([z.array(single), single]) as z.ZodType<
    Value<z.output<S>> | Value<z.output<S>>[],
    Value<z.input<S>> | Value<z.input<S>>[]
  >
}
