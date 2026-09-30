import { create } from 'zustand'
import { pdfRequest, type ResolvedArtboard, type Theme } from '@nyra/design'
import { pdfFileName } from '../components/design/pageOrder'

export type MissingImage = { page: number; id: string; src: string }

export type DesignExportPhase =
  | { kind: 'idle' }
  | { kind: 'exporting'; file: string; pages: number }
  | {
      kind: 'done'
      path: string
      file: string
      pages: number
      bytes: number
      missing: MissingImage[]
      /** The design it came from, so "Go to artboard" knows where to go. */
      designPath: string
    }
  | { kind: 'error'; file: string; message: string }

type DesignExportState = {
  phase: DesignExportPhase
  dismiss: () => void
  exportPdf: (args: {
    artboards: ResolvedArtboard[]
    theme: Theme
    designName: string
    designPath: string
    openWhenDone: boolean
  }) => Promise<'cancelled' | 'done' | 'failed'>
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const dirName = (path: string): string | null => {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at > 0 ? path.slice(0, at) : null
}

/**
 * One export at a time, app-wide.
 *
 * Not per chat: the notice is about a file on your disk, which does not belong
 * to a conversation, and two exports racing into one notice would be the only
 * way to get the counts wrong.
 */
export const useDesignExportStore = create<DesignExportState>((set, get) => ({
  phase: { kind: 'idle' },
  dismiss: () => set({ phase: { kind: 'idle' } }),

  exportPdf: async ({ artboards, theme, designName, designPath, openWhenDone }) => {
    if (get().phase.kind === 'exporting' || artboards.length === 0) return 'failed'

    // Asked before rendering: a cancelled dialog should cost nothing, and the
    // progress notice should only ever describe real work.
    const out = await window.api.design.pickPdfPath(pdfFileName(designName))
    if (!out) return 'cancelled'
    const file = baseName(out)

    set({ phase: { kind: 'exporting', file, pages: artboards.length } })
    const request = pdfRequest(artboards, theme)
    const result = await window.api.design.pdf({
      html: request.html,
      pages: request.pages,
      out,
      baseDir: dirName(designPath)
    })

    if (!result.ok || !result.path) {
      set({ phase: { kind: 'error', file, message: result.error ?? 'The export failed.' } })
      return 'failed'
    }

    const missing = result.missing ?? []
    set({
      phase: {
        kind: 'done',
        path: result.path,
        file,
        pages: result.pages ?? artboards.length,
        bytes: result.bytes ?? 0,
        missing,
        designPath
      }
    })
    // Not with missing images: opening it would show you the gap before the
    // notice has told you why. "Open anyway" is one click away.
    if (openWhenDone && missing.length === 0) {
      void window.api.fs.openWith(result.path, null)
    }
    return 'done'
  }
}))
