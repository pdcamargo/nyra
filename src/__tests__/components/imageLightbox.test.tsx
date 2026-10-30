import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImageLightbox from '../../renderer/src/components/ImageLightbox'
import ZoomableImage from '../../renderer/src/components/ZoomableImage'
import { useLightboxStore, showImage } from '../../renderer/src/store/lightbox'

const PIXEL = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  useLightboxStore.setState({ image: null })
})

describe('lightbox store', () => {
  it('ignores an image with no src rather than opening an empty dialog', () => {
    showImage(undefined)
    expect(useLightboxStore.getState().image).toBeNull()
  })

  it('holds one image at a time', () => {
    showImage(PIXEL, 'first.png')
    showImage(PIXEL, 'second.png')
    expect(useLightboxStore.getState().image?.name).toBe('second.png')
  })
})

describe('ZoomableImage', () => {
  it('opens the lightbox on the image it was given', async () => {
    const user = userEvent.setup()
    render(<ZoomableImage src={PIXEL} name="shot.png" />)

    await user.click(screen.getByRole('button', { name: 'View shot.png' }))
    expect(useLightboxStore.getState().image).toEqual({ src: PIXEL, name: 'shot.png' })
  })

  // Thumbnails sit inside chips and rows that have their own click. Looking at
  // the picture is the more specific intent.
  it('does not trigger a click on whatever contains it', async () => {
    const user = userEvent.setup()
    const onOuter = vi.fn()
    render(
      <div onClick={onOuter}>
        <ZoomableImage src={PIXEL} name="shot.png" />
      </div>
    )

    await user.click(screen.getByRole('button', { name: 'View shot.png' }))
    expect(onOuter).not.toHaveBeenCalled()
  })

  it('is reachable from the keyboard', async () => {
    const user = userEvent.setup()
    render(<ZoomableImage src={PIXEL} name="shot.png" />)

    await user.tab()
    expect(screen.getByRole('button', { name: 'View shot.png' })).toHaveFocus()
  })
})

describe('ImageLightbox', () => {
  it('renders nothing until an image is shown', () => {
    const { container } = render(<ImageLightbox />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the image and its name', () => {
    render(<ImageLightbox />)
    act(() => showImage(PIXEL, 'diagram.png'))

    expect(screen.getByRole('img', { name: 'diagram.png' })).toHaveAttribute('src', PIXEL)
    // Twice on purpose: the sr-only dialog title names it for a screen reader,
    // the caption names it on screen.
    expect(screen.getByText('diagram.png', { selector: 'p' })).toBeInTheDocument()
  })

  it('closes on the close button', async () => {
    const user = userEvent.setup()
    render(<ImageLightbox />)
    act(() => showImage(PIXEL, 'diagram.png'))

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(useLightboxStore.getState().image).toBeNull()
  })

  it('closes on a click beside the image', async () => {
    const user = userEvent.setup()
    render(<ImageLightbox />)
    act(() => showImage(PIXEL, 'diagram.png'))

    await user.click(screen.getByRole('button', { name: 'Close image' }))
    expect(useLightboxStore.getState().image).toBeNull()
  })

  /**
   * The one that matters. `session.abort` holds bare Escape on a bubble-phase
   * window listener, so without the capture-phase stop, putting a screenshot
   * away would also kill the turn Claude was in the middle of.
   */
  it('closes on Escape without letting the key reach the global abort', () => {
    const globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)
    try {
      render(<ImageLightbox />)
      act(() => showImage(PIXEL, 'diagram.png'))

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })

      expect(useLightboxStore.getState().image).toBeNull()
      expect(globalEscape).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', globalEscape)
    }
  })

  it('leaves Escape alone when no image is open', () => {
    const globalEscape = vi.fn()
    window.addEventListener('keydown', globalEscape)
    try {
      render(<ImageLightbox />)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(globalEscape).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', globalEscape)
    }
  })

  it('ignores a held-down Escape repeat', () => {
    render(<ImageLightbox />)
    act(() => showImage(PIXEL, 'diagram.png'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true }))
    })
    expect(useLightboxStore.getState().image).not.toBeNull()
  })

  describe('zoom and pan', () => {
    const scaleOf = (img: HTMLElement): number => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1])

    it('zooms in on a double-click and back out on the next', async () => {
      const user = userEvent.setup()
      render(<ImageLightbox />)
      act(() => showImage(PIXEL, 'diagram.png'))
      const img = screen.getByRole('img', { name: 'diagram.png' })

      await user.dblClick(img)
      expect(scaleOf(img)).toBe(2)
      expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('200%')
      // Zooming is not a click beside the picture.
      expect(useLightboxStore.getState().image).not.toBeNull()

      await user.dblClick(img)
      expect(scaleOf(img)).toBe(1)
      expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull()
    })

    it('zooms with the wheel, never below fit', () => {
      render(<ImageLightbox />)
      act(() => showImage(PIXEL, 'diagram.png'))
      const img = screen.getByRole('img', { name: 'diagram.png' })

      act(() => void window.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, cancelable: true })))
      expect(scaleOf(img)).toBeGreaterThan(1)

      act(() => void window.dispatchEvent(new WheelEvent('wheel', { deltaY: 4000, cancelable: true })))
      expect(scaleOf(img)).toBe(1)
    })

    it('resets from the keyboard and from the zoom readout', async () => {
      const user = userEvent.setup()
      render(<ImageLightbox />)
      act(() => showImage(PIXEL, 'diagram.png'))
      const img = screen.getByRole('img', { name: 'diagram.png' })

      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' })))
      expect(scaleOf(img)).toBe(1.5)
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: '0' })))
      expect(scaleOf(img)).toBe(1)

      await user.dblClick(img)
      await user.click(screen.getByRole('button', { name: 'Reset zoom' }))
      expect(scaleOf(img)).toBe(1)
    })

    it('opens the next image at fit', async () => {
      const user = userEvent.setup()
      render(<ImageLightbox />)
      act(() => showImage(PIXEL, 'first.png'))
      await user.dblClick(screen.getByRole('img', { name: 'first.png' }))

      act(() => showImage('data:image/png;base64,AAAA', 'second.png'))
      expect(scaleOf(screen.getByRole('img', { name: 'second.png' }))).toBe(1)
    })
  })
})
