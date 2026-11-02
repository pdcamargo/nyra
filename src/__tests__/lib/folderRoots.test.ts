import { describe, expect, it } from 'vitest'
import { folderRoots, rootOf } from '../../renderer/src/lib/folderRoots'
import { linkProblem } from '../../renderer/src/lib/linkedFolders'
import type { Project } from '../../renderer/src/store/sessions'

describe('folderRoots', () => {
  it('puts the chat folder first and skips a link to itself', () => {
    const roots = folderRoots('/dev/nyra', [{ path: '/dev/nyra' }, { path: '/dev/design', note: 'Read only.' }])
    expect(roots).toEqual([
      { path: '/dev/nyra', name: 'nyra', main: true },
      { path: '/dev/design', name: 'design', main: false, note: 'Read only.' }
    ])
  })

  it('names folders by their parent only when two share a name', () => {
    const names = folderRoots('/a/web', [{ path: '/b/web' }, { path: '/b/api' }]).map((r) => r.name)
    expect(names).toEqual(['a/web', 'b/web', 'api'])
  })
})

describe('rootOf', () => {
  const roots = folderRoots('/dev/nyra', [{ path: '/dev/nyra-docs' }, { path: '/dev/nyra/vendor/ui' }])

  it('does not mistake a sibling sharing the prefix for a child', () => {
    expect(rootOf(roots, '/dev/nyra-docs/a.md')?.path).toBe('/dev/nyra-docs')
  })

  it('picks the deepest root when they nest', () => {
    expect(rootOf(roots, '/dev/nyra/vendor/ui/button.tsx')?.path).toBe('/dev/nyra/vendor/ui')
    expect(rootOf(roots, '/dev/nyra/src/a.ts')?.path).toBe('/dev/nyra')
  })
})

describe('linkProblem', () => {
  const project = { id: 'p', name: 'nyra', path: '/dev/nyra', workspaceId: 'w', linkedFolders: [{ path: '/dev/design' }] } as Project

  it('refuses the main folder, anything inside it, and a second copy', () => {
    expect(linkProblem(project, '/dev/nyra')).not.toBeNull()
    expect(linkProblem(project, '/dev/nyra/src')).not.toBeNull()
    expect(linkProblem(project, '/dev/design')).not.toBeNull()
    expect(linkProblem(project, '/dev/docs')).toBeNull()
  })

  it('lets a folder being relocated match its own old place', () => {
    expect(linkProblem(project, '/dev/design', '/dev/design')).toBeNull()
  })
})
