/**
 * The row under the address bar, present only while a device is pinned.
 *
 * Everything you reach for repeatedly is here rather than in the "..." menu,
 * next to the size it changes, so you can watch the page reflow as you touch
 * it. The menu decides whether device mode is on at all; this decides what it
 * is. Putting the device list in the menu meant toggling the mode closed it,
 * which read as being stuck on whatever it started with.
 *
 * It is also where the agent's choice shows up: a click leaves no trace and
 * needs a transient mark, but a device change leaves a large one already, so
 * what is missing is the attribution rather than the trace.
 */
import React, { useEffect, useRef, useState } from 'react'
import { RotateCcwSquare, Smartphone } from 'lucide-react'
import { IconButton } from '../ui/icon-button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { DevicePreset, TabDevice } from '../../lib/api-types'
import type { DeviceSpec } from './BrowserMenu'

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5]

/** How long the agent's mark stays up. Long enough to notice on the way past,
 *  short enough not to become part of the furniture. */
const ATTRIBUTION_MS = 2500

/** A hand-typed size is not a preset, but it still needs a row to sit on so the
 *  picker has something to show when you type over one. */
const CUSTOM = 'custom'

export default function DeviceBar({
  device,
  devices,
  zoom,
  fitPercent,
  onZoom,
  onDevice
}: {
  device: TabDevice
  devices: DevicePreset[]
  zoom: number | 'fit'
  fitPercent: number
  onZoom: (zoom: number | 'fit') => void
  onDevice: (spec: DeviceSpec) => void
}): React.JSX.Element {
  const byAgent = useAgentMark(device)

  return (
    <div
      className={`flex items-center gap-1 border-b border-border/55 px-1.5 py-1 text-[11px] ${
        byAgent ? 'ring-1 ring-inset ring-info/40' : ''
      }`}
    >
      <Smartphone className="size-3 shrink-0 text-muted-foreground" />

      <Select value={device.id} onValueChange={(id) => onDevice({ id })}>
        <SelectTrigger
          aria-label="Device"
          // Sized to its own text, not to the row. `flex-1` here pushed the
          // fields and the zoom off to the right for no reason; the cap keeps
          // "iPhone 16 Pro Max" from doing the same in a narrow panel.
          className="h-6 min-w-0 max-w-[132px] shrink px-1.5 text-[11px] [&>svg]:size-3"
        >
          {/* Named explicitly, because the default renders the whole selected
              item — which would put the size in the trigger as well, reading as
              "Pixel 9412x923" next to the fields that already say it. */}
          <SelectValue>
            <span className="truncate">
              {devices.find((preset) => preset.id === device.id)?.label ?? 'Custom'}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {devices.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {preset.label}
              <span className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">
                {preset.width}&times;{preset.height}
              </span>
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom</SelectItem>
        </SelectContent>
      </Select>

      <SizeField
        label="Width"
        value={device.width}
        onCommit={(width) => onDevice({ id: CUSTOM, width, height: device.height })}
      />
      <span className="shrink-0 text-muted-foreground">&times;</span>
      <SizeField
        label="Height"
        value={device.height}
        onCommit={(height) => onDevice({ id: CUSTOM, width: device.width, height })}
      />

      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        @{device.deviceScaleFactor}x
      </span>

      <IconButton
        label="Rotate"
        onClick={() => onDevice({ id: CUSTOM, width: device.height, height: device.width })}
      >
        <RotateCcwSquare className="size-3" />
      </IconButton>

      <Select
        value={zoom === 'fit' ? 'fit' : String(zoom)}
        onValueChange={(v) => onZoom(v === 'fit' ? 'fit' : Number(v))}
      >
        <SelectTrigger
          aria-label="Zoom"
          className="ml-auto h-6 w-[84px] shrink-0 px-1.5 text-[11px] [&>svg]:size-3"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fit">Fit ({fitPercent}%)</SelectItem>
          {ZOOM_STEPS.map((step) => (
            <SelectItem key={step} value={String(step)}>
              {Math.round(step * 100)}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** True for a moment after a size arrives that the agent chose. */
function useAgentMark(device: TabDevice): boolean {
  const [marked, setMarked] = useState(false)
  const seen = useRef('')

  useEffect(() => {
    const signature = `${device.id}:${device.width}x${device.height}:${device.by}`
    if (seen.current === signature) return
    seen.current = signature
    if (device.by !== 'agent') {
      setMarked(false)
      return
    }
    setMarked(true)
    const timer = setTimeout(() => setMarked(false), ATTRIBUTION_MS)
    return () => clearTimeout(timer)
  }, [device.id, device.width, device.height, device.by])

  return marked
}

/**
 * A width or a height, committed rather than streamed.
 *
 * Deliberately not `settings/primitives.tsx`'s `NumberField`: that commits on
 * every keystroke and clamps to 1..100, so typing "393" would relayout the page
 * at 3, then 39, then 100.
 *
 * Carries a border and a fill even at rest. It had neither, and a bare number on
 * a toolbar reads as a label — there was nothing to say it could be typed in.
 */
function SizeField({
  label,
  value,
  onCommit
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const ref = useRef<HTMLInputElement>(null)
  /** Escape blurs, and blurring commits. Without this the abandoned draft is
   *  what gets committed — `setDraft` has not landed yet when `onBlur` reads
   *  it, so pressing Escape after typing "9" resized the page to 9. */
  const abandoned = useRef(false)

  // Follow the page, but never move the text out from under someone typing it.
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value))
  }, [value])

  const commit = (): void => {
    if (abandoned.current) {
      abandoned.current = false
      setDraft(String(value))
      return
    }
    const next = Number(draft)
    if (Number.isFinite(next) && next > 0 && next !== value) onCommit(Math.round(next))
    else setDraft(String(value))
  }

  return (
    <input
      ref={ref}
      aria-label={label}
      value={draft}
      inputMode="numeric"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          ref.current?.blur()
        }
        if (e.key === 'Escape') {
          abandoned.current = true
          setDraft(String(value))
          ref.current?.blur()
        }
      }}
      className="h-6 w-12 shrink-0 rounded border border-border/70 bg-secondary/50 px-1 text-right font-mono text-[11px] text-foreground outline-none transition-colors hover:border-border focus:border-ring focus:bg-secondary"
    />
  )
}
