import { create } from 'zustand'
import type { ConfigDir } from '../lib/api-types'

/** One row of Codex's `model/list`, as the backend trims it. */
export type CodexModel = {
  id: string
  displayName: string | null
  description: string | null
  /** The efforts this model takes, lowest first. */
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}

/** One account's list. */
export type CodexModelList = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  models: CodexModel[]
  /** Why there is no list: no Codex installed, too old, not signed in. */
  error: string | null
}

const IDLE: CodexModelList = { status: 'idle', models: [], error: null }

/** A workspace's account, by its config dir; Default is the CLI's own home. */
const keyOf = (configDir: ConfigDir): string => configDir ?? 'default'

type CodexModelsState = {
  byAccount: Record<string, CodexModelList>
  /** Ask once per account. Starting Codex costs a process, so nothing asks until
   *  a picker opens or a Codex chat needs its labels. */
  load: (configDir: ConfigDir) => void
  /** Ask again: the account was signed in, out, or switched. */
  reload: (configDir: ConfigDir) => void
}

export const useCodexModels = create<CodexModelsState>((set, get) => ({
  byAccount: {},
  load: (configDir) => {
    if ((get().byAccount[keyOf(configDir)] ?? IDLE).status !== 'idle') return
    get().reload(configDir)
  },
  reload: (configDir) => {
    const key = keyOf(configDir)
    const put = (list: CodexModelList): void => set((s) => ({ byAccount: { ...s.byAccount, [key]: list } }))
    put({ ...(get().byAccount[key] ?? IDLE), status: 'loading' })
    window.api.codex
      .models(configDir)
      .then((reply) =>
        put(
          reply.available
            ? { status: 'ready', models: reply.models ?? [], error: null }
            : { status: 'unavailable', models: [], error: reply.error ?? null }
        )
      )
      .catch((e: unknown) => put({ status: 'unavailable', models: [], error: String(e) }))
  }
}))

/** One account's list, and the way to ask for it. */
export function useCodexModelsFor(configDir: ConfigDir): CodexModelList & { load: () => void } {
  const list = useCodexModels((s) => s.byAccount[keyOf(configDir)] ?? IDLE)
  const load = useCodexModels((s) => s.load)
  return { ...list, load: () => load(configDir) }
}

/** The model a Codex chat is set to, by id; '' is the account's default. */
export function codexModel(models: CodexModel[], id: string): CodexModel | undefined {
  return id ? models.find((m) => m.id === id) : (models.find((m) => m.isDefault) ?? models[0])
}
