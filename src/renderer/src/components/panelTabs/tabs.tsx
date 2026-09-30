import { FileText, Globe } from 'lucide-react'
import type { CommandId } from '../../commands/registry'

export type NewTabKind = 'browser' | 'file'

/**
 * What the "+" offers, and what an empty panel offers.
 *
 * One list because they are the same question asked in two places, and two lists
 * would drift the moment a third kind of tab existed.
 *
 * A design is deliberately NOT here, and must never be. A blank design tab has
 * no answer to "which design?" — a chat can have ten of them — so offering one
 * from a menu asks the user to go and find a file, which is the opposite of the
 * point. Designs are opened by something that already knows which one: a chip
 * in the transcript, "Open in Design" on a file, or Claude itself.
 */
export const NEW_TAB_CHOICES: {
  kind: NewTabKind
  label: string
  icon: typeof Globe
  command: CommandId
}[] = [
  { kind: 'browser', label: 'Browser', icon: Globe, command: 'panel.right.browser' },
  { kind: 'file', label: 'Files', icon: FileText, command: 'panel.right.file' }
]
