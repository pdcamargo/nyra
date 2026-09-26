import { describe, expect, it } from 'vitest'
import {
  ancestorsWithin,
  basenameOf,
  breadcrumbs,
  dirnameOf,
  joinPath,
  relativeTo
} from '@renderer/components/files/paths'
import {
  PREVIEW_MIN_WIDTH,
  TREE_DEFAULT_WIDTH,
  TREE_MIN_WIDTH,
  clampTreeWidth,
  treeFits
} from '@renderer/components/files/treeWidth'

describe('path arithmetic', () => {
  it('lists the folders between the root and a file, outermost first', () => {
    expect(ancestorsWithin('/repo', '/repo/src/lib/a.ts')).toEqual(['/repo/src', '/repo/src/lib'])
    expect(ancestorsWithin('/repo/', '/repo/src/a.ts')).toEqual(['/repo/src'])
    expect(ancestorsWithin('/repo', '/repo/a.ts')).toEqual([])
    // Outside the tree, and a sibling that merely shares the prefix.
    expect(ancestorsWithin('/repo', '/elsewhere/a.ts')).toEqual([])
    expect(ancestorsWithin('/repo', '/repo-two/src/a.ts')).toEqual([])
  })

  it('joins without doubling the separator', () => {
    expect(joinPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinPath('/repo/', 'src')).toBe('/repo/src')
    expect(joinPath('/repo', '')).toBe('/repo')
  })

  it('relativises against the tree root, trailing slash or not', () => {
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo/', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/repo')).toBe('')
  })

  // A worktree chat's cwd is outside the project entirely, so a path from one
  // must not be silently reported as relative to the other.
  it('leaves a path outside the root alone', () => {
    expect(relativeTo('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
  })

  it('splits a path into a directory and a name', () => {
    expect(dirnameOf('/repo/src/a.ts')).toBe('/repo/src')
    expect(dirnameOf('/a.ts')).toBe('/')
    expect(basenameOf('/repo/src/a.ts')).toBe('a.ts')
    expect(basenameOf('/repo/src/')).toBe('src')
  })
})

describe('breadcrumbs', () => {
  it('starts at the chat’s folder, not at /', () => {
    const crumbs = breadcrumbs('/Users/me/repo', '/Users/me/repo/src/lib/a.ts')
    expect(crumbs.map((c) => c.label)).toEqual(['repo', 'src', 'lib', 'a.ts'])
    expect(crumbs[0].isRoot).toBe(true)
  })

  it('gives each crumb the path it stands for', () => {
    const crumbs = breadcrumbs('/repo', '/repo/src/a.ts')
    expect(crumbs.map((c) => c.path)).toEqual(['/repo', '/repo/src', '/repo/src/a.ts'])
  })

  it('is just the root for the root itself', () => {
    expect(breadcrumbs('/repo', '/repo')).toHaveLength(1)
  })

  it('does not invent crumbs for a path outside the root', () => {
    expect(breadcrumbs('/repo', '/elsewhere/a.ts')).toHaveLength(1)
  })
})

describe('clampTreeWidth', () => {
  const ROOMY = 600

  it('leaves a sane width alone', () => {
    expect(clampTreeWidth(240, ROOMY)).toBe(240)
  })

  it('holds the tree above its minimum', () => {
    expect(clampTreeWidth(10, ROOMY)).toBe(TREE_MIN_WIDTH)
  })

  it('leaves the preview its minimum', () => {
    expect(clampTreeWidth(ROOMY, ROOMY)).toBe(ROOMY - PREVIEW_MIN_WIDTH)
  })

  it('survives a corrupt stored width', () => {
    expect(clampTreeWidth(Number.NaN, ROOMY)).toBe(TREE_DEFAULT_WIDTH)
  })

  // The panel's own minimum is 200, which is less than the two panes need — so
  // this is reachable by dragging, not a theoretical case.
  it('knows when the panel cannot hold both panes', () => {
    expect(treeFits(TREE_MIN_WIDTH + PREVIEW_MIN_WIDTH)).toBe(true)
    expect(treeFits(TREE_MIN_WIDTH + PREVIEW_MIN_WIDTH - 1)).toBe(false)
    expect(treeFits(200)).toBe(false)
  })
})
