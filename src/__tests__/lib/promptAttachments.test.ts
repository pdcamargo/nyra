import { describe, it, expect } from 'vitest'
import { withAttachments } from '../../renderer/src/lib/promptAttachments'
import type { FileAttachment, ImageAttachment } from '../../renderer/src/store/sessions'

const img = (path: string): ImageAttachment => ({ path, mediaType: 'image/png', dataUrl: '' })

const file = (over: Partial<FileAttachment> & { path: string }): FileAttachment => ({
  id: over.path,
  name: over.path.split('/').pop()!,
  size: 1,
  category: 'document',
  ...over
})

describe('withAttachments', () => {
  it('leaves a plain message alone', () => {
    expect(withAttachments('hello')).toBe('hello')
    expect(withAttachments('hello', [], [])).toBe('hello')
  })

  it('appends an image the text never mentioned', () => {
    expect(withAttachments('look at this', [img('/tmp/a.png')])).toBe(
      'look at this\n\n[Image: /tmp/a.png]'
    )
  })

  it('does not repeat a marker the composer already dropped at the caret', () => {
    const text = 'compare [Image: /tmp/a.png] with this'
    expect(withAttachments(text, [img('/tmp/a.png')])).toBe(text)
  })

  it('appends only the unreferenced ones out of several', () => {
    const out = withAttachments('[Image: /tmp/a.png] and the other', [
      img('/tmp/a.png'),
      img('/tmp/b.png')
    ])
    expect(out).toBe('[Image: /tmp/a.png] and the other\n\n[Image: /tmp/b.png]')
  })

  it('wraps extracted file text and marks image files as images', () => {
    const out = withAttachments(
      'read these',
      [],
      [
        file({ path: '/tmp/c.png', category: 'image' }),
        file({ path: '/tmp/notes.md', extractedText: 'body text' })
      ]
    )
    expect(out).toBe(
      'read these\n\n[Image: /tmp/c.png]\n\n<attached_file name="notes.md">\nbody text\n</attached_file>'
    )
  })

  // This used to drop the attachment on the floor: you attached a zip, nothing
  // was extractable from it, and Claude was never told the file existed at all.
  // Handing over the path is the whole point of the binary category.
  it('hands over the path of a document that never extracted', () => {
    expect(withAttachments('read this', [], [file({ path: '/tmp/x.zip' })])).toBe(
      'read this\n\n<attached_file name="x.zip" path="/tmp/x.zip" />'
    )
  })

  it('needs no separator when the message is only attachments', () => {
    expect(withAttachments('', [img('/tmp/a.png')])).toBe('[Image: /tmp/a.png]')
  })
})

describe('withAttachments — files with nothing to inline', () => {
  const video = (path = '/tmp/nyra-files-1/clip.mp4'): FileAttachment =>
    file({ path, category: 'binary' })

  // The point of the binary category: we never read the bytes, so the path is
  // the whole message. Claude's own Read opens it.
  it('hands over a path for a file it could not extract', () => {
    expect(withAttachments('what is in this', undefined, [video()])).toBe(
      'what is in this\n\n<attached_file name="clip.mp4" path="/tmp/nyra-files-1/clip.mp4" />'
    )
  })

  it('still inlines the text of a file that had some', () => {
    const doc = file({ path: '/tmp/r.pdf', category: 'document', extractedText: 'hello' })
    expect(withAttachments('read this', undefined, [doc])).toBe(
      'read this\n\n<attached_file name="r.pdf">\nhello\n</attached_file>'
    )
  })

  // The composer's chip is `[File: <name>]` — the name is what belongs in the
  // sentence — and a name is not something Claude can open, so the path ref is
  // emitted alongside it rather than suppressed by it.
  it('emits the path even when the composer already wrote the name chip', () => {
    const out = withAttachments('look at [File: clip.mp4] please', undefined, [video()])
    expect(out).toContain('[File: clip.mp4]')
    expect(out).toContain('path="/tmp/nyra-files-1/clip.mp4"')
  })

  it('carries several opaque files at once', () => {
    const out = withAttachments('these', undefined, [
      video('/tmp/a.mp4'),
      file({ path: '/tmp/b.sqlite', category: 'binary' })
    ])
    expect(out).toContain('path="/tmp/a.mp4"')
    expect(out).toContain('path="/tmp/b.sqlite"')
  })

  it('leaves images on the image path, not this one', () => {
    const png = file({ path: '/tmp/a.png', category: 'image' })
    expect(withAttachments('see', undefined, [png])).toBe('see\n\n[Image: /tmp/a.png]')
  })
})
