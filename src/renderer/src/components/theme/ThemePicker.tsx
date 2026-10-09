import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, FileDown, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Key } from './Key'
import { useThemeStore } from '../../store/themes'
import { BUILT_IN_THEMES, type Theme, type ThemeMode } from '../../lib/themes'
import { SwatchStrip } from './ThemeThumb'

/**
 * The dropdown on a theme slot: that mode's themes, yours first.
 *
 * Moving through the list previews each theme on the whole window, Settings
 * included — the point is to see it on the app, not on a swatch. Enter or a
 * click keeps it; Escape or clicking away puts back what was there.
 */
export function ThemePicker({
  mode,
  value,
  onChoose,
  onNew,
  onImport
}: {
  mode: ThemeMode
  value: Theme
  onChoose: (theme: Theme) => void
  onNew: () => void
  onImport: () => void
}): React.JSX.Element {
  const userThemes = useThemeStore((s) => s.userThemes)
  const setPreview = useThemeStore((s) => s.setPreview)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const yours = useMemo(() => userThemes.filter((t) => t.mode === mode), [userThemes, mode])
  const builtIn = useMemo(() => BUILT_IN_THEMES.filter((t) => t.mode === mode), [mode])
  const flat = useMemo(() => [...yours, ...builtIn], [yours, builtIn])

  useEffect(() => {
    if (!open) return
    const i = flat.findIndex((t) => t.id === value.id)
    setActive(i < 0 ? 0 : i)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Never leave a preview behind: closing by any route puts the slot back.
  useEffect(() => {
    if (!open) setPreview(null)
  }, [open, setPreview])
  useEffect(() => () => setPreview(null), [setPreview])

  const preview = (i: number): void => {
    setActive(i)
    const theme = flat[i]
    setPreview(theme && theme.id !== value.id ? theme : null)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const choose = (theme: Theme): void => {
    setPreview(null)
    setOpen(false)
    onChoose(theme)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      preview(Math.min(flat.length - 1, active + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      preview(Math.max(0, active - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const theme = flat[active]
      if (theme) choose(theme)
    }
  }

  const row = (theme: Theme, i: number): React.JSX.Element => {
    const chosen = theme.id === value.id
    const previewing = i === active && !chosen
    return (
      <button
        key={theme.id}
        type="button"
        role="option"
        aria-selected={chosen}
        data-index={i}
        onMouseEnter={() => preview(i)}
        onClick={() => choose(theme)}
        className={`flex h-[34px] w-full items-center gap-3 rounded-md px-2 text-left text-xs text-foreground transition-colors ${
          i === active ? 'bg-accent' : ''
        }`}
      >
        <SwatchStrip theme={theme} />
        <span className="min-w-0 grow truncate">{theme.name}</span>
        {previewing && <span className="shrink-0 text-[11px] text-info">Previewing</span>}
        {chosen && <Check className="size-3.5 shrink-0 text-info" />}
      </button>
    )
  }

  const groupLabel = (text: string): React.JSX.Element => (
    <p className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{text}</p>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${mode === 'light' ? 'Light' : 'Dark'} theme: ${value.name}`}
          className={`flex h-7 min-w-0 grow items-center gap-2 rounded-lg border px-2 text-left transition-colors ${
            open ? 'border-info' : 'border-border-strong hover:border-foreground/40'
          }`}
        >
          <span className="truncate text-xs font-medium text-foreground">{value.name}</span>
          <span className="grow" />
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[272px] gap-0 p-1"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          listRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-1.5 px-2 pt-1.5">
          <span className="grow text-xs font-medium text-foreground">{mode === 'light' ? 'Light' : 'Dark'} themes</span>
          <Key>↑↓</Key>
          <span className="text-[11px] text-muted-foreground">to preview</span>
        </div>
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={`${mode} themes`}
          className="max-h-[320px] overflow-y-auto outline-hidden"
        >
          {yours.length > 0 && groupLabel('Yours')}
          {yours.map((t, i) => row(t, i))}
          {groupLabel('Built in')}
          {builtIn.map((t, i) => row(t, yours.length + i))}
        </div>
        <div className="my-1 h-px bg-border" />
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onNew()
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="size-3.5 text-muted-foreground" />
          New theme from {value.name}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onImport()
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
        >
          <FileDown className="size-3.5 text-muted-foreground" />
          Import theme file…
        </button>
      </PopoverContent>
    </Popover>
  )
}
