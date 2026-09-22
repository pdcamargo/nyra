import { create } from 'zustand'

/**
 * Live dictation state: whether the microphone is on, what has been heard so
 * far, and how far a model download has got.
 *
 * Deliberately not persisted, for the same reason `backgroundAgents` is not —
 * every one of these fields describes a process that a reload kills. A
 * restored "downloading, 34%" would never advance and never clear.
 *
 * This is the app's first determinate progress state; the updater, marketplace
 * installs and attachment uploads are all binary-plus-shimmer.
 */
export type DictationPhase = 'idle' | 'recording' | 'transcribing' | 'downloading'

type DictationStore = {
  phase: DictationPhase
  /** Latest RMS, 0–1, for the meter on the mic button. */
  level: number
  /** The running transcript while speaking. Replaced wholesale each pass, and
   *  shown above the composer rather than inside the editor. */
  interim: string
  /** Set when the capture thread has heard nothing but exact silence, which
   *  means the microphone is refused, muted, or the wrong one. Holds the
   *  device name so the message can say which. */
  silentDevice: string | null
  /** Bytes fetched and total, while a model download runs. */
  received: number
  total: number
  /** Which model the download is for, so a stale event cannot move the bar. */
  downloadingModel: string | null
  error: string | null

  startRecording: () => void
  setLevel: (level: number) => void
  setInterim: (interim: string) => void
  setSilent: (device: string) => void
  setTranscribing: () => void
  reset: () => void
  setError: (error: string | null) => void
  startDownload: (model: string) => void
  setProgress: (model: string, received: number, total: number) => void
  endDownload: () => void
}

const IDLE = {
  phase: 'idle' as DictationPhase,
  level: 0,
  interim: '',
  silentDevice: null as string | null,
  received: 0,
  total: 0,
  downloadingModel: null
}

export const useDictationStore = create<DictationStore>((set) => ({
  ...IDLE,
  error: null,

  startRecording: () => set({ ...IDLE, phase: 'recording', error: null }),
  setLevel: (level) => set({ level }),
  setInterim: (interim) => set({ interim }),
  // Only while recording: a late event must not relabel an idle button.
  setSilent: (device) =>
    set((s) => (s.phase === 'recording' ? { silentDevice: device } : s)),
  setTranscribing: () => set({ phase: 'transcribing', level: 0 }),
  reset: () => set({ ...IDLE }),
  setError: (error) => set({ error, phase: 'idle', level: 0, interim: '' }),

  startDownload: (model) =>
    set({ ...IDLE, phase: 'downloading', downloadingModel: model, error: null }),

  // Guarded on the model id: a cancelled download's last in-flight event must
  // not restart the bar for a different one.
  setProgress: (model, received, total) =>
    set((s) =>
      s.phase === 'downloading' && s.downloadingModel === model ? { received, total } : s
    ),

  endDownload: () => set((s) => (s.phase === 'downloading' ? { ...IDLE } : s))
}))

/** 0–1, or 0 when nothing is downloading. */
export function downloadFraction(received: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, received / total))
}

/** "142 MB of 547 MB" — the detail line in the popover. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}
