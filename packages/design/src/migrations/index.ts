/**
 * Bringing an old document forward.
 *
 * The format is allowed to break. What it is not allowed to do is strand a file:
 * every version that changes the shape ships a step that reads the version
 * before it, so any document from any earlier Nyra can be walked up to this one.
 * The tests refuse a version bump that has no step.
 *
 * Steps work on raw JSON, never on the typed document. An old file is by
 * definition one the current schema rejects, so typing the input as the current
 * `DesignDocument` would be a lie the compiler believes.
 *
 * Opening a file runs the chain in memory and leaves the file alone. Writing the
 * result back is a separate, explicit act — the panel's "Upgrade file", or
 * Claude's `upgrade` action — because a file that silently changes underneath
 * someone's editor, or in their repo, is worse than one that shows a banner.
 */
import { SCHEMA_VERSION } from '../schema'
import { slotsMetaModes } from './001-slots-meta-modes'

/** One number for every file a design system holds: documents, tokens, manifest. */
export const FORMAT_VERSION = SCHEMA_VERSION

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export type FileKind = 'design' | 'tokens' | 'manifest'

export type Migration = {
  /** The version this step reads. It produces `from + 1`. */
  from: number
  /** One line, for upgrade notes and for whoever reads this list next. */
  summary: string
  /**
   * Pure: it is handed a copy, and returns the new shape plus anything it
   * could not carry across. A note is for the user, so write it as one.
   * `schema` is set by the chain, not by the step.
   */
  migrate: (doc: JsonObject, kind: FileKind) => { doc: JsonObject; notes?: string[] }
}

/** Every step, oldest first. A version bump without one fails the tests. */
export const MIGRATIONS: readonly Migration[] = [slotsMetaModes]

export type Upgrade = {
  from: number
  to: number
  /** What changed, step by step, followed by anything a step had to drop. */
  notes: string[]
  /** The document at `to`. A fresh object; the input is never touched. */
  doc: JsonObject
}

/** A file from a later Nyra. Refused whole rather than drawn half right. */
export class NewerFormatError extends Error {
  constructor(
    readonly version: number,
    readonly supported: number
  ) {
    super(
      `This file was made with a newer version of Nyra Design (format v${version}; this Nyra reads up to v${supported}). Update Nyra to open it.`
    )
    this.name = 'NewerFormatError'
  }
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The version a file says it is, or null when it says nothing usable. */
export function formatVersionOf(input: unknown): number | null {
  if (!isObject(input)) return null
  const v = input.schema
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null
}

/**
 * Walk `input` up to `target`.
 *
 * Returns null when there is nothing to do: the file is current, or it carries
 * no usable version and validation is the right place to say so. Throws
 * `NewerFormatError` for a file from the future, and a plain error if the chain
 * has a gap — which the tests exist to make impossible.
 */
export function upgrade(
  input: unknown,
  kind: FileKind = 'design',
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = FORMAT_VERSION
): Upgrade | null {
  const from = formatVersionOf(input)
  if (from === null) return null
  if (from > target) throw new NewerFormatError(from, target)
  if (from === target) return null

  let doc = structuredClone(input) as JsonObject
  const notes: string[] = []
  for (let v = from; v < target; v++) {
    const step = migrations.find((m) => m.from === v)
    if (!step) throw new Error(`no migration from format v${v} to v${v + 1}`)
    const out = step.migrate(doc, kind)
    doc = { ...out.doc, schema: v + 1 }
    notes.push(`v${v} → v${v + 1}: ${step.summary}`, ...(out.notes ?? []))
  }
  return { from, to: target, notes, doc }
}

/**
 * The upgraded document as it should be written: pretty-printed, newline at the
 * end. Pretty because a file Claude edits is read in line ranges, and a
 * 400 KB single line cannot be read in pieces.
 */
export function serializeDocument(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Every version below `target` has exactly one step. */
export function missingMigrations(
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = FORMAT_VERSION
): number[] {
  const missing: number[] = []
  for (let v = 1; v < target; v++) {
    if (migrations.filter((m) => m.from === v).length !== 1) missing.push(v)
  }
  return missing
}
