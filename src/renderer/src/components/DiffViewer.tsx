/**
 * Two versions of a file, side by side.
 *
 * Used by the permission dialog and the tool card, where what is on offer is a
 * pair of blobs — `Edit`'s old and new strings, or `Write`'s whole file — rather
 * than a patch. `DiffFile.createInstance` covers exactly that case: given both
 * contents and no hunks, it computes the diff itself.
 *
 * This was Monaco's `DiffEditor`. It moved so the app has one diff renderer
 * rather than two that would drift in colour, font and wrapping — the Changes tab
 * needs to draw real unified patches, which Monaco cannot do at all. Monaco
 * itself stays, as the file preview and the two editors.
 *
 * The props are unchanged so the two call sites did not have to be.
 */
import React from 'react'
import { DiffView, DiffFile, DiffModeEnum } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view.css'
import { detectLanguage } from '../utils/diff'
import { useResolvedTheme } from '../hooks/useResolvedTheme'

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
  const theme = useResolvedTheme()
  const fileName = filePath.split('/').pop() ?? filePath
  const language = detectLanguage(filePath)

  const diffFile = React.useMemo(() => {
    const file = DiffFile.createInstance({
      oldFile: { fileName, fileLang: language, content: original },
      newFile: { fileName, fileLang: language, content: modified }
    })
    file.initRaw()
    return file
  }, [fileName, language, original, modified])

  return (
    <div className="overflow-hidden rounded-lg border border-border/55">
      <div className="flex items-center gap-2 border-b border-border/55 bg-muted/40 px-3 py-1.5">
        <span className="truncate font-mono text-[10px] text-muted-foreground">{fileName}</span>
        <span className="ml-auto truncate text-[10px] text-muted-foreground">{filePath}</span>
      </div>
      <div style={{ maxHeight: height }} className="nyra-diff overflow-auto">
        <DiffView
          diffFile={diffFile}
          diffViewMode={renderSideBySide ? DiffModeEnum.Split : DiffModeEnum.Unified}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewFontSize={12}
        />
      </div>
    </div>
  )
}
