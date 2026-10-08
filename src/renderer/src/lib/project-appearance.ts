import {
  BookOpen,
  Bot,
  Box,
  Briefcase,
  CodeXml,
  Database,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  Music,
  Palette,
  Rocket,
  Server,
  Smartphone,
  Terminal,
  type LucideIcon
} from 'lucide-react'

/**
 * The preset colours a project can take. Each is a CSS variable set per theme in
 * index.css, so a preset stays readable when the theme flips — a hex the user
 * picked does not, and that is theirs to choose.
 */
export const PROJECT_TINTS = ['blue', 'green', 'amber', 'red', 'violet'] as const
export type ProjectTint = (typeof PROJECT_TINTS)[number]

/** Stored by name, so renaming a lucide export cannot break a saved project. */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  code: CodeXml,
  globe: Globe,
  box: Box,
  rocket: Rocket,
  flask: FlaskConical,
  book: BookOpen,
  gamepad: Gamepad2,
  palette: Palette,
  terminal: Terminal,
  server: Server,
  phone: Smartphone,
  database: Database,
  bot: Bot,
  music: Music,
  briefcase: Briefcase
}

const HEX = /^#[0-9a-f]{6}$/i

export function isPresetTint(color: string | undefined): color is ProjectTint {
  return (PROJECT_TINTS as readonly string[]).includes(color ?? '')
}

export function isCustomTint(color: string | undefined): color is string {
  return HEX.test(color ?? '')
}

/** A CSS colour for a stored value, or null for none — or for anything stored
 *  that is neither a preset nor a hex, which is drawn as no colour at all. */
export function tintColor(color: string | undefined): string | null {
  if (isPresetTint(color)) return `var(--tint-${color})`
  if (isCustomTint(color)) return color
  return null
}

/** The icon a project's row draws. Without a chosen one it is the folder, open
 *  or shut, which is also how the row says whether it is collapsed. */
export function projectIcon(icon: string | undefined): LucideIcon | null {
  return (icon && PROJECT_ICONS[icon]) || null
}
