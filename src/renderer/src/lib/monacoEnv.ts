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

let installed = false

export function installMonacoEnvironment(): void {
  if (installed) return
  installed = true

  // Local monaco rather than the CDN: the app's CSP blocks remote scripts.
  loader.config({ monaco })

  self.MonacoEnvironment = {
    getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })))
  }
}
