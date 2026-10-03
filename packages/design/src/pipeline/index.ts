import { defaultTheme } from '../theme/default'
import type { Theme } from '../theme/types'
import type { DesignDocument } from '../schema'
import { resolveComponents } from './resolveComponents'
import { resolveBackground, resolveTokens } from './resolveTokens'
import { validate } from './validate'
import { PipelineError, err, warn, type Issue, type ResolvedArtboard, type ResolvedDocument } from './types'
import { NewerFormatError, upgrade, type Upgrade } from '../migrations'
import type { Registry } from './registry'

export * from './types'
export { validate } from './validate'
export { resolveComponents } from './resolveComponents'
export { resolveTokens, resolveBackground } from './resolveTokens'
export * from './emit'
export * from './registry'

export type ThemeSource = Record<string, Theme>

const THEMES: ThemeSource = { default: defaultTheme }

export type Compiled = {
  doc: ResolvedDocument
  theme: Theme
  issues: Issue[]
  /**
   * Set when the file is an older format and what was compiled is its upgraded
   * copy. The file on disk is untouched; writing `upgrade.doc` back is the
   * caller's decision, and an explicit one.
   */
  upgrade: Upgrade | null
}

/**
 * upgrade -> validate -> resolve components -> resolve tokens -> emit
 *
 * Each stage is a pure function of the previous one, which is what lets
 * features slot in rather than thread through: variants land in component
 * resolution, theming in token resolution, lints read between any two, and
 * interaction becomes a stage of its own.
 */
export type CompileContext = {
  /** Built-in themes by name, for a standalone draft. The default set if omitted. */
  themes?: ThemeSource
  /** A system's theme. When given, the document's `theme` name is not used. */
  theme?: Theme
  /** Themes for named modes, for artboards pinned with `mode`. */
  modes?: Record<string, Theme>
  /** Every component the document may use — a system's whole namespace. */
  registry?: Registry
  /** The document's path in its system, so origins and issues name the file. */
  file?: string
}

export function compile(input: unknown, ctx: CompileContext = {}): Compiled {
  const themes = ctx.themes ?? THEMES
  let upgraded: Upgrade | null
  try {
    upgraded = upgrade(input)
  } catch (e) {
    if (e instanceof NewerFormatError) {
      throw new PipelineError(e.message, [err('schema-newer', e.message)])
    }
    throw e
  }
  const source = upgraded ? upgraded.doc : input
  const checked = validate(source, { registry: ctx.registry })
  if (!checked.ok) {
    throw new PipelineError(
      `document has ${checked.issues.filter((i) => i.severity === 'error').length} error(s)`,
      checked.issues
    )
  }
  const { doc } = checked
  const issues = [...checked.issues]

  const named = (source as { theme?: unknown }).theme
  if (ctx.theme && typeof named === 'string' && named !== 'default') {
    issues.push(warn('theme-ignored', `"theme": "${named}" is ignored inside a design system; the system's tokens decide`))
  }
  const theme = ctx.theme ?? themes[doc.theme]
  if (!theme) {
    throw new PipelineError(`no theme "${doc.theme}" (have: ${Object.keys(themes).join(', ')})`, issues)
  }

  const artboards: ResolvedArtboard[] = doc.artboards.map((a) => {
    let own: Theme | undefined
    if (a.mode !== undefined) {
      own = ctx.modes?.[a.mode]
      if (!own) {
        const have = Object.keys(ctx.modes ?? {})
        issues.push(
          warn(
            'unknown-mode',
            `artboard "${a.id}" asks for mode "${a.mode}", which this theme does not have${have.length ? ` (it has: ${have.join(', ')})` : ''}`
          )
        )
      }
    }
    const t = own ?? theme
    const out: ResolvedArtboard = {
      id: a.id,
      name: a.name,
      size: a.size,
      position: a.position,
      background: resolveBackground(a.background, t),
      root: resolveTokens(resolveComponents(doc as DesignDocument, a.id, { registry: ctx.registry, file: ctx.file }), t)
    }
    if (a.mode !== undefined) out.mode = a.mode
    if (own) out.theme = own
    return out
  })

  // Issues raised in this file say so, so a message read out of context —
  // in a tool result, in a list of a whole system's problems — names it.
  const located =
    ctx.file === undefined
      ? issues
      : issues.map((i) => (i.at && i.at.file === undefined ? { ...i, at: { ...i.at, file: ctx.file } } : i))

  const resolved: ResolvedDocument = { name: doc.name, theme: doc.theme, artboards }
  if (doc.meta) resolved.meta = doc.meta
  return { doc: resolved, theme, issues: located, upgrade: upgraded }
}
