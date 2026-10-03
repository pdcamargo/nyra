/**
 * A design system's `tokens.json`: its theme, plus modes.
 *
 * The shape is the built-in `Theme` — the scales the validator, the token
 * regexes and the skill already know — with two additions: `baseMode`, the name
 * of what the scales themselves describe ("light"), and `modes`, partial
 * themes laid over the base ("dark"). Modes sit *on top*: the pipeline never
 * learns about them, it is just handed the merged theme for each artboard.
 *
 * Interchange formats (DTCG, CSS variables, a Tailwind theme) are exports from
 * this, never the format itself; see the spec.
 */
import { z } from 'zod'
import { SCALES, type Theme } from './types'
import { tokenPaths } from './resolve'

/** Every key in a token path is one segment of `$scale.a.b`, so it must match the
 *  token regex — `brand-primary` could never be referenced. */
const keySchema = z.string().regex(/^[A-Za-z0-9]+$/, 'token names are letters and digits only, so `$color.brandPrimary`, not `brand-primary`')

const colorRamp: z.ZodType<unknown> = z.lazy(() => z.record(keySchema, z.union([z.string(), colorRamp])))
const fontBundle = z.strictObject({
  family: z.string(),
  size: z.number(),
  weight: z.number(),
  lineHeight: z.number(),
  letterSpacing: z.number().optional()
})
const borderToken = z.strictObject({
  width: z.number(),
  color: z.string(),
  style: z.enum(['solid', 'dashed'])
})

const scales = {
  color: colorRamp,
  space: z.record(keySchema, z.number()),
  radius: z.record(keySchema, z.number()),
  shadow: z.record(keySchema, z.string()),
  border: z.record(keySchema, borderToken),
  font: z.record(keySchema, fontBundle)
}

const partialScales = z
  .strictObject({
    color: colorRamp.optional(),
    space: z.record(keySchema, z.number()).optional(),
    radius: z.record(keySchema, z.number()).optional(),
    shadow: z.record(keySchema, z.string()).optional(),
    border: z.record(keySchema, borderToken.partial()).optional(),
    font: z.record(keySchema, fontBundle.partial()).optional()
  })
  .partial()

export const tokensSchema = z.strictObject({
  schema: z.number().int().min(1),
  /** What the scales describe on their own. */
  baseMode: keySchema.default('light'),
  ...scales,
  modes: z.record(keySchema, partialScales).optional()
})

export type Tokens = z.infer<typeof tokensSchema>

export type TokensResult =
  | { ok: true; tokens: Tokens; issues: string[] }
  | { ok: false; issues: string[] }

/**
 * Validate a `tokens.json`. Beyond the shape: the two tokens the emitter and
 * every existing component rely on must exist, and a mode may only change
 * tokens the base already has — a mode that *adds* one is a design that
 * compiles in dark and fails in light.
 */
export function loadTokens(input: unknown): TokensResult {
  const parsed = tokensSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => {
        const at = i.path.join('.') || 'tokens'
        // Zod reports a bad record key generically; say what is wrong with it.
        if (i.code === 'invalid_key') {
          return `${at}: token names are letters and digits only, so \`$color.brandPrimary\`, not \`brand-primary\``
        }
        return `${at}: ${i.message}`
      })
    }
  }
  const tokens = parsed.data
  const issues: string[] = []
  if (!tokens.font.body) issues.push('font.body is required — it is every artboard\'s base text style')
  if ((tokens.color as Record<string, unknown>).transparent === undefined) {
    issues.push('color.transparent is required — components use it for "no fill"')
  }
  if (tokens.modes && Object.hasOwn(tokens.modes, tokens.baseMode)) {
    issues.push(`modes.${tokens.baseMode} repeats the base mode; put those values in the scales themselves`)
  }
  const base = new Set(tokenPaths(baseTheme(tokens, 'tokens')))
  for (const [mode, layer] of Object.entries(tokens.modes ?? {})) {
    const added = tokenPaths(merge(baseTheme(tokens, 'tokens'), layer as Partial<Theme>)).filter((p) => !base.has(p))
    for (const p of added) issues.push(`modes.${mode} adds ${p}, which the base does not have; a mode may only change existing tokens`)
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, tokens, issues }
}

function baseTheme(tokens: Tokens, name: string): Theme {
  const theme = { name } as Theme
  for (const scale of SCALES) (theme as Record<string, unknown>)[scale] = tokens[scale]
  return theme
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function merge<T>(base: T, layer: unknown): T {
  if (!isPlain(base) || !isPlain(layer)) return (layer === undefined ? base : layer) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(layer)) out[k] = merge(out[k], v)
  return out as T
}

/** The base mode first, then the rest in the order they were written. */
export function modesOf(tokens: Tokens): string[] {
  return [tokens.baseMode, ...Object.keys(tokens.modes ?? {})]
}

const cache = new WeakMap<Tokens, Map<string, Theme>>()

/**
 * The theme for one mode: the base scales with that mode laid over them.
 * Memoised per tokens object, so every artboard in a mode shares one theme —
 * which is also what keeps a worker's structured clone from copying it per
 * artboard.
 */
export function themeFor(tokens: Tokens, mode: string | undefined, name = 'system'): Theme {
  const want = mode ?? tokens.baseMode
  let byMode = cache.get(tokens)
  if (!byMode) cache.set(tokens, (byMode = new Map()))
  const hit = byMode.get(want)
  if (hit) return hit
  const base = baseTheme(tokens, name)
  const layer = want === tokens.baseMode ? undefined : tokens.modes?.[want]
  const theme = layer ? { ...merge(base, layer), name: `${name}:${want}` } : base
  byMode.set(want, theme)
  return theme
}
