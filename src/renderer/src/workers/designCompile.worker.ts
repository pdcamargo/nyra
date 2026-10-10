/**
 * Compiles design documents off the main thread. All the logic is in
 * `compileAndDraw`; this file only carries messages, so the worker and the
 * main-thread fallback can never disagree.
 */
import { compileAndDraw, type SystemCompileContext } from '../lib/designCompile'

// Typed narrowly rather than through the `webworker` lib, which collides with
// the DOM lib the rest of the renderer is compiled against.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; text: string; sys?: SystemCompileContext }>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (e) => {
  const { id, text, sys } = e.data
  scope.postMessage({ id, ...compileAndDraw(text, sys) })
}
