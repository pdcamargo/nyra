/**
 * Text in, a drawable design out — the part of opening a design that is pure
 * CPU, and so the part that runs in a worker.
 *
 * Parsing and validating a 40 MB document takes long enough to freeze the
 * window, and the panel exists to stay responsive while Claude works. So the
 * same function runs in two places: `designCompile.worker.ts` calls it off the
 * main thread, and environments with no `Worker` (the tests) call it directly.
 * One function means the two cannot disagree about what a design is.
 */
import {
  buildRegistry,
  compile,
  loadTokens,
  modesOf,
  themeFor,
  type CompileContext,
  type Compiled,
  type DesignDocument,
  type Issue,
  type Theme
} from '@nyra/design'

/**
 * What a file needs from the system it belongs to, as plain data — it crosses
 * into the worker by structured clone, so no Maps and no class instances.
 */
export type SystemCompileContext = {
  /** This file's path in the system. */
  file: string
  /** Every file's component definitions: the shared namespace. */
  components: { file: string; components: Record<string, unknown> }[]
  /** The parsed `tokens.json`, or null when the system has none (built-in theme). */
  tokens: unknown | null
  /** The mode to draw artboards that do not pin one; the base mode if omitted. */
  mode?: string
  /** The system's name, for theme names in messages. */
  name?: string
}

/** The pipeline context for one file of a system. Exported for the tests. */
export function systemContext(sys: SystemCompileContext): { ctx: CompileContext; issues: Issue[] } {
  const { registry, issues } = buildRegistry(
    sys.components.map((c) => ({ file: c.file, doc: { components: c.components } as unknown as DesignDocument }))
  )
  const ctx: CompileContext = { registry, file: sys.file }
  if (sys.tokens !== null) {
    const loaded = loadTokens(sys.tokens)
    if (loaded.ok) {
      const modes: Record<string, Theme> = {}
      for (const m of modesOf(loaded.tokens)) modes[m] = themeFor(loaded.tokens, m, sys.name)
      ctx.theme = themeFor(loaded.tokens, sys.mode, sys.name)
      ctx.modes = modes
    } else {
      issues.push(...loaded.issues.map((message) => ({ severity: 'error' as const, code: 'tokens', message })))
    }
  }
  // Duplicate names are reported where they are defined, not on every file
  // that happens to be compiled; the ones that matter here surface as
  // "ambiguous" on the instances that use them.
  return { ctx, issues: issues.filter((i) => i.code !== 'duplicate-component' || i.at?.file === sys.file) }
}

export type CompileOutcome =
  | ({ ok: true } & Compiled)
  | {
      ok: false
      /** `newer`: a file from a later Nyra, refused whole. `json`: not JSON at
       *  all. `invalid`: JSON the validator rejected. */
      reason: 'json' | 'invalid' | 'newer'
      message: string
      issues: Issue[]
    }

export function compileText(text: string, sys?: SystemCompileContext): CompileOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, reason: 'json', message: e instanceof Error ? e.message : String(e), issues: [] }
  }
  try {
    if (!sys) return { ok: true, ...compile(parsed) }
    const { ctx, issues } = systemContext(sys)
    const out = compile(parsed, ctx)
    return { ok: true, ...out, issues: [...issues, ...out.issues] }
  } catch (e) {
    const issues = (e as { issues?: Issue[] }).issues ?? []
    const newer = issues.some((i) => i.code === 'schema-newer')
    return {
      ok: false,
      reason: newer ? 'newer' : 'invalid',
      message: e instanceof Error ? e.message : String(e),
      issues
    }
  }
}

type Pending = (outcome: CompileOutcome) => void

let worker: Worker | null = null
let workerFailed = false
let nextId = 0
const pending = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker
  if (typeof Worker === 'undefined') {
    workerFailed = true
    return null
  }
  try {
    worker = new Worker(new URL('../workers/designCompile.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; outcome: CompileOutcome }>) => {
      const done = pending.get(e.data.id)
      pending.delete(e.data.id)
      done?.(e.data.outcome)
    }
    // A worker that dies takes its queue with it. Fall back to the main thread
    // for those and for everything after: slower, but never a design that
    // simply never opens.
    worker.onerror = () => {
      workerFailed = true
      worker?.terminate()
      worker = null
      for (const [, resolve] of pending) resolve({ ok: false, reason: 'invalid', message: 'the design worker stopped', issues: [] })
      pending.clear()
    }
    return worker
  } catch {
    workerFailed = true
    return null
  }
}

/** `compileText`, off the main thread when there is one to be off. */
export function compileOffThread(text: string, sys?: SystemCompileContext): Promise<CompileOutcome> {
  const w = getWorker()
  if (!w) return Promise.resolve(compileText(text, sys))
  const id = ++nextId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    w.postMessage({ id, text, sys })
  })
}
