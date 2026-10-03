/**
 * Opening a design: read it whole, then compile it off the main thread.
 *
 * Every place that shows or renders a design comes through here — the panel,
 * the miniature over the chat, and Claude's render tool — so a file opens the
 * same way, with the same errors, wherever it is looked at. There is no size
 * limit: the read streams, the compile runs in a worker, and the canvas only
 * draws the artboards near the viewport.
 */
import type { Compiled, Issue } from '@nyra/design'
import type { SystemEntry } from './api-types'
import { compileOffThread, type SystemCompileContext } from './designCompile'
import { compileContextFor, loadSystem } from './designSystem'
import { joinPath } from './paths'

export type DesignLoadPhase =
  | { phase: 'reading'; loaded: number; total: number }
  | { phase: 'checking'; total: number }

export type DesignLoad =
  | ({
      kind: 'ok'
      mtimeMs: number
      totalBytes: number
      /** The system this file belongs to, and its path inside it. */
      system: { entry: SystemEntry; rel: string } | null
    } & Compiled)
  /** Registered but not written yet — usually about to be. */
  | { kind: 'missing' }
  | { kind: 'cancelled' }
  /** From a later Nyra. Refused whole, with the reason. */
  | { kind: 'newer'; message: string }
  /** Not JSON, or JSON the validator rejected. `issues` are what Claude fixes. */
  | { kind: 'invalid'; message: string; issues: Issue[] }
  | { kind: 'error'; message: string }

export type DesignLoadOptions = {
  cwd?: string
  signal?: AbortSignal
  onPhase?: (phase: DesignLoadPhase) => void
  /** For a file in a design system: the mode to draw in. The base mode if omitted. */
  mode?: string
}

export async function loadDesign(
  path: string,
  { cwd, signal, onPhase, mode }: DesignLoadOptions = {}
): Promise<DesignLoad> {
  // A file in a design system is compiled with the system: its components,
  // its theme. A path under a root the system has moved away from is said to
  // be one — Claude writing there from memory would otherwise start a second,
  // ghost system that nobody sees.
  const membership = (await window.api.designSystem?.of(path)) ?? null
  if (membership?.moved) {
    return {
      kind: 'error',
      message: `The ${membership.system.name} design system moved to ${membership.system.root}. This file is now ${joinPath(membership.system.root, membership.rel)}.`
    }
  }

  const read = await window.api.design.read(path, {
    cwd,
    signal,
    onProgress: (loaded, total) => onPhase?.({ phase: 'reading', loaded, total })
  })
  switch (read.kind) {
    case 'missing':
    case 'cancelled':
      return read
    case 'notAFile':
      return { kind: 'error', message: `${path} is a folder, not a design file` }
    case 'error':
      return { kind: 'error', message: `could not read ${path}: ${read.message}` }
  }
  if (signal?.aborted) return { kind: 'cancelled' }

  onPhase?.({ phase: 'checking', total: read.totalBytes })
  let sys: SystemCompileContext | undefined
  if (membership) {
    try {
      sys = compileContextFor(await loadSystem(membership.system), membership.rel, mode)
    } catch (e) {
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }
  const out = await compileOffThread(read.content, sys)
  if (signal?.aborted) return { kind: 'cancelled' }
  if (out.ok) {
    const { ok: _ok, ...compiled } = out
    return {
      kind: 'ok',
      mtimeMs: read.mtimeMs,
      totalBytes: read.totalBytes,
      system: membership ? { entry: membership.system, rel: membership.rel } : null,
      ...compiled
    }
  }
  if (out.reason === 'newer') return { kind: 'newer', message: out.message }
  return {
    kind: 'invalid',
    message: out.reason === 'json' ? `${path} is not valid JSON: ${out.message}` : out.message,
    issues: out.issues
  }
}

/** "12.4 MB", "830 KB" — for the loading state. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / (1024 * 1024)
  // One decimal while it still says something; "40.0" reads as fussier than "40".
  return `${mb < 100 ? String(Number(mb.toFixed(1))) : Math.round(mb)} MB`
}
