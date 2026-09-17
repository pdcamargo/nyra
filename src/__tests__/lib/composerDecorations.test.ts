import { describe, expect, it } from 'vitest'
import { findCommand, findFileMentions, findUltrathink, mentionLabel, findAttachmentRefs, attachmentMarker } from '../../renderer/src/lib/composerDecorations'

describe('findCommand', () => {
  it('matches a known command at the start', () => {
    expect(findCommand('/context please')).toEqual({ from: 0, to: 8 })
  })

  it('ignores a command that is not at the start — the CLI would too', () => {
    expect(findCommand('run /context please')).toBeNull()
  })

  it('leaves an unknown slash alone, because it is probably a path', () => {
    expect(findCommand('/usr/local/bin/claude is where it lives')).toBeNull()
    expect(findCommand('/notacommand')).toBeNull()
  })

  it('matches a hyphenated command', () => {
    expect(findCommand('/pr-review')).toEqual({ from: 0, to: 10 })
  })

  it('stops at the command, not the whole line', () => {
    const span = findCommand('/clear and then some')!
    expect(span.to).toBe('/clear'.length)
  })
})

describe('findUltrathink', () => {
  it('finds it anywhere in the message', () => {
    expect(findUltrathink('please ultrathink this')).toEqual([{ from: 7, to: 17 }])
  })

  it('is case-insensitive', () => {
    expect(findUltrathink('ULTRATHINK')).toHaveLength(1)
  })

  it('finds every occurrence', () => {
    expect(findUltrathink('ultrathink then ultrathink again')).toHaveLength(2)
  })

  it('needs a word boundary, so it does not fire inside another word', () => {
    expect(findUltrathink('superultrathinking')).toEqual([])
  })

  it('returns nothing when absent', () => {
    expect(findUltrathink('just think about it')).toEqual([])
  })
})

describe('findFileMentions', () => {
  it('finds a mention and its span', () => {
    const [m] = findFileMentions('see @src/app.ts here')
    expect(m.path).toBe('src/app.ts')
    expect('see @src/app.ts here'.slice(m.from, m.to)).toBe('@src/app.ts')
  })

  it('finds a mention at the very start', () => {
    expect(findFileMentions('@a/b.ts please')[0].from).toBe(0)
  })

  it('finds several', () => {
    expect(findFileMentions('@a.ts and @b.ts')).toHaveLength(2)
  })

  it('leaves an email alone — the @ has to start a word', () => {
    expect(findFileMentions('mail me at pat@example.com')).toEqual([])
  })

  it('stops at whitespace', () => {
    expect(findFileMentions('@src/app.ts and more')[0].path).toBe('src/app.ts')
  })
})

describe('mentionLabel', () => {
  it('shows just the filename', () => {
    expect(mentionLabel('src/renderer/components/ChatInput.tsx')).toBe('ChatInput.tsx')
  })

  it('shows a bare name unchanged', () => {
    expect(mentionLabel('README.md')).toBe('README.md')
  })

  it('names a folder by its last segment, trailing slash and all', () => {
    expect(mentionLabel('src/renderer/components/')).toBe('components')
  })
})

describe('attachment references', () => {
  it('finds an image reference and names it by file', () => {
    const [ref] = findAttachmentRefs('look at [Image: /tmp/nyra/shot-2.png] here')
    expect(ref).toMatchObject({ kind: 'Image', target: '/tmp/nyra/shot-2.png' })
    expect(mentionLabel(ref.target)).toBe('shot-2.png')
  })

  it('finds a file reference by name', () => {
    const [ref] = findAttachmentRefs('as [File: quarterly report.pdf] says')
    expect(ref).toMatchObject({ kind: 'File', target: 'quarterly report.pdf' })
  })

  it('finds several in one sentence, in order', () => {
    const refs = findAttachmentRefs('[Image: /a.png] versus [Image: /b.png]')
    expect(refs.map((r) => r.target)).toEqual(['/a.png', '/b.png'])
  })

  it('leaves ordinary bracketed text alone', () => {
    expect(findAttachmentRefs('[note: this is not an attachment]')).toEqual([])
    expect(findAttachmentRefs('a markdown [link](http://x)')).toEqual([])
  })

  it('does not run past the end of a line', () => {
    // An unclosed bracket should not swallow the rest of the message.
    expect(findAttachmentRefs('[Image: /a.png\nsecond line]')).toEqual([])
  })

  it('spans exactly the marker, so replacing it removes the whole thing', () => {
    const text = 'before [Image: /a.png] after'
    const [ref] = findAttachmentRefs(text)
    expect(text.slice(ref.from, ref.to)).toBe('[Image: /a.png]')
  })

  it('round-trips what attachmentMarker writes', () => {
    const marker = attachmentMarker('Image', '/tmp/a b.png')
    const [ref] = findAttachmentRefs(`x ${marker} y`)
    expect(ref.target).toBe('/tmp/a b.png')
  })
})
