import { z } from 'zod'
import { token } from '../theme/types'

/** Raw colours are allowed but linted; the token form is the intended one. */
export const CSS_COLOR_RE =
  /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent|currentColor)$/

export const percentLit = z
  .string()
  .regex(/^(100|[1-9]?[0-9])(\.[0-9]+)?%$/, 'expected a percentage like "60%"')

export const colorLit = z.union([token('color'), z.string().regex(CSS_COLOR_RE, 'expected a $color.* token or a CSS colour')])

export const spaceLit = z.union([token('space'), z.number().min(0), percentLit])

/** One value, or [block, inline], or [top, right, bottom, left]. */
export const spacingLit = z.union([
  spaceLit,
  z.tuple([spaceLit, spaceLit]),
  z.tuple([spaceLit, spaceLit, spaceLit, spaceLit])
])

export const radiusLit = z.union([token('radius'), z.number().min(0)])
export const shadowLit = z.union([token('shadow'), z.literal('none')])

export const borderLit = z.union([
  token('border'),
  z.strictObject({
    width: z.number().min(0),
    color: colorLit,
    style: z.enum(['solid', 'dashed'])
  })
])

export const fontLit = z.union([
  token('font'),
  z.strictObject({
    family: z.string(),
    size: z.number().positive(),
    weight: z.number().int().min(100).max(900),
    lineHeight: z.number().positive(),
    letterSpacing: z.number().optional()
  })
])

/**
 * A length: px, a percentage, or one of the two keywords CSS sizing needs.
 *
 * The percentage form is what makes anything proportional expressible at all —
 * a bar in a chart, a progress fill, a split pane. Without it a bar is a fixed
 * pixel height and a taller container just adds air above it.
 */
export const lengthLit = z.union([z.number().min(0), percentLit, z.literal('full'), z.literal('fit')])

export const insetLit = z.strictObject({
  top: spaceLit.optional(),
  right: spaceLit.optional(),
  bottom: spaceLit.optional(),
  left: spaceLit.optional()
})

export const px = (n: number | string): string => (typeof n === 'number' ? `${n}px` : n)

/**
 * A resolved space value: px, or a percentage passed through.
 *
 * Note that CSS resolves a *padding* percentage against the containing block's
 * WIDTH on every side, including top and bottom. That is real CSS behaviour and
 * so it is allowed, but it is surprising enough that the validator says so when
 * it appears on a vertical edge.
 */
export const spaceCss = (v: number | string, what: string): string => px(resolved(v, what))

export const lengthCss = (v: number | string): string =>
  v === 'full' ? '100%' : v === 'fit' ? 'fit-content' : typeof v === 'string' ? v : `${v}px`

/** [block, inline] and [t,r,b,l] collapse to the same CSS shorthand. */
export const spacingCss = (v: number | string | readonly (number | string)[]): string =>
  Array.isArray(v) ? v.map((n) => px(n)).join(' ') : px(v as number | string)

/**
 * Emitters run after the token stage, so a `$`-prefixed string reaching one is
 * a pipeline-order bug. Loud beats a stylesheet with `padding: $space.2` in it.
 */
export function resolved<T>(v: T, what: string): Exclude<T, string> {
  if (typeof v === 'string' && v.startsWith('$')) {
    throw new Error(`unresolved token ${v} reached the ${what} emitter`)
  }
  return v as Exclude<T, string>
}

export const asNumber = (v: unknown, what: string): number => {
  const r = resolved(v, what)
  if (typeof r !== 'number') throw new Error(`${what}: expected a number, got ${typeof r}`)
  return r
}

/** One value for both axes, or [row, column]. */
export const gapLit = z.union([spaceLit, z.tuple([spaceLit, spaceLit])])

/** A ratio as width/height, or [w, h] which reads better in a document. */
export const aspectLit = z.union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])])

export const gradientLit = z.strictObject({
  from: colorLit,
  to: colorLit,
  angle: z.number().min(0).max(360).optional()
})

/**
 * Where an image comes from. Checked for shape rather than reachability, but
 * "shape" means an actual URL, data URI or project-relative path — `src: "x"`
 * previously parsed and rendered a broken image, which is a mock that lies.
 */
export const srcLit = z
  .string()
  .min(1)
  .refine(
    (v) => /^(https?:\/\/|data:image\/|\/|\.\/)/.test(v),
    'expected an http(s) URL, a data:image URI, or a path starting with / or ./'
  )
