/**
 * One file's patch, drawn by `@git-diff-view`.
 *
 * Behind a lazy boundary for the same reason Monaco was: it pulls a highlighter
 * (lowlight) that nothing else in the app needs, and a chat that never opens a
 * diff should never pay for it.
 *
 * `onAddWidgetClick` and friends are threaded through as optional props even
 * though nothing passes them yet. That is the whole of the line-comment
 * foundation on this side — when comments land they attach here, and the layers
 * between this and the store already carry `{ path, side, line }` rather than
 * having flattened it away.
 */
import React from 'react'
import { DiffView, DiffModeEnum, SplitSide, type DiffViewProps } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view.css'
import { detectLanguage } from '../../utils/diff'
import { useResolvedTheme } from '../../hooks/useResolvedTheme'
import type { LineAnchor } from '../../store/changes'

export type PatchViewProps = {
  path: string
  /** Raw unified diff, straight from `git diff`. */
  patch: string
  /** Split needs roughly 700px; the panel is usually half that. */
  mode: 'unified' | 'split'
  /** Soft-wrap long lines instead of scrolling them horizontally. */
  wrap?: boolean
  /** Set once line comments exist. Until then the gutter has no affordance. */
  onAddComment?: (anchor: LineAnchor) => void
}

export default function PatchView({
  path,
  patch,
  mode,
  wrap = false,
  onAddComment
}: PatchViewProps): React.JSX.Element {
  // Follows the app's resolved theme, including 'system'. Hardcoding dark put a
  // dark diff inside a light app, which is exactly the seam a user notices.
  const theme = useResolvedTheme()
  const lang = detectLanguage(path)
  const name = path.split('/').pop() ?? path
  const data = React.useMemo(
    () => ({
      hunks: [patch],
      oldFile: { fileName: name, fileLang: lang },
      newFile: { fileName: name, fileLang: lang }
    }),
    [patch, name, lang]
  )

  const widgetProps: Partial<DiffViewProps<string[]>> = onAddComment
    ? {
        diffViewAddWidget: true,
        onAddWidgetClick: (lineNumber, side) =>
          onAddComment({
            path,
            // The library's side is an enum; the anchor keeps the two names it
            // will always have, so nothing downstream has to translate.
            side: side === SplitSide.old ? 'old' : 'new',
            line: lineNumber
          })
      }
    : {}

  return (
    <div className="nyra-diff text-[11px]">
      <DiffView<string[]>
        data={data}
        diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap={wrap}
        diffViewFontSize={11}
        {...widgetProps}
      />
    </div>
  )
}
