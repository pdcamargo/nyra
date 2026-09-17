import type { FileAttachment, ImageAttachment, TextMessage } from '../store/sessions'

export type Attachment =
  | { kind: 'image'; key: string; name: string }
  | { kind: 'file'; key: string; name: string; size: number }

/**
 * Everything attached to a conversation, oldest first.
 *
 * Attachments already live on the messages, so the summary panel needs no new
 * state — it just reads across them. Keyed per message so the same file attached
 * twice shows twice.
 */
export function collectAttachments(messages: TextMessage[]): Attachment[] {
  const out: Attachment[] = []
  for (const msg of messages) {
    for (const img of (msg.images ?? []) as ImageAttachment[]) {
      out.push({
        kind: 'image',
        key: `${msg.id}:${img.path}`,
        name: img.path.split('/').pop() ?? img.path
      })
    }
    for (const file of (msg.files ?? []) as FileAttachment[]) {
      out.push({ kind: 'file', key: `${msg.id}:${file.id}`, name: file.name, size: file.size })
    }
  }
  return out
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
