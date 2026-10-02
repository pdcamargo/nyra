/**
 * Which cat a subagent is.
 *
 * Every subagent gets one when it is spawned, and keeps it: the transcript line
 * that announces it and its row in the pinned summary draw the same cat, so the
 * cat *is* the agent. A session hands out each of the ten breeds once before it
 * repeats any, and a repeat comes with its own fur colour so two agents still
 * never look alike.
 */
import type { CSSProperties } from 'react'

export const CAT_BREEDS = [
  'white',
  'orange-tabby',
  'blue-gray',
  'gray-tabby',
  'black',
  'cream',
  'ginger-bicolor',
  'calico',
  'golden-spotted',
  'blue-tuxedo'
] as const

export type CatBreed = (typeof CAT_BREEDS)[number]

export type AgentCat = {
  breed: CatBreed
  /** Set once every breed is taken: the fur is repainted around this hue. */
  hue?: number
}

/**
 * The next agent's cat, given the cats the session's agents already have.
 * `random` is injectable so a test can pin the pick.
 */
export function pickCat(taken: readonly (AgentCat | undefined)[], random = Math.random): AgentCat {
  // Only an untinted cat uses up its breed. Once the breeds have run out every
  // pick is tinted, and those never make a breed available again.
  const used = new Set(taken.filter((c) => c && c.hue === undefined).map((c) => c!.breed))
  const free = CAT_BREEDS.filter((b) => !used.has(b))
  if (free.length > 0) return { breed: free[Math.floor(random() * free.length)] }
  return {
    breed: CAT_BREEDS[Math.floor(random() * CAT_BREEDS.length)],
    hue: Math.floor(random() * 360)
  }
}

/**
 * An agent saved before cats existed has none. Give it one by its place in the
 * session, so it is at least the same cat in both places and on every render.
 */
export function catOf(agent: { cat?: AgentCat } | undefined, index: number): AgentCat {
  return agent?.cat ?? { breed: CAT_BREEDS[Math.max(index, 0) % CAT_BREEDS.length] }
}

/**
 * The CSS variables that repaint a cat's coat. The SVGs read every colour
 * through a `--cat-*` variable with the breed's own as the fallback, so an
 * untinted cat sets nothing. Eyes, nose and mouth keep the breed's colours.
 */
export function catTintStyle(cat: AgentCat): CSSProperties | undefined {
  if (cat.hue === undefined) return undefined
  const h = cat.hue
  return {
    '--cat-fur': `hsl(${h} 55% 62%)`,
    '--cat-patch1': `hsl(${h} 50% 42%)`,
    '--cat-patch2': `hsl(${h} 65% 82%)`,
    '--cat-inner': `hsl(${h} 60% 86%)`,
    '--cat-outline': `hsl(${h} 45% 38%)`
  } as CSSProperties
}
