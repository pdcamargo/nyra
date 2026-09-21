import { SCALES, type ScaleName, type Theme } from './types'

export class TokenError extends Error {}

const SCALE_RE = new RegExp(`^\\$(${SCALES.join('|')})\\.`)

/** True for `$color.accent`, false for a label that happens to read `$5.00`. */
export function isTokenPath(v: unknown): v is string {
  return typeof v === 'string' && SCALE_RE.test(v)
}

export function scaleOf(path: string): ScaleName {
  return path.slice(1, path.indexOf('.')) as ScaleName
}

function walk(root: unknown, segments: string[]): unknown {
  let cur: unknown = root
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Chases `accent -> $color.violet.600 -> #6E56CF`. Aliases are how a theme
 * stays editable in one place; the seen-set is how a typo in one does not hang
 * the renderer.
 */
export function lookupToken(theme: Theme, path: string, seen = new Set<string>()): unknown {
  if (seen.has(path)) {
    throw new TokenError(`token alias cycle: ${[...seen, path].join(' -> ')}`)
  }
  seen.add(path)

  const [scale, ...rest] = path.slice(1).split('.')
  if (!SCALES.includes(scale as ScaleName)) {
    throw new TokenError(`unknown token scale in "${path}" (have: ${SCALES.join(', ')})`)
  }
  const found = walk(theme[scale as ScaleName], rest)
  if (found === undefined) {
    throw new TokenError(`unknown token "${path}"`)
  }
  return isTokenPath(found) ? lookupToken(theme, found, seen) : found
}

/**
 * Replaces every token path inside a value, at any depth, so a `$border.*`
 * bundle whose colour is itself an alias comes back fully concrete.
 */
export function resolveDeep(v: unknown, theme: Theme): unknown {
  if (isTokenPath(v)) return resolveDeep(lookupToken(theme, v), theme)
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, theme))
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveDeep(x, theme)])
    )
  }
  return v
}

/** Every token path a theme can answer — the vocabulary the skill documents. */
export function tokenPaths(theme: Theme): string[] {
  const out: string[] = []
  const rec = (prefix: string, node: unknown): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      out.push(prefix)
      return
    }
    const entries = Object.entries(node as Record<string, unknown>)
    // A font bundle or border token is a leaf, not a nested ramp.
    if (entries.some(([k]) => ['family', 'size', 'weight', 'width', 'style'].includes(k))) {
      out.push(prefix)
      return
    }
    for (const [k, v] of entries) rec(`${prefix}.${k}`, v)
  }
  for (const scale of SCALES) rec(`$${scale}`, theme[scale])
  return out.sort()
}
