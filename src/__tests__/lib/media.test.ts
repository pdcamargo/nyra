import { describe, expect, it } from 'vitest'
import { extensionOf, isImagePath, isMarkdownPath } from '../../renderer/src/components/files/media'

describe('file preview formats', () => {
  it('recognizes common raster images regardless of extension case', () => {
    for (const path of ['/a/p.png', '/a/p.JPG', '/a/p.jpeg', '/a/p.gif', '/a/p.WebP']) {
      expect(isImagePath(path)).toBe(true)
    }
    expect(isImagePath('/a/p.svg')).toBe(false)
  })

  it('recognizes Markdown and ignores dots in directory names', () => {
    expect(extensionOf('/dir.with.dot/README')).toBe('')
    expect(isMarkdownPath('/dir.with.dot/README.MD')).toBe(true)
    expect(isMarkdownPath('/doc.markdown')).toBe(true)
    expect(isMarkdownPath('/doc.mdown')).toBe(true)
    expect(isMarkdownPath('/doc.mkd')).toBe(true)
    expect(isMarkdownPath('/.hidden')).toBe(false)
  })
})
