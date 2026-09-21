import { z } from 'zod'

export type FontBundle = {
  family: string
  size: number
  weight: number
  lineHeight: number
  letterSpacing?: number
}

export type BorderToken = {
  width: number
  color: string
  style: 'solid' | 'dashed'
}

/** A colour scale is a ramp (`gray.600`) or a flat alias (`accent`). */
export type ColorScale = { [key: string]: string | ColorScale }

export type Theme = {
  name: string
  color: ColorScale
  space: Record<string, number>
  radius: Record<string, number>
  shadow: Record<string, string>
  border: Record<string, BorderToken>
  font: Record<string, FontBundle>
}

export const SCALES = ['color', 'space', 'radius', 'shadow', 'border', 'font'] as const
export type ScaleName = (typeof SCALES)[number]

/**
 * A `$` prefix marks a token path, so a token and a string are never ambiguous.
 * Each scale gets its own schema, so `$space.2` cannot land in a colour slot.
 */
export function token<S extends ScaleName>(scale: S) {
  return z
    .string()
    .regex(
      new RegExp(`^\\$${scale}\\.[A-Za-z0-9]+(\\.[A-Za-z0-9]+)*$`),
      `expected a $${scale}.* token`
    )
}

export const isToken = (v: unknown): v is string => typeof v === 'string' && v.startsWith('$')
