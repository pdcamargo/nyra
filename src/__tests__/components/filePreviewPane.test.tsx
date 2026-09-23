import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import FilePreviewPane from '@renderer/components/files/FilePreviewPane'
import type { ReadTextOutcome } from '@renderer/lib/api-types'

const text = (content: string): ReadTextOutcome => ({
  kind: 'text',
  content,
  truncated: false,
  lossy: false,
  returnedBytes: content.length,
  totalBytes: content.length,
  mtimeMs: 0,
  ino: 0
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('FilePreviewPane', () => {
  /**
   * The bug: a screenshot the agent just took read as "Binary file (82 KB)" —
   * which is true and useless. A picture is bytes, not text, and the viewer has
   * a way to ask for them.
   */
  it('draws a picture instead of the binary placeholder', async () => {
    const readImage = vi
      .spyOn(window.api.fs, 'readImage')
      .mockResolvedValue({ base64: 'AAAB', mediaType: 'image/png' })

    render(<FilePreviewPane path="/repo/shot.png" wrap={false} />)

    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAB')
    expect(readImage).toHaveBeenCalledWith('/repo/shot.png')
    expect(screen.queryByText(/Binary file/)).toBeNull()
  })

  // A format Rust will not hand over — SVG by policy, or a raster the render
  // allowlist has not been widened to yet — says so where the picture would have
  // been, rather than showing an empty pane.
  it('says why a picture it cannot read has nothing to show', async () => {
    vi.spyOn(window.api.fs, 'readImage').mockResolvedValue({ error: 'Not a PNG or JPEG.' })

    render(<FilePreviewPane path="/repo/loop.gif" wrap={false} />)

    expect(await screen.findByText('Not a PNG or JPEG.')).toBeInTheDocument()
  })

  /**
   * The other half: a markdown file is the one file type whose whole point is
   * how it reads. Source in the viewer made a README look like a transcript of
   * a README.
   */
  it('renders markdown with the composer’s live preview', async () => {
    vi.spyOn(window.api.fs, 'readTextFile').mockResolvedValue(text('# Title\n\nbody\n'))

    const { container } = render(<FilePreviewPane path="/repo/README.md" wrap />)

    await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull())
    expect(container.querySelector('.cm-content')?.textContent).toContain('Title')
  })
})
