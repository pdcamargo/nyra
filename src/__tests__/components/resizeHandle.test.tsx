import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ResizeHandle, { type ResizeSide } from '@renderer/components/ResizeHandle'

/** Drag the handle by (dx, dy) and report every size it asked for. */
function drag(side: ResizeSide, from: number, dx: number, dy: number): number[] {
  const seen: number[] = []
  const view = render(
    <ResizeHandle
      side={side}
      label="Resize"
      getSize={() => from}
      clamp={(n) => n}
      onSize={(n) => seen.push(n)}
      onReset={() => {}}
    />
  )
  const handle = view.getByRole('separator')
  fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 })
  fireEvent.mouseMove(document, { clientX: 100 + dx, clientY: 100 + dy })
  fireEvent.mouseUp(document)
  view.unmount()
  return seen
}

beforeEach(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('ResizeHandle drag direction', () => {
  it('grows the projects rail when dragged right', () => {
    expect(drag('left', 256, 40, 0)).toEqual([296])
    expect(drag('left', 256, -40, 0)).toEqual([216])
  })

  it('grows the workspace panel when dragged left', () => {
    expect(drag('right', 256, -40, 0)).toEqual([296])
    expect(drag('right', 256, 40, 0)).toEqual([216])
  })

  it('grows the bottom dock when dragged up', () => {
    expect(drag('bottom', 250, 0, -40)).toEqual([290])
    expect(drag('bottom', 250, 0, 40)).toEqual([210])
  })

  it('ignores the off-axis direction', () => {
    expect(drag('left', 256, 0, 80)).toEqual([256])
    expect(drag('bottom', 250, 80, 0)).toEqual([250])
  })
})

describe('ResizeHandle clamping', () => {
  it('passes every candidate through clamp before reporting it', () => {
    const onSize = vi.fn()
    render(
      <ResizeHandle
        side="left"
        label="Resize"
        getSize={() => 256}
        clamp={(n) => Math.min(n, 300)}
        onSize={onSize}
        onReset={() => {}}
      />
    )
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: 500, clientY: 0 })
    fireEvent.mouseUp(document)
    expect(onSize).toHaveBeenCalledWith(300)
  })

  it('calls the current clamp, not the one from when the drag started', () => {
    // This is what keeps a window resized mid-drag honoured — the inline version
    // in App got it for free by reading window.innerHeight inside onMove.
    const onSize = vi.fn()
    const props = (ceiling: number): React.ComponentProps<typeof ResizeHandle> => ({
      side: 'left',
      label: 'Resize',
      getSize: () => 256,
      clamp: (n) => Math.min(n, ceiling),
      onSize,
      onReset: () => {}
    })
    const view = render(<ResizeHandle {...props(300)} />)
    fireEvent.mouseDown(view.getByRole('separator'), { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: 500, clientY: 0 })
    expect(onSize).toHaveBeenLastCalledWith(300)

    view.rerender(<ResizeHandle {...props(200)} />)
    fireEvent.mouseMove(document, { clientX: 500, clientY: 0 })
    fireEvent.mouseUp(document)
    expect(onSize).toHaveBeenLastCalledWith(200)
  })
})

describe('ResizeHandle reset', () => {
  it('resets on the second mousedown of a double-click and starts no drag', () => {
    const onReset = vi.fn()
    const onSize = vi.fn()
    render(
      <ResizeHandle
        side="left"
        label="Resize"
        getSize={() => 256}
        clamp={(n) => n}
        onSize={onSize}
        onReset={onReset}
      />
    )
    const handle = screen.getByRole('separator')
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100, detail: 1 })
    fireEvent.mouseUp(document)
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100, detail: 2 })
    fireEvent.mouseMove(document, { clientX: 400, clientY: 100 })
    fireEvent.mouseUp(document)

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onSize).not.toHaveBeenCalled()
  })

  it('treats an ordinary drag as a drag', () => {
    const onReset = vi.fn()
    render(
      <ResizeHandle
        side="left"
        label="Resize"
        getSize={() => 256}
        clamp={(n) => n}
        onSize={() => {}}
        onReset={onReset}
      />
    )
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(document, { clientX: 300, clientY: 100 })
    fireEvent.mouseUp(document)
    expect(onReset).not.toHaveBeenCalled()
  })
})

describe('ResizeHandle cleanup', () => {
  it('restores the body styles and stops listening on mouseup', () => {
    const onSize = vi.fn()
    render(
      <ResizeHandle
        side="left"
        label="Resize"
        getSize={() => 256}
        clamp={(n) => n}
        onSize={onSize}
        onReset={() => {}}
      />
    )
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 100, clientY: 100 })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.mouseUp(document)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    onSize.mockClear()
    fireEvent.mouseMove(document, { clientX: 400, clientY: 100 })
    expect(onSize).not.toHaveBeenCalled()
  })

  it('uses the row cursor on the vertical axis', () => {
    render(
      <ResizeHandle side="bottom" label="Resize" getSize={() => 250} clamp={(n) => n} onSize={() => {}} onReset={() => {}} />
    )
    fireEvent.mouseDown(screen.getByRole('separator'), { clientX: 0, clientY: 0 })
    expect(document.body.style.cursor).toBe('row-resize')
    fireEvent.mouseUp(document)
  })

  it('lets go of the document if it unmounts mid-drag', () => {
    const onSize = vi.fn()
    const view = render(
      <ResizeHandle side="bottom" label="Resize" getSize={() => 250} clamp={(n) => n} onSize={onSize} onReset={() => {}} />
    )
    fireEvent.mouseDown(view.getByRole('separator'), { clientX: 0, clientY: 0 })
    view.unmount()
    expect(document.body.style.cursor).toBe('')
    fireEvent.mouseMove(document, { clientX: 0, clientY: 90 })
    expect(onSize).not.toHaveBeenCalled()
  })
})

describe('ResizeHandle layout footprint', () => {
  it('takes no space, so the panel dividers stay as they were', () => {
    const { container } = render(
      <ResizeHandle side="left" label="Resize" getSize={() => 256} clamp={(n) => n} onSize={() => {}} onReset={() => {}} />
    )
    expect(container.firstElementChild?.className).toContain('w-0')
  })

  it('describes itself for assistive tech', () => {
    render(
      <ResizeHandle side="bottom" label="Resize bottom panel" getSize={() => 250} clamp={(n) => n} onSize={() => {}} onReset={() => {}} />
    )
    expect(screen.getByRole('separator', { name: 'Resize bottom panel' })).toHaveAttribute(
      'aria-orientation',
      'horizontal'
    )
  })
})
