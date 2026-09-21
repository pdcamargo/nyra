import { PROPS } from '../registry/props'
import type { PropName } from '../registry/types'
import { resolveDeep, TokenError } from '../theme/resolve'
import type { Theme } from '../theme/types'
import { err, PipelineError, type Issue, type ResolvedNode } from './types'

/**
 * Replaces every token path with its themed value.
 *
 * Only properties that *declare* a token scale are walked. That is what keeps
 * a price label reading "$5.00" intact: `text.value` declares no scales, so the
 * stage never looks inside it. Doing this by scanning every string would work
 * until the first design with money in it.
 */
export function resolveTokens(node: ResolvedNode, theme: Theme): ResolvedNode {
  const issues: Issue[] = []
  const out = walk(node, theme, issues)
  if (issues.length > 0) throw new PipelineError(issues[0].message, issues)
  return out
}

function walk(node: ResolvedNode, theme: Theme, issues: Issue[]): ResolvedNode {
  const out: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(node)) {
    if (k === 'children') continue
    if (!(k in PROPS)) {
      out[k] = v
      continue
    }
    const def = PROPS[k as PropName]
    if ((def.tokens.length === 0 && !def.resolve) || v === undefined) {
      out[k] = v
      continue
    }
    const one = (x: unknown): unknown => resolveDeep(x, theme)
    try {
      out[k] = def.resolve ? def.resolve(v as never, one) : one(v)
    } catch (e) {
      if (!(e instanceof TokenError)) throw e
      issues.push(err('token', `"${k}": ${e.message}`, node.origin, [k]))
      out[k] = v
    }
  }

  if (node.type === 'box') {
    out.children = node.children.map((c) => walk(c, theme, issues))
  }
  return out as ResolvedNode
}

/** Artboard backgrounds live outside the node tree but take tokens too. */
export function resolveBackground(background: string | undefined, theme: Theme): string | undefined {
  if (background === undefined) return undefined
  return resolveDeep(background, theme) as string
}
