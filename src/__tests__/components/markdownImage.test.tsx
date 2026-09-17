import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownRenderer from '../../renderer/src/components/MarkdownRenderer'
import { resetImageCache } from '../../renderer/src/lib/imageCache'

describe('markdown images', () => {
  beforeEach(() => {
    resetImageCache()
  })

  it('renders a PNG Claude wrote to an absolute path', async () => {
    window.api.fs.readImage = vi
      .fn()
      .mockResolvedValue({ base64: 'AAAA', mediaType: 'image/png' })

    render(<MarkdownRenderer>{'![sales chart](/tmp/chart.png)'}</MarkdownRenderer>)

    const img = await screen.findByAltText('sales chart')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(img).toHaveAttribute('title', '/tmp/chart.png')
  })

  it('links a remote image instead of rendering it', async () => {
    // The CSP allows data: and blob: but not https:, so an <img> here would be a
    // guaranteed broken-image icon.
    const read = vi.fn()
    window.api.fs.readImage = read

    render(<MarkdownRenderer>{'![Build status](https://example.com/badge.svg)'}</MarkdownRenderer>)

    expect(screen.getByText('Build status').tagName).toBe('A')
    expect(screen.queryByRole('img')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('never reads a path that is not a PNG or JPEG', () => {
    const read = vi.fn()
    window.api.fs.readImage = read

    render(<MarkdownRenderer>{'![passwd](/etc/passwd)'}</MarkdownRenderer>)

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('passwd')).toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
  })

  it('leaves SVG out of v1', () => {
    const read = vi.fn()
    window.api.fs.readImage = read

    render(<MarkdownRenderer>{'![diagram](/tmp/diagram.svg)'}</MarkdownRenderer>)

    expect(screen.queryByRole('img')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('shows a quiet placeholder when the file is gone', async () => {
    window.api.fs.readImage = vi
      .fn()
      .mockResolvedValue({ error: 'Image not found.', missing: true })

    render(<MarkdownRenderer>{'![old chart](/tmp/swept.png)'}</MarkdownRenderer>)

    expect(await screen.findByText(/Image not found\./)).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('surfaces the size limit rather than a blank space', async () => {
    window.api.fs.readImage = vi
      .fn()
      .mockResolvedValue({ error: 'Image too large: 14.2 MB. Maximum is 10 MB.' })

    render(<MarkdownRenderer>{'![huge](/tmp/huge.png)'}</MarkdownRenderer>)

    expect(await screen.findByText(/Maximum is 10 MB/)).toBeInTheDocument()
  })
})
