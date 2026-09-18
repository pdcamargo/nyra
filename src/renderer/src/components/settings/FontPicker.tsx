import React, { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { FontFamily } from '../../lib/api-types'

/**
 * Pick one of the machine's installed families.
 *
 * A combobox rather than a `<select>`: a typical Mac has three hundred-odd
 * families, which is unusable as a native dropdown. Each row is previewed in its
 * own face, which is free — the font is installed, that is why it is listed.
 */
export default function FontPicker({
  value,
  onChange,
  fonts,
  loading,
  defaultLabel
}: {
  value: string
  onChange: (name: string) => void
  fonts: FontFamily[]
  loading: boolean
  defaultLabel: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? fonts.filter((f) => f.name.toLowerCase().includes(q)) : fonts
    // Long lists are the norm here; the search narrows them, the cap keeps the
    // popover from rendering three hundred rows for an empty query.
    return list.slice(0, 200)
  }, [fonts, query])

  const select = (name: string): void => {
    onChange(name)
    setOpen(false)
    setQuery('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={loading}
        className="flex w-44 items-center justify-between gap-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 outline-hidden transition-colors hover:bg-accent/40 focus:border-border-strong disabled:opacity-50"
        style={value ? { fontFamily: `"${value.replace(/["\\]/g, '')}"` } : undefined}
      >
        <span className="truncate">{loading ? 'Loading…' : value || defaultLabel}</span>
        <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search fonts…" />
          <CommandList>
            <CommandEmpty>No font matches that.</CommandEmpty>
            <CommandItem value="__default__" onSelect={() => select('')}>
              <Check className={`size-3.5 ${value ? 'opacity-0' : ''}`} />
              {defaultLabel}
            </CommandItem>
            {matches.map((font) => (
              <CommandItem
                key={font.name}
                value={font.name}
                onSelect={() => select(font.name)}
                style={{ fontFamily: `"${font.name.replace(/["\\]/g, '')}"` }}
              >
                <Check className={`size-3.5 ${value === font.name ? '' : 'opacity-0'}`} />
                <span className="truncate">{font.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
