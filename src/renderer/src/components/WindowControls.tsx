import React, { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * Minimise, maximise and close, for a window the OS draws no frame around.
 *
 * Only mounted where `platform().windowControls` is `drawn` — Windows, whose
 * window is undecorated (`tauri.windows.conf.json`) so the title bar can be
 * ours. Laid out the way Windows lays its own out: flush right, full bar
 * height, 46px each, and a red close so it reads as the one that is final.
 */
function CaptionButton({
  label,
  onClick,
  danger,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={`flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors ${
            danger ? 'hover:bg-[#c42b1c] hover:text-white' : 'hover:bg-accent hover:text-foreground'
          }`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  // Maximising happens outside these buttons too — a double-click on the bar,
  // Win+Up, a snap — so the icon follows the window rather than the click.
  useEffect(() => {
    let live = true
    const sync = (): void => {
      void window.api.appWindow.isMaximized().then((m) => live && setMaximized(m))
    }
    sync()
    const off = window.api.appWindow.onResized(sync)
    return () => {
      live = false
      void off.then((unlisten) => unlisten())
    }
  }, [])

  return (
    <div className="-my-px flex h-[38px] shrink-0 self-stretch" data-testid="window-controls">
      <CaptionButton label="Minimize" onClick={() => void window.api.appWindow.minimize()}>
        <Minus className="size-4" />
      </CaptionButton>
      <CaptionButton
        label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.api.appWindow.toggleMaximize()}
      >
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </CaptionButton>
      <CaptionButton label="Close" danger onClick={() => void window.api.appWindow.close()}>
        <X className="size-4" />
      </CaptionButton>
    </div>
  )
}
