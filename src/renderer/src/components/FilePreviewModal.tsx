import React, { useState, useEffect, useCallback } from 'react'
import Modal from './Modal'
import { loader, Editor } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { useFilePreviewStore } from '../store/filePreview'
import { useSessionsStore } from '../store/sessions'
import { detectLanguage } from '../utils/diff'
import { useMonacoNyraTheme } from '../hooks/useMonacoNyraTheme'

loader.config({ monaco })

function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('/')) return filePath
  // Strip leading ./ if present
  const cleaned = filePath.startsWith('./') ? filePath.slice(2) : filePath
  return `${cwd.replace(/\/$/, '')}/${cleaned}`
}

export default function FilePreviewModal(): React.JSX.Element | null {
  const filePath = useFilePreviewStore((s) => s.filePath)
  const close = useFilePreviewStore((s) => s.close)
  const { defined: themeDefined, theme } = useMonacoNyraTheme()

  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Resolve relative paths against active session CWD
  const cwd = useSessionsStore((s) => {
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId)
    return session?.cwd ?? ''
  })

  const resolvedPath = filePath ? resolvePath(filePath, cwd) : null
  const fileName = resolvedPath?.split('/').pop() ?? ''
  const language = resolvedPath ? detectLanguage(resolvedPath) : 'plaintext'

  useEffect(() => {
    if (!resolvedPath) {
      setContent(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    setContent(null)
    window.api.fs
      .readFile(resolvedPath)
      .then((res) => {
        if (res.error) setError(res.error)
        else setContent(res.content ?? '')
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [resolvedPath])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    },
    [close]
  )

  useEffect(() => {
    if (filePath) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [filePath, handleKeyDown])

  if (!filePath) return null

  return (
    <Modal
      onClose={close}
      title="File preview"
      className="w-[90vw] max-w-5xl flex flex-col max-h-none h-[75vh]"
    >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/40 border-b border-border/55 shrink-0">
          <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
          <span className="text-xs text-muted-foreground/70 truncate ml-1">{resolvedPath}</span>
          <button
            onClick={close}
            className="ml-auto text-muted-foreground hover:text-foreground/80 transition-colors text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0">
          {loading && (
            <div className="flex items-center justify-center h-full text-muted-foreground/70 text-sm">
              Loading...
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-danger/60 text-sm px-8 text-center">
              {error}
            </div>
          )}
          {content !== null && !loading && !error && themeDefined && (
            <Editor
              value={content}
              language={language}
              theme={theme}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 13,
                lineNumbers: 'on',
                folding: true,
                glyphMargin: false,
                lineDecorationsWidth: 0,
                lineNumbersMinChars: 4,
                overviewRulerBorder: false,
                scrollbar: {
                  vertical: 'auto',
                  horizontal: 'auto',
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6
                }
              }}
            />
          )}
        </div>
    </Modal>
  )
}
