import type { Theme } from './types'

/**
 * Self-contained, and deliberately not seeded from Nyra's own tokens: those are
 * shadcn role tokens (card, muted, ring), achromatic apart from --destructive,
 * with one --radius and no spacing scale. A design vocabulary needs ramps.
 *
 * Aliases point at ramp entries with `$` paths and are chased at resolve time,
 * so retheming means editing the alias block, not every design.
 */
export const defaultTheme: Theme = {
  name: 'default',

  color: {
    transparent: 'transparent',

    gray: {
      '50': '#FAFAFB',
      '100': '#F4F4F6',
      '200': '#E7E7EC',
      '300': '#D3D4DB',
      '400': '#A1A2AE',
      '500': '#71727F',
      '600': '#52535F',
      '700': '#3F4049',
      '800': '#2A2B33',
      '900': '#1A1B21',
      '950': '#111216'
    },
    violet: {
      '50': '#F6F4FE',
      '100': '#EDE9FE',
      '200': '#DDD6FE',
      '300': '#C4B4FD',
      '400': '#A68BFA',
      '500': '#8B5CF6',
      '600': '#6E56CF',
      '700': '#5B44B0',
      '800': '#4C3A91',
      '900': '#3F3175'
    },
    green: { '100': '#DCFCE7', '500': '#22C55E', '600': '#16A34A', '700': '#15803D' },
    amber: { '100': '#FEF3C7', '500': '#F59E0B', '600': '#D97706', '700': '#B45309' },
    red: { '100': '#FEE2E2', '500': '#EF4444', '600': '#DC2626', '700': '#B91C1C' },
    blue: { '100': '#DBEAFE', '500': '#3B82F6', '600': '#2563EB', '700': '#1D4ED8' },

    bg: '$color.gray.50',
    surface: '#FFFFFF',
    surfaceSunken: '$color.gray.100',
    text: '$color.gray.900',
    textMuted: '$color.gray.600',
    textSubtle: '$color.gray.500',
    border: '$color.gray.200',
    borderStrong: '$color.gray.300',
    accent: '$color.violet.600',
    accentHover: '$color.violet.700',
    accentSubtle: '$color.violet.50',
    onAccent: '#FFFFFF',
    success: '$color.green.600',
    successSubtle: '$color.green.100',
    warning: '$color.amber.600',
    warningSubtle: '$color.amber.100',
    danger: '$color.red.600',
    dangerSubtle: '$color.red.100',
    onDanger: '#FFFFFF',
    info: '$color.blue.600',
    infoSubtle: '$color.blue.100'
  },

  space: {
    '0': 0,
    // Sub-step insets: a toggle knob and a focus ring need 1-2px, and without
    // these the raw-literal lint correctly fires on every one of them.
    px: 1,
    xs: 2,
    '1': 4,
    '2': 8,
    '3': 12,
    '4': 16,
    '5': 20,
    '6': 24,
    '7': 28,
    '8': 32,
    '10': 40,
    '12': 48,
    '16': 64,
    '20': 80,
    '24': 96
  },

  radius: { none: 0, sm: 4, md: 8, lg: 12, xl: 16, '2xl': 24, full: 9999 },

  shadow: {
    none: 'none',
    sm: '0 1px 2px 0 rgb(17 18 22 / 0.05)',
    md: '0 2px 4px -1px rgb(17 18 22 / 0.08), 0 1px 2px -1px rgb(17 18 22 / 0.04)',
    lg: '0 8px 16px -4px rgb(17 18 22 / 0.10), 0 2px 4px -2px rgb(17 18 22 / 0.05)',
    xl: '0 20px 32px -8px rgb(17 18 22 / 0.14), 0 4px 8px -4px rgb(17 18 22 / 0.06)'
  },

  border: {
    hairline: { width: 1, color: '$color.border', style: 'solid' },
    strong: { width: 1, color: '$color.borderStrong', style: 'solid' },
    accent: { width: 1, color: '$color.accent', style: 'solid' },
    danger: { width: 1, color: '$color.danger', style: 'solid' },
    dashed: { width: 1, color: '$color.borderStrong', style: 'dashed' },
    focus: { width: 2, color: '$color.accent', style: 'solid' }
  },

  font: {
    display: { family: 'ui-sans-serif, system-ui, sans-serif', size: 40, weight: 700, lineHeight: 1.1, letterSpacing: -0.6 },
    h1: { family: 'ui-sans-serif, system-ui, sans-serif', size: 28, weight: 650, lineHeight: 1.2, letterSpacing: -0.3 },
    h2: { family: 'ui-sans-serif, system-ui, sans-serif', size: 22, weight: 620, lineHeight: 1.25, letterSpacing: -0.2 },
    h3: { family: 'ui-sans-serif, system-ui, sans-serif', size: 18, weight: 600, lineHeight: 1.3 },
    h4: { family: 'ui-sans-serif, system-ui, sans-serif', size: 15, weight: 600, lineHeight: 1.35 },
    body: { family: 'ui-sans-serif, system-ui, sans-serif', size: 14, weight: 400, lineHeight: 1.55 },
    bodyStrong: { family: 'ui-sans-serif, system-ui, sans-serif', size: 14, weight: 550, lineHeight: 1.55 },
    lead: { family: 'ui-sans-serif, system-ui, sans-serif', size: 16, weight: 400, lineHeight: 1.6 },
    small: { family: 'ui-sans-serif, system-ui, sans-serif', size: 12.5, weight: 400, lineHeight: 1.5 },
    smallStrong: { family: 'ui-sans-serif, system-ui, sans-serif', size: 12.5, weight: 550, lineHeight: 1.5 },
    caption: { family: 'ui-sans-serif, system-ui, sans-serif', size: 11.5, weight: 500, lineHeight: 1.4, letterSpacing: 0.2 },
    label: { family: 'ui-sans-serif, system-ui, sans-serif', size: 12, weight: 600, lineHeight: 1.4, letterSpacing: 0.3 },
    button: { family: 'ui-sans-serif, system-ui, sans-serif', size: 13.5, weight: 550, lineHeight: 1.2 },
    mono: { family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 12.5, weight: 400, lineHeight: 1.5 },
    monoSmall: { family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 11.5, weight: 400, lineHeight: 1.45 }
  }
}
