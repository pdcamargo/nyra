import { FORMAT_VERSION } from '../migrations'
import { defaultTheme } from './default'
import { SCALES } from './types'

/** The built-in theme in `tokens.json` form: what a new design system starts from. */
export function defaultTokens(): Record<string, unknown> {
  const out: Record<string, unknown> = { schema: FORMAT_VERSION, baseMode: 'light' }
  for (const scale of SCALES) out[scale] = defaultTheme[scale]
  return out
}

export const defaultTokensJson = (): string => `${JSON.stringify(defaultTokens(), null, 2)}\n`
