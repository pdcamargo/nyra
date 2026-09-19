import { create } from 'zustand'
import { useUiStore } from './ui'
import {
  clampBottomHeight,
  clampRail,
  clampWidths,
  usePanelSizesStore,
  PANEL_MINS,
  type PanelKey,
  type PanelSizes,
  type RailKey,
  type RailsOpen
} from './panelSizes'

export type PanelLayout = {
  sidebarWidth: number
  rightPanelWidth: number
  bottomPanelHeight: number
}

/** Matches the window tauri.conf.json opens at, for the non-browser case. */
function viewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1400, height: 900 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function railsOpen(): RailsOpen {
  const ui = useUiStore.getState()
  return { sidebar: ui.projectsPanelOpen, rightPanel: ui.rightPanelOpen }
}

function desiredSizes(): PanelSizes {
  const { sidebarWidth, rightPanelWidth, bottomPanelHeight, flowInspectorWidth, flowPanelWidth } =
    usePanelSizesStore.getState()
  return { sidebarWidth, rightPanelWidth, bottomPanelHeight, flowInspectorWidth, flowPanelWidth }
}

function computeLayout(): PanelLayout {
  const { width, height } = viewport()
  const desired = desiredSizes()
  return {
    ...clampWidths(desired, railsOpen(), width),
    bottomPanelHeight: clampBottomHeight(desired.bottomPanelHeight, height)
  }
}

/**
 * The sizes actually on screen: what the user dragged to, clamped to the window
 * they are looking at right now.
 *
 * Derived rather than stored, so a temporary narrow window never overwrites a
 * width set on a large display — shrink the window and the rails give way, grow
 * it back and they return. Each panel selects its own number, so zustand's
 * identity check means dragging one rail does not re-render the other unless it
 * is genuinely being squeezed.
 */
export const usePanelLayoutStore = create<PanelLayout>()(() => computeLayout())

/** Exported for the tests; otherwise driven by the subscriptions below. */
export function recomputeLayout(): void {
  usePanelLayoutStore.setState(computeLayout())
}

if (typeof window !== 'undefined') {
  usePanelSizesStore.subscribe(recomputeLayout)
  // Opening or closing a rail changes how much room the other one may have.
  useUiStore.subscribe(recomputeLayout)

  let frame = 0
  window.addEventListener('resize', () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      recomputeLayout()
    })
  })
}

/**
 * The two props a handle needs, read on demand rather than subscribed to — so
 * the component rendering a handle never re-renders during the drag it starts.
 *
 * `getSize` reports the *effective* size, so a drag begins where the eye is even
 * when the window is clamping the stored width.
 */
export function handleBinding(key: PanelKey): {
  getSize: () => number
  clamp: (candidate: number) => number
} {
  if (key === 'bottomPanelHeight') {
    return {
      getSize: () => usePanelLayoutStore.getState().bottomPanelHeight,
      clamp: (candidate) => clampBottomHeight(candidate, viewport().height)
    }
  }
  if (key === 'flowInspectorWidth' || key === 'flowPanelWidth') {
    // Not arbitrated against the rails: it sits inside the canvas, so the only
    // thing it can starve is the graph next to it. Half the window is a
    // generous ceiling for a panel holding one node's prompt.
    return {
      getSize: () => usePanelSizesStore.getState()[key],
      clamp: (candidate) =>
        Math.max(
          PANEL_MINS[key],
          Math.min(candidate, Math.max(PANEL_MINS[key], viewport().width / 2))
        )
    }
  }
  const rail: RailKey = key
  return {
    getSize: () => usePanelLayoutStore.getState()[rail],
    clamp: (candidate) => clampRail(rail, candidate, desiredSizes(), railsOpen(), viewport().width)
  }
}
