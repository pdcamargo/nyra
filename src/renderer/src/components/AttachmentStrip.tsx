import React from 'react'
import { FileText, Loader2, X } from 'lucide-react'
import type { FileAttachment, ImageAttachment } from '../store/sessions'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** An attachment still being read, so the strip is never empty while you wait. */
export type PendingAttachment = { id: string; name: string }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Extension as a short badge — the one bit of a filename worth reading first. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE'
}

/**
 * Only formats that carry a real risk of being huge or slow get a colour. Tinting
 * every badge the same red says "problem" about a 2 KB text file.
 */
function badgeTone(ext: string): string {
  if (ext === 'PDF') return 'bg-danger/15 text-danger'
  if (['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG'].includes(ext)) return 'bg-info/15 text-info'
  if (['CSV', 'XLSX', 'XLS'].includes(ext)) return 'bg-success/15 text-success'
  return 'bg-accent text-muted-foreground'
}

function Tile({
  children,
  onRemove,
  removeLabel
}: {
  children: React.ReactNode
  onRemove?: () => void
  removeLabel?: string
}): React.JSX.Element {
  return (
    <div className="group/tile relative size-24 shrink-0 overflow-hidden rounded-lg border border-border bg-background">
      {children}
      {onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRemove}
              aria-label={removeLabel}
              className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/tile:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{removeLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * Staged attachments above the composer.
 *
 * Renders inside the composer box, under the environment chips, so it shares the
 * composer's surface rather than stacking another one above it.
 *
 * Tiles rather than chips: an image you are about to send is worth seeing, and a
 * document tile large enough to hold its own name is worth more than a line of
 * truncated text. Anything still being read gets a tile immediately — reading a
 * few MB takes long enough that without one it looks like nothing happened, and
 * the obvious response to that is to attach the file again.
 */
export default function AttachmentStrip({
  images,
  files,
  pending,
  onRemoveImage,
  onRemoveFile
}: {
  images: ImageAttachment[]
  files: FileAttachment[]
  pending: PendingAttachment[]
  onRemoveImage: (index: number) => void
  onRemoveFile: (id: string) => void
}): React.JSX.Element | null {
  if (images.length === 0 && files.length === 0 && pending.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 pb-2">
      {images.map((img, i) => (
        <Tile key={`img-${i}`} onRemove={() => onRemoveImage(i)} removeLabel="Remove image">
          <img src={img.dataUrl} alt="" className="size-full object-cover" />
        </Tile>
      ))}

      {files.map((file) => (
        <Tile key={file.id} onRemove={() => onRemoveFile(file.id)} removeLabel={`Remove ${file.name}`}>
          {file.dataUrl ? (
            <img src={file.dataUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full flex-col">
              <div className="flex flex-1 flex-col items-center justify-center gap-1">
                <FileText className="size-7 text-muted-foreground" />
                <span className="text-[9px] text-muted-foreground">{formatSize(file.size)}</span>
              </div>
              <div className="flex items-center gap-1 border-t border-border bg-card/50 px-1.5 py-1">
                <span
                  className={`shrink-0 rounded-sm px-1 text-[9px] font-semibold ${badgeTone(extensionOf(file.name))}`}
                >
                  {extensionOf(file.name)}
                </span>
                <span className="min-w-0 truncate text-[10px] text-foreground/80" title={file.name}>
                  {file.name}
                </span>
              </div>
            </div>
          )}
        </Tile>
      ))}

      {pending.map((p) => (
        <Tile key={p.id}>
          <div className="flex size-full flex-col items-center justify-center gap-1.5 px-2">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="w-full truncate text-center text-[10px] text-muted-foreground" title={p.name}>
              {p.name}
            </span>
          </div>
        </Tile>
      ))}
    </div>
  )
}
