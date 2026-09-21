import { icons } from 'lucide'

/**
 * The real lucide set, so an icon name is validated for existence and not just
 * for shape. A name that merely *looks* right renders as a hole, and a design
 * with a hole in it is a mock that lies — which is the one thing the CSS-subset
 * rule exists to prevent.
 *
 * Note that lucide no longer ships brand marks: "github" parses as a kebab-case
 * name and does not exist. Only a lookup catches that.
 */
const pascal = (kebab: string): string =>
  kebab
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')

const KEYS = new Set(Object.keys(icons))

export const iconNames: string[] = Object.keys(icons)
  .map((k) => k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
  .sort()

export const hasIcon = (kebab: string): boolean => KEYS.has(pascal(kebab))

export const iconData = (
  kebab: string
): [string, Record<string, string | number>][] | undefined =>
  (icons as Record<string, [string, Record<string, string | number>][]>)[pascal(kebab)]

/**
 * A near miss worth naming, since Claude will reach for names that sound right.
 * Containment alone misses a transposition ("chevron-rigth"), so the first
 * kebab segment is the fallback — wrong suffix, right family is the common
 * shape of the mistake.
 */
export function suggestIcon(kebab: string): string | undefined {
  const target = kebab.toLowerCase()
  const contained = iconNames.find((n) => n.includes(target) || target.includes(n))
  if (contained && contained !== target) return contained
  const head = target.split('-')[0]
  if (head.length < 3) return undefined
  return iconNames.find((n) => n === head || n.startsWith(`${head}-`))
}
