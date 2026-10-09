import React, { useMemo } from 'react'
import { previewColors, type Theme } from '../../lib/themes'

/**
 * A miniature Nyra window in a theme's own colours: the workspace rail, the
 * sidebar, the conversation with your message in it, and the composer.
 *
 * Drawn from the resolved colours rather than a screenshot, so a theme you are
 * editing is thumbnailed as it stands and a theme file you just imported has
 * one without ever having been opened.
 */
export function ThemeThumb({ theme, className = 'h-[92px]' }: { theme: Theme; className?: string }): React.JSX.Element {
  const c = useMemo(() => previewColors(theme), [theme])
  return (
    <div
      aria-hidden
      className={`flex w-full overflow-hidden rounded-md border border-border ${className}`}
    >
      <div className="flex w-3.5 shrink-0 flex-col items-center gap-1 py-1.5" style={{ background: c.rail }}>
        <span className="size-[7px] rounded-[2px]" style={{ background: c.accent }} />
        <span className="size-[7px] rounded-[2px] opacity-50" style={{ background: c.muted }} />
      </div>
      <div className="flex w-[28%] shrink-0 flex-col gap-[5px] px-1.5 py-2" style={{ background: c.sidebar }}>
        <span className="h-[3px] w-3/5 rounded-full opacity-70" style={{ background: c.muted }} />
        <span className="h-1.5 w-full rounded-[2px] opacity-25" style={{ background: c.muted }} />
        <span className="h-[3px] w-3/4 rounded-full opacity-70" style={{ background: c.muted }} />
        <span className="h-[3px] w-1/2 rounded-full opacity-70" style={{ background: c.muted }} />
      </div>
      <div className="flex min-w-0 grow flex-col gap-[5px] px-2 py-2" style={{ background: c.background }}>
        <span className="h-[3px] w-4/5 rounded-full" style={{ background: c.text }} />
        <span className="h-[3px] w-3/5 rounded-full" style={{ background: c.muted }} />
        <span className="h-3 w-[48%] self-end rounded-[4px]" style={{ background: c.bubble }} />
        <span className="h-[3px] w-[70%] rounded-full" style={{ background: c.muted }} />
        <span className="grow" />
        <span
          className="flex h-[13px] items-center justify-end rounded-[4px] border px-[3px]"
          style={{ background: c.composer, borderColor: c.border }}
        >
          <span className="size-[7px] rounded-full" style={{ background: c.accent }} />
        </span>
      </div>
    </div>
  )
}

/** Five stripes of a theme, for a list row too small for a thumbnail. */
export function SwatchStrip({ theme }: { theme: Theme }): React.JSX.Element {
  const c = useMemo(() => previewColors(theme), [theme])
  return (
    <span aria-hidden className="flex h-5 w-10 shrink-0 overflow-hidden rounded-sm border border-border">
      {[c.sidebar, c.background, c.bubble, c.text, c.accent].map((color, i) => (
        <span key={i} className="grow" style={{ background: color }} />
      ))}
    </span>
  )
}
