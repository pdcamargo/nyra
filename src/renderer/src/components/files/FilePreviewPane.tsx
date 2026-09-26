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
import { isImagePath, isMarkdownPath } from './media'
import type { ReadImageResult, ReadTextOutcome } from '../../lib/api-types'

const MonacoPreview = React.lazy(() => import('./MonacoPreview'))
const MarkdownPreview = React.lazy(() => import('./MarkdownPreview'))

/** What came back for a path: text, or the bytes of a picture. The path rides
 *  along because the pane keeps showing the last file until the next one is
 *  read, and the viewer has to know which file it is actually holding. */
type Loaded = { path: string } & (
  | { kind: 'text'; outcome: ReadTextOutcome }
  | { kind: 'image'; result: ReadImageResult }
)

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function FilePreviewPane({
  path,
  wrap
}: {
  path: string | null
  /** Soft-wrap the text viewer. Shared with the diff, so a panel that wraps
   *  diffs wraps files too rather than making the reader set it twice. */
  wrap: boolean
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const stamp = useFileStamp(path)
  const image = path !== null && isImagePath(path)

  useEffect(() => {
    if (!path) {
      setLoaded(null)
      return
    }
    let cancelled = false
    setLoading(true)
    // A picture is read as bytes, not as text: `readTextFile` answers "binary"
    // for every one of them, and showing a placeholder for a screenshot the
    // agent just took is the one thing the preview should never do.
    const read: Promise<Loaded> = image
      ? window.api.fs.readImage(path).then((result) => ({ path, kind: 'image', result }))
      : window.api.fs.readTextFile(path).then((outcome) => ({ path, kind: 'text', outcome }))
    void read
      .then((next) => {
        if (cancelled) return
        setLoaded(next)
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setLoaded({ path, kind: 'text', outcome: { kind: 'error', message: err.message } })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `stamp` is the whole point: it changes when the file does, and re-reading
    // is how the preview follows an edit made outside Nyra.
  }, [path, stamp, image])

  if (!path) {
    return (
      <Empty>
        <FileText className="mb-3 size-6 text-muted-foreground" />
        <p className="mb-1 text-[12px] text-foreground">Open file</p>
        <p className="max-w-[240px] text-[11px] leading-relaxed text-muted-foreground">
          Select a file from the workspace tree.
        </p>
      </Empty>
    )
  }

  if (!loaded) return <Empty>{loading ? 'Reading…' : ''}</Empty>

  if (loaded.kind === 'image') {
    const { base64, mediaType, error, missing } = loaded.result
    if (!base64 || !mediaType) {
      // What Rust refuses — SVG, or a raster the allowlist has not been widened
      // to — says so where the picture would have been. A missing file says
      // that instead, because it is the one the reader can do something about.
      return <Empty>{missing ? 'This file no longer exists.' : (error ?? 'Not an image.')}</Empty>
    }
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/20 p-3">
        <img
          src={`data:${mediaType};base64,${base64}`}
          alt={path ?? ''}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  const outcome = loaded.outcome
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
              {/* Keyed on the file the content came from: a different file
                  starts at the top instead of wherever the last one was left,
                  while the same file re-read after an edit keeps its place. */}
              {isMarkdownPath(loaded.path) ? (
                <MarkdownPreview key={loaded.path} value={outcome.content} wrap={wrap} />
              ) : (
                <MonacoPreview
                  key={loaded.path}
                  value={outcome.content}
                  language={detectLanguage(loaded.path)}
                  wrap={wrap}
                />
              )}
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
