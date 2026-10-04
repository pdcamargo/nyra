// Monaco ships no types for its internals. This is the one `monacoEnv.ts`
// reaches into, to replace the clipboard service before an editor exists.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: {
    initialize(overrides: Record<string, unknown>): unknown
  }
}
