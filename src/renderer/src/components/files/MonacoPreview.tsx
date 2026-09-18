/**
 * Monaco, read-only, as a file viewer.
 *
 * The panel is not an IDE, and this is not one: `DiffViewer` stubs Monaco's
 * workers globally with a blank blob, so there is no language service anywhere
 * in the app — no linting, no validation, no rename, no go-to-definition. What
 * is left is a tokenizer and a virtualized scroller, which is exactly what
 * reading a file wants and what a 20,000-line file needs.
 *
 * Imported through a lazy boundary because this module pulls the monaco chunk.
 */
import React from 'react'
import { Editor } from '@monaco-editor/react'
import { useMonacoNyraTheme } from '../../hooks/useMonacoNyraTheme'
import { installMonacoEnvironment } from '../../lib/monacoEnv'

installMonacoEnvironment()

export default function MonacoPreview({
  value,
  language
}: {
  value: string
  language: string
}): React.JSX.Element | null {
  const { defined, theme } = useMonacoNyraTheme()
  if (!defined) return null

  return (
    <Editor
      value={value}
      language={language}
      theme={theme}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        lineNumbers: 'on',
        folding: true,
        glyphMargin: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 3,
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        // The panel is narrow and this is a document, not a quoted fragment:
        // wrapping a 200-column line would cost more than scrolling to it.
        wordWrap: 'off',
        stickyScroll: { enabled: false },
        occurrencesHighlight: 'off',
        renderLineHighlight: 'none',
        renderWhitespace: 'none',
        // Ours, not Monaco's — the tree and the preview should agree on what a
        // right-click does.
        contextmenu: false,
        automaticLayout: true,
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6
        }
      }}
    />
  )
}
