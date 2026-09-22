import type { QueuedMessage } from '../store/sessions'

/**
 * A queued message, as the one line the tray has room for.
 *
 * The tray is a preview of what is about to be sent, and it showed
 * `queued.text` verbatim. Two things were wrong with that. An image written
 * into the message is markdown — `![shot](/tmp/nyra-images-1/a.png)` — which
 * the transcript renders as a picture and the tray rendered as that literal
 * string; a row of syntax is not a preview of a picture. And an image *staged*
 * on the message rather than written into it was not in the row at all, so a
 * queued message could be a photo and look like an empty line.
 *
 * So: the pictures come out as pictures, and the text is what is left.
 */

/** `![alt](src "title")` — the only markdown a one-line preview has to undo. */
const IMAGE_MD = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

export type QueuedImage = {
  /** Staged attachments arrive already decoded; nothing has to be read. */
  dataUrl?: string
  /** Written into the text as a path, so it still has to be loaded. */
  path?: string
}

export type QueuePreview = {
  text: string
  images: QueuedImage[]
}

export function queuePreview(queued: QueuedMessage): QueuePreview {
  const images: QueuedImage[] = (queued.images ?? []).map((i) => ({ dataUrl: i.dataUrl }))

  const text = (queued.text ?? '')
    .replace(IMAGE_MD, (_match, _alt: string, src: string) => {
      // A remote image cannot be shown — the CSP allows `data:` and `blob:`
      // only — so it stays as its label rather than becoming a broken thumb.
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('data:')) return ''
      images.push(src.startsWith('data:') ? { dataUrl: src } : { path: src })
      return ''
    })
    // One line, whatever the message looked like. A queued row is a row.
    .replace(/\s+/g, ' ')
    .trim()

  return { text, images }
}
