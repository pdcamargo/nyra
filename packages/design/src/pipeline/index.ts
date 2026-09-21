import { defaultTheme } from '../theme/default'
import type { Theme } from '../theme/types'
import type { DesignDocument } from '../schema'
import { resolveComponents } from './resolveComponents'
import { resolveBackground, resolveTokens } from './resolveTokens'
import { validate } from './validate'
import { PipelineError, type Issue, type ResolvedArtboard, type ResolvedDocument } from './types'

export * from './types'
export { validate } from './validate'
export { resolveComponents } from './resolveComponents'
export { resolveTokens, resolveBackground } from './resolveTokens'
export * from './emit'

export type ThemeSource = Record<string, Theme>

const THEMES: ThemeSource = { default: defaultTheme }

/**
 * document -> validate -> resolve components -> resolve tokens -> emit
 *
 * Each stage is a pure function of the previous one, which is what lets
 * features slot in rather than thread through: variants land in component
 * resolution, theming in token resolution, lints read between any two, and
 * interaction becomes a stage of its own.
 */
export function compile(
  input: unknown,
  themes: ThemeSource = THEMES
): { doc: ResolvedDocument; theme: Theme; issues: Issue[] } {
  const checked = validate(input)
  if (!checked.ok) {
    throw new PipelineError(
      `document has ${checked.issues.filter((i) => i.severity === 'error').length} error(s)`,
      checked.issues
    )
  }
  const { doc, issues } = checked

  const theme = themes[doc.theme]
  if (!theme) {
    throw new PipelineError(`no theme "${doc.theme}" (have: ${Object.keys(themes).join(', ')})`, issues)
  }

  const artboards: ResolvedArtboard[] = doc.artboards.map((a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    position: a.position,
    background: resolveBackground(a.background, theme),
    root: resolveTokens(resolveComponents(doc as DesignDocument, a.id), theme)
  }))

  return { doc: { name: doc.name, theme: doc.theme, artboards }, theme, issues }
}
