import React from 'react'
import { loader, DiffEditor } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { detectLanguage } from '../utils/diff'
import { useMonacoNyraTheme } from '../hooks/useMonacoNyraTheme'

// Use local monaco-editor instead of CDN — the app's CSP blocks remote scripts.
loader.config({ monaco })

// Disable Monaco's built-in workers (we only use it for diffs, not editing)
// This prevents the "ts.worker.js does not exist" warning from Vite
self.MonacoEnvironment = {
  getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' })))
}

export type DiffViewerProps = {
  filePath: string
  original: string
  modified: string
  height?: number
  renderSideBySide?: boolean
}

export default function DiffViewer({
  filePath,
  original,
  modified,
  height = 360,
  renderSideBySide = true
}: DiffViewerProps): React.JSX.Element {
  const { defined: themeDefined, theme } = useMonacoNyraTheme({ withDiff: true })
  const language = detectLanguage(filePath)
  const fileName = filePath.split('/').pop() ?? filePath

  return (
    <div className="rounded-lg overflow-hidden border border-border/55">
      {/* File path header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border/55">
        <span className="text-[10px] font-mono text-muted-foreground truncate">{fileName}</span>
        <span className="text-[10px] text-muted-foreground/70 truncate ml-auto">{filePath}</span>
      </div>

      {/* Monaco DiffEditor */}
      <div style={{ height }}>
        {themeDefined ? (
          <DiffEditor
            original={original}
            modified={modified}
            language={language}
            theme={theme}
            options={{
              readOnly: true,
              renderSideBySide,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbers: 'on',
              folding: false,
              glyphMargin: false,
              lineDecorationsWidth: 0,
              lineNumbersMinChars: 3,
              renderOverviewRuler: false,
              overviewRulerBorder: false,
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 4,
                horizontalScrollbarSize: 4
              }
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground/70 text-xs">
            Loading diff...
          </div>
        )}
      </div>
    </div>
  )
}
