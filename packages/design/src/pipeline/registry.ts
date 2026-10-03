import type { ComponentDef, DesignDocument } from '../schema'
import { err, type Issue } from './types'

/**
 * Every component a document can use, and which file defines it.
 *
 * A standalone draft's registry is its own `components`. Inside a design
 * system it is every component in every file of the system — one namespace,
 * so a screen uses `Button` from `components/button.nyui.json` without saying
 * where it lives. The file travels with the definition so a node's `origin`
 * can name the file to edit, not just the component.
 */
export type ComponentEntry = {
  def: ComponentDef
  /** System-relative POSIX path. Absent for a standalone draft. */
  file?: string
  /** Other files that also define this name. Using it is then an error that
   *  names them all, rather than a silent pick of one. */
  conflicts?: string[]
}

export type Registry = ReadonlyMap<string, ComponentEntry>

/** A single document's own components. */
export function localRegistry(doc: Pick<DesignDocument, 'components'>, file?: string): Registry {
  const out = new Map<string, ComponentEntry>()
  for (const [name, def] of Object.entries(doc.components ?? {})) {
    out.set(name, file === undefined ? { def } : { def, file })
  }
  return out
}

/**
 * The shared namespace of a set of files.
 *
 * A name defined in two files is reported once, naming both, and kept as a
 * conflict: a file that uses it gets "Button is defined in a and b", which is
 * the message that tells someone what to fix. Last-writer-wins would draw one
 * of them and hide that the other exists.
 */
export function buildRegistry(files: { file: string; doc: Pick<DesignDocument, 'components'> }[]): {
  registry: Registry
  issues: Issue[]
} {
  const out = new Map<string, ComponentEntry>()
  const issues: Issue[] = []
  for (const { file, doc } of files) {
    for (const [name, def] of Object.entries(doc.components ?? {})) {
      const seen = out.get(name)
      if (!seen) {
        out.set(name, { def, file })
        continue
      }
      const all = [seen.file ?? '?', ...(seen.conflicts ?? []), file]
      out.set(name, { ...seen, conflicts: all.slice(1) })
      issues.push(
        err(
          'duplicate-component',
          `"${name}" is defined in more than one file: ${all.join(', ')}. Keep one and delete the others.`,
          { scope: name, id: name, file }
        )
      )
    }
  }
  return { registry: out, issues }
}

/** Every file a name is defined in, for messages. */
export const definedIn = (entry: ComponentEntry): string[] =>
  [entry.file, ...(entry.conflicts ?? [])].filter((f): f is string => typeof f === 'string')
