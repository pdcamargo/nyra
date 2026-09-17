import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PanelKey = 'sidebarWidth' | 'rightPanelWidth' | 'bottomPanelHeight'
export type RailKey = Exclude<PanelKey, 'bottomPanelHeight'>
export type PanelSizes = Record<PanelKey, number>
export type RailsOpen = { sidebar: boolean; rightPanel: boolean }

/** 256 is what `w-64` resolved to before the rails could be dragged. */
export const PANEL_DEFAULTS: PanelSizes = {
  sidebarWidth: 256,
  rightPanelWidth: 256,
  bottomPanelHeight: 250
}

/** 120 is the floor the bottom panel's drag already used. */
export const PANEL_MINS: PanelSizes = {
  sidebarWidth: 180,
  rightPanelWidth: 200,
  bottomPanelHeight: 120
}

/**
 * What the conversation keeps for itself, whatever the rails want.
 *
 * Deliberately below Chat's own --col-min (34rem / 544px): this is a hard floor,
 * not a comfort target. Anything much above 520 would leave both rails stuck at
 * their minimums in the smallest window tauri.conf.json allows (900px), since
 * those minimums already claim 380 of it.
 */
export const CHAT_MIN_WIDTH = 360

/** The 200 that was baked into the bottom panel's `innerHeight - 200`. */
export const CHAT_MIN_HEIGHT = 200

/**
 * Beyond any plausible rail on any display. A stored value this large means the
 * blob is corrupt, not that someone had a very wide monitor.
 */
const MAX_PANEL_PX = 4000

type PanelSizesStore = PanelSizes & {
  setSize: (key: PanelKey, px: number) => void
  resetSize: (key: PanelKey) => void
}

/**
 * Guard against a value that would poison the arithmetic.
 *
 * NaN is the one that matters: it survives every Math.min/max downstream, and
 * `style={{ width: NaN }}` renders a zero-width panel with no console error — so
 * a corrupt blob would look like the panel had simply vanished.
 */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A *stored* size, or the default if it is anything we would not have written.
 *
 * Only for reading a persisted blob. A live drag candidate below the minimum
 * means the pointer went past the edge and should clamp to the minimum — it must
 * not jump back to the default, so the clamps below use `finite` instead.
 */
function sane(key: PanelKey, value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= PANEL_MINS[key] &&
    value <= MAX_PANEL_PX
    ? value
    : PANEL_DEFAULTS[key]
}

/**
 * The widths to actually render, given what else is on screen. 0 for a closed
 * rail, so callers can feed the result straight to `--rail`.
 *
 * Sequential rather than proportional: the workspace panel is the one that
 * yields. Asymmetric on purpose — sharing the shortfall between both rails needs
 * iteration to respect each minimum, and "the right one gives way" is at least
 * predictable.
 *
 * The result is never written back to the store. The width you dragged to
 * outlives a narrow window, so plugging into a projector does not quietly
 * destroy a layout set on a large display.
 */
export function clampWidths(
  desired: PanelSizes,
  open: RailsOpen,
  viewportWidth: number
): { sidebarWidth: number; rightPanelWidth: number } {
  const budget = viewportWidth - CHAT_MIN_WIDTH
  const rightReserve = open.rightPanel ? PANEL_MINS.rightPanelWidth : 0
  const sidebarWidth = open.sidebar
    ? Math.max(PANEL_MINS.sidebarWidth, Math.min(finite(desired.sidebarWidth, PANEL_DEFAULTS.sidebarWidth), budget - rightReserve))
    : 0
  const rightPanelWidth = open.rightPanel
    ? Math.max(
        PANEL_MINS.rightPanelWidth,
        Math.min(finite(desired.rightPanelWidth, PANEL_DEFAULTS.rightPanelWidth), budget - sidebarWidth)
      )
    : 0
  return { sidebarWidth, rightPanelWidth }
}

/**
 * The ceiling for a live drag — deliberately not the same rule as clampWidths.
 *
 * Using the other rail's *minimum* here would let you drag this rail into space
 * the other one is currently using, and the next frame would squash it down: you
 * drag one handle and a different panel jumps. So leave the other rail the width
 * it is actually using.
 *
 * The dragged rail is pinned to its own minimum while measuring the other, so
 * the ceiling stays put instead of chasing the handle as the drag proceeds.
 *
 * Consequence, accepted: when the other rail is genuinely huge this one cannot
 * grow until you shrink that one first. Pushing the far rail is a non-goal.
 */
export function railDragMax(
  key: RailKey,
  desired: PanelSizes,
  open: RailsOpen,
  viewportWidth: number
): number {
  const otherKey: RailKey = key === 'sidebarWidth' ? 'rightPanelWidth' : 'sidebarWidth'
  const other = clampWidths({ ...desired, [key]: PANEL_MINS[key] }, open, viewportWidth)[otherKey]
  return Math.max(PANEL_MINS[key], viewportWidth - CHAT_MIN_WIDTH - other)
}

export function clampRail(
  key: RailKey,
  candidate: number,
  desired: PanelSizes,
  open: RailsOpen,
  viewportWidth: number
): number {
  const ceiling = railDragMax(key, desired, open, viewportWidth)
  return Math.max(PANEL_MINS[key], Math.min(finite(candidate, PANEL_DEFAULTS[key]), ceiling))
}

/** Parity with the clamp the bottom panel's drag already used. */
export function clampBottomHeight(candidate: number, viewportHeight: number): number {
  return Math.max(
    PANEL_MINS.bottomPanelHeight,
    Math.min(finite(candidate, PANEL_DEFAULTS.bottomPanelHeight), viewportHeight - CHAT_MIN_HEIGHT)
  )
}

/**
 * Fold a persisted blob into the defaults.
 *
 * Exported so the coercion stays tested: everything downstream assumes these
 * three are finite numbers.
 */
export function mergePanelSizes(persisted: unknown, current: PanelSizesStore): PanelSizesStore {
  const raw = (persisted ?? {}) as Partial<Record<PanelKey, unknown>>
  return {
    ...current,
    sidebarWidth: sane('sidebarWidth', raw.sidebarWidth),
    rightPanelWidth: sane('rightPanelWidth', raw.rightPanelWidth),
    bottomPanelHeight: sane('bottomPanelHeight', raw.bottomPanelHeight)
  }
}

/**
 * The sizes the user dragged to — not necessarily the ones on screen.
 *
 * Kept apart from the ui store on purpose: folding these in would persist
 * `paletteOpen`, `settingsOpen` and `pendingInputPrefill` too, none of which
 * should survive a restart.
 */
export const usePanelSizesStore = create<PanelSizesStore>()(
  persist(
    (set) => ({
      ...PANEL_DEFAULTS,
      setSize: (key, px) => set({ [key]: px } as Partial<PanelSizes>),
      resetSize: (key) => set({ [key]: PANEL_DEFAULTS[key] } as Partial<PanelSizes>)
    }),
    {
      name: 'nyra-panel-sizes',
      merge: (persisted, current) => mergePanelSizes(persisted, current as PanelSizesStore)
    }
  )
)
