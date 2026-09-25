/**
 * Async IndexedDB-backed storage for the sessions store's persist middleware.
 *
 * Why IndexedDB: the sessions store persists the entire conversation history
 * (messages, tool results, and base64 image previews). On localStorage that meant
 * synchronous main-thread writes on every mutation, and a ~5–10 MB quota that a
 * few screenshots or a long session could blow, silently dropping sessions.
 *
 * Why one record per chat: it used to be one blob holding every chat, and that
 * blob was re-serialised on every debounced write. Past ~100 MB each write stalled
 * the app, and a boot that could not read the blob back came up empty — and then
 * persisted the emptiness over the history. Now the key the store names holds a
 * small index (every persisted field but `sessions`, plus the chat ids in order),
 * each chat lives under `<name>/<id>`, and a write only touches the chats whose
 * object changed. The store updates sessions immutably, so identity is the diff.
 *
 * A read that has not finished, or failed, never becomes an empty write. zustand's
 * persist calls `setItem` on every `set`, hydrated or not, so anything the store
 * did while a large history was still loading used to be written over it. Writes
 * are dropped until this storage's own read of that name has completed — the
 * hydration that follows replaces that state anyway. If the index cannot be read
 * at all, writing stays off for the rest of the run: the app comes up empty, but
 * the data on disk stays exactly as it was. A single chat that cannot be read is
 * left out of the state and kept in the index, so it is neither shown nor deleted.
 *
 * Falls back to localStorage when IndexedDB is unavailable (e.g. jsdom in tests).
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware'

const DB_NAME = 'nyra'
const STORE = 'kv'
const hasIdb = typeof indexedDB !== 'undefined'

type Op = { key: string; value: string } | { key: string; delete: true }

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

/** Reads several keys in one transaction. A missing key reads as null. */
async function kvGetMany(keys: string[]): Promise<(string | null)[]> {
  if (!hasIdb) return keys.map((k) => localStorage.getItem(k))
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const out: (string | null)[] = new Array(keys.length).fill(null)
    let left = keys.length
    if (left === 0) resolve(out)
    keys.forEach((key, i) => {
      const req = store.get(key)
      req.onsuccess = () => {
        out[i] = (req.result as string | undefined) ?? null
        if (--left === 0) resolve(out)
      }
      req.onerror = () => reject(req.error)
    })
  })
}

/** Applies every op in one transaction, so a write lands whole or not at all. */
async function kvApply(ops: Op[]): Promise<void> {
  if (ops.length === 0) return
  if (!hasIdb) {
    for (const op of ops) {
      if ('delete' in op) localStorage.removeItem(op.key)
      else localStorage.setItem(op.key, op.value)
    }
    return
  }
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const op of ops) {
      if ('delete' in op) store.delete(op.key)
      else store.put(op.value, op.key)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

type Row = { id: string }
type Index<T> = Omit<T, 'sessions'> & { sessionIds: string[] }

const rowKey = (name: string, id: string): string => `${name}/${id}`

/**
 * Build a PersistStorage for a state holding `sessions`, one record per session,
 * that coalesces bursts of writes into one write `throttleMs` after the last change.
 */
export function createSessionsStorage<T extends { sessions: Row[] }>(throttleMs = 800): PersistStorage<T> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, StorageValue<T>>()
  // Per store name: the session object last written (or read) for each id, so a
  // write can tell which chats changed without serialising the ones that did not.
  const written = new Map<string, Map<string, Row>>()
  // What each chat looked like on disk at boot. Hydration rebuilds every session
  // object, so the first write compares text instead of identity — once per chat.
  const booted = new Map<string, Map<string, string>>()
  // Ids in the index whose record could not be read. Kept, never deleted.
  const unreadable = new Map<string, Set<string>>()
  // Names whose read has completed. Nothing is written for a name before that.
  const loaded = new Set<string>()
  const blocked = new Set<string>()

  const block = (name: string, reason: unknown): void => {
    blocked.add(name)
    pending.delete(name)
    const t = timers.get(name)
    if (t) clearTimeout(t)
    timers.delete(name)
    console.error(`[idb] could not read "${name}"; saving is off until restart so the data on disk is kept`, reason)
  }

  const flush = (name: string): void => {
    const value = pending.get(name)
    timers.delete(name)
    pending.delete(name)
    if (value === undefined || !loaded.has(name) || blocked.has(name)) return

    const prev = written.get(name) ?? new Map<string, Row>()
    const boot = booted.get(name)
    const skipped = unreadable.get(name) ?? new Set<string>()
    const { sessions, ...rest } = value.state
    const next = new Map<string, Row>()
    const ops: Op[] = []
    for (const s of sessions) {
      next.set(s.id, s)
      if (prev.get(s.id) === s) continue
      const text = JSON.stringify(s)
      if (boot?.get(s.id) === text) continue
      ops.push({ key: rowKey(name, s.id), value: text })
    }
    for (const id of prev.keys()) {
      if (!next.has(id) && !skipped.has(id)) ops.push({ key: rowKey(name, id), delete: true })
    }
    const index: StorageValue<Index<T>> = {
      ...value,
      state: { ...rest, sessionIds: [...next.keys(), ...[...skipped].filter((id) => !next.has(id))] } as Index<T>
    }
    ops.push({ key: name, value: JSON.stringify(index) })

    // Recorded before the write lands so the next flush diffs against this one; a
    // failure puts the previous map back, and the next flush rewrites the difference.
    written.set(name, next)
    booted.delete(name)
    kvApply(ops).catch((e) => {
      if (written.get(name) === next) written.set(name, prev)
      console.error('[idb] persist failed', e)
    })
  }

  // Best-effort flush of any debounced write when the window goes away.
  if (typeof window !== 'undefined') {
    const flushAll = (): void => {
      for (const name of [...pending.keys()]) flush(name)
    }
    window.addEventListener('pagehide', flushAll)
    window.addEventListener('beforeunload', flushAll)
  }

  const read = async (name: string): Promise<StorageValue<T> | null> => {
    let [raw] = await kvGetMany([name])
    // One-time migration: pull existing data out of the old localStorage backend.
    if (raw == null && hasIdb) {
      const legacy = localStorage.getItem(name)
      if (legacy != null) {
        raw = legacy
        await kvApply([{ key: name, value: legacy }])
        localStorage.removeItem(name)
      }
    }
    if (raw == null) return null

    const stored = JSON.parse(raw) as StorageValue<Index<T> | T>
    const state = stored.state as Partial<Index<T> & T>

    if (Array.isArray(state.sessions)) {
      // The single-blob layout. Split it in one transaction: the blob is only
      // replaced by the index once every chat has a record of its own.
      const sessions = state.sessions as Row[]
      const { sessions: _, ...rest } = state
      const index = { ...stored, state: { ...rest, sessionIds: sessions.map((s) => s.id) } }
      const texts = new Map(sessions.map((s) => [s.id, JSON.stringify(s)]))
      await kvApply([
        ...[...texts].map(([id, value]) => ({ key: rowKey(name, id), value })),
        { key: name, value: JSON.stringify(index) }
      ])
      written.set(name, new Map(sessions.map((s) => [s.id, s])))
      booted.set(name, texts)
      unreadable.set(name, new Set())
      return stored as StorageValue<T>
    }

    const ids = state.sessionIds ?? []
    const rows = await kvGetMany(ids.map((id) => rowKey(name, id)))
    const sessions: Row[] = []
    const boot = new Map<string, string>()
    const skipped = new Set<string>()
    rows.forEach((text, i) => {
      try {
        if (text == null) throw new Error('missing record')
        sessions.push(JSON.parse(text) as Row)
        boot.set(ids[i], text)
      } catch (e) {
        skipped.add(ids[i])
        console.error(`[idb] could not read session ${ids[i]}; leaving it on disk`, e)
      }
    })
    written.set(name, new Map(sessions.map((s) => [s.id, s])))
    booted.set(name, boot)
    unreadable.set(name, skipped)
    const { sessionIds: _, ...rest } = state
    return { ...stored, state: { ...rest, sessions } as unknown as T }
  }

  return {
    getItem: async (name) => {
      try {
        const value = await read(name)
        loaded.add(name)
        return value
      } catch (e) {
        block(name, e)
        return null
      }
    },
    setItem: (name, value) => {
      if (!loaded.has(name) || blocked.has(name)) return
      pending.set(name, value)
      const existing = timers.get(name)
      if (existing) clearTimeout(existing)
      timers.set(name, setTimeout(() => flush(name), throttleMs))
    },
    removeItem: async (name) => {
      const t = timers.get(name)
      if (t) clearTimeout(t)
      timers.delete(name)
      pending.delete(name)
      if (!loaded.has(name) || blocked.has(name)) return
      const ids = new Set([...(written.get(name)?.keys() ?? []), ...(unreadable.get(name) ?? [])])
      written.delete(name)
      await kvApply([...[...ids].map((id) => ({ key: rowKey(name, id), delete: true as const })), { key: name, delete: true }]).catch(
        () => {}
      )
    }
  }
}
