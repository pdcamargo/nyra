/**
 * Value equality for things that get serialised to disk.
 *
 * Exists for one job: deciding whether a save actually changed anything. The
 * flow canvas writes React Flow's state back into the store on every save, and
 * a save happens on every run — so hitting Run twice handed React Flow two
 * brand new `nodes` arrays even when nothing had been edited. New node objects
 * mean new measurements, and until they are re-measured the edges between them
 * have nothing to route around, so the graph renders without its connections.
 *
 * Key order is normalised because the two sides come from different places: one
 * is built by `fromFlowNodes`, the other was parsed from JSON on disk, and they
 * agree on content while disagreeing on the order they list it in.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
      )
    }
    return val
  })
}

/** True when `a` and `b` serialise identically, key order aside. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/**
 * `next` if it differs from `prev`, otherwise `prev` itself.
 *
 * Returning the original reference is the point: downstream effects key off
 * identity, so an unchanged save should be invisible to them.
 */
export function preserveIfSame<T>(next: T, prev: T): T {
  return sameValue(next, prev) ? prev : next
}
