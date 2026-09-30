import { useEffect } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { cn } from 'cn'
import { useDesignExportStore } from '../../store/designExport'
import { openDesignInPanel } from '../../lib/openFile'

/** How long a clean "saved" notice stays. One with a problem stays until dismissed. */
const DONE_MS = 8000

const size = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * What a PDF export is doing, bottom-right.
 *
 * The same corner and card as the update notice: an export is a file landing
 * on disk, which is news about the machine rather than about the conversation,
 * so it does not belong in the chat column.
 */
export default function DesignExportToast(): React.JSX.Element | null {
  const phase = useDesignExportStore((s) => s.phase)
  const dismiss = useDesignExportStore((s) => s.dismiss)

  const clean = phase.kind === 'done' && phase.missing.length === 0
  useEffect(() => {
    if (!clean) return
    const id = setTimeout(dismiss, DONE_MS)
    return () => clearTimeout(id)
  }, [clean, phase, dismiss])

  if (phase.kind === 'idle') return null

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-40 flex w-[340px] flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-panel data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2"
      data-open=""
    >
      {phase.kind === 'exporting' && (
        <Top
          icon={<LoaderCircle className="animate-spin" />}
          tone="info"
          title={`Exporting ${phase.file}…`}
          detail={`${phase.pages} page${phase.pages === 1 ? '' : 's'}`}
        />
      )}

      {phase.kind === 'error' && (
        <Top
          icon={<CircleAlert />}
          tone="danger"
          title={`Couldn't export ${phase.file}`}
          detail={phase.message}
          onClose={dismiss}
        />
      )}

      {phase.kind === 'done' && (
        <>
          <Top
            icon={phase.missing.length > 0 ? <TriangleAlert /> : <CircleCheck />}
            tone={phase.missing.length > 0 ? 'warning' : 'success'}
            title={
              phase.missing.length > 0
                ? `${phase.file} saved, with ${phase.missing.length} missing image${phase.missing.length === 1 ? '' : 's'}`
                : `${phase.file} saved`
            }
            detail={
              phase.missing.length > 0 ? (
                <>
                  Page {phase.missing[0].page + 1} ·{' '}
                  <span className="font-mono">{phase.missing[0].src}</span> couldn&apos;t be loaded
                  {phase.missing.length > 1 && `, and ${phase.missing.length - 1} more`}
                </>
              ) : (
                `${phase.pages} page${phase.pages === 1 ? '' : 's'} · ${size(phase.bytes)}`
              )
            }
            onClose={dismiss}
          />
          <div className="flex gap-3 pl-10 text-[11px] font-medium">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                void window.api.fs.openWith(phase.path, null)
                dismiss()
              }}
            >
              {phase.missing.length > 0 ? 'Open anyway' : 'Open'}
            </button>
            {phase.missing.length > 0 ? (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  void openDesignInPanel(`${phase.designPath}#${phase.missing[0].id}`)
                  dismiss()
                }}
              >
                Go to artboard
              </button>
            ) : (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => void window.api.fs.reveal(phase.path)}
              >
                Show in folder
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const TONES = {
  info: 'bg-info/12 text-info',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger'
} as const

function Top({
  icon,
  tone,
  title,
  detail,
  onClose
}: {
  icon: React.ReactNode
  tone: keyof typeof TONES
  title: string
  detail: React.ReactNode
  onClose?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-[15px]',
          TONES[tone]
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
