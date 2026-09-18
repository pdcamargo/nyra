import { FileText, Globe } from 'lucide-react'
import type { CommandId } from '../../commands/registry'

export type NewTabKind = 'browser' | 'file'

/**
 * What the "+" offers, and what an empty panel offers.
 *
 * One list because they are the same question asked in two places, and two lists
 * would drift the moment a third kind of tab existed.
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
