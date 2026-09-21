import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * A harness for looking at output, and nothing more. Separate from the app's
 * vite config on purpose: no Tailwind, no aliases, no Tauri. The emitted CSS
 * has to be self-contained, and the surest way to know it is is to render it
 * on a page that ships no stylesheet of its own.
 */
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname, '..')] } }
})
