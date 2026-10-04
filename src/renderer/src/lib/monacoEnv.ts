/**
 * Monaco's worker stub.
 *
 * This lived in `DiffViewer.tsx` and everything else that loads Monaco depended
 * on it without saying so — `MonacoPreview`'s own header notes that "DiffViewer
 * stubs Monaco's workers globally". When the diff viewer moved to
 * `@git-diff-view`, deleting that file would have quietly taken the stub with it
 * and let the file preview spawn real language workers.
 *
 * So it is its own module now, imported by every entry point that pulls Monaco.
 * The blank blob is the point: the panel is a viewer, not an IDE, so there is no
 * language service anywhere in the app — no linting, no validation, no
 * go-to-definition — and stubbing the worker is also what silences Vite's
 * "ts.worker.js does not exist" warning.
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'

let installed = false

export function installMonacoEnvironment(): void {
  if (installed) return
  installed = true

  // Local monaco rather than the CDN: the app's CSP blocks remote scripts.
  loader.config({ monaco })

  self.MonacoEnvironment = {
    getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })))
  }

  // Before anything asks Monaco for a service: once its stock clipboard
  // service exists, the override is ignored.
  StandaloneServices.initialize({ clipboardService: plainClipboard() })
}

/**
 * Monaco's clipboard service, minus its WebKit workaround.
 *
 * The stock service, in a WebKit view, starts a `clipboard.write` on every
 * click and keydown in `document.body` — the whole app, not just the editor —
 * and leaves it pending until the next one. WebKit allows one write at a time,
 * so every other copy in Nyra was refused while Monaco held the clipboard:
 * Copy as PNG on a design worked or did nothing depending on where the last
 * click landed. The workaround exists for VS Code extensions copying from a
 * worker, which a read-only viewer and a skill editor never do. The editor's
 * own Cmd+C and Cmd+V go through native events and never reach this.
 */
function plainClipboard(): Record<string, unknown> {
  const typed = new Map<string, string>()
  let findText = ''
  return {
    _serviceBrand: undefined,
    triggerPaste: () => undefined,
    readImage: async () => new Uint8Array(),
    writeText: async (text: string, type?: string) => {
      if (type) typed.set(type, text)
      else await navigator.clipboard.writeText(text).catch(() => {})
    },
    readText: async (type?: string) =>
      type ? (typed.get(type) ?? '') : await navigator.clipboard.readText().catch(() => ''),
    readFindText: async () => findText,
    writeFindText: async (text: string) => {
      findText = text
    },
    writeResources: async () => {},
    readResources: async () => [],
    hasResources: async () => false,
    clearInternalState: () => {}
  }
}
