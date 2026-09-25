import { describe, expect, it } from 'vitest'
import { previewParts, queuePreview } from '@renderer/lib/queuePreview'
import type { QueuedMessage } from '@renderer/store/sessions'

const queued = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({ text: '', ...over })

describe('queuePreview', () => {
  it('leaves a plain message alone', () => {
    expect(queuePreview(queued({ text: 'run the tests' }))).toEqual({
      text: 'run the tests',
      images: []
    })
  })

  // The bug: the tray showed this string verbatim where the transcript shows a
  // picture.
  it('takes an image out of the text and offers it as an image', () => {
    const result = queuePreview(queued({ text: 'look at ![shot](/tmp/a.png) please' }))

    expect(result.text).toBe('look at please')
    expect(result.images).toEqual([{ path: '/tmp/a.png' }])
  })

  it('carries a staged attachment, which was in no row at all before', () => {
    const result = queuePreview(
      queued({ text: '', images: [{ path: '/tmp/a.png', mediaType: 'image/png', dataUrl: 'data:x' }] })
    )

    expect(result.images).toEqual([{ dataUrl: 'data:x' }])
  })

  it('puts staged attachments before ones written into the text', () => {
    const result = queuePreview(
      queued({
        text: '![b](/tmp/b.png)',
        images: [{ path: '/tmp/a.png', mediaType: 'image/png', dataUrl: 'data:a' }]
      })
    )

    expect(result.images).toEqual([{ dataUrl: 'data:a' }, { path: '/tmp/b.png' }])
  })

  it('reads a data URL written inline as an image rather than as a path', () => {
    expect(queuePreview(queued({ text: '![x](data:image/png;base64,AA)' })).images).toEqual([
      { dataUrl: 'data:image/png;base64,AA' }
    ])
  })

  // The CSP allows `data:` and `blob:` only, so a remote one could never paint.
  it('drops a remote image instead of promising a thumbnail it cannot show', () => {
    const result = queuePreview(queued({ text: 'see ![x](https://example.com/a.png)' }))

    expect(result.images).toEqual([])
    expect(result.text).toBe('see')
  })

  it('handles a title on the image, which is still valid markdown', () => {
    expect(queuePreview(queued({ text: '![x](/tmp/a.png "A shot")' })).images).toEqual([
      { path: '/tmp/a.png' }
    ])
  })

  it('collapses a multi-line message, because the tray is one row', () => {
    expect(queuePreview(queued({ text: 'first\n\nsecond   third' })).text).toBe(
      'first second third'
    )
  })

  it('leaves a link alone — only images come out', () => {
    const text = 'see [the docs](/tmp/a.md)'
    expect(queuePreview(queued({ text }))).toEqual({ text, images: [] })
  })
})

describe('previewParts', () => {
  it('splits attachment markers out of the text so they draw as chips', () => {
    expect(previewParts('see [Image: /var/x/shot.png] and [File: /a/b.txt]')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'Image', target: '/var/x/shot.png' },
      { kind: 'text', text: ' and ' },
      { kind: 'File', target: '/a/b.txt' }
    ])
  })

  it('does not show a staged image twice when the text already names it', () => {
    const result = queuePreview(
      queued({
        text: '[Image: /tmp/a.png] look',
        images: [{ path: '/tmp/a.png', mediaType: 'image/png', dataUrl: 'data:x' }]
      })
    )
    expect(result.images).toEqual([])
    expect(result.text).toBe('[Image: /tmp/a.png] look')
  })
})
