import { useEffect, useRef, useState } from 'react'
import { MessageCirclePlus, MessageSquareText } from 'lucide-react'
import { Button } from '../../ui/button'
import { composerKeys } from '../../../lib/designComments'
import { DESIGN_PRIMARY } from '../designAccent'

const WIDTH = 320
const HEIGHT = 170

/**
 * The small box a right-click opens: feedback on the artboard, or a comment
 * pinned to an element.
 *
 * Right where you clicked, kept inside the window. Enter sends straight to
 * the chat; Escape throws it away, and nothing is pinned until you send. A
 * click elsewhere closes it only while it is empty — a stray click should not
 * cost a paragraph.
 */
export default function CommentComposer({
  kind,
  target,
  at,
  onSend,
  onCancel
}: {
  kind: 'feedback' | 'comment'
  /** What it is about: an artboard's name, or `Grant access · Permissions`. */
  target: string
  /** Where the right-click was, in window pixels. */
  at: { x: number; y: number }
  onSend: (text: string) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)

  // After the menu has let go of focus, not during: it hands focus back as it
  // closes, and an earlier focus here is taken straight away.
  useEffect(() => {
    const t = setTimeout(() => area.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (box.current?.contains(e.target as Node)) return
      if (area.current?.value.trim() === '') onCancel()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onCancel])

  const send = async (): Promise<void> => {
    const words = text.trim()
    if (!words || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSend(words)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const left = Math.max(8, Math.min(at.x + 12, window.innerWidth - WIDTH - 8))
  const top = Math.max(8, Math.min(at.y - 8, window.innerHeight - HEIGHT - 8))
  const Icon = kind === 'feedback' ? MessageSquareText : MessageCirclePlus

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={kind === 'feedback' ? 'Feedback on this design' : 'Comment'}
      className="fixed z-50 flex flex-col gap-2 rounded-[12px] border bg-popover p-3 text-[12.5px] text-popover-foreground shadow-panel"
      style={{ left, top, width: WIDTH }}
    >
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Icon className="size-[13px] shrink-0 text-design-accent" />
        <span className="truncate">
          {kind === 'feedback' ? 'Feedback on' : 'Comment on'}{' '}
          <span className="font-semibold text-foreground">{target}</span>
        </span>
      </div>
      <textarea
        ref={area}
        value={text}
        rows={3}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder={kind === 'feedback' ? 'What should change?' : 'What about this?'}
        className="min-h-17 resize-none rounded-[8px] border bg-background p-2 text-[12.5px] leading-[1.5] outline-none focus-visible:border-design-accent focus-visible:ring-1 focus-visible:ring-design-accent"
      />
      {error && <p className="text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-muted-foreground">{composerKeys()}</span>
        <Button
          size="sm"
          className={`h-7 rounded-[8px] px-3 text-[12.5px] font-[550] ${DESIGN_PRIMARY}`}
          disabled={!text.trim() || busy}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </div>
  )
}
