import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useThemeStore, type ThemeEdit } from '../../store/themes'
import { TOKENS, type ColorKey } from '../../lib/themes'
import { Key } from './Key'

/**
 * Two things that float over the window while the editor is open: the pill that
 * says the window is a preview, and — in pick mode — the outline that follows
 * the pointer and names the colour under it.
 *
 * Surfaces opt in with `data-theme-token="<key>"`; the nearest one under the
 * pointer wins, so a click on a chat row in the sidebar picks the sidebar.
 * Clicks are swallowed while picking, so nothing in the app fires: picking the
 * send button's surface should not send.
 */
export function PickOverlay({ edit, island }: { edit: ThemeEdit; island: React.CSSProperties }): React.JSX.Element {
  const [target, setTarget] = useState<{ key: ColorKey; rect: DOMRect } | null>(null)

  useEffect(() => {
    if (!edit.picking) {
      setTarget(null)
      return
    }
    document.documentElement.classList.add('nyra-picking')
    const find = (t: EventTarget | null): { key: ColorKey; el: Element } | null => {
      if (!(t instanceof Element) || t.closest('[data-theme-editor]')) return null
      const el = t.closest('[data-theme-token]')
      const key = el?.getAttribute('data-theme-token') as ColorKey | null
      return el && key && TOKENS.some((tk) => tk.key === key) ? { key, el } : null
    }
    const move = (e: PointerEvent): void => {
      const hit = find(e.target)
      setTarget(hit ? { key: hit.key, rect: hit.el.getBoundingClientRect() } : null)
    }
    const swallow = (e: Event): void => {
      if (e.target instanceof Element && e.target.closest('[data-theme-editor]')) return
      e.preventDefault()
      e.stopPropagation()
    }
    const click = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('[data-theme-editor]')) return
      e.preventDefault()
      e.stopPropagation()
      const hit = find(e.target)
      if (hit) useThemeStore.getState().select(hit.key)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerdown', swallow, true)
    window.addEventListener('mousedown', swallow, true)
    window.addEventListener('mouseup', swallow, true)
    window.addEventListener('click', click, true)
    return () => {
      document.documentElement.classList.remove('nyra-picking')
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerdown', swallow, true)
      window.removeEventListener('mousedown', swallow, true)
      window.removeEventListener('mouseup', swallow, true)
      window.removeEventListener('click', click, true)
    }
  }, [edit.picking])

  const label = target && TOKENS.find((t) => t.key === target.key)?.label

  return createPortal(
    <>
      <div
        style={island}
        className="nyra-theme-island pointer-events-none fixed top-12 left-1/2 z-[60] -translate-x-1/2"
        role="status"
      >
        <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-popover px-3 py-1.5 text-xs shadow-panel">
          <span className={`size-2 rounded-full ${edit.comparing ? 'bg-info' : 'bg-warning'}`} />
          {edit.picking ? (
            <>
              <span className="font-medium text-foreground">Click any part of Nyra to edit its colour</span>
              <span className="h-3.5 w-px bg-border" />
              <Key>esc</Key>
              <span className="text-muted-foreground">to stop</span>
            </>
          ) : edit.comparing ? (
            <span className="font-medium text-foreground">Showing the theme as it was</span>
          ) : (
            <>
              <span className="font-medium text-foreground">Previewing your edits</span>
              <span className="h-3.5 w-px bg-border" />
              <span className="text-muted-foreground">Hold</span>
              <Key>⌥</Key>
              <span className="text-muted-foreground">to see it as it was</span>
            </>
          )}
        </div>
      </div>
      {target && (
        <div
          style={{ ...island, left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height }}
          className="nyra-theme-island pointer-events-none fixed z-[59] rounded-sm border-2 border-dashed border-info"
        >
          <span className="absolute top-1 left-1 rounded-sm bg-info px-1.5 py-0.5 text-[11px] font-medium text-info-foreground">
            {label} · click to edit
          </span>
        </div>
      )}
    </>,
    document.body
  )
}
