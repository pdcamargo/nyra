import React from 'react'

/**
 * The controls every settings pane is built from.
 *
 * These used to live at the bottom of SettingsModal, with a second copy of
 * `Toggle` in PermissionsModal that had drifted (it carried `shrink-0`). One
 * copy, in the file the panes all import.
 */

export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:mt-0">
      {children}
    </p>
  )
}

/** A short explanation under a section label, for the panes that need one. */
export function SectionNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{children}</p>
}

/**
 * One setting, with a hairline under it.
 *
 * The rows used to be separated by margin alone, which left a long pane reading
 * as one undifferentiated column. `border-separator` is a hair off the surface
 * rather than a border colour — enough to give the list a rhythm without drawing
 * a box around every row. The last row in a run drops it, so a section never
 * ends on a line.
 */
export function SettingRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-separator py-2.5 last:border-b-0 [&:has(+p)]:border-b-0">
      <label className="min-w-0 text-xs text-foreground/80">
        {label}
        {hint ? <span className="text-muted-foreground/70"> — {hint}</span> : null}
      </label>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-info' : 'bg-accent'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

export function Select({
  value,
  onChange,
  options,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 outline-hidden focus:border-border-strong transition-colors appearance-none cursor-pointer pr-6 ${className ?? ''}`}
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23666' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center'
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} className="bg-popover text-foreground">
          {opt.label}
        </option>
      ))}
    </select>
  )
}

export function SegmentedControl({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}): React.JSX.Element {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`px-3 py-1 text-xs transition-colors ${
            value === opt.value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground/80'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function NumberField({
  value,
  onChange,
  min = 1,
  max = 100
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}): React.JSX.Element {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
      className="w-16 rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs text-foreground/80 font-mono outline-hidden focus:border-border-strong transition-colors"
    />
  )
}

export function TextField({
  value,
  onChange,
  mono = false,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  mono?: boolean
  placeholder?: string
}): React.JSX.Element {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 outline-hidden focus:border-border-strong transition-colors ${mono ? 'font-mono' : ''}`}
    />
  )
}

/** A labelled block for controls that need the full width — textareas, tables. */
export function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-separator py-2.5 last:border-b-0 [&:has(+p)]:border-b-0">
      <label className="mb-1.5 block text-xs text-foreground/80">{label}</label>
      {children}
    </div>
  )
}
