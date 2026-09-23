import React, { useCallback, useEffect, useRef, type SetStateAction } from 'react'
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor'
import AttachmentStrip from './AttachmentStrip'
import { newlineInList } from '../lib/markdownEditing'
import { useAttachmentStaging } from '../hooks/useAttachmentStaging'
import type { FileAttachment, ImageAttachment } from '../store/sessions'

/**
 * A sent message, opened for editing.
 *
 * The composer's own editor rather than a bare `<textarea>`: this is the same
 * text going back to the same place, so it should live-preview the markdown and
 * chip the @-mentions exactly as it did the first time you wrote it. It was the
 * last surface in the conversation still showing raw characters.
 *
 * Its own component because of the hooks — CodeMirror is mounted imperatively
 * and has to be told to take focus, and attachments are staged here — and the
 * transcript builds its rows inside a `map`, where none could be called.
 *
 * Attachments stage through the composer's own hook, so pasting an image or a
 * file works here exactly as it does there. It starts from the message's own,
 * and whatever is on the strip at Save is what goes.
 */
export default function EditMessageBox({
  value,
  images,
  files,
  onChange,
  onCancel,
  onSave
}: {
  value: string
  images?: ImageAttachment[]
  files?: FileAttachment[]
  onChange: (next: string) => void
  onCancel: () => void
  onSave: (images: ImageAttachment[], files: FileAttachment[]) => void
}): React.JSX.Element {
  const editorRef = useRef<MarkdownEditorHandle>(null)

  // The text is the parent's; the hook writes it through an updater, so read
  // the newest value rather than the one this render closed over.
  const valueRef = useRef(value)
  valueRef.current = value
  const setText = useCallback(
    (next: SetStateAction<string>) => {
      const text = typeof next === 'function' ? next(valueRef.current) : next
      valueRef.current = text
      onChange(text)
    },
    [onChange]
  )
  const {
    stagedImages,
    stagedFiles,
    pendingAttachments,
    fileError,
    handlePaste,
    removeImage,
    removeFile
  } = useAttachmentStaging(editorRef, setText, { images, files })
  // Mirrors the composer: attachments alone are a message, and nothing goes
  // while one is still being read.
  const canSave =
    pendingAttachments.length === 0 &&
    (!!value.trim() || stagedImages.length > 0 || stagedFiles.length > 0)
  const save = (): void => {
    if (canSave) onSave(stagedImages, stagedFiles)
  }

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
      save()
    }
  }

  return (
    <div className="w-full">
      {fileError && <p className="mb-2 text-right text-c-sm text-danger">{fileError}</p>}
      {/* The composer's box, in the transcript. Info-tinted border rather than
          the old solid blue fill: the fill fought every colour the markdown and
          the chips are drawn in, and the buttons below already say what this
          is. */}
      <div className="composer-box rounded-lg border border-info/50 bg-muted">
        <AttachmentStrip
          images={stagedImages}
          files={stagedFiles}
          pending={pendingAttachments}
          onRemoveImage={removeImage}
          onRemoveFile={removeFile}
        />
        <MarkdownEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
          disabled={!canSave}
          onClick={save}
          className="rounded-lg bg-info px-3 py-1 text-c-md font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-25"
        >
          Save
        </button>
      </div>
    </div>
  )
}
