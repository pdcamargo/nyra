/**
 * Find the design work each project already has, once per launch.
 *
 * Every project in the sidebar is asked, one at a time and after startup has
 * settled: Rust lists the project's files through git — tracked, plus
 * untracked ones git is not ignoring, never a walk of the disk — and adopts a
 * committed `nyra.design.json` as a system and a loose `.nyui.json` as a
 * draft. After that they are in Nyra's lists: the design picker, the Pinned
 * Summary, the command palette, and `nyra_design action:"list"` for Claude,
 * which then never has to go looking.
 *
 * Main checkouts only. A project's path is never a worktree, and adopting a
 * worktree's copies would file drafts that vanish with the worktree.
 */
import { useSessionsStore } from '../store/sessions'

/** Long enough for the first chat to load before git runs for every project. */
const SETTLE_MS = 3000

const asked = new Set<string>()
let queue: Promise<void> = Promise.resolve()

/** Discover one project, once per launch. Queued behind any already running. */
export function discoverProject(path: string): void {
  if (!path || asked.has(path)) return
  asked.add(path)
  queue = queue.then(() =>
    window.api.designSystem
      .discover(path, true)
      .then(() => undefined)
      .catch(() => undefined)
  )
}

/** Discover every project now, and each one added from here on. */
export function installDesignDiscovery(): () => void {
  const timer = setTimeout(() => {
    for (const p of useSessionsStore.getState().projects) discoverProject(p.path)
  }, SETTLE_MS)
  const stop = useSessionsStore.subscribe((state, prev) => {
    if (state.projects === prev.projects) return
    for (const p of state.projects) if (!prev.projects.some((q) => q.path === p.path)) discoverProject(p.path)
  })
  return () => {
    clearTimeout(timer)
    stop()
  }
}

/** For tests: forget which projects were asked. */
export function resetDesignDiscovery(): void {
  asked.clear()
  queue = Promise.resolve()
}
