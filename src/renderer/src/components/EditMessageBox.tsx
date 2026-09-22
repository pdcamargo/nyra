import React, { useEffect, useRef } from 'react'
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor'
import { newlineInList } from '../lib/markdownEditing'
import type { ImageAttachment } from '../store/sessions'
import ZoomableImage from './ZoomableImage'

/**
 * A sent message, opened for editing.
 *
 * The composer's own editor rather than a bare `<textarea>`: this is the same
 * text going back to the same place, so it should live-preview the markdown and
 * chip the @-mentions exactly as it did the first time you wrote it. It was the
 * last surface in the conversation still showing raw characters.
 *
 * Its own component because of the two hooks — CodeMirror is mounted
 * imperatively and has to be told to take focus — and the transcript builds its
 * rows inside a `map`, where neither could be called.
 */
export default function EditMessageBox({
  value,
  images,
  onChange,
  onCancel,
  onSave
}: {
  value: string
  images?: ImageAttachment[]
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  const editorRef = useRef<MarkdownEditorHandle>(null)

  // Caret at the end, which is where `autoFocus` used to leave it and where you
  // are most likely to want it: the common edit is adding the thing you forgot.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    editor.setSelectionRange(value.length, value.length)
    // Mount only. Re-running it on every keystroke would drag the caret back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }

    // Shift+Enter breaks the line, and inside a list starts the next item —
    // the composer's rule, through the composer's helper. Claimed explicitly or
    // CodeMirror's default keymap inserts a plain newline and knows nothing
    // about the list you were in.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const editor = editorRef.current
      const edit = newlineInList(
        value,
        editor?.selectionStart ?? value.length,
        editor?.selectionEnd ?? value.length
      )
      onChange(edit.text)
      requestAnimationFrame(() => {
        editorRef.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
      })
      return
    }

    // Enter saves, the way Enter sends in the composer. Editing a message is
    // sending it again, so the key that sends should be the one that does it.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim()) onSave()
    }
  }

  return (
    <div className="w-full">
      {images && images.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
          {images.map((img, i) => (
            <ZoomableImage
              key={i}
              src={img.dataUrl}
              name={`Image ${i + 1}`}
              className="h-20 max-w-[200px] rounded-lg object-cover"
            />
          ))}
        </div>
      )}
      {/* The composer's box, in the transcript. Info-tinted border rather than
          the old solid blue fill: the fill fought every colour the markdown and
          the chips are drawn in, and the buttons below already say what this
          is. */}
      <div className="composer-box rounded-lg border border-info/50 bg-muted">
        <MarkdownEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          placeholder="Edit your message…"
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1 text-c-md text-foreground/80 transition-colors hover:text-foreground"
        >
          Cancel
        </button>
        <button
          disabled={!value.trim()}
          onClick={onSave}
          className="rounded-lg bg-info px-3 py-1 text-c-md font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-25"
        >
          Save
        </button>
      </div>
    </div>
  )
}
