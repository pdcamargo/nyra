import type { FileAttachment, ImageAttachment } from '../store/sessions'

/**
 * Fold a message's attachments into the text the CLI actually receives.
 *
 * The composer drops `[Image: path]` at the caret as you attach, so most of
 * these are already in the text, in the sentence they belong to. Appending them
 * again would show Claude the same screenshot twice; this catches the ones that
 * are not there — an attachment whose chip was deleted, or a message sent from
 * somewhere that never had a composer.
 *
 * Shared by the two ways a message reaches the child: sending it as its own turn
 * and steering it into a running one. A queued message carries attachments like
 * any other, and they must arrive the same way whichever button you press.
 */
export function withAttachments(
  text: string,
  images?: ImageAttachment[],
  files?: FileAttachment[]
): string {
  let prompt = text
  const imgs = images ?? []
  const fls = files ?? []

  const sep = (): string => (prompt ? '\n\n' : '')
  const referenced = (path: string): boolean => prompt.includes(`[Image: ${path}]`)

  const orphanImages = imgs.filter((img) => !referenced(img.path))
  if (orphanImages.length > 0) {
    const imagePaths = orphanImages.map((img) => `[Image: ${img.path}]`).join('\n')
    prompt = `${prompt}${sep()}${imagePaths}`
  }
  if (fls.length > 0) {
    const imageFiles = fls.filter((f) => f.category === 'image' && !referenced(f.path))
    if (imageFiles.length > 0) {
      const imgPaths = imageFiles.map((f) => `[Image: ${f.path}]`).join('\n')
      prompt = `${prompt}${sep()}${imgPaths}`
    }
    const fileParts = fls
      .filter((f) => f.category !== 'image' && f.extractedText)
      .map((f) => `<attached_file name="${f.name}">\n${f.extractedText}\n</attached_file>`)
    if (fileParts.length > 0) {
      prompt = `${prompt}${sep()}${fileParts.join('\n\n')}`
    }
  }

  return prompt
}
