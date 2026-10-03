import { createElement } from 'react'
import { iconData } from '@nyra/design'

/**
 * A lucide icon by its kebab-case name, drawn from the set the design package
 * already carries for its own renderer — so a name means the same icon here as
 * in a design, and the app does not bundle a second copy of lucide.
 */
export default function NamedIcon({ name, className }: { name: string; className?: string }): React.ReactElement | null {
  const data = iconData(name)
  if (!data) return null
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {data.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}
