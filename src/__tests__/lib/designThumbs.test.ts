import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORMAT_VERSION } from '@nyra/design'
import { compileOffThread } from '../../renderer/src/lib/designCompile'
import { requestThumbnail, thumbnailNow, type Thumbnail } from '../../renderer/src/lib/designThumbs'

const doc = (label: string): string =>
  JSON.stringify({
    schema: FORMAT_VERSION,
    name: 'Thumbs',
    artboards: [
      {
        id: 'one',
        name: 'one',
        size: { width: 400, height: 200 },
        root: { id: 'root', type: 'box', children: [{ id: 'label', type: 'text', value: label }] }
      }
    ]
  })

async function board(label: string) {
  const out = await compileOffThread(doc(label))
  if (!out.ok) throw new Error(out.message)
  return { artboard: out.doc.artboards[0], theme: out.theme }
}

let made = 0
const frames: FrameRequestCallback[] = []
const nextFrame = (): void => frames.shift()?.(performance.now())

beforeEach(() => {
  made = 0
  URL.createObjectURL = vi.fn(() => `blob:thumb-${++made}`)
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
})
afterEach(() => {
  vi.unstubAllGlobals()
  frames.length = 0
})

const box = { maxWidth: 40, maxHeight: 40 }

describe('artboard thumbnails', () => {
  it('are made once, at the size they are shown, and then only read', async () => {
    const { artboard, theme } = await board('first')
    let got: Thumbnail | null = null
    requestThumbnail(artboard, theme, box, (t) => (got = t))
    expect(thumbnailNow(artboard, theme, box)).toBeNull()
    nextFrame()
    expect(got).toEqual({ url: 'blob:thumb-1', width: 40, height: 20 })
    expect(thumbnailNow(artboard, theme, box)).toEqual(got)
    expect(made).toBe(1)
  })

  it('come back for a reload that left the board alone, and not for one that changed it', async () => {
    const a = await board('same')
    requestThumbnail(a.artboard, a.theme, box, () => {})
    nextFrame()
    const reloaded = await board('same')
    expect(thumbnailNow(reloaded.artboard, reloaded.theme, box)?.url).toBe('blob:thumb-1')
    const changed = await board('different')
    expect(thumbnailNow(changed.artboard, changed.theme, box)).toBeNull()
  })

  it('are made one per frame, skipping any nobody waits for any more', async () => {
    const boards = await Promise.all(['q1', 'q2', 'q3'].map(board))
    const done: string[] = []
    const cancel = boards.map((b, i) => requestThumbnail(b.artboard, b.theme, box, () => done.push(`q${i + 1}`)))
    cancel[1]()
    nextFrame()
    expect(done).toEqual(['q1'])
    nextFrame()
    nextFrame()
    expect(done).toEqual(['q1', 'q3'])
    expect(made).toBe(2)
  })
})
