import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cachedImage, loadImage, resetImageCache } from '../../renderer/src/lib/imageCache'

const PNG = { base64: 'AAAA', mediaType: 'image/png' }

describe('imageCache', () => {
  beforeEach(() => {
    resetImageCache()
  })

  it('turns the backend response into a data URL', async () => {
    window.api.fs.readImage = vi.fn().mockResolvedValue(PNG)

    const entry = await loadImage('/tmp/chart.png')

    expect(entry).toEqual({ status: 'ready', dataUrl: 'data:image/png;base64,AAAA' })
  })

  it('reads a path once however many callers ask at the same time', async () => {
    const read = vi.fn().mockResolvedValue(PNG)
    window.api.fs.readImage = read

    // The transcript is virtualised, so the same image can mount in several rows
    // in the same frame.
    const [a, b] = await Promise.all([loadImage('/tmp/chart.png'), loadImage('/tmp/chart.png')])

    expect(read).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  it('serves a resolved image from memory on the next mount', async () => {
    const read = vi.fn().mockResolvedValue(PNG)
    window.api.fs.readImage = read

    await loadImage('/tmp/chart.png')
    await loadImage('/tmp/chart.png')

    expect(read).toHaveBeenCalledTimes(1)
    expect(cachedImage('/tmp/chart.png')).toEqual({
      status: 'ready',
      dataUrl: 'data:image/png;base64,AAAA'
    })
  })

  it('retries a missing file, then stops', async () => {
    // Claude streams the `![...]` line before the Bash call that writes the PNG,
    // so the first read can legitimately miss. Scrolling past retries it.
    const read = vi.fn().mockResolvedValue({ error: 'Image not found.', missing: true })
    window.api.fs.readImage = read

    await loadImage('/tmp/late.png')
    expect(cachedImage('/tmp/late.png')).toBeUndefined()

    await loadImage('/tmp/late.png')
    await loadImage('/tmp/late.png')
    await loadImage('/tmp/late.png')

    expect(read).toHaveBeenCalledTimes(3)
    expect(cachedImage('/tmp/late.png')).toEqual({
      status: 'error',
      message: 'Image not found.'
    })
  })

  it('does not retry a failure that cannot fix itself', async () => {
    const read = vi.fn().mockResolvedValue({ error: 'Not a PNG or JPEG.' })
    window.api.fs.readImage = read

    await loadImage('/tmp/notes.txt')
    await loadImage('/tmp/notes.txt')

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected call rather than throwing at the component', async () => {
    window.api.fs.readImage = vi.fn().mockRejectedValue(new Error('ipc died'))

    expect(await loadImage('/tmp/chart.png')).toEqual({ status: 'error', message: 'ipc died' })
  })
})
