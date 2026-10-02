/**
 * A subagent's cat. See `lib/agentCats.ts` for how one is chosen.
 */
import React, { useId, useMemo } from 'react'
import { catTintStyle, type AgentCat, type CatBreed } from '../lib/agentCats'

const SOURCES = import.meta.glob<string>('../assets/cats/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** Each breed's markup, sized by its container rather than its own 256px. */
const MARKUP = Object.fromEntries(
  Object.entries(SOURCES).map(([path, svg]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.svg'.length),
    svg.replace(/ width="256" height="256"/, ' width="100%" height="100%" aria-hidden="true"')
  ])
) as Record<CatBreed, string>

export default function CatIcon({
  cat,
  className
}: {
  cat: AgentCat
  className?: string
}): React.JSX.Element {
  // The head is clipped by id. Two of the same breed on screen would share that
  // id, and once the first one unmounts or is hidden the second loses its
  // markings — so every instance gets its own.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const html = useMemo(
    () => (MARKUP[cat.breed] ?? '').replaceAll(`cat-${cat.breed}-clip`, `cat-${cat.breed}-clip-${uid}`),
    [cat.breed, uid]
  )
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 [&>svg]:block ${className ?? ''}`}
      style={catTintStyle(cat)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
