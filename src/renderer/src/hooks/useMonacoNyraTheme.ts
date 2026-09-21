import { useEffect, useState } from 'react'
import { useMonaco } from '@monaco-editor/react'
import { useResolvedTheme } from './useResolvedTheme'

const THEME_DARK = 'nyra-dark'
const THEME_LIGHT = 'nyra-light'

type ColorMap = Record<string, string>

// Monaco takes hex strings and cannot read CSS variables, so these mirror the
// theme tokens by hand: --card for the surface, --muted-foreground for gutter
// numbers. They have to be updated if those tokens move — the theme's tokens are
// achromatic `oklch(L 0 0)`, which converts to a plain grey at
// round(255 * srgb(L ** 3)).
const DARK_COLORS: ColorMap = {
  // --card oklch(0.2134 0 0), --muted-foreground oklch(0.7090 0 0)
  'editor.background': '#191919',
  'editorLineNumber.foreground': '#a1a1a199',
  'editorGutter.background': '#191919',
  'scrollbar.shadow': '#00000000',
  'editorOverviewRuler.border': '#00000000'
}

const LIGHT_COLORS: ColorMap = {
  // --card oklch(1.0000 0 0), --muted-foreground oklch(0.5486 0 0)
  'editor.background': '#ffffff',
  'editorLineNumber.foreground': '#71717199',
  'editorGutter.background': '#ffffff',
  'scrollbar.shadow': '#00000000',
  'editorOverviewRuler.border': '#00000000'
}

const DIFF_DARK_EXTRAS: ColorMap = {
  'diffEditor.insertedTextBackground': '#22c55e12',
  'diffEditor.removedTextBackground': '#ef444412',
  'diffEditor.insertedLineBackground': '#22c55e08',
  'diffEditor.removedLineBackground': '#ef444408'
}

const DIFF_LIGHT_EXTRAS: ColorMap = {
  'diffEditor.insertedTextBackground': '#22c55e22',
  'diffEditor.removedTextBackground': '#ef444422',
  'diffEditor.insertedLineBackground': '#22c55e10',
  'diffEditor.removedLineBackground': '#ef444410'
}

/**
 * Defines nyra-dark + nyra-light Monaco themes and returns the active one
 * based on the resolved app theme. Pass `withDiff: true` for DiffEditor usage.
 */
export function useMonacoNyraTheme({ withDiff = false }: { withDiff?: boolean } = {}): {
  defined: boolean
  theme: string
} {
  const monacoApi = useMonaco()
  const resolved = useResolvedTheme()
  const [defined, setDefined] = useState(false)

  useEffect(() => {
    if (!monacoApi) return
    monacoApi.editor.defineTheme(THEME_DARK, {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { ...DARK_COLORS, ...(withDiff ? DIFF_DARK_EXTRAS : {}) }
    })
    monacoApi.editor.defineTheme(THEME_LIGHT, {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { ...LIGHT_COLORS, ...(withDiff ? DIFF_LIGHT_EXTRAS : {}) }
    })
    setDefined(true)
  }, [monacoApi, withDiff])

  return { defined, theme: resolved === 'light' ? THEME_LIGHT : THEME_DARK }
}
