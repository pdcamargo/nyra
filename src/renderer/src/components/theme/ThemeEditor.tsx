import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  Ellipsis,
  FileUp,
  Moon,
  Palette,
  Pencil,
  RotateCcw,
  Sun,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { allThemes, changeCount, isDirty, useThemeStore, type ThemeEdit } from '../../store/themes'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
import {
  CORE_KEYS,
  GROUPS,
  MIN_CONTRAST,
  TOKENS,
  autoValue,
  copyName,
  fixContrast,
  flipTheme,
  isCoreKey,
  islandStyle,
  nameTaken,
  resolveColors,
  shadesOf,
  textOn,
  tokenContrast,
  type ColorKey,
  type Theme,
  type TokenGroup
} from '../../lib/themes'
import { closeEditor, copyOf, deleteTheme, exportTheme, saveDraft } from '../../lib/themeActions'
import { ColorPicker } from './ColorPicker'
import { Key } from './Key'
import { PickOverlay } from './PickOverlay'

/**
 * The theme editor: a panel docked on the right while the whole window becomes
 * the preview.
 *
 * Every change repaints the real app, not a thumbnail of it. The panel itself
 * is the one thing that does not repaint — it stays in Nyra's own colours (see
 * `islandStyle`), so a draft cannot make the tool you would fix it with
 * unreadable.
 */
export default function ThemeEditor(): React.JSX.Element | null {
  const edit = useThemeStore((s) => s.edit)
  if (!edit) return null
  return <Editor edit={edit} />
}

type Pending = { title: string; body: string; confirm: string; run: () => void }

function Editor({ edit }: { edit: ThemeEdit }): React.JSX.Element {
  const store = useThemeStore.getState
  const userThemes = useThemeStore((s) => s.userThemes)
  const mode = useResolvedTheme()
  const island = useMemo(() => islandStyle(mode), [mode])
  const { draft } = edit
  const resolved = useMemo(() => resolveColors(draft), [draft])
  const dirty = isDirty(edit)
  const changes = changeCount(edit)

  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<ColorKey, HTMLElement>())

  const others = useMemo(() => allThemes(userThemes), [userThemes])
  const nameError = !draft.name.trim()
    ? 'Give the theme a name.'
    : nameTaken(draft.name, others, draft.id)
      ? `${draft.name.trim()} is already a theme. Pick another name.`
      : null

  useEffect(() => {
    if (edit.focusName) {
      nameRef.current?.focus()
      nameRef.current?.select()
    }
  }, [edit.focusName, draft.id])

  // A colour picked off the window may belong to a collapsed group.
  useEffect(() => {
    const key = edit.selected
    if (!key) return
    if (TOKENS.find((t) => t.key === key)?.group === 'status') setStatusOpen(true)
    requestAnimationFrame(() => rowRefs.current.get(key)?.scrollIntoView({ block: 'nearest' }))
  }, [edit.selected])

  /** Run `action`, asking first if it would throw away unsaved changes. */
  const guard = (title: string, action: () => void): void => {
    if (!dirty || (!edit.saved && changes === 0)) return action()
    setPending({
      title,
      body: 'The window goes back to how it looked before you started editing.',
      confirm: 'Discard',
      run: action
    })
  }

  const cancel = (): void => guard(`Discard ${changes || ''} ${changes === 1 ? 'change' : 'changes'} to ${draft.name || 'this theme'}?`.replace('  ', ' '), closeEditor)

  const save = async (): Promise<void> => {
    if (nameError) {
      setError(nameError)
      nameRef.current?.focus()
      return
    }
    const failed = await saveDraft()
    if (failed) setError(failed)
  }

  const startFrom = (theme: Theme, focusName: boolean): void => {
    store().startEdit(theme, { saved: null, baseline: edit.baseline, focusName })
    setError(null)
  }

  // Keys while the editor is open. Popovers and dialogs handle their own
  // Escape first and mark it handled, so this only sees the ones left over.
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') store().setComparing(true)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing(e.target)) {
        e.preventDefault()
        store().undo()
        return
      }
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        const s = store().edit
        if (s?.picking) store().setPicking(false)
        else if (s?.selected) store().select(null)
        else if (!pending && !deleting) cancel()
        return
      }
      if (!typing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        store().setPicking(!store().edit?.picking)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') store().setComparing(false)
    }
    const blur = (): void => store().setComparing(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  })

  const groupNote = (group: TokenGroup): string => {
    if (group === 'core') return 'everything else follows these'
    const set = TOKENS.filter((t) => t.group === group && !isCoreKey(t.key) && draft.colors[t.key as keyof typeof draft.colors]).length
    return set === 0 ? 'Auto' : `${set} set`
  }

  const savedLine = edit.saved
    ? `${draft.basedOn ? `Started from ${draft.basedOn} · ` : ''}${edit.saved.updatedAt ? `Saved ${relative(edit.saved.updatedAt)}` : 'Saved'}`
    : draft.basedOn
      ? `A copy of ${draft.basedOn} · not saved yet`
      : 'Not saved yet'

  return (
    <aside
      data-theme-editor
      aria-label="Theme editor"
      style={island}
      className="nyra-theme-island flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-popover text-popover-foreground"
    >
      {/* Header */}
      <div className="flex flex-col gap-1.5 border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <Palette className="size-3.5 text-info" />
          <span className="grow text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Theme editor</span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Theme actions" className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <Ellipsis className="size-4" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Theme actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" style={island} className="nyra-theme-island w-56">
              <DropdownMenuItem onSelect={() => setTimeout(() => nameRef.current?.select(), 0)}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => guard(`Discard your changes to ${draft.name}?`, () => startFrom(copyOf(draft, copyName(draft.name, others)), true))}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => guard(`Discard your changes to ${draft.name}?`, () => startFrom(flipTheme(draft, others), true))}>
                {draft.mode === 'dark' ? <Sun /> : <Moon />} Make a {draft.mode === 'dark' ? 'light' : 'dark'} version
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportTheme(draft)}>
                <FileUp /> Export theme file…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => store().setColors(Object.fromEntries(CORE_KEYS.map((k) => [k, draft.colors[k]])) as typeof draft.colors)}
              >
                <RotateCcw /> Reset everything to Auto
              </DropdownMenuItem>
              {edit.saved && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                    <Trash2 /> Delete theme
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={cancel} aria-label="Close the editor" className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <X className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close without saving</TooltipContent>
          </Tooltip>
        </div>
        <div
          className={`flex items-center gap-2 rounded-md border px-1.5 transition-colors focus-within:border-info ${
            nameError && error ? 'border-danger' : 'border-transparent hover:border-border'
          }`}
        >
          <input
            ref={nameRef}
            value={draft.name}
            aria-label="Theme name"
            placeholder="Name this theme"
            spellCheck={false}
            maxLength={60}
            onChange={(e) => {
              store().rename(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="h-8 min-w-0 grow bg-transparent text-base font-semibold text-foreground outline-hidden placeholder:text-muted-foreground"
          />
          <Pencil className="size-3 shrink-0 text-muted-foreground" />
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {draft.mode === 'dark' ? 'Dark' : 'Light'}
          </span>
        </div>
        {error && nameError ? (
          <p className="text-[11px] text-danger">{nameError}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">{savedLine}</p>
        )}
      </div>

      {/* Pick from the window */}
      <div className="border-b border-border px-4 py-2">
        <button
          type="button"
          aria-pressed={edit.picking}
          onClick={() => store().setPicking(!edit.picking)}
          className={`flex h-[30px] w-full items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors ${
            edit.picking
              ? 'border-info bg-info/15 text-info'
              : 'border-border-strong text-foreground hover:bg-accent'
          }`}
        >
          <Crosshair className="size-3.5" />
          <span className="grow text-left">{edit.picking ? 'Click a part of the window…' : 'Click anything in the window'}</span>
          <Key>P</Key>
        </button>
      </div>

      {/* Colours */}
      <div className="min-h-0 grow overflow-y-auto px-2 pb-2">
        {GROUPS.map((group) => {
          const tokens = TOKENS.filter((t) => t.group === group.id)
          const collapsible = group.id === 'status'
          const open = !collapsible || statusOpen
          return (
            <section key={group.id}>
              <button
                type="button"
                disabled={!collapsible}
                onClick={() => setStatusOpen((o) => !o)}
                aria-expanded={collapsible ? open : undefined}
                className="flex w-full items-center gap-2 px-2 pt-3 pb-1 text-left"
              >
                {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
                <span className="grow text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</span>
                <span className="text-[11px] text-muted-foreground">{groupNote(group.id)}</span>
              </button>
              {open &&
                (group.id === 'core' ? (
                  <div className="grid grid-cols-4 gap-2 px-2 pb-1">
                    {tokens.map((t) => (
                      <TokenPopover key={t.key} tokenKey={t.key} edit={edit} resolved={resolved} rowRefs={rowRefs}>
                        <CoreTile tokenKey={t.key} edit={edit} resolved={resolved} />
                      </TokenPopover>
                    ))}
                  </div>
                ) : (
                  tokens.map((t) => (
                    <TokenPopover key={t.key} tokenKey={t.key} edit={edit} resolved={resolved} rowRefs={rowRefs}>
                      <TokenRow tokenKey={t.key} edit={edit} resolved={resolved} />
                    </TokenPopover>
                  ))
                ))}
              {group.id === 'core' && <ContrastFixes edit={edit} keys={['accent', 'text']} />}
            </section>
          )
        })}
      </div>

      {/* Footer */}
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {error && !nameError && <p className="text-[11px] text-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {changes === 0 ? 'No changes' : `${changes} ${changes === 1 ? 'change' : 'changes'}`}
          </span>
          <button
            type="button"
            disabled={!edit.history.length}
            onClick={() => store().undo()}
            className="rounded-md px-1.5 py-0.5 text-[11px] text-info transition-colors hover:bg-accent disabled:pointer-events-none disabled:text-muted-foreground"
          >
            Undo
          </button>
          <span className="grow" />
          <button
            type="button"
            onClick={cancel}
            className="h-7 rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!!edit.saved && !dirty}
            className="h-7 rounded-md bg-info px-3 text-xs font-medium text-info-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      <PickOverlay edit={edit} island={island} />

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent style={island} className="nyra-theme-island">
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const run = pending?.run
                setPending(null)
                run?.()
              }}
            >
              {pending?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent style={island} className="nyra-theme-island">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {edit.saved?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its file is removed from ~/.nyra/themes. If it is in use, Nyra goes back to its own {draft.mode} theme.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (!edit.saved) return
                const failed = await deleteTheme(edit.saved)
                if (failed) setError(failed)
                else closeEditor()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}

// ---------------------------------------------------------------- rows

type RowProps = { tokenKey: ColorKey; edit: ThemeEdit; resolved: Record<ColorKey, string> }

function isChanged(edit: ThemeEdit, key: ColorKey): boolean {
  const before = (edit.saved ?? edit.baseline).colors as Record<string, string | undefined>
  const after = edit.draft.colors as Record<string, string | undefined>
  return before[key] !== after[key]
}

function ContrastBadge({ ratio }: { ratio: number }): React.JSX.Element {
  const ok = ratio >= MIN_CONTRAST
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] ${
        ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
      }`}
    >
      {ratio.toFixed(1)}:1
    </span>
  )
}

function CoreTile({ tokenKey, edit, resolved }: RowProps): React.JSX.Element {
  const meta = TOKENS.find((t) => t.key === tokenKey)!
  const ratio = tokenContrast(edit.draft, tokenKey)
  const selected = edit.selected === tokenKey
  return (
    <button
      type="button"
      onClick={() => useThemeStore.getState().select(selected ? null : tokenKey)}
      aria-label={`${meta.label}, ${resolved[tokenKey]}`}
      className="flex min-w-0 flex-col gap-1 text-left"
    >
      <span
        className={`flex h-10 w-full items-start justify-end rounded-at-8 border p-1 ${
          selected ? 'border-info ring-2 ring-info/40' : isChanged(edit, tokenKey) ? 'border-info' : 'border-border-strong'
        }`}
        style={{ background: resolved[tokenKey] }}
      >
        {ratio !== null && (
          <span className="rounded-at-4 bg-popover px-1">
            <span className={`font-mono text-[10px] ${ratio >= MIN_CONTRAST ? 'text-success' : 'text-warning'}`}>
              {ratio.toFixed(1)}
            </span>
          </span>
        )}
      </span>
      <span className="truncate text-[11px] text-foreground">{meta.label}</span>
      <span className="font-mono text-[10px] uppercase text-muted-foreground">{resolved[tokenKey]}</span>
    </button>
  )
}

function TokenRow({ tokenKey, edit, resolved }: RowProps): React.JSX.Element {
  const meta = TOKENS.find((t) => t.key === tokenKey)!
  const set = !!(edit.draft.colors as Record<string, string | undefined>)[tokenKey]
  const ratio = tokenContrast(edit.draft, tokenKey)
  const selected = edit.selected === tokenKey
  return (
    <div>
      <button
        type="button"
        onClick={() => useThemeStore.getState().select(selected ? null : tokenKey)}
        className={`flex w-full items-center gap-3 rounded-md border px-2 py-1.5 text-left transition-colors ${
          selected ? 'border-info bg-accent' : 'border-transparent hover:bg-accent'
        }`}
      >
        <span
          className={`size-6 shrink-0 rounded-at-6 border ${set ? 'border-border-strong' : 'border-dashed border-border-strong'}`}
          style={{ background: resolved[tokenKey] }}
        />
        <span className="flex min-w-0 grow flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{meta.label}</span>
            {isChanged(edit, tokenKey) && <span className="size-1.5 shrink-0 rounded-full bg-info" />}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{meta.where}</span>
        </span>
        {ratio !== null && <ContrastBadge ratio={ratio} />}
        {set ? (
          <span className="shrink-0 font-mono text-[11px] uppercase text-foreground">{resolved[tokenKey]}</span>
        ) : (
          <span className="shrink-0 rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">Auto</span>
        )}
      </button>
      <ContrastFixes edit={edit} keys={[tokenKey]} />
    </div>
  )
}

/** The warning under a colour that reads badly, with the one-click way out. */
function ContrastFixes({ edit, keys }: { edit: ThemeEdit; keys: ColorKey[] }): React.JSX.Element | null {
  const failing = keys.filter((k) => {
    const r = tokenContrast(edit.draft, k)
    return r !== null && r < MIN_CONTRAST && fixContrast(edit.draft, k) !== null
  })
  if (!failing.length) return null
  return (
    <>
      {failing.map((k) => {
        const meta = TOKENS.find((t) => t.key === k)!
        return (
          <div key={k} className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-warning/15 px-2 py-1.5">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" />
            <span className="grow text-[11px] leading-snug text-foreground">
              {meta.label} is hard to read on Background. Fix keeps the hue and moves the lightness until it reaches {MIN_CONTRAST}:1.
            </span>
            <button
              type="button"
              onClick={() => {
                const fixed = fixContrast(edit.draft, k)
                if (fixed) useThemeStore.getState().setColor(k, fixed)
              }}
              className="h-6 shrink-0 rounded-md border border-border-strong px-2 text-[11px] font-medium text-foreground hover:bg-accent"
            >
              Fix
            </button>
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- the popover

function TokenPopover({
  tokenKey,
  edit,
  resolved,
  rowRefs,
  children
}: RowProps & { rowRefs: React.MutableRefObject<Map<ColorKey, HTMLElement>>; children: React.ReactNode }): React.JSX.Element {
  const open = edit.selected === tokenKey && !edit.picking
  const mode = useResolvedTheme()
  const island = useMemo(() => islandStyle(mode), [mode])
  return (
    <Popover open={open} onOpenChange={(o) => !o && useThemeStore.getState().select(null)}>
      <PopoverAnchor asChild>
        <div
          ref={(el) => {
            if (el) rowRefs.current.set(tokenKey, el)
            else rowRefs.current.delete(tokenKey)
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={12}
        collisionPadding={12}
        style={island}
        className="nyra-theme-island w-[268px] gap-3 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ColorPanel tokenKey={tokenKey} edit={edit} resolved={resolved} />
      </PopoverContent>
    </Popover>
  )
}

function ColorPanel({ tokenKey, edit, resolved }: RowProps): React.JSX.Element {
  const meta = TOKENS.find((t) => t.key === tokenKey)!
  const value = resolved[tokenKey]
  const core = isCoreKey(tokenKey)
  const set = core || !!(edit.draft.colors as Record<string, string | undefined>)[tokenKey]
  const change = (hex: string, opts?: { coalesce: boolean }): void => useThemeStore.getState().setColor(tokenKey, hex, opts)
  const shades = useMemo(() => shadesOf(resolved.accent), [resolved.accent])
  const inTheme = useMemo(
    () =>
      Array.from(
        new Set([resolved.background, resolved.chrome, resolved.sidebar, resolved.popover, resolved.border, resolved.bubble, resolved.text])
      ).slice(0, 8),
    [resolved]
  )
  const ratio = tokenContrast(edit.draft, tokenKey)
  const onFill = tokenKey === 'bubble' || tokenKey === 'accent'
  const fillText = textOn(edit.draft, value)

  const swatch = (c: string, label: string): React.JSX.Element => (
    <Tooltip key={c + label}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label} ${c}`}
          onClick={() => change(c)}
          className={`size-[22px] shrink-0 rounded-at-4 border ${c === value ? 'border-info ring-2 ring-info/40' : 'border-border-strong'}`}
          style={{ background: c }}
        />
      </TooltipTrigger>
      <TooltipContent>{c.toUpperCase()}</TooltipContent>
    </Tooltip>
  )

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="grow text-xs font-medium text-foreground">{meta.label}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={() => useThemeStore.getState().select(null)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <ColorPicker value={value} onChange={change} />
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Shades of your accent</span>
        <div className="flex gap-1">{shades.map((c) => swatch(c, 'Shade'))}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-muted-foreground">Already in this theme</span>
        <div className="flex gap-1">{inTheme.map((c) => swatch(c, 'From this theme'))}</div>
      </div>
      {(onFill || ratio !== null) && (
        <div className="flex items-center gap-3 rounded-md bg-muted p-2">
          {onFill ? (
            <span className="flex h-[26px] w-[34px] shrink-0 items-center justify-center rounded-at-4 text-xs font-semibold" style={{ background: value, color: fillText }}>
              Aa
            </span>
          ) : (
            <span className="flex h-[26px] w-[34px] shrink-0 items-center justify-center rounded-at-4 text-xs font-semibold" style={{ background: resolved.background, color: value }}>
              Aa
            </span>
          )}
          <span className="flex min-w-0 grow flex-col">
            <span className="text-[11px] text-foreground">
              {onFill ? 'Its text is picked for you' : 'On Background'}
            </span>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              {onFill ? `${fillText} · ` : ''}
              {ratio !== null ? `${ratio.toFixed(1)}:1` : ''}
            </span>
          </span>
          {ratio !== null && (
            <span
              className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ${
                ratio >= MIN_CONTRAST ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
              }`}
            >
              {ratio >= MIN_CONTRAST ? 'AA' : 'Low'}
            </span>
          )}
        </div>
      )}
      {!core && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!set}
            onClick={() => useThemeStore.getState().setColor(tokenKey, undefined)}
            className="text-[11px] text-info hover:underline disabled:pointer-events-none disabled:text-muted-foreground"
          >
            {set ? 'Reset to Auto' : 'On Auto'}
          </button>
          {set && (
            <span className="truncate text-[11px] text-muted-foreground">
              Auto would be <span className="font-mono uppercase">{autoValue(edit.draft, tokenKey as Exclude<ColorKey, (typeof CORE_KEYS)[number]>)}</span>
            </span>
          )}
        </div>
      )}
    </>
  )
}

function relative(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}
