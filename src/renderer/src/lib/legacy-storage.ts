/**
 * One-time rename of the browser-side storage keys.
 *
 * Every persisted key used to carry a `coide-` prefix, and the sessions
 * IndexedDB database was called `coide`. Renaming them would not lose the data —
 * it would leave it on disk and unreachable, which reads to the user as "the app
 * forgot everything". So each key is carried to its new name once.
 *
 * Ordering matters twice over:
 *   - `migrateLocalStorage` has to run before any store module is evaluated,
 *     because zustand's persist middleware reads localStorage synchronously as
 *     the store is created. `main.tsx` imports this above `./App` for that
 *     reason, and the call sits at the bottom of this file rather than in
 *     `main.tsx`'s body, which runs after every import.
 *   - `migrateSessionsDb` has to run before `useSessionsStore.persist.rehydrate()`,
 *     which `App.tsx` now awaits it in front of.
 *
 * Both are idempotent, and both can go once no install is old enough to still be
 * holding the old names.
 */

const LOCAL_KEYS = ['settings', 'ui', 'panel-sizes', 'workspace', 'shortcuts'] as const

const OLD_DB = 'coide'
const NEW_DB = 'nyra'
const DB_STORE = 'kv'
const OLD_SESSIONS_KEY = 'coide-sessions'
const NEW_SESSIONS_KEY = 'nyra-sessions'

/** The synchronous half — the small, settings-shaped stores. */
export function migrateLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  for (const key of LOCAL_KEYS) {
    try {
      const carried = localStorage.getItem(`coide-${key}`)
      if (carried === null) continue
      // Only an absent new key makes this a migration rather than a clobber: a
      // second launch must not overwrite real state with something stale.
      if (localStorage.getItem(`nyra-${key}`) === null) {
        localStorage.setItem(`nyra-${key}`, carried)
      }
      // The old key is copied, never deleted: a rollback to an older build should
      // still find its settings, panel sizes and shortcuts, and five small keys of
      // dead bytes are cheaper than losing them. (Not, as this once claimed,
      // because dev shares a WebKit store with the installed app. It does not —
      // an unbundled binary gets its own, keyed on the executable name.)
    } catch {
      // A quota or security error is survivable here — the app comes up on
      // defaults, rather than not coming up.
    }
  }
}

function openDb(name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = create ? indexedDB.open(name, 1) : indexedDB.open(name)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

function get(db: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Opening an old database without a version gives you whatever is there,
    // which on a fresh install is a database with no object store at all.
    if (!db.objectStoreNames.contains(DB_STORE)) {
      resolve(null)
      return
    }
    try {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function put(db: IDBDatabase, key: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

/**
 * The asynchronous half — the conversation history, which is the one piece of
 * state whose loss would actually hurt. The old database is left intact: a copy
 * is cheap, and it means a downgrade still finds its sessions.
 */
export async function migrateSessionsDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return

  const next = await openDb(NEW_DB, true)
  if (!next) return
  if ((await get(next, NEW_SESSIONS_KEY)) !== null) {
    next.close()
    return
  }

  const prev = await openDb(OLD_DB, false)
  if (!prev) {
    next.close()
    return
  }
  const carried = await get(prev, OLD_SESSIONS_KEY)
  prev.close()

  if (carried !== null) await put(next, NEW_SESSIONS_KEY, carried)
  next.close()
}

// Runs on import, not on call — see the ordering note above.
migrateLocalStorage()
