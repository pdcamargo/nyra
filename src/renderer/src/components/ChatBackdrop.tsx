import React from 'react'
import { useSettingsStore } from '../store/settings'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import { resolveLook, useBackgroundUrl } from '../lib/chatBackground'
import type { BackgroundEffect, BackgroundLook } from '../../../shared/types'

export type ResolvedBackdrop = NonNullable<ReturnType<typeof resolveLook>>

/** The background for this chat right now, or null when it should be plain. */
export function useChatBackdrop(isNewChat: boolean): ResolvedBackdrop | null {
  const bg = useSettingsStore((s) => s.chatBackground)
  const mode = useResolvedTheme()
  if (bg.scope === 'new' && !isNewChat) return null
  return resolveLook(bg, mode)
}

/**
 * The picture behind the chat column: the image, then a fade into the page
 * colour from the bottom. It sits at `-z-10` inside an `isolate` parent, so it
 * paints above that parent's (absent) background and under everything else
 * without any sibling needing a z-index of its own.
 *
 * The fade ends on `--background`, so it follows whichever theme is on.
 */
export default function ChatBackdrop({
  image,
  effect,
  look,
  focusX,
  focusY,
  fadeTo = 'var(--background)',
  className = ''
}: {
  image: string
  effect: BackgroundEffect
  look: BackgroundLook
  focusX: number
  focusY: number
  /** The page colour to fade into. The settings preview passes the other mode's. */
  fadeTo?: string
  className?: string
}): React.JSX.Element {
  const url = useBackgroundUrl(image, effect)
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`}>
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          style={{
            objectPosition: `${focusX}% ${focusY}%`,
            opacity: look.opacity / 100,
            filter: `brightness(${look.brightness}%)${look.blur > 0 ? ` blur(${look.blur}px)` : ''}`,
            // A blurred edge fades to transparent; growing the image a little
            // keeps that soft edge outside the frame.
            transform: look.blur > 0 ? `scale(${1 + look.blur / 100})` : undefined,
            imageRendering: effect === 'dither' ? 'pixelated' : undefined
          }}
        />
      )}
      {look.fade > 0 && (
        <div
          className="absolute inset-x-0 bottom-0"
          style={{
            height: `${look.fade}%`,
            background: `linear-gradient(to bottom, transparent, ${fadeTo})`
          }}
        />
      )}
    </div>
  )
}
