import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  KNOWN_MODELS,
  isNewerModel,
  modelFamily,
  type ModelVersions,
  type OfferedModel
} from '../lib/models'
import { api } from '../lib/tauri-api'

/**
 * What each alias last resolved to, so a label can carry a version number.
 *
 * `--model opus` is a request for "the latest Opus" and the CLI answers it
 * server-side; nothing on this machine knows that today's answer is
 * `claude-opus-5-5`. The one moment it is stated is `system/init`, which
 * reports the resolved id at the start of every turn. So this is a note of what
 * we asked for against what came back, and it is the only way the composer can
 * say `Opus 5.5` without a hardcoded number that goes stale on release day.
 *
 * Persisted because the chip is on screen before you send anything. In memory
 * only — the shape `lib/slashCommands` uses for the same kind of learned fact —
 * every label would lose its number on launch and grow one back mid-turn.
 *
 * Keyed by what was requested, not by model family. Those are different keys on
 * purpose: this app sent no `--model` for months and the CLI's own default
 * resolved to `claude-opus-5`, while `--model opus` resolves to
 * `claude-opus-5-5`. Filing both under `opus` would let the weaker one relabel
 * the alias.
 */
type ModelVersionsStore = {
  /** Requested value (an alias, or '' for the CLI default) → the id it became. */
  resolved: Record<string, string>
  /** Family ('opus') → the newest id seen for it, from any source at all. */
  families: Record<string, string>
  /** Family → what the CLI's own catalog says that alias currently means. */
  catalog: Record<string, string>
  /** The models this account is offered, as the CLI's `/model` lists them. */
  offered: OfferedModel[]
  setCatalog: (catalog: Record<string, string>) => void
  setOffered: (offered: OfferedModel[]) => void
  note: (requested: string, resolved: string) => void
  /** Any resolved id, however it was come by — a subagent's, say. */
  noteId: (id: string) => void
}

/**
 * Only aliases and the default are worth remembering.
 *
 * A pinned id already is its own answer, and recording those would grow a
 * persisted map by one key for every full name anyone ever types.
 */
const isLearnable = (requested: string): boolean =>
  requested === '' || (KNOWN_MODELS as readonly string[]).includes(requested)

/**
 * Whether `next` should replace what a family has on file.
 *
 * Only when it is at least as new. A subagent pinned to `claude-opus-4-6` is
 * evidence that 4.6 exists, not that it is what Opus means now, and filing it
 * last-write-wins put 4.6 on the Opus row over the 5.5 the alias really ran.
 */
const keepsNewest = (current: string | undefined, next: string): boolean =>
  current !== next && (!current || !isNewerModel(current, next))

export const useModelVersionsStore = create<ModelVersionsStore>()(
  persist(
    (set) => ({
      resolved: {},
      families: {},
      catalog: {},
      offered: [],
      setOffered: (offered) =>
        set((state) => (offered.length === 0 ? state : { offered })),
      setCatalog: (catalog) =>
        set((state) => {
          // An empty scan means "this build did not tell us", which must not
          // wipe what a previous one did.
          if (Object.keys(catalog).length === 0) return state
          return { catalog }
        }),
      note: (requested, resolved) =>
        set((state) => {
          if (!resolved) return state
          const family = modelFamily(resolved)
          const next: Partial<ModelVersionsStore> = {}
          // Evidence about the family regardless of what was asked for, which
          // is how a model nobody has selected still gets a number.
          if (family && keepsNewest(state.families[family], resolved)) {
            next.families = { ...state.families, [family]: resolved }
          }
          if (isLearnable(requested) && state.resolved[requested] !== resolved) {
            next.resolved = { ...state.resolved, [requested]: resolved }
          }
          return Object.keys(next).length > 0 ? next : state
        }),
      noteId: (id) =>
        set((state) => {
          const family = modelFamily(id)
          if (!family || !keepsNewest(state.families[family], id)) return state
          return { families: { ...state.families, [family]: id } }
        })
    }),
    {
      name: 'nyra-model-versions',
      partialize: (s) => ({
        resolved: s.resolved,
        families: s.families,
        catalog: s.catalog,
        offered: s.offered
      })
    }
  )
)

/** Record what `system/init` said an alias resolved to, for labelling the picker. */
export function noteModelVersion(requested: string, resolved: string | undefined | null): void {
  if (resolved) useModelVersionsStore.getState().note(requested, resolved)
}

/** Record the account's model list, from the CLI's answer to `initialize`. */
export function noteOfferedModels(models: OfferedModel[] | undefined | null): void {
  if (models?.length) useModelVersionsStore.getState().setOffered(models)
}

/** Record a resolved id seen somewhere other than our own spawn — a subagent's. */
export function noteModelId(id: string | undefined | null): void {
  if (id) useModelVersionsStore.getState().noteId(id)
}

/**
 * Read the CLI's model catalog, once per launch.
 *
 * Persisted as well as fetched, so the picker is not briefly bare on every
 * start; the fetch then corrects it after a CLI update. Failure is silent by
 * design — the labels have a bare name to fall back to and this is the only
 * thing on the path that can be absent without anything being wrong.
 */
export async function loadModelCatalog(): Promise<void> {
  try {
    useModelVersionsStore.getState().setCatalog(await api.claude.modelAliasTargets())
  } catch {
    /* an older binary, or none — bare names, as before */
  }
}

/** What the label helpers take, read as one value so call sites stay short. */
export function useModelVersions(): ModelVersions {
  const resolved = useModelVersionsStore((s) => s.resolved)
  const families = useModelVersionsStore((s) => s.families)
  const catalog = useModelVersionsStore((s) => s.catalog)
  const offered = useModelVersionsStore((s) => s.offered)
  return { resolved, families, catalog, offered }
}
