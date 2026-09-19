/**
 * The renderer's console, teed into the backend's debug log.
 *
 * Nothing captured it before, which meant the one half of Nyra you could not
 * see from outside was the half you look at. Rather than a ring buffer with an
 * endpoint of its own, the lines go to the same batched file the backend writes
 * (`logger.rs`) — so renderer and backend interleave in causal order, and the
 * record survives the renderer crashing outright, which an in-memory ring does
 * not.
 *
 * Read it with `node scripts/nyra-dev.mjs log`, or tail the path `/health`
 * reports.
 *
 * Two rules this module lives by:
 *
 * 1. **It never calls `console` itself.** Every diagnostic goes through the
 *    captured originals. A patched `console.error` whose own failure path calls
 *    `console.error` is a loop inside the logger, and the logger is the thing
 *    that would have told you.
 * 2. **It gives up rather than retries forever.** If the backend will not take
 *    the lines, three failures is enough to conclude nobody is listening.
 */
import { invoke } from '@tauri-apps/api/core'

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug'

interface Line {
  level: Level
  text: string
}

/** Captured before patching. The only console this module is allowed to use. */
const original: Record<Level, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

/**
 * Warnings and errors always — those are what a bug report needs. The chatty
 * three only in a dev build, where they are worth their volume; in release they
 * are mostly third-party noise, and this file already holds the conversation.
 */
const LEVELS: Level[] = import.meta.env.DEV
  ? ['log', 'info', 'warn', 'error', 'debug']
  : ['warn', 'error']

const FLUSH_MS = 200
const MAX_QUEUE = 2000
const MAX_ARGS = 8
const MAX_ARG_CHARS = 2000
const MAX_DEPTH = 2
const MAX_ITEMS = 24
const GIVE_UP_AFTER = 3

let queue: Line[] = []
let dropped = 0
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Bounded, cycle-safe, and it must not throw.
 *
 * `JSON.stringify` is not usable here: a DOM node or a React element either
 * throws on a cycle or emits megabytes, and a logger that throws inside a
 * `console.error` takes the page with it.
 */
function render(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value
  if (type === 'string') return depth === 0 ? (value as string) : JSON.stringify(value)
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
  if (type === 'symbol') return String(value)
  if (type === 'function') return `[Function: ${(value as { name?: string }).name || 'anonymous'}]`

  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`
    // WebKit's `stack` is frames only — the `Name: message` header is a V8
    // convention. Taking `stack` alone here lost the message, which is the part
    // you actually came for. Checked rather than assumed, so it stays right if
    // this ever runs somewhere that follows V8.
    if (!value.stack) return head
    return value.stack.startsWith(value.name) ? value.stack : `${head}\n${value.stack}`
  }
  // Nodes are the classic way to get megabytes out of a logger.
  if (typeof Node !== 'undefined' && value instanceof Node) {
    const el = value as Partial<Element> & { nodeName: string }
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/).join('.')}` : ''
    return `<${el.nodeName.toLowerCase()}${id}${cls}>`
  }

  const object = value as object
  if (seen.has(object)) return '[Circular]'
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]'
  seen.add(object)

  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((v) => render(v, depth + 1, seen))
      if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`)
      return `[${items.join(', ')}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
    const body = entries
      .slice(0, MAX_ITEMS)
      .map(([k, v]) => `${k}: ${render(v, depth + 1, seen)}`)
    if (entries.length > MAX_ITEMS) body.push(`… ${entries.length - MAX_ITEMS} more`)
    const name = object.constructor?.name
    const prefix = name && name !== 'Object' ? `${name} ` : ''
    return `${prefix}{${body.join(', ')}}`
  } catch {
    return '[unserializable]'
  } finally {
    seen.delete(object)
  }
}

/**
 * One console call's arguments as one line. Exported for its tests — the rest
 * of this module is side effects and a socket, and this is the part with edge
 * cases worth pinning down.
 */
export function formatConsoleArgs(args: unknown[]): string {
  const shown = args.slice(0, MAX_ARGS).map((arg) => {
    const text = render(arg, 0, new WeakSet())
    return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}… (${text.length} chars)` : text
  })
  if (args.length > MAX_ARGS) shown.push(`… ${args.length - MAX_ARGS} more args`)
  return shown.join(' ')
}

async function flush(): Promise<void> {
  timer = null
  if (queue.length === 0) return

  const lines = queue
  queue = []
  if (dropped > 0) {
    lines.unshift({ level: 'warn', text: `… ${dropped} console lines dropped (over ${MAX_QUEUE} queued)` })
    dropped = 0
  }

  try {
    await invoke('dev_log_push', { lines })
    failures = 0
  } catch (err) {
    failures += 1
    if (failures >= GIVE_UP_AFTER) {
      // Stop forwarding rather than queue against a backend that is not there.
      // Without this, a rejecting `invoke` that logs its own failure feeds the
      // queue it just failed to drain.
      queue = []
      original.warn('[devlog] backend rejected console forwarding; giving up', err)
    }
  }
}

function push(level: Level, args: unknown[]): void {
  if (failures >= GIVE_UP_AFTER) return
  if (queue.length >= MAX_QUEUE) {
    dropped += 1
    return
  }
  try {
    queue.push({ level, text: formatConsoleArgs(args) })
  } catch {
    return
  }
  if (timer === null) timer = setTimeout(() => void flush(), FLUSH_MS)
}

/**
 * Patch the console and the three error events.
 *
 * Called at module evaluation, not exported for `main.tsx` to call — a function
 * call in `main.tsx` would run only once every import there had already been
 * evaluated, so a module-level throw in `App` or any store would happen before
 * the listeners existed and be invisible. Import order in `main.tsx` is what
 * makes this work, the same way `legacy-storage` depends on it.
 *
 * It still cannot catch a failure in the bundler's own prelude. The complete
 * answer there is a `WKUserScript` at document start, which the CSP's
 * `script-src 'self'` will not allow without a file to point at. Worth knowing;
 * not worth the machinery.
 */
function install(): void {
  for (const level of LEVELS) {
    console[level] = (...args: unknown[]): void => {
      original[level](...args)
      push(level, args)
    }
  }

  window.addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ''
    push('error', [`Uncaught${where}:`, event.error ?? event.message])
  })

  window.addEventListener('unhandledrejection', (event) => {
    push('error', ['Unhandled rejection:', event.reason])
  })

  // The CSP here is tight — `script-src 'self'`, no `unsafe-inline` — and a
  // violation is exactly the class of bug that presents as "nothing happened"
  // with a message you never see.
  window.addEventListener('securitypolicyviolation', (event) => {
    push('error', [
      `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`
    ])
  })
}

install()

/** For tests: put the real console back. */
export function resetDevLog(): void {
  for (const level of Object.keys(original) as Level[]) console[level] = original[level]
  queue = []
  dropped = 0
  failures = 0
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}
