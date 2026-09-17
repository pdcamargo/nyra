import React, { useEffect, useRef } from 'react'

export type ResizeSide = 'left' | 'right' | 'bottom'

/**
 * `side` names where the panel being resized sits relative to the handle, which
 * settles both the axis and which way a positive drag grows the panel: the
 * projects rail is to the handle's left and grows rightward, the workspace panel
 * and the bottom dock are the other way round.
 */
const SIDES = {
  left: { axis: 'x', sign: 1 },
  right: { axis: 'x', sign: -1 },
  bottom: { axis: 'y', sign: -1 }
} as const

type Props = {
  side: ResizeSide
  /** Read at mousedown, so a drag starts from what is on screen — and so this
   *  component never subscribes to the size it is changing. */
  getSize: () => number
  /** Applied to every candidate. Owns the panel's minimum and the joint "leave
   *  room for the conversation" ceiling. Called on each move rather than
   *  snapshotted, so a window resized mid-drag is still honoured. */
  clamp: (candidate: number) => number
  onSize: (next: number) => void
  /** Double-click. */
  onReset: () => void
  label: string
}

/**
 * The drag handle shared by all three panels.
 *
 * It takes no space in the layout: the outer box is zero-width (or zero-height)
 * and an absolutely positioned child straddles the seam. That keeps each panel's
 * 1px divider looking exactly as it did while giving the drag a 9px target, and
 * it is what lets --rail be the sidebar's width exactly rather than the width
 * plus some handle constant that would rot the first time anyone restyles this.
 */
export default function ResizeHandle({
  side,
  getSize,
  clamp,
  onSize,
  onReset,
  label
}: Props): React.JSX.Element {
  const { axis, sign } = SIDES[side]

  // The move closure is built once per drag but has to call the current props —
  // `clamp` in particular reads the live window, which the inline version in App
  // used to get for free by reading window.innerHeight inside onMove.
  const latest = useRef({ getSize, clamp, onSize, onReset })
  latest.current = { getSize, clamp, onSize, onReset }

  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const onMouseDown = (e: React.MouseEvent): void => {
    // The second mousedown of a double-click. Handled here rather than in
    // onDoubleClick so it lands before a drag can start: otherwise drag, release,
    // then click again nearby resets the panel you just finished sizing. The
    // browser resets `detail` once the pointer moves past its double-click
    // distance tolerance, so a real drag followed by a click still reads as 1.
    if (e.detail === 2) {
      latest.current.onReset()
      return
    }
    e.preventDefault()
    const origin = axis === 'x' ? e.clientX : e.clientY
    const startSize = latest.current.getSize()

    const onMove = (ev: MouseEvent): void => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - origin
      latest.current.onSize(latest.current.clamp(startSize + sign * delta))
    }
    const onUp = (): void => stop.current?.()

    stop.current = () => {
      stop.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`relative z-10 shrink-0 ${axis === 'x' ? 'w-0' : 'h-0'}`}>
      <div
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label={label}
        onMouseDown={onMouseDown}
        className={`group absolute ${
          axis === 'x'
            ? '-left-1 top-0 h-full w-[9px] cursor-col-resize'
            : '-top-1 left-0 h-[9px] w-full cursor-row-resize'
        }`}
      >
        <div
          className={`absolute transition-colors group-hover:bg-info/30 ${
            axis === 'x' ? 'left-[3px] top-0 h-full w-[3px]' : 'left-0 top-[3px] h-[3px] w-full'
          }`}
        />
      </div>
    </div>
  )
}
