import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, MessageSquarePlus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { useAnnotationsStore } from '../../store/annotations'
import { newMessageId, type Message } from '../../store/sessions'
import { ANNOTATABLE, annotatableRoot, clampToRoot, offsetsOf, snapToWords } from '../../lib/chatAnnotations'
import { annotationRange, setHighlight } from '../../lib/annotationHighlights'
import { formatChord } from '../../lib/keys'

const TOOLBAR_HEIGHT = 34
const POPOVER_WIDTH = 340
const POPOVER_HEIGHT = 190
const MARGIN = 8

/** The selection being acted on, held as a live range while its row is mounted. */
type Target = {
  range: Range
  messageId: string
  source: 'user' | 'assistant'
  start: number
  end: number
  quote: string
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'toolbar'; target: Target }
  | { kind: 'compose'; target: Target; editId?: string; initial: string }

/**
 * The selection as a target: cut down to the message it starts in, and
 * widened to whole words at either end. The page's selection is updated to
 * match, so what is highlighted is what will be quoted.
 */
function readSelection(): Target | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const picked = selection.getRangeAt(0)
  const root = annotatableRoot(picked.startContainer) ?? annotatableRoot(picked.endContainer)
  if (!root) return null
  const range = clampToRoot(root, picked)
  if (!range) return null
  snapToWords(range)
  // Only when it changed: re-adding an identical range still fires
  // selectionchange.
  if (
    range.compareBoundaryPoints(Range.START_TO_START, picked) !== 0 ||
    range.compareBoundaryPoints(Range.END_TO_END, picked) !== 0
  ) {
    selection.removeAllRanges()
    selection.addRange(range)
  }
  // Off the selection rather than the range: the selection skips
  // `user-select: none` chrome, such as a code block's language label.
  const quote = selection.toString().trim()
  if (!quote) return null
  const { start, end } = offsetsOf(root, range)
  return {
    range: range.cloneRange(),
    messageId: root.getAttribute(ANNOTATABLE)!,
    source: root.dataset.annotatableSource === 'user' ? 'user' : 'assistant',
    start,
    end,
    quote
  }
}

/** A range's box, or null once its row has unmounted and it points at nothing. */
function rectOf(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect()
  return rect.width === 0 && rect.height === 0 ? null : rect
}

/**
 * Select text in any message, yours or Claude's, and a toolbar offers Comment
 * and Copy. Comment opens a popover under the selection; what it adds waits in
 * the composer's tray until the next send. A pin on annotated text reopens the
 * same popover to edit or delete it.
 *
 * One instance per chat, positioned in window space rather than inside the
 * virtualised rows, so a row unmounting under it does not take it along.
 */
export default function SelectionAnnotator({
  sessionId,
  messages
}: {
  sessionId: string | null
  messages: Message[]
}): React.JSX.Element | null {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [rect, setRect] = useState<DOMRect | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const close = useCallback((): void => {
    setHighlight('nyra-annotation-draft', 'draft', null)
    useAnnotationsStore.getState().edit(null)
    setMode({ kind: 'idle' })
  }, [])

  // Show the toolbar when a selection settles: on release of the pointer, or
  // of the key that extended it.
  useEffect(() => {
    const settle = (e: Event): void => {
      if (modeRef.current.kind === 'compose') return
      if (e instanceof KeyboardEvent && !e.shiftKey && e.key !== 'Shift') return
      // After the browser has finished moving the selection.
      requestAnimationFrame(() => {
        const target = readSelection()
        if (target) {
          setMode({ kind: 'toolbar', target })
          setRect(rectOf(target.range))
        } else if (modeRef.current.kind === 'toolbar') {
          setMode({ kind: 'idle' })
        }
      })
    }
    const collapsed = (): void => {
      if (modeRef.current.kind === 'toolbar' && window.getSelection()?.isCollapsed) setMode({ kind: 'idle' })
    }
    document.addEventListener('pointerup', settle)
    document.addEventListener('keyup', settle)
    document.addEventListener('selectionchange', collapsed)
    return () => {
      document.removeEventListener('pointerup', settle)
      document.removeEventListener('keyup', settle)
      document.removeEventListener('selectionchange', collapsed)
    }
  }, [])

  // A pin, or the tray's pencil, asks for an annotation to be edited.
  const editing = useAnnotationsStore((s) => s.editing)
  useEffect(() => {
    if (!editing || !sessionId) return
    const annotation = useAnnotationsStore.getState().bySession[sessionId]?.find((a) => a.id === editing)
    const range = annotationRange(editing)
    if (!annotation || !range) return
    setMode({
      kind: 'compose',
      editId: annotation.id,
      initial: annotation.comment,
      target: { ...annotation, range }
    })
    setRect(rectOf(range))
  }, [editing, sessionId])

  // Follow the text as the transcript scrolls under it.
  useEffect(() => {
    if (mode.kind === 'idle') return
    const follow = (): void => {
      const next = rectOf(mode.target.range)
      if (next) setRect(next)
      else if (mode.kind === 'toolbar') setMode({ kind: 'idle' })
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [mode])

  // A different chat: whatever was open belonged to the last one.
  useEffect(() => close, [sessionId, close])

  if (mode.kind === 'idle' || !rect || !sessionId) return null

  if (mode.kind === 'toolbar') {
    const { target } = mode
    const above = rect.top - TOOLBAR_HEIGHT - MARGIN
    const top = above >= MARGIN ? above : rect.bottom + MARGIN
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - 200))
    return (
      <div
        role="toolbar"
        aria-label="Selection"
        // Keep the selection: a press here would otherwise collapse it first.
        onMouseDown={(e) => e.preventDefault()}
        className="fixed z-50 flex items-center gap-0.5 rounded-at-10 border bg-popover p-1 text-[12.5px] text-popover-foreground shadow-panel"
        style={{ top, left }}
      >
        <button
          type="button"
          onClick={() => {
            window.getSelection()?.removeAllRanges()
            setHighlight('nyra-annotation-draft', 'draft', target.range)
            setMode({ kind: 'compose', target, initial: '' })
          }}
          className="flex h-6.5 items-center gap-1.5 rounded-at-7 px-2.5 font-[550] transition-colors hover:bg-accent"
        >
          <MessageSquarePlus className="size-3.5" />
          Comment
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(window.getSelection()?.toString() ?? target.quote)
            setMode({ kind: 'idle' })
          }}
          className="flex h-6.5 items-center gap-1.5 rounded-at-7 px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Copy className="size-3.5" />
          Copy
        </button>
      </div>
    )
  }

  const below = rect.bottom + MARGIN
  const top = below + POPOVER_HEIGHT <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, rect.top - POPOVER_HEIGHT - MARGIN)
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - MARGIN))
  return (
    <CommentPopover
      key={mode.editId ?? `${mode.target.messageId}:${mode.target.start}`}
      quote={mode.target.quote}
      initial={mode.initial}
      editing={!!mode.editId}
      style={{ top, left, width: POPOVER_WIDTH }}
      onCancel={close}
      onDelete={() => {
        if (mode.editId) useAnnotationsStore.getState().remove(sessionId, mode.editId)
        close()
      }}
      onSave={(comment) => {
        const store = useAnnotationsStore.getState()
        if (mode.editId) {
          store.update(sessionId, mode.editId, comment)
        } else {
          const { range: _range, ...target } = mode.target
          store.add(sessionId, {
            ...target,
            id: newMessageId(),
            comment,
            order: messagesRef.current.findIndex((m) => m.id === target.messageId)
          })
        }
        close()
      }}
    />
  )
}

function CommentPopover({
  quote,
  initial,
  editing,
  style,
  onSave,
  onCancel,
  onDelete
}: {
  quote: string
  initial: string
  editing: boolean
  style: React.CSSProperties
  onSave: (comment: string) => void
  onCancel: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // A click elsewhere closes it only while nothing has been written — a stray
  // click should not cost a comment.
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (box.current?.contains(e.target as Node)) return
      if ((area.current?.value ?? '') === initial) onCancel()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [initial, onCancel])

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={editing ? 'Edit annotation' : 'Add annotation'}
      className="fixed z-50 flex flex-col gap-2 rounded-at-12 border bg-popover p-3 text-[12.5px] text-popover-foreground shadow-panel"
      style={style}
    >
      <div className="flex gap-2">
        <span className="w-0.5 shrink-0 rounded-full bg-info" />
        <p className="line-clamp-2 min-w-0 text-muted-foreground">{quote}</p>
      </div>
      <textarea
        ref={area}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onSave(text.trim())
          }
        }}
        placeholder="Add a comment (optional)…"
        className="min-h-17 resize-none rounded-at-8 border bg-background p-2 text-[12.5px] leading-[1.5] outline-none focus-visible:border-border-strong"
      />
      <div className="flex items-center gap-2">
        {editing ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete annotation"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
            {formatChord('enter')} add · {formatChord('shift+enter')} new line
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="outline" className="h-7 rounded-at-8 px-3 text-[12.5px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 rounded-at-8 bg-foreground px-3 text-[12.5px] font-[550] text-background hover:bg-foreground/85"
          onClick={() => onSave(text.trim())}
        >
          {editing ? 'Save' : 'Add'}
        </Button>
      </div>
    </div>
  )
}
