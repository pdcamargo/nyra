import { describe, expect, it, vi } from 'vitest'
import { absoluteInRepo, repoRootFor } from '@renderer/lib/repoRoot'
import { isImagePath, isMarkdownPath } from '@renderer/components/files/media'

/**
 * `git diff` prints a path from the top of the tree, always — whether or not it
 * ran in a subdirectory. A chat opened in `Developer/mv-ui` therefore has a repo
 * above it, and resolving that path against the chat's own directory names a
 * file that does not exist. These are the shapes that has to survive.
 */
const trees = (paths: string[]): void => {
  vi.spyOn(window.api.git, 'worktreeList').mockResolvedValue(
    paths.map((path) => ({ path, branch: 'main', detached: false }))
  )
}

describe('repoRootFor', () => {
  it('finds the repo above a chat opened in a subdirectory', async () => {
    trees(['/repo'])
    expect(await repoRootFor('/repo/apps/foo/internal')).toBe('/repo')
  })

  it('prefers the worktree the chat is in over the main checkout', async () => {
    // `worktree list` always lists the main worktree first, which is the wrong
    // answer for a chat whose files live in a linked worktree.
    trees(['/repo', '/elsewhere/nyra-feat'])
    expect(await repoRootFor('/elsewhere/nyra-feat/sub')).toBe('/elsewhere/nyra-feat')
  })

  it('is the cwd itself when the chat is the repo root', async () => {
    trees(['/repo'])
    expect(await repoRootFor('/repo')).toBe('/repo')
  })

  it('does not mistake a sibling with a shared prefix for the repo', async () => {
    trees(['/repo'])
    expect(await repoRootFor('/repository/src')).toBe('/repository/src')
  })

  it('falls back to the cwd when git will not answer', async () => {
    vi.spyOn(window.api.git, 'worktreeList').mockRejectedValue(new Error('not a repo'))
    expect(await repoRootFor('/loose/folder/')).toBe('/loose/folder')
  })

  it('normalises an absolute git path out of the way', async () => {
    expect(await absoluteInRepo('/repo', '/repo/src/a.ts')).toBe('/repo/src/a.ts')
  })

  it('joins a repo-relative path onto the root, without doubling the slash', async () => {
    trees(['/repo/'])
    expect(await absoluteInRepo('/repo/src', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(await absoluteInRepo('/repo/src', './src/b.ts')).toBe('/repo/src/b.ts')
  })

  it('says nothing clever when there is no cwd at all', async () => {
    expect(await absoluteInRepo('', 'src/a.ts')).toBe('src/a.ts')
  })
})

describe('what the viewer can draw', () => {
  it('knows the raster formats it renders', () => {
    for (const name of ['a.png', 'a.PNG', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp']) {
      expect(isImagePath(`/repo/${name}`), name).toBe(true)
    }
  })

  // SVG is a script-execution surface inside an `<img>`, and it needs its own
  // decision rather than a place on the list.
  it('leaves SVG, and everything else, to the placeholder', () => {
    for (const name of ['a.svg', 'a.pdf', 'a.ts', 'a.png.txt', 'Makefile']) {
      expect(isImagePath(`/repo/${name}`), name).toBe(false)
    }
  })

  it('knows markdown by its extensions, and not by a name that merely ends well', () => {
    expect(isMarkdownPath('/repo/README.md')).toBe(true)
    expect(isMarkdownPath('/repo/docs/guide.markdown')).toBe(true)
    expect(isMarkdownPath('/repo/markdown')).toBe(false)
    expect(isMarkdownPath('/repo/a.md.ts')).toBe(false)
  })
})
