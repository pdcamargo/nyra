import React, { useMemo, useState } from 'react'
import { ArrowUp, ImageIcon, ImagePlus, Moon, Plus, Sun, Trash2 } from 'lucide-react'
import { useSettingsStore } from '../../store/settings'
import { slotTheme, useThemeStore } from '../../store/themes'
import { usePreferredMode } from '../../hooks/useResolvedTheme'
import { previewColors, type ThemeMode } from '../../lib/themes'
import { canDither, forgetBackground, resolveLook, useBackgroundUrl } from '../../lib/chatBackground'
import { DEFAULT_BACKGROUND_LOOK, type BackgroundEffect, type BackgroundLook } from '../../../../shared/types'
import ChatBackdrop from '../ChatBackdrop'
import { Slider } from '../ui/slider'
import { SectionLabel, SegmentedControl, Select, SettingRow } from './primitives'

const SLIDER_CLASS = '[&_[data-slot=slider-range]]:bg-info [&_[data-slot=slider-track]]:bg-border-strong'

type Adjustment = {
  key: 'brightness' | 'blur' | 'opacity' | 'fade' | 'composerOpacity'
  label: string
  min: number
  max: number
  unit: string
}

const ADJUSTMENTS: Adjustment[] = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 200, unit: '%' },
  { key: 'blur', label: 'Blur', min: 0, max: 40, unit: 'px' },
  { key: 'opacity', label: 'Image opacity', min: 0, max: 100, unit: '%' },
  { key: 'fade', label: 'Bottom fade', min: 0, max: 100, unit: '%' },
  // Below this the composer's text has nothing under it but the photo.
  { key: 'composerOpacity', label: 'Composer opacity', min: 40, max: 100, unit: '%' }
]

function setLook(mode: ThemeMode, patch: Partial<BackgroundLook>): void {
  const { chatBackground, updateSettings } = useSettingsStore.getState()
  updateSettings({ chatBackground: { ...chatBackground, [mode]: { ...chatBackground[mode], ...patch } } })
}

/** Delete a file no look points at any more. */
function discard(name: string | null): void {
  if (!name) return
  const { light, dark } = useSettingsStore.getState().chatBackground
  if (light.image === name || dark.image === name) return
  forgetBackground(name)
  void window.api.backgrounds.remove(name)
}

/**
 * Appearance → Background: a picture behind the chat column, one per mode.
 *
 * Laid out like the theme slots above it, for the same reason: under System the
 * window moves between the two by itself. Dark borrows light's image until it is
 * given its own, but its adjustments are always its own — a photo that sits well
 * behind a light page nearly always wants dimming behind a dark one.
 */
export default function BackgroundSection(): React.JSX.Element {
  const bg = useSettingsStore((s) => s.chatBackground)
  const update = useSettingsStore((s) => s.updateSettings)
  const preferred = usePreferredMode()
  const [tuning, setTuning] = useState<ThemeMode>(preferred)
  const [error, setError] = useState<string | null>(null)

  const choose = async (mode: ThemeMode): Promise<void> => {
    setError(null)
    const path = await window.api.dialog.pickImage()
    if (!path) return
    const res = await window.api.backgrounds.import(path)
    if (!res.name) {
      setError(res.error ?? 'Could not add that image.')
      return
    }
    const previous = useSettingsStore.getState().chatBackground[mode].image
    setLook(mode, { image: res.name, focusX: 50, focusY: 50 })
    discard(previous)
    setTuning(mode)
  }

  const remove = (mode: ThemeMode): void => {
    const previous = bg[mode].image
    setLook(mode, { image: null })
    discard(previous)
  }

  if (!bg.light.image && !bg.dark.image) {
    return (
      <>
        <SectionLabel>Background</SectionLabel>
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-6 py-7 text-center">
          <ImageIcon className="size-5 text-muted-foreground" />
          <p className="text-xs font-medium text-foreground">Put a picture behind your chats</p>
          <p className="max-w-[360px] text-[11px] leading-relaxed text-muted-foreground">
            PNG, JPEG, WebP or GIF, up to 10 MB. You can pick a second one for dark mode afterwards.
          </p>
          <button
            type="button"
            onClick={() => void choose('light')}
            className="mt-1 flex h-7 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <ImagePlus className="size-3.5 text-muted-foreground" />
            Choose image…
          </button>
          {error && <p className="text-[11px] text-danger">{error}</p>}
        </div>
      </>
    )
  }

  const look = bg[tuning]
  const resolved = resolveLook(bg, tuning)
  const gif = resolved ? !canDither(resolved.image) : false

  return (
    <>
      <SectionLabel>Background</SectionLabel>
      <div className="flex items-center justify-between gap-4 pb-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground/80">Show it on</p>
          <p className="text-[11px] text-muted-foreground">Behind a new chat only, or behind conversations too.</p>
        </div>
        <SegmentedControl
          value={bg.scope}
          onChange={(v) => update({ chatBackground: { ...bg, scope: v as 'new' | 'all' } })}
          options={[
            { value: 'new', label: 'New chats' },
            { value: 'all', label: 'Every chat' }
          ]}
        />
      </div>

      <div className="flex items-stretch gap-3">
        <Slot mode="light" inUse={preferred === 'light'} onChoose={choose} onRemove={remove} />
        <Slot mode="dark" inUse={preferred === 'dark'} onChoose={choose} onRemove={remove} />
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

      <div className="mt-5 mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Adjust</p>
        <SegmentedControl
          value={tuning}
          onChange={(v) => setTuning(v as ThemeMode)}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </div>

      <Preview mode={tuning} />

      <SettingRow label="Effect" hint={gif ? 'GIFs stay as they are' : 'dither turns the photo into a pixel texture'}>
        <Select
          value={gif ? 'none' : look.effect}
          onChange={(v) => setLook(tuning, { effect: v as BackgroundEffect })}
          options={[
            { value: 'none', label: 'None' },
            ...(gif ? [] : [{ value: 'dither', label: 'Dither' }])
          ]}
        />
      </SettingRow>

      {ADJUSTMENTS.map((a) => (
        <SettingRow key={a.key} label={a.label}>
          <div className="flex w-[260px] items-center gap-3">
            <Slider
              className={SLIDER_CLASS}
              aria-label={a.label}
              min={a.min}
              max={a.max}
              step={1}
              value={[look[a.key]]}
              onValueChange={([v]) => setLook(tuning, { [a.key]: v })}
            />
            <span className="w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              {look[a.key]}
              {a.unit}
            </span>
          </div>
        </SettingRow>
      ))}

      <div className="mt-2 flex items-start justify-between gap-4">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Images are copied into <span className="font-mono">~/.nyra/backgrounds</span>, so moving the original
          breaks nothing.
        </p>
        <button
          type="button"
          onClick={() => {
            const { brightness, blur, opacity, fade, composerOpacity, effect } = DEFAULT_BACKGROUND_LOOK
            setLook(tuning, { brightness, blur, opacity, fade, composerOpacity, effect })
          }}
          className="shrink-0 text-[11px] text-info hover:underline"
        >
          Reset {tuning} adjustments
        </button>
      </div>
    </>
  )
}

/** One mode's image. Clicking the thumbnail picks the part that stays in view. */
function Slot({
  mode,
  inUse,
  onChoose,
  onRemove
}: {
  mode: ThemeMode
  inUse: boolean
  onChoose: (mode: ThemeMode) => Promise<void>
  onRemove: (mode: ThemeMode) => void
}): React.JSX.Element {
  const bg = useSettingsStore((s) => s.chatBackground)
  const own = bg[mode].image
  const resolved = resolveLook(bg, mode)
  const borrowed = mode === 'dark' && !own && resolved !== null
  const url = useBackgroundUrl(resolved?.image ?? null, 'none')
  const Icon = mode === 'light' ? Sun : Moon

  const setFocus = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setLook(mode, {
      focusX: Math.round(((e.clientX - r.left) / r.width) * 100),
      focusY: Math.round(((e.clientY - r.top) / r.height) * 100)
    })
  }

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-3 rounded-lg border p-3 ${inUse ? 'border-info' : 'border-border'}`}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{mode === 'light' ? 'Light' : 'Dark'}</span>
        <span className="grow" />
        {inUse && (
          <span className="flex items-center gap-1 text-[11px] text-info">
            <span className="size-1.5 rounded-full bg-info" />
            In use now
          </span>
        )}
      </div>

      {own && url ? (
        <button
          type="button"
          onClick={setFocus}
          title="Click the part of the image that should stay in view"
          className="group relative aspect-video w-full cursor-crosshair overflow-hidden rounded-md bg-muted"
        >
          <img
            src={url}
            alt=""
            draggable={false}
            className="size-full object-cover"
            style={{ objectPosition: `${bg[mode].focusX}% ${bg[mode].focusY}%` }}
          />
          <span
            aria-hidden
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${bg[mode].focusX}%`, top: `${bg[mode].focusY}%` }}
          />
        </button>
      ) : (
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted">
          {borrowed && url ? (
            <>
              <img src={url} alt="" draggable={false} className="size-full object-cover opacity-35" />
              <span className="absolute bottom-2 left-2 rounded-sm bg-background px-2 py-0.5 text-[11px] text-foreground">
                Same as light
              </span>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{own ? '' : 'No image'}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void onChoose(mode)}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          {own ? <ImagePlus className="size-3.5 text-muted-foreground" /> : <Plus className="size-3.5 text-muted-foreground" />}
          {own ? 'Replace…' : borrowed ? 'Use a different image…' : 'Choose image…'}
        </button>
        <span className="grow" />
        {own && (
          <button
            type="button"
            onClick={() => onRemove(mode)}
            aria-label={`Remove the ${mode} image`}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The look being tuned, over that mode's own page and composer colours — so
 * tuning dark while the window is light still shows what dark will look like.
 */
function Preview({ mode }: { mode: ThemeMode }): React.JSX.Element {
  const bg = useSettingsStore((s) => s.chatBackground)
  const themeId = useSettingsStore((s) => (mode === 'light' ? s.lightTheme : s.darkTheme))
  const userThemes = useThemeStore((s) => s.userThemes)
  const c = useMemo(() => previewColors(slotTheme(mode, themeId, userThemes)), [mode, themeId, userThemes])
  const resolved = resolveLook(bg, mode)

  return (
    <div
      className="relative isolate mb-1 flex h-[220px] items-end justify-center overflow-hidden rounded-lg border border-border px-10 pb-5"
      style={{ background: c.background }}
    >
      {resolved ? (
        <ChatBackdrop
          image={resolved.image}
          effect={resolved.effect}
          look={resolved.look}
          focusX={resolved.focusX}
          focusY={resolved.focusY}
          fadeTo={c.background}
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-[11px]" style={{ color: c.muted }}>
          No {mode} image
        </p>
      )}
      <div
        className="flex w-full max-w-[380px] flex-col gap-4 rounded-lg border px-3 pt-2.5 pb-2 shadow-panel"
        style={{
          borderColor: c.border,
          background: `color-mix(in oklab, ${c.composer} ${resolved ? resolved.look.composerOpacity : 100}%, transparent)`,
          backdropFilter: resolved && resolved.look.composerOpacity < 100 ? 'blur(16px) saturate(1.2)' : undefined
        }}
      >
        <span className="text-xs" style={{ color: c.muted }}>
          Ask anything, / for commands, @ for context
        </span>
        <span className="flex items-center justify-between">
          <Plus className="size-3.5" style={{ color: c.muted }} />
          <span className="flex size-6 items-center justify-center rounded-md" style={{ background: c.accent }}>
            <ArrowUp className="size-3.5" style={{ color: c.background }} />
          </span>
        </span>
      </div>
    </div>
  )
}
