/**
 * The left half of a file tab: one file, read only.
 *
 * Reading is bounded on the Rust side, so everything this has to handle arrives
 * as a named outcome rather than as a string to pattern-match.
 */
import React, { Suspense, useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import Empty from '../workspace/Empty'
import { useFileStamp } from '../../hooks/useFileStamp'
import { detectLanguage } from '../../utils/diff'
import type { ReadTextOutcome } from '../../lib/api-types'

const MonacoPreview = React.lazy(() => import('./MonacoPreview'))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function FilePreviewPane({ path }: { path: string | null }): React.JSX.Element {
  const [outcome, setOutcome] = useState<ReadTextOutcome | null>(null)
  const [loading, setLoading] = useState(false)
  const stamp = useFileStamp(path)

  useEffect(() => {
    if (!path) {
      setOutcome(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.api.fs
      .readTextFile(path)
      .then((next) => {
        if (!cancelled) setOutcome(next)
      })
      .catch((err: Error) => {
        if (!cancelled) setOutcome({ kind: 'error', message: err.message })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `stamp` is the whole point: it changes when the file does, and re-reading
    // is how the preview follows an edit made outside Nyra.
  }, [path, stamp])

  if (!path) {
    return (
      <Empty>
        <FileText className="mb-3 size-6 text-muted-foreground/50" />
        <p className="mb-1 text-[12px] text-foreground">Open file</p>
        <p className="max-w-[240px] text-[11px] leading-relaxed text-muted-foreground">
          Select a file from the workspace tree.
        </p>
      </Empty>
    )
  }

  if (!outcome) return <Empty>{loading ? 'Reading…' : ''}</Empty>

  switch (outcome.kind) {
    case 'binary':
      return <Empty>Binary file ({formatBytes(outcome.size)})</Empty>
    case 'tooLarge':
      return (
        <Empty>
          {formatBytes(outcome.size)} — too large to preview (limit{' '}
          {formatBytes(outcome.limit)})
        </Empty>
      )
    case 'missing':
      return <Empty>This file no longer exists.</Empty>
    case 'notAFile':
      return <Empty>Not a file.</Empty>
    case 'error':
      return <Empty>{outcome.message}</Empty>
    case 'text':
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Suspense fallback={<Empty>Loading viewer…</Empty>}>
              <MonacoPreview value={outcome.content} language={detectLanguage(path)} />
            </Suspense>
          </div>
          {outcome.truncated && (
            <p className="shrink-0 border-t border-border/55 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
              Showing the first {formatBytes(outcome.returnedBytes)} of{' '}
              {formatBytes(outcome.totalBytes)}.
            </p>
          )}
        </div>
      )
  }
}
