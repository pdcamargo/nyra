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

  it('skips a document that never extracted', () => {
    expect(withAttachments('read this', [], [file({ path: '/tmp/x.zip' })])).toBe('read this')
  })

  it('needs no separator when the message is only attachments', () => {
    expect(withAttachments('', [img('/tmp/a.png')])).toBe('[Image: /tmp/a.png]')
  })
})
