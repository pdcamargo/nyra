import { describe, expect, it } from 'vitest'
import { collectAttachments, formatSize } from '@renderer/lib/summary'
import type { TextMessage } from '@renderer/store/sessions'

const msg = (over: Partial<TextMessage> & { id: string }): TextMessage => ({
  role: 'user',
  text: '',
  ...over
})

describe('collectAttachments', () => {
  it('lists images and files across the whole conversation, in order', () => {
    const list = collectAttachments([
      msg({
        id: 'm1',
        images: [{ path: '/tmp/shot.png', mediaType: 'image/png', dataUrl: 'data:' }]
      }),
      msg({
        id: 'm2',
        files: [{ id: 'f1', name: 'spec.pdf', path: '/tmp/spec.pdf', size: 2048, category: 'document' }]
      })
    ])
    expect(list.map((a) => a.name)).toEqual(['shot.png', 'spec.pdf'])
    expect(list[0].kind).toBe('image')
    expect(list[1].kind).toBe('file')
  })

  it('keys entries per message so the same file attached twice both show', () => {
    const file = { id: 'f1', name: 'a.txt', path: '/a.txt', size: 1, category: 'text' as const }
    const list = collectAttachments([msg({ id: 'm1', files: [file] }), msg({ id: 'm2', files: [file] })])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((a) => a.key)).size).toBe(2)
  })

  it('is empty for a conversation with nothing attached', () => {
    expect(collectAttachments([msg({ id: 'm1', text: 'hello' })])).toEqual([])
  })
})

describe('formatSize', () => {
  it('scales units', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
