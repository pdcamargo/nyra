import React from 'react'
import { FileText } from 'lucide-react'
import { useSettingsStore } from '../../store/settings'
import { DEFAULT_CORNER_RADIUS, MAX_CORNER_RADIUS, MIN_CORNER_RADIUS } from '../../lib/appearance'
import { Slider } from '../ui/slider'
import { Checkbox } from '../ui/checkbox'
import { SectionLabel } from './primitives'

/**
 * Appearance → Corners. One number; every tier of `rounded-*` is a ratio of it.
 *
 * The sample below the slider is built from the real classes rather than
 * drawn, so what moves when you drag is exactly what moves in the app. The
 * things that stay put stay put on purpose: pills and dots are round because of
 * what they are, and a checkbox that rounds into a circle reads as a radio.
 */
export default function CornersSection(): React.JSX.Element {
  const radius = useSettingsStore((s) => s.cornerRadius)
  const update = useSettingsStore((s) => s.updateSettings)
  const set = (px: number): void =>
    update({ cornerRadius: Math.min(MAX_CORNER_RADIUS, Math.max(MIN_CORNER_RADIUS, px)) })
  const atDefault = Math.abs(radius - DEFAULT_CORNER_RADIUS) < 0.01

  return (
    <>
      <SectionLabel>Shape</SectionLabel>
      <div className="flex items-center justify-between gap-4 py-2.5">
        <div className="min-w-0">
          <p className="text-xs text-foreground/80">Corners</p>
          <p className="text-[11px] text-muted-foreground">Everything rounded scales from this</p>
        </div>
        <div className="flex w-[260px] shrink-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="relative grow">
              <Slider
                className="[&_[data-slot=slider-range]]:bg-info [&_[data-slot=slider-track]]:bg-border-strong"
                aria-label="Corner radius"
                min={MIN_CORNER_RADIUS}
                max={MAX_CORNER_RADIUS}
                step={1}
                value={[Math.round(radius)]}
                onValueChange={([v]) => set(v === Math.round(DEFAULT_CORNER_RADIUS) ? DEFAULT_CORNER_RADIUS : v)}
              />
              {/* Where Nyra ships, so the way back is visible without reading a number. */}
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-border-strong"
                style={{ left: `${(DEFAULT_CORNER_RADIUS / MAX_CORNER_RADIUS) * 100}%` }}
              />
            </div>
            <label className="flex h-7 w-[60px] shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 focus-within:border-border-strong">
              <input
                type="number"
                aria-label="Corner radius in pixels"
                min={MIN_CORNER_RADIUS}
                max={MAX_CORNER_RADIUS}
                value={Math.round(radius)}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) set(v)
                }}
                className="w-full min-w-0 bg-transparent font-mono text-xs text-foreground outline-hidden [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-[11px] text-muted-foreground">px</span>
            </label>
          </div>
          <div className="flex justify-between pr-[68px] text-[11px] text-muted-foreground">
            <span>Square</span>
            <span>Default</span>
            <span>Round</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-4 pb-2.5">
        <div aria-hidden className="flex grow flex-col gap-3 rounded-xl bg-muted p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 items-center rounded-md bg-info px-3 text-xs font-medium text-info-foreground">Save</span>
            <span className="flex h-7 grow items-center rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
              Search chats
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox checked tabIndex={-1} />
            <span className="grow">Show thinking</span>
            <span className="flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[11px]">
              <FileText className="size-3 text-muted-foreground" />
              index.css
            </span>
            <span className="size-2 rounded-full bg-success" />
          </div>
          <span className="self-end rounded-lg bg-bubble px-3 py-2 text-xs text-bubble-foreground">
            Make the corners rounder
          </span>
        </div>
        <div className="flex w-[190px] shrink-0 flex-col gap-1.5 pt-0.5 text-[11px] leading-relaxed">
          <p className="font-medium text-foreground">What changes</p>
          <p className="text-muted-foreground">Buttons, fields, cards, menus, chips, the composer and your messages.</p>
          <p className="pt-1 font-medium text-foreground">What stays</p>
          <p className="text-muted-foreground">
            Pills, avatars and status dots stay round. Checkboxes stay at 4px so they never read as radio buttons.
          </p>
          {!atDefault && (
            <button
              type="button"
              onClick={() => set(DEFAULT_CORNER_RADIUS)}
              className="self-start pt-1 text-info hover:underline"
            >
              Reset to {Math.round(DEFAULT_CORNER_RADIUS)}px
            </button>
          )}
        </div>
      </div>
    </>
  )
}
