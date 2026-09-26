/**
 * A markdown file, drawn rather than quoted.
 *
 * Raw source in the viewer was the wrong answer for the one file type whose
 * whole point is how it reads — a README opened in the panel looked like a
 * transcript of a README. So the file renders the way the composer renders what
 * you type: `livePreview` hides the markers and draws what they mean, and the
 * line the pointer is on shows its own source again.
 *
 * Not editable, and not on the way to being: this is a file, and Nyra reads
 * files rather than writing them.
 */
import React from 'react'
import MarkdownEditor from '../MarkdownEditor'

export default function MarkdownPreview({
  value,
  wrap
}: {
  value: string
  wrap: boolean
}): React.JSX.Element {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <MarkdownEditor
        value={value}
        onChange={() => {}}
        readOnly
        wrap={wrap}
        // The panel's height, not the composer's grow-to-300px: the editor's
        // own scroller is the document's, so both scrollbars sit at the
        // panel's edges.
        fill
      />
    </div>
  )
}
