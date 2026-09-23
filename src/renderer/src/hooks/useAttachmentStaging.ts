/**
 * Attachments being staged into a draft: pasted, dropped or picked, read,
 * saved where Claude can reach them, and referenced from the text at the caret.
 *
 * Lifted out of the composer so editing a sent message stages attachments the
 * same way writing one does — pasting into the edit box used to do nothing,
 * because none of this was reachable from there.
 */
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { attachmentMarker, removeAttachmentRef } from '../lib/composerDecorations'
import { compressImage } from '../utils/imageCompression'
import type { FileAttachment, ImageAttachment } from '../store/sessions'
import type { PendingAttachment } from '../components/AttachmentStrip'
import type { MarkdownEditorHandle } from '../components/MarkdownEditor'

/**
 * Images we can preview and compress here in the renderer.
 *
 * Not a gate on what may be attached — anything can be. This is only the test
 * for "can we show a thumbnail and shrink it before sending", and everything
 * else goes to the backend to be classified.
 */
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * The most we will carry through the renderer to attach a dropped or pasted file.
 *
 * `dragDropEnabled` is off in tauri.conf.json so the webview's own HTML5 drop
 * events work, which means a dropped file arrives as bytes with no filesystem
 * path — and the only way to get it to Rust is to base64 it (+33%) and pass it
 * over the IPC bridge as a string. For a film that exhausts renderer memory long
 * before it reaches anything that could have refused it politely.
 *
 * The file picker hands over real paths and has no such limit, so the message
 * points there. Lifting this properly means native drag-drop, which would take
 * HTML5 drop away from the browser panel too — its own change, not this one.
 */
const MAX_INLINE_TRANSFER = 100 * 1024 * 1024 // 100 MB

export function useAttachmentStaging(
  editorRef: RefObject<MarkdownEditorHandle | null>,
  setText: Dispatch<SetStateAction<string>>,
  initial: { images?: ImageAttachment[]; files?: FileAttachment[] } = {}
) {
  const [stagedImages, setStagedImages] = useState<ImageAttachment[]>(initial.images ?? [])
  const [stagedFiles, setStagedFiles] = useState<FileAttachment[]>(initial.files ?? [])
  const [fileError, setFileError] = useState<string | null>(null)
  // Attachments still being read. Reading a few MB is slow enough that without a
  // tile it looks like nothing happened, and the obvious response is to attach again.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])

  /**
   * Drop a reference to an attachment where the caret is.
   *
   * The point is to write "on this screen [shot.png] the sidebar…" and have
   * Claude read the path in that sentence, rather than appending every
   * attachment after the message and leaving you to explain in prose which one
   * you meant. The marker is the form the CLI already expects, so nothing needs
   * translating on the way out.
   */
  const insertAttachmentRef = useCallback((kind: 'Image' | 'File', target: string): void => {
    const marker = attachmentMarker(kind, target)
    setText((prev) => {
      const editor = editorRef.current
      const at = editor ? editor.selectionStart : prev.length
      const before = prev.slice(0, at)
      const after = prev.slice(at)
      const lead = before && !/\s$/.test(before) ? ' ' : ''
      const trail = after && !/^\s/.test(after) ? ' ' : ''
      const next = `${before}${lead}${marker}${trail}${after}`
      const caret = before.length + lead.length + marker.length + trail.length
      requestAnimationFrame(() => {
        editorRef.current?.setSelectionRange(caret, caret)
        editorRef.current?.focus()
      })
      return next
    })
  }, [])

  const processImageFile = useCallback(async (file: File): Promise<void> => {
    if (!SUPPORTED_TYPES.includes(file.type)) return
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    const rawBase64 = dataUrl.split(',')[1]
    const compressed = await compressImage(rawBase64, file.type)
    const path = await window.api.claude.saveImage(compressed.base64, compressed.mediaType)
    const finalDataUrl = `data:${compressed.mediaType};base64,${compressed.base64}`
    setStagedImages((prev) => [...prev, { path, mediaType: compressed.mediaType, dataUrl: finalDataUrl }])
    insertAttachmentRef('Image', path)
  }, [insertAttachmentRef])

  // File processing
  const processAttachedFile = useCallback(async (file: File) => {
    setFileError(null)
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setPendingAttachments((prev) => [...prev, { id: pendingId, name: file.name }])
    const done = (): void =>
      setPendingAttachments((prev) => prev.filter((p) => p.id !== pendingId))
    try {
      if (SUPPORTED_TYPES.includes(file.type)) {
        await processImageFile(file)
        return
      }
      // A dropped File carries no filesystem path, so stage the bytes to a temp
      // file first and hand the backend that path to extract from.
      if (file.size > MAX_INLINE_TRANSFER) {
        setFileError(
          `${file.name} is too large to drop (${Math.round(file.size / 1024 / 1024)} MB). Use + → Attach files.`
        )
        setTimeout(() => setFileError(null), 6000)
        return
      }
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
      }
      const base64 = btoa(binary)
      const filePath = await window.api.claude.saveTempFile(base64, file.name)
      if (!filePath) {
        setFileError('Could not read file path')
        return
      }
      const result = await window.api.claude.processFile(filePath)
      if (result.error) {
        setFileError(result.error)
        setTimeout(() => setFileError(null), 5000)
        return
      }
      if (result.category === 'image') {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        const rawBase64 = dataUrl.split(',')[1]
        const compressed = await compressImage(rawBase64, file.type)
        const path = await window.api.claude.saveImage(compressed.base64, compressed.mediaType)
        const finalDataUrl = `data:${compressed.mediaType};base64,${compressed.base64}`
        setStagedImages((prev) => [...prev, { path, mediaType: compressed.mediaType, dataUrl: finalDataUrl }])
        insertAttachmentRef('Image', path)
      } else {
        // The backend names it after the temp file the bytes were staged to, which
        // is a timestamped id. Keep what the user dropped.
        setStagedFiles((prev) => [...prev, { ...(result as FileAttachment), name: file.name }])
        // The name, not the temp path: the file's contents still travel as their
        // own block, and this is the pointer that says where it belongs.
        insertAttachmentRef('File', file.name)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to attach file'
      setFileError(message)
      setTimeout(() => setFileError(null), 5000)
    } finally {
      done()
    }
  }, [processImageFile, insertAttachmentRef])

  // Taking it off the strip takes its chip with it. They were independent, so
  // removing an attachment left a marker in the draft pointing at a file that
  // was no longer going to be sent.
  const removeImage = useCallback(
    (index: number) => {
      // Read the list, then set both. Reaching for the item inside the updater
      // would make the updater impure, and React invokes those twice in
      // development — which would strip a second marker when the same file is
      // referenced twice in one draft.
      const gone = stagedImages[index]
      if (gone) setText((text) => removeAttachmentRef(text, 'Image', gone.path))
      setStagedImages((prev) => prev.filter((_, i) => i !== index))
    },
    [stagedImages]
  )

  const removeFile = useCallback(
    (id: string) => {
      const gone = stagedFiles.find((f) => f.id === id)
      if (gone) setText((text) => removeAttachmentRef(text, 'File', gone.name))
      setStagedFiles((prev) => prev.filter((f) => f.id !== id))
    },
    [stagedFiles]
  )

  /**
   * Paste an attachment, of any kind.
   *
   * It used to take images only — the clipboard was filtered to
   * `SUPPORTED_TYPES` — so a PDF copied in Finder pasted as nothing, or as
   * whatever text representation it happened to carry. `processAttachedFile`
   * has always handled every type the picker and drag-drop accept; paste simply
   * never reached it.
   *
   * Copied *text* is left alone even when it looks like a path. Pasting a path
   * into a message is a thing people do on purpose, and silently turning it into
   * an attachment would take the words out of what they were writing.
   *
   * Handed to the editor as a prop rather than bound to `contentDOM` here: the
   * EditorView used to be rebuilt whenever the placeholder changed, which is
   * every time a turn starts or ends, and the listener stayed attached to the
   * detached node — so pasting an image stopped working after the first turn.
   *
   * Synchronous on purpose. `defaultPrevented` has to be true by the time this
   * returns, or CodeMirror pastes the clipboard's text form underneath us.
   */
  const handlePaste = useCallback(
    (e: ClipboardEvent): void => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null)
      if (files.length === 0) return
      e.preventDefault()
      void (async () => {
        for (const file of files) await processAttachedFile(file)
      })()
    },
    [processAttachedFile]
  )

  return {
    stagedImages,
    setStagedImages,
    stagedFiles,
    setStagedFiles,
    fileError,
    setFileError,
    pendingAttachments,
    setPendingAttachments,
    processAttachedFile,
    handlePaste,
    removeImage,
    removeFile
  }
}
