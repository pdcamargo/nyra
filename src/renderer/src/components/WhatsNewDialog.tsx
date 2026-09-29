import React, { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import Modal from './Modal'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { RELEASE_NOTES } from '../data/releaseNotes'
import { whatsNew, type WhatsNew } from '../lib/whatsNew'
import { useUpdatesStore } from '../store/updates'
import { useSettingsStore } from '../store/settings'

/**
 * "What's new", once, on the first launch after the version changed.
 *
 * The version is recorded as soon as the dialog is decided on rather than when
 * it is closed, so a crash or a quit with it open does not bring it back every
 * launch. Skipped releases are listed together, newest first, each under its
 * own version.
 */
export default function WhatsNewDialog(): React.JSX.Element | null {
  const [shown, setShown] = useState<(WhatsNew & { current: string }) | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.updates
      .version()
      .then((current) => {
        if (cancelled || !current) return
        const { lastSeenVersion, setLastSeenVersion } = useUpdatesStore.getState()
        const existingInstall = useSettingsStore.getState().onboardingComplete
        const result = whatsNew(RELEASE_NOTES, current, lastSeenVersion, existingInstall)
        setLastSeenVersion(current)
        if (result) setShown({ ...result, current })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!shown) return null
  const close = (): void => setShown(null)
  const many = shown.releases.length > 1

  return (
    <Modal
      onClose={close}
      title={`What's new in Nyra ${shown.current}`}
      // The × is the first tabbable thing, and focusing it on open raises its
      // tooltip over a dialog nobody has touched yet.
      focusContentOnOpen
      className="flex max-h-[80vh] max-w-[440px] flex-col rounded-xl p-0"
    >
      <div className="relative flex shrink-0 flex-col gap-2 bg-linear-to-b from-info/12 to-transparent px-6 pt-6 pb-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute top-4 right-4 flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
        <span className="flex size-7 items-center justify-center rounded-md bg-info/12 text-info">
          <Sparkles className="size-[15px]" />
        </span>
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {shown.from ? `Updated from ${shown.from}` : 'Updated'}
          {many && ` · ${shown.releases.length} releases`}
        </p>
        <h2 className="text-sm font-semibold text-foreground">
          What&apos;s new in Nyra {shown.current}
        </h2>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pt-2 pb-6">
        {shown.releases.map((release) => (
          <section key={release.version} className="space-y-2">
            {many && (
              <p className="flex items-baseline gap-2 font-mono">
                <span className="text-xs text-foreground">{release.version}</span>
                <span className="text-[10px] text-muted-foreground">{release.date}</span>
              </p>
            )}
            <ul className="space-y-2.5">
              {release.notes.map((note, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs leading-relaxed text-foreground"
                >
                  <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-muted-foreground" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border bg-muted/50 px-6 py-3">
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => {
            close()
            window.dispatchEvent(new CustomEvent('nyra:open-release-notes'))
          }}
        >
          All release notes
        </Button>
        <Button className="bg-info text-info-foreground hover:bg-info/85" onClick={close}>
          Got it
        </Button>
      </div>
    </Modal>
  )
}
