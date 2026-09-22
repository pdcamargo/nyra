/**
 * Dictate into the composer.
 *
 * The mic is the only entry point — there is no "set up dictation" screen to
 * find. Clicking it with no model downloaded offers the download; clicking it
 * while a download runs shows the download; clicking it once it is ready
 * starts listening.
 *
 * Audio never reaches this file. Rust captures from the microphone, resamples
 * and transcribes locally, and everything arrives here as `dictation:event`.
 */
import React from 'react'
import { Loader2, Mic, Square, X } from 'lucide-react'
import Modal from './Modal'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useChordLabel } from './ui/kbd'
import { useSettingsStore } from '../store/settings'
import { useSessionsStore } from '../store/sessions'
import { useUiStore } from '../store/ui'
import { useDictationStore, downloadFraction, formatBytes } from '../store/dictation'
import { buildVocabulary } from '../lib/dictationVocabulary'
import type { DictationModel, DictationStatus } from '../lib/tauri-api'

export default function DictationButton({
  tight = false
}: {
  tight?: boolean
}): React.JSX.Element | null {
  const modelId = useSettingsStore((s) => s.dictationModel)
  const language = useSettingsStore((s) => s.dictationLanguage)
  const device = useSettingsStore((s) => s.dictationDevice)
  const liveTranscript = useSettingsStore((s) => s.dictationLiveTranscript)
  const useVocabulary = useSettingsStore((s) => s.dictationVocabulary)
  const phase = useDictationStore((s) => s.phase)
  const level = useDictationStore((s) => s.level)
  const received = useDictationStore((s) => s.received)
  const silentDevice = useDictationStore((s) => s.silentDevice)
  const total = useDictationStore((s) => s.total)

  const [status, setStatus] = React.useState<DictationStatus | null>(null)
  const [askingToDownload, setAskingToDownload] = React.useState(false)
  const keys = useChordLabel('composer.dictate')

  const model: DictationModel | undefined =
    status?.catalogue.find((m) => m.id === modelId) ?? status?.catalogue[0]

  const refreshStatus = React.useCallback(async () => {
    try {
      const bridge = window.api?.dictation
      if (!bridge) return
      const next = await bridge.status(modelId)
      setStatus(next)
      // Rust owns the microphone, so it is the authority on whether one is
      // open. A renderer reload — HMR in dev, a crash or refresh in the app —
      // resets this store while the capture thread keeps running, which would
      // otherwise leave a live microphone with nothing on screen saying so.
      if (next.recording && useDictationStore.getState().phase === 'idle') {
        useDictationStore.getState().startRecording()
      }
    } catch {
      // A failed status read leaves the button offering a download, which is
      // recoverable; throwing here would take the composer down with it.
    }
  }, [modelId])

  React.useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // ---- events ------------------------------------------------------------

  React.useEffect(() => {
    const store = useDictationStore.getState()
    if (!window.api?.dictation) return
    return window.api.dictation.onEvent((event) => {
      switch (event.type) {
        case 'recording_started':
          store.startRecording()
          break
        case 'level':
          store.setLevel(event.level)
          break
        case 'interim':
          store.setInterim(event.text)
          break
        case 'no_signal':
          store.setSilent(event.device)
          break
        case 'transcribing':
          store.setTranscribing()
          break
        case 'transcript':
          store.reset()
          // Lands in the composer as ordinary editable text, appended after
          // whatever is already typed. Empty means nothing was said — the
          // silence guard fired — and must not append a blank.
          if (event.text.trim()) useUiStore.getState().prefillInput(event.text.trim())
          break
        case 'cancelled':
          store.reset()
          break
        case 'error':
          store.setError(event.error)
          break
        case 'model_progress':
          store.setProgress(event.model, event.received, event.total)
          break
        case 'model_ready':
          store.endDownload()
          void refreshStatus()
          break
        case 'model_cancelled':
          store.endDownload()
          void refreshStatus()
          break
        case 'model_failed':
          store.endDownload()
          store.setError(event.error)
          void refreshStatus()
          break
      }
    })
  }, [refreshStatus])

  // ---- actions -----------------------------------------------------------

  const startRecording = React.useCallback(async () => {
    const state = useSessionsStore.getState()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)

    let vocabulary: string[] = []
    if (useVocabulary && session?.cwd) {
      try {
        const files = await window.api.fs.listFiles(session.cwd, '')
        vocabulary = buildVocabulary(files)
      } catch {
        // Biasing is an improvement, not a requirement — dictate unbiased.
      }
    }

    const result = await window.api.dictation.start({
      model: modelId,
      language: language || undefined,
      device: device || undefined,
      vocabulary,
      liveTranscript: liveTranscript
    })
    if (result?.error) useDictationStore.getState().setError(result.error)
  }, [modelId, device, language, liveTranscript, useVocabulary])

  const beginDownload = React.useCallback(() => {
    if (!model) return
    setAskingToDownload(false)
    useDictationStore.getState().startDownload(model.id)
    void window.api.dictation.modelDownload(model.id)
  }, [model])

  const handleClick = React.useCallback(() => {
    if (phase === 'transcribing' || phase === 'downloading') return
    if (phase === 'recording') {
      void window.api.dictation.stop()
      return
    }
    if (!status?.installed) {
      setAskingToDownload(true)
      return
    }
    void startRecording()
  }, [phase, status?.installed, startRecording])

  // The command is unbound by default, so this is usually reached by clicking;
  // it exists so a chord bound in Settings works from inside the editor.
  React.useEffect(() => {
    const toggle = (): void => handleClick()
    window.addEventListener('nyra:dictate-toggle', toggle)
    return () => window.removeEventListener('nyra:dictate-toggle', toggle)
  }, [handleClick])

  // Escape throws the recording away rather than transcribing it.
  React.useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      void window.api.dictation.cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase])

  // ---- render ------------------------------------------------------------

  const downloading = phase === 'downloading'
  const recording = phase === 'recording'
  const transcribing = phase === 'transcribing'
  const fraction = downloadFraction(received, total)

  const label = downloading
    ? `Downloading · ${Math.round(fraction * 100)}%`
    : recording
      ? 'Stop dictating'
      : transcribing
        ? 'Transcribing…'
        : 'Dictate'
  const tooltip = recording
    ? silentDevice
      ? `No sound from ${silentDevice}. Check microphone access in System Settings.`
      : 'Stop dictating'
    : keys && !downloading
      ? `${label} (${keys})`
      : label

  // Recording and transcribing widen into a pill, the same shape PlanModePill
  // uses, so the state is legible without a banner above the composer. Idle
  // and downloading stay a bare icon, because neither is a mode you are in.
  const pill = recording || transcribing
  const button = (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      aria-pressed={recording}
      disabled={transcribing}
      className={`relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md text-xs transition-colors ${
        recording
          ? 'bg-danger/10 text-danger hover:bg-danger/20'
          : transcribing
            ? 'cursor-default bg-accent text-foreground'
            : 'w-7 justify-center text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      } ${pill ? (tight ? 'w-7 justify-center' : 'px-2') : ''}`}
    >
      {transcribing ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Mic className="size-3.5 shrink-0" />
      )}

      {pill && !tight ? (
        <span>{transcribing ? 'Transcribing' : silentDevice ? 'No sound' : 'Listening'}</span>
      ) : null}

      {/* Stop lives inside the pill rather than beside it: one control, one
          click target, and no nested button for a screen reader to trip on. */}
      {recording && !tight ? <Square className="size-2.5 shrink-0 fill-current" /> : null}

      {/* The only honest answer to "is it hearing me?". A microphone that is
          muted, refused, or pointed at the wrong device sits flat at zero. */}
      {recording ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left bg-danger transition-transform duration-75"
          style={{ transform: `scaleX(${Math.min(1, level * 6).toFixed(3)})` }}
        />
      ) : null}

      {downloading ? (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-accent">
          <span
            className="block h-0.5 bg-info transition-all duration-300 ease-out"
            style={{ width: `${(fraction * 100).toFixed(1)}%` }}
          />
        </span>
      ) : null}
    </button>
  )

  return (
    <>
      {downloading ? (
        // Tooltip labels the control; the Popover holds a control of its own.
        // Same composition as PortChips, which is the app's pattern for this.
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{button}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" side="top" className="w-72 p-3">
            <DownloadDetail
              label={model?.label ?? 'Speech model'}
              received={received}
              total={total}
              onCancel={() => void window.api.dictation.modelCancel()}
            />
          </PopoverContent>
        </Popover>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )}

      {askingToDownload && model ? (
        <DownloadPrompt
          model={model}
          tight={tight}
          onCancel={() => setAskingToDownload(false)}
          onConfirm={beginDownload}
        />
      ) : null}
    </>
  )
}

function DownloadDetail({
  label,
  received,
  total,
  onCancel
}: {
  label: string
  received: number
  total: number
  onCancel: () => void
}): React.JSX.Element {
  const fraction = downloadFraction(received, total)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {Math.round(fraction * 100)}%
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-accent">
        <div
          className="h-full rounded-full bg-info transition-[width] duration-300"
          style={{ width: `${(fraction * 100).toFixed(1)}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {formatBytes(received)} of {formatBytes(total)}
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
        Cancel download
      </button>
    </div>
  )
}

function DownloadPrompt({
  model,
  tight,
  onCancel,
  onConfirm
}: {
  model: DictationModel
  tight: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Modal
      onClose={onCancel}
      title="Download the speech model"
      className={tight ? 'max-w-sm p-5' : 'max-w-md p-5'}
    >
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Download the speech model</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Dictation needs the <span className="text-foreground">{model.label}</span> model,{' '}
          <span className="font-mono text-foreground">{formatBytes(model.bytes)}</span>, downloaded
          once into <span className="font-mono">~/.nyra/models</span>.
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Nothing you say leaves this Mac, and dictation costs nothing to use.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-info px-4 py-2 text-sm font-medium text-info-foreground transition-colors hover:bg-info/85"
          >
            Download
          </button>
        </div>
      </div>
    </Modal>
  )
}
