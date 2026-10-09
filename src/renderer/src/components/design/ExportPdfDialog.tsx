import { useEffect, useMemo, useState } from 'react'
import type { ResolvedArtboard, Theme } from '@nyra/design'
import { ChevronLeft, ChevronRight, GripVertical, Plus, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import ScaledArtboard from './ScaledArtboard'
import { arrange, moveTo, type PageOrder } from './pageOrder'

const ORDERS: { value: PageOrder; label: string }[] = [
  { value: 'selection', label: 'Selection' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'document', label: 'Document' }
]

const sizeLabel = (a: ResolvedArtboard): string =>
  `${a.size.width} × ${a.size.height === 'auto' ? 'auto' : a.size.height}`

/**
 * Which artboards become pages, and in what order.
 *
 * The list is the document: what you see top to bottom is page 1 to N. The
 * switch above it only ever rearranges the list, so adding or removing a page
 * survives changing your mind about the order.
 */
export default function ExportPdfDialog({
  open,
  onOpenChange,
  artboards,
  theme,
  picked,
  onExport
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  artboards: ResolvedArtboard[]
  theme: Theme
  /** The canvas selection, in the order it was clicked. */
  picked: string[]
  onExport: (ids: string[], openWhenDone: boolean) => void
}): React.ReactElement {
  const byId = useMemo(() => new Map(artboards.map((a) => [a.id, a])), [artboards])
  /** Pick order including anything added here, for the Selection order. */
  const [pickOrder, setPickOrder] = useState<string[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [order, setOrder] = useState<PageOrder>('selection')
  const [current, setCurrent] = useState(0)
  const [dragging, setDragging] = useState<string | null>(null)
  const [openWhenDone, setOpenWhenDone] = useState(true)

  // A fresh list every time it opens: the dialog describes this selection,
  // not whatever the last export was.
  useEffect(() => {
    if (!open) return
    const start = picked.filter((id) => byId.has(id))
    setPickOrder(start)
    setIds(start)
    setOrder('selection')
    setCurrent(0)
    // Deliberately only on open — the file reloading mid-dialog must not reset
    // an order someone has just dragged into shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Pages whose artboard vanished (Claude rewrote the file) drop out quietly.
  const pages = ids.filter((id) => byId.has(id))
  const at = Math.min(current, Math.max(0, pages.length - 1))
  const previewed = byId.get(pages[at] ?? '')
  const addable = artboards.filter((a) => !pages.includes(a.id))

  const reorder = (next: string[]): void => {
    setIds(next)
    setOrder('custom')
  }

  const pickOrderMode = (next: PageOrder): void => {
    if (next === 'custom') return
    setOrder(next)
    setIds(arrange(pages, next, artboards, pickOrder))
  }

  const move = (id: string, to: number): void => {
    const next = moveTo(pages, id, to)
    if (next === pages) return
    reorder(next)
    setCurrent(next.indexOf(id))
  }

  const remove = (id: string): void => setIds(pages.filter((x) => x !== id))

  const add = (id: string): void => {
    setPickOrder((p) => (p.includes(id) ? p : [...p, id]))
    const next = order === 'custom' ? [...pages, id] : arrange([...pages, id], order, artboards, [...pickOrder, id])
    setIds(next)
    setCurrent(next.indexOf(id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[860px] gap-0 overflow-hidden p-0" showCloseButton>
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-sm">Export as PDF</DialogTitle>
          <DialogDescription>
            {pages.length} page{pages.length === 1 ? '' : 's'}. Each page is the size of its artboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-[420px] min-h-0 gap-5 p-5">
          <div className="flex w-[340px] shrink-0 flex-col gap-2.5">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Page order
            </span>
            <div role="radiogroup" className="flex gap-0.5 rounded-md bg-muted p-0.5">
              {[...ORDERS, ...(order === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : [])].map(
                (o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={order === o.value}
                    onClick={() => pickOrderMode(o.value)}
                    className={cn(
                      'flex-1 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors',
                      order === o.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {o.label}
                  </button>
                )
              )}
            </div>

            <ol className="-mx-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1 py-0.5">
              {pages.map((id, i) => {
                const artboard = byId.get(id)!
                return (
                  <li
                    key={id}
                    tabIndex={0}
                    draggable
                    aria-label={`Page ${i + 1}: ${artboard.name}`}
                    onClick={() => setCurrent(i)}
                    onKeyDown={(e) => {
                      if (!e.altKey) return
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        move(id, i - 1)
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        move(id, i + 1)
                      }
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(id)
                    }}
                    onDragOver={(e) => {
                      if (dragging === null) return
                      e.preventDefault()
                      // Reordered live, so the gap is always where the row
                      // will land — the list is its own drop indicator.
                      if (dragging !== id) move(dragging, i)
                    }}
                    onDrop={(e) => e.preventDefault()}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      'group flex cursor-grab items-center gap-2.5 rounded-md border px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                      dragging === id
                        ? 'border-dashed border-primary/50 bg-primary/5 [&>*]:opacity-0'
                        : i === at
                          ? 'border-primary/60 bg-primary/5'
                          : 'bg-background hover:bg-accent/40'
                    )}
                  >
                    <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="w-3 shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex size-10 shrink-0 items-center justify-center">
                      <ScaledArtboard
                        artboard={artboard}
                        theme={theme}
                        maxWidth={40}
                        maxHeight={40}
                        className="rounded-at-2 ring-1 ring-border"
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium">{artboard.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{sizeLabel(artboard)}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${artboard.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(id)
                      }}
                      className="rounded-at-4 p-0.5 text-muted-foreground opacity-60 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                )
              })}
            </ol>

            {addable.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                    <span className="flex-1 text-left">Add artboard</span>
                    <span className="text-[10px]">{addable.length} more in this design</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 w-[300px] overflow-y-auto">
                  {addable.map((a) => (
                    <DropdownMenuItem key={a.id} onSelect={() => add(a.id)}>
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{sizeLabel(a)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
              Drag rows to reorder, or use Alt+↑/↓. Once you reorder, the order becomes Custom.
            </p>
          </div>

          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg bg-muted/50 p-4">
            {previewed ? (
              <>
                <ScaledArtboard
                  artboard={previewed}
                  theme={theme}
                  maxWidth={400}
                  maxHeight={320}
                  className="shadow-md"
                />
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={at === 0}
                    onClick={() => setCurrent(at - 1)}
                    className="rounded-at-4 p-0.5 hover:bg-accent disabled:opacity-30"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <span className="max-w-[260px] truncate">
                    Page <span className="font-medium text-foreground">{at + 1}</span> of {pages.length} ·{' '}
                    {previewed.name}
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={at >= pages.length - 1}
                    onClick={() => setCurrent(at + 1)}
                    className="rounded-at-4 p-0.5 hover:bg-accent disabled:opacity-30"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No pages. Add an artboard to export.</p>
            )}
          </div>
        </div>

        <DialogFooter className="flex-row items-center border-t bg-muted/40 px-5 py-3">
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={openWhenDone} onCheckedChange={(v) => setOpenWhenDone(v === true)} />
            Open the PDF when it&apos;s done
          </label>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pages.length === 0} onClick={() => onExport(pages, openWhenDone)}>
            Export {pages.length} page{pages.length === 1 ? '' : 's'}…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
