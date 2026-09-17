import React from 'react'
import { cn } from 'cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/**
 * The app's modal shell.
 *
 * Every modal here used to hand-roll `fixed inset-0 z-50` with its own backdrop,
 * its own Escape handler and its own click-outside check — fourteen copies, three
 * different backdrop opacities between them, and no focus trapping anywhere. This
 * is one Dialog underneath, so focus is trapped and returned, Escape works, and
 * the backdrop matches everywhere.
 *
 * `title` is required because it is what a screen reader announces on open. Pass
 * `titleHidden` when the content already shows a heading of its own, which most
 * of these do.
 */
export default function Modal({
  open = true,
  onClose,
  title,
  description,
  titleHidden = true,
  className,
  showCloseButton = false,
  children
}: {
  open?: boolean
  onClose: () => void
  title: string
  description?: string
  titleHidden?: boolean
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={showCloseButton}
        className={cn('max-h-[85vh] gap-0 overflow-hidden', className)}
      >
        <DialogTitle className={titleHidden ? 'sr-only' : undefined}>{title}</DialogTitle>
        {description ? (
          <DialogDescription className="sr-only">{description}</DialogDescription>
        ) : null}
        {children}
      </DialogContent>
    </Dialog>
  )
}
