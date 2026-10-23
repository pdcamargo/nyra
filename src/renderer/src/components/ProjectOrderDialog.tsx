import React, { useEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'
import Modal from './Modal'
import { ProjectTile } from './SidebarStatus'
import { useSessionsStore, type Project } from '../store/sessions'
import { useSettingsStore } from '../store/settings'
import { tintColor } from '../lib/project-appearance'
import { autoTint } from '../lib/sidebarStatus'

/** A drag in progress, measured once when it starts. */
type Drag = {
  id: string
  from: number
  /** The pointer's start, and how far it has moved since. */
  startY: number
  dy: number
  /** Where every row sat when the drag began, in list order. */
  tops: number[]
  heights: number[]
  /** How far a row moves to make room: the dragged row and one gap. */
  step: number
  /** How far the dragged row may travel before it leaves the list. */
  minDy: number
  maxDy: number
}

/** The slot the dragged row would land in, among the rows as they began. */
function targetIndex(d: Drag): number {
  const center = d.tops[d.from] + d.heights[d.from] / 2 + d.dy
  let index = 0
  for (let i = 0; i < d.tops.length; i++) {
    if (i !== d.from && d.tops[i] + d.heights[i] / 2 < center) index++
  }
  return index
}

/** How far row `i` moves aside while the dragged row hovers over `target`. */
function shiftOf(d: Drag, i: number, target: number): number {
  if (i === d.from) return d.dy
  if (d.from < target && i > d.from && i <= target) return -d.step
  if (target < d.from && i >= target && i < d.from) return d.step
  return 0
}

/**
 * The order projects are listed in, set by dragging.
 *
 * A dialog rather than drag-and-drop in the rail itself: a project's header is
 * already a collapse toggle, a menu, a New chat button and a sort, and an open
 * project is a tall thing to drag past. Here every project is one row.
 *
 * Pointer events rather than the browser's own drag and drop. That one showed a
 * translucent snapshot of the row, flipped the cursor to "not allowed" over
 * anything that was not a drop target, and could only preview the new order by
 * reordering the real rows under the pointer, which made them jump. Here the
 * row lifts and follows the pointer, the others slide aside to show where it
 * will land, and it is saved when you let go. Escape mid-drag puts it back.
 * A handle also takes ↑ and ↓ from the keyboard, for the same move without a
 * pointer.
 */
export default function ProjectOrderDialog({
  open,
  onClose,
  projects
}: {
  open: boolean
  onClose: () => void
  /** The active workspace's projects, in their current order. */
  projects: Project[]
}): React.JSX.Element {
  const [ids, setIds] = useState(() => projects.map((p) => p.id))
  const [drag, setDrag] = useState<Drag | null>(null)
  // The frame a drop lands in. The rows are reordered and their offsets
  // cleared at once, so they are already where they were drawn — animating
  // the offsets back to zero would slide them a second time.
  const [settling, setSettling] = useState(false)
  const spine = useSettingsStore((s) => s.sidebarStyle === 'spine')
  const rows = useRef(new Map<string, HTMLLIElement>())
  const handles = useRef(new Map<string, HTMLButtonElement>())

  // Picked up fresh each time it opens. While open the list is its own, or a
  // store update mid-drag would snap the row back under the pointer.
  useEffect(() => {
    if (open) setIds(projects.map((p) => p.id))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Escape cancels the drag rather than closing the dialog. Caught on the way
  // down, before the dialog's own listener on the document hears it.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setDrag(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!settling) return
    const frame = requestAnimationFrame(() => setSettling(false))
    return () => cancelAnimationFrame(frame)
  }, [settling])

  const byId = new Map(projects.map((p) => [p.id, p]))
  const save = (next: string[]): void => useSessionsStore.getState().reorderProjects(next)

  const moveTo = (id: string, index: number): string[] => {
    const next = ids.filter((x) => x !== id)
    next.splice(Math.max(0, Math.min(index, next.length)), 0, id)
    return next
  }

  const onKey = (e: React.KeyboardEvent, id: string): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const from = ids.indexOf(id)
    const to = e.key === 'ArrowUp' ? from - 1 : from + 1
    if (to < 0 || to >= ids.length) return
    const next = moveTo(id, to)
    setIds(next)
    save(next)
    // The row moved; keep the handle that moved it focused.
    requestAnimationFrame(() => handles.current.get(id)?.focus())
  }

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, id: string): void => {
    if (e.button !== 0) return
    const rects = ids.map((x) => rows.current.get(x)!.getBoundingClientRect())
    const from = ids.indexOf(id)
    const list = rows.current.get(id)!.parentElement!.getBoundingClientRect()
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 0
    // Captured, so the drag carries on outside the handle and the cursor stays
    // the grabbing hand wherever the pointer goes.
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({
      id,
      from,
      startY: e.clientY,
      dy: 0,
      tops: rects.map((r) => r.top),
      heights: rects.map((r) => r.height),
      step: rects[from].height + gap,
      minDy: list.top - rects[from].top,
      maxDy: list.bottom - rects[from].bottom
    })
  }

  const moveDrag = (e: React.PointerEvent): void => {
    if (!drag) return
    const dy = Math.max(drag.minDy, Math.min(drag.maxDy, e.clientY - drag.startY))
    if (dy !== drag.dy) setDrag({ ...drag, dy })
  }

  const endDrag = (): void => {
    if (!drag) return
    const target = targetIndex(drag)
    setDrag(null)
    if (target === drag.from) return
    const next = moveTo(drag.id, target)
    setSettling(true)
    setIds(next)
    save(next)
  }

  const target = drag ? targetIndex(drag) : -1

  return (
    <Modal open={open} onClose={onClose} title="Project order" titleHidden={false} className="w-[360px] p-4">
      <p className="mt-1 mb-3 text-xs text-muted-foreground">
        Drag a project by its handle, or focus the handle and use ↑ and ↓.
      </p>
      {/* Padded and pulled out by the same amount, so the rows sit where they
          did and the lifted row's shadow has room inside the scroller, which
          would otherwise clip it at the sides. */}
      <ol
        className={`relative -mx-2 flex max-h-[60vh] flex-col gap-px overflow-y-auto p-1 ${drag ? 'select-none' : ''}`}
      >
        {ids.map((id, i) => {
          const project = byId.get(id)
          if (!project) return null
          const tint = tintColor(project.color) ?? (spine ? tintColor(autoTint(project.id)) : null)
          const lifted = drag?.id === id
          const offset = drag ? shiftOf(drag, i, target) : 0
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) rows.current.set(id, el)
                else rows.current.delete(id)
              }}
              style={offset ? { transform: `translateY(${offset}px)` } : undefined}
              className={`flex items-center gap-2 rounded-md px-1 py-1 ${
                lifted
                  ? 'relative z-10 bg-popover shadow-panel ring-1 ring-foreground/10'
                  : drag
                    ? ''
                    : 'hover:bg-rail-hover'
              } ${lifted || settling ? '' : 'transition-[transform,background-color] duration-150 ease-out'}`}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) handles.current.set(id, el)
                  else handles.current.delete(id)
                }}
                aria-label={`Move ${project.name}`}
                onPointerDown={(e) => startDrag(e, id)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => onKey(e, id)}
                className={`touch-none rounded-sm p-1 transition-colors hover:text-foreground ${
                  lifted ? 'cursor-grabbing text-foreground' : 'cursor-grab text-muted-foreground'
                }`}
              >
                <GripVertical className="size-3.5" />
              </button>
              <ProjectTile project={project} tint={tint} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-foreground">{project.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground" title={project.path}>
                  {project.path}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-secondary px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          Done
        </button>
      </div>
    </Modal>
  )
}
