import { describe, it, expect } from 'vitest'
import { buildDiffFromToolInput, detectLanguage, unifiedHunks } from '../../renderer/src/utils/diff'

describe('buildDiffFromToolInput', () => {
  it('returns null for non-file tools', () => {
    expect(buildDiffFromToolInput('Bash', { command: 'ls' })).toBeNull()
    expect(buildDiffFromToolInput('Grep', { pattern: 'foo' })).toBeNull()
  })

  it('returns null when no file path', () => {
    expect(buildDiffFromToolInput('Edit', { old_string: 'a', new_string: 'b' })).toBeNull()
  })

  it('handles Edit tool', () => {
    const result = buildDiffFromToolInput('Edit', {
      file_path: '/src/app.ts',
      old_string: 'const x = 1',
      new_string: 'const x = 2'
    })
    expect(result).toEqual({
      filePath: '/src/app.ts',
      original: 'const x = 1',
      modified: 'const x = 2',
      isNewFile: false
    })
  })

  it('returns null for Edit with empty strings', () => {
    expect(buildDiffFromToolInput('Edit', {
      file_path: '/src/app.ts',
      old_string: '',
      new_string: ''
    })).toBeNull()
  })

  it('handles Write tool for new file', () => {
    const result = buildDiffFromToolInput('Write', {
      file_path: '/src/new.ts',
      content: 'export default 42'
    }, null)
    expect(result).toEqual({
      filePath: '/src/new.ts',
      original: '',
      modified: 'export default 42',
      isNewFile: true
    })
  })

  it('handles Write tool for existing file', () => {
    const result = buildDiffFromToolInput('Write', {
      file_path: '/src/existing.ts',
      content: 'new content'
    }, 'old content')
    expect(result).toEqual({
      filePath: '/src/existing.ts',
      original: 'old content',
      modified: 'new content',
      isNewFile: false
    })
  })

  it('uses path as fallback for file_path', () => {
    const result = buildDiffFromToolInput('Edit', {
      path: '/src/alt.ts',
      old_string: 'a',
      new_string: 'b'
    })
    expect(result?.filePath).toBe('/src/alt.ts')
  })
})

describe('detectLanguage', () => {
  it('detects common extensions', () => {
    expect(detectLanguage('/src/app.ts')).toBe('typescript')
    expect(detectLanguage('/src/app.tsx')).toBe('typescript')
    expect(detectLanguage('/src/app.js')).toBe('javascript')
    expect(detectLanguage('/src/app.py')).toBe('python')
    expect(detectLanguage('/src/app.rs')).toBe('rust')
    expect(detectLanguage('/src/app.go')).toBe('go')
    expect(detectLanguage('/src/style.css')).toBe('css')
    expect(detectLanguage('/data.json')).toBe('json')
    expect(detectLanguage('/config.yaml')).toBe('yaml')
    expect(detectLanguage('/config.yml')).toBe('yaml')
  })

  it('detects special filenames', () => {
    expect(detectLanguage('/project/Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('/project/Makefile')).toBe('makefile')
  })

  it('returns plaintext for unknown extensions', () => {
    expect(detectLanguage('/file.xyz')).toBe('plaintext')
    expect(detectLanguage('/noext')).toBe('plaintext')
  })

  it('handles deeply nested paths', () => {
    expect(detectLanguage('/a/b/c/d/file.tsx')).toBe('typescript')
  })
})

describe('unifiedHunks', () => {
  it('turns two contents into the patch DiffView draws', () => {
    const [patch] = unifiedHunks('notes.txt', 'a\nb\n', 'a\nb\nc\n')
    expect(patch).toBe('--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,3 @@\n a\n b\n+c\n')
  })

  it('has nothing to draw for two identical contents', () => {
    expect(unifiedHunks('a.ts', 'same\n', 'same\n')).toEqual([])
  })

  it('draws a new file as all additions', () => {
    const [patch] = unifiedHunks('new.md', '', 'one\ntwo\n')
    expect(patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two')
  })
})

