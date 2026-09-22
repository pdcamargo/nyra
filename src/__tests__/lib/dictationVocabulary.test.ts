import { describe, expect, it } from 'vitest'
import { buildVocabulary, identifiersFromPath } from '@renderer/lib/dictationVocabulary'
import type { FileEntry } from '@renderer/lib/api-types'

const file = (path: string): FileEntry => ({ path, type: 'file' })

describe('identifiersFromPath', () => {
  it('keeps the compound and its words', () => {
    // "ComposerBar" is exactly the term that comes back as "composer bar"
    // without the compound in the prompt, so both have to be there.
    expect(identifiersFromPath('src/components/ComposerBar.tsx')).toEqual([
      'ComposerBar',
      'Composer',
      'Bar'
    ])
  })

  it('splits kebab and snake case', () => {
    expect(identifiersFromPath('src/use-chat-settings.ts')).toEqual(['use', 'chat', 'settings'])
    expect(identifiersFromPath('src/file_extractor.rs')).toEqual(['file', 'extractor'])
  })

  it('drops the extension and very short fragments', () => {
    expect(identifiersFromPath('a/b/ui.tsx')).toEqual([])
    expect(identifiersFromPath('lib/cn.ts')).toEqual([])
  })

  it('survives odd paths', () => {
    expect(identifiersFromPath('')).toEqual([])
    expect(identifiersFromPath('.gitignore')).toEqual([])
    expect(identifiersFromPath('src/')).toEqual([])
  })
})

describe('buildVocabulary', () => {
  it('ignores vendored and build directories', () => {
    const vocab = buildVocabulary([
      file('node_modules/leftpad/Padding.js'),
      file('target/debug/Artifact.rs'),
      file('dist/Bundle.js'),
      file('src/Composer.tsx')
    ])
    expect(vocab).toContain('Composer')
    expect(vocab).not.toContain('Padding')
    expect(vocab).not.toContain('Artifact')
    expect(vocab).not.toContain('Bundle')
  })

  it('ignores folders', () => {
    const vocab = buildVocabulary([{ path: 'src/Widgets', type: 'folder' }])
    expect(vocab).not.toContain('Widgets')
  })

  /**
   * The ordering contract: Whisper reads only the last 224 prompt tokens, and
   * later tokens weigh more. A list built most-valuable-first would put the
   * project's own words in the part that gets truncated away.
   */
  it('puts project terms after the generic baseline', () => {
    const vocab = buildVocabulary([file('src/Composer.tsx')])
    expect(vocab).toContain('TypeScript')
    expect(vocab.indexOf('Composer')).toBeGreaterThan(vocab.indexOf('TypeScript'))
  })

  it('ranks frequent identifiers last, where they survive truncation', () => {
    const vocab = buildVocabulary([
      file('src/Rare.tsx'),
      file('src/Common.tsx'),
      file('src/Common.test.tsx'),
      file('a/Common.rs')
    ])
    expect(vocab.indexOf('Common')).toBeGreaterThan(vocab.indexOf('Rare'))
  })

  it('caps how many project identifiers it sends', () => {
    const files = Array.from({ length: 500 }, (_, i) => file(`src/Widget${i}Thing.tsx`))
    const vocab = buildVocabulary(files, 20)
    // The baseline is always there; the project's own terms are what the cap
    // applies to. 'Thing' is in every filename, so it takes one of the slots.
    const project = vocab.filter((t) => t.startsWith('Widget') || t === 'Thing')
    expect(project).toHaveLength(20)
    expect(vocab.at(-1)).toBe('Thing')
  })

  it('does not repeat a baseline term the project already supplies', () => {
    const vocab = buildVocabulary([file('src/Tauri.ts')])
    expect(vocab.filter((t) => t.toLowerCase() === 'tauri')).toHaveLength(1)
  })

  it('returns just the baseline for an empty project', () => {
    expect(buildVocabulary([])).toContain('Claude')
  })
})
