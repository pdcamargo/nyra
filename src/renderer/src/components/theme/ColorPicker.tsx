import React, { useEffect, useRef, useState } from 'react'
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from '../../lib/color'

/**
 * Saturation/value square, hue strip and a hex field.
 *
 * Hue is kept in local state rather than re-derived from the hex on every
 * render: at zero saturation or zero value every hue is the same hex, so a
 * picker that round-tripped would snap its hue handle to red the moment you
 * dragged into a corner, and lose your place.
 *
 * `onChange` gets `coalesce: true` for every step of a drag after the first, so
 * the editor can keep one undo step per gesture rather than one per pixel.
 */
export function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (hex: string, opts: { coalesce: boolean }) => void
}): React.JSX.Element {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value))
  const [text, setText] = useState(value.slice(1).toUpperCase())
  const lastEmitted = useRef(value)

  // Follow outside changes (undo, a swatch, Fix) without fighting a drag.
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    const next = hexToHsv(value)
    setHsv((prev) => (next.s === 0 || next.v === 0 ? { ...next, h: prev.h } : next))
    setText(value.slice(1).toUpperCase())
  }, [value])

  const emit = (next: Hsv, coalesce: boolean): void => {
    setHsv(next)
    const hex = hsvToHex(next)
    setText(hex.slice(1).toUpperCase())
    if (hex === lastEmitted.current) return
    lastEmitted.current = hex
    onChange(hex, { coalesce })
  }

  const drag = (
    e: React.PointerEvent<HTMLDivElement>,
    read: (x: number, y: number) => Hsv
  ): void => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const at = (ev: { clientX: number; clientY: number }): [number, number] => [
      Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))
    ]
    emit(read(...at(e)), false)
    const move = (ev: PointerEvent): void => emit(read(...at(ev)), true)
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const nudge = (e: React.KeyboardEvent, axis: 'sv' | 'h'): void => {
    const step = e.shiftKey ? 0.1 : 0.01
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1]
    }
    const dir = d[e.key]
    if (!dir) return
    e.preventDefault()
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    if (axis === 'sv') emit({ ...hsv, s: clamp(hsv.s + dir[0] * step), v: clamp(hsv.v + dir[1] * step) }, true)
    else emit({ ...hsv, h: Math.min(359.9, Math.max(0, hsv.h + (dir[0] || dir[1]) * step * 360)) }, true)
  }

  const commitText = (): void => {
    const hex = normalizeHex(text)
    if (!hex) {
      setText(value.slice(1).toUpperCase())
      return
    }
    emit(hexToHsv(hex), false)
  }

  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 })

  return (
    <div className="flex flex-col gap-3">
      <div
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        tabIndex={0}
        onPointerDown={(e) => drag(e, (x, y) => ({ h: hsv.h, s: x, v: 1 - y }))}
        onKeyDown={(e) => nudge(e, 'sv')}
        className="relative h-[140px] cursor-crosshair touch-none overflow-hidden rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-info"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }}
      >
        <span
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }}
        />
      </div>
      <div
        role="slider"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        onPointerDown={(e) => drag(e, (x) => ({ ...hsv, h: Math.min(359.9, x * 360) }))}
        onKeyDown={(e) => nudge(e, 'h')}
        className="relative h-3 cursor-pointer touch-none rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-info"
        style={{
          background:
            'linear-gradient(to right, #f00 0%, #ff0 16.66%, #0f0 33.33%, #0ff 50%, #00f 66.66%, #f0f 83.33%, #f00 100%)'
        }}
      >
        <span
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }}
        />
      </div>
      <label className="flex h-7 items-center gap-1 rounded-md border border-border-strong bg-background px-2 focus-within:border-info">
        <span className="font-mono text-xs text-muted-foreground">#</span>
        <input
          aria-label="Hex colour"
          value={text}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => setText(e.target.value.replace(/^#/, ''))}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitText()
            }
          }}
          className="w-full min-w-0 bg-transparent font-mono text-xs uppercase text-foreground outline-hidden"
        />
      </label>
    </div>
  )
}
