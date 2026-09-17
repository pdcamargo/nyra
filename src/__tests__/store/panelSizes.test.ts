import { describe, expect, it, beforeEach } from 'vitest'
import {
  CHAT_MIN_WIDTH,
  PANEL_DEFAULTS,
  PANEL_MINS,
  clampBottomHeight,
  clampRail,
  clampWidths,
  mergePanelSizes,
  railDragMax,
  usePanelSizesStore,
  type PanelSizes,
  type RailsOpen
} from '@renderer/store/panelSizes'

const BOTH: RailsOpen = { sidebar: true, rightPanel: true }
const sizes = (partial: Partial<PanelSizes> = {}): PanelSizes => ({ ...PANEL_DEFAULTS, ...partial })

beforeEach(() => usePanelSizesStore.setState(PANEL_DEFAULTS))

describe('clampWidths', () => {
  it('leaves the defaults alone on a window they comfortably fit', () => {
    expect(clampWidths(sizes(), BOTH, 1400)).toEqual({ sidebarWidth: 256, rightPanelWidth: 256 })
  })

  it('leaves the defaults alone at the narrowest window the app opens at', () => {
    // 1024 is where clamping would start to bite if CHAT_MIN_WIDTH were raised
    // to Chat's own --col-min. It is deliberately lower so this stays untouched.
    expect(clampWidths(sizes(), BOTH, 1024)).toEqual({ sidebarWidth: 256, rightPanelWidth: 256 })
  })

  it('makes both rails give way rather than starve the conversation', () => {
    const effective = clampWidths(sizes({ sidebarWidth: 400, rightPanelWidth: 400 }), BOTH, 900)
    expect(effective).toEqual({ sidebarWidth: 340, rightPanelWidth: 200 })
    expect(900 - effective.sidebarWidth - effective.rightPanelWidth).toBe(CHAT_MIN_WIDTH)
  })

  it('never takes a rail below its own minimum, even when nothing fits', () => {
    const effective = clampWidths(sizes({ sidebarWidth: 400, rightPanelWidth: 400 }), BOTH, 400)
    expect(effective).toEqual({ sidebarWidth: PANEL_MINS.sidebarWidth, rightPanelWidth: PANEL_MINS.rightPanelWidth })
  })

  it('reports a closed rail as 0 and lets the open one keep its full width', () => {
    const desired = sizes({ sidebarWidth: 400, rightPanelWidth: 400 })
    expect(clampWidths(desired, { sidebar: true, rightPanel: false }, 900)).toEqual({
      sidebarWidth: 400,
      rightPanelWidth: 0
    })
    // ...and reopening squeezes it again, because nothing was written back.
    expect(clampWidths(desired, BOTH, 900)).toEqual({ sidebarWidth: 340, rightPanelWidth: 200 })
  })

  it('does not mutate what it was handed', () => {
    const desired = sizes({ sidebarWidth: 400, rightPanelWidth: 400 })
    clampWidths(desired, BOTH, 900)
    expect(desired).toEqual(sizes({ sidebarWidth: 400, rightPanelWidth: 400 }))
  })

  it('never writes the clamped width back to the store', () => {
    // The whole design rests on this: a laptop screen must not destroy a layout
    // set on a large display.
    usePanelSizesStore.getState().setSize('sidebarWidth', 400)
    expect(clampWidths(sizes({ sidebarWidth: 400 }), BOTH, 900).sidebarWidth).toBe(340)
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(400)
  })
})

describe('railDragMax', () => {
  it('stops a drag at the space the other rail is actually using', () => {
    // Not at `viewport - CHAT_MIN - rightMin`: that would let the sidebar eat
    // into the workspace panel, which would then jump on the next frame.
    const desired = sizes({ sidebarWidth: 256, rightPanelWidth: 400 })
    expect(railDragMax('sidebarWidth', desired, BOTH, 1400)).toBe(1400 - CHAT_MIN_WIDTH - 400)
  })

  it('holds still as the dragged rail grows, so the ceiling does not chase the handle', () => {
    const at = (sidebarWidth: number): number =>
      railDragMax('sidebarWidth', sizes({ sidebarWidth, rightPanelWidth: 300 }), BOTH, 1400)
    expect(at(600)).toBe(at(200))
  })

  it('leaves the other rail exactly where it was when the drag hits the ceiling', () => {
    const desired = sizes({ sidebarWidth: 256, rightPanelWidth: 400 })
    const max = railDragMax('sidebarWidth', desired, BOTH, 1400)
    const after = clampWidths({ ...desired, sidebarWidth: max }, BOTH, 1400)
    expect(after).toEqual({ sidebarWidth: max, rightPanelWidth: 400 })
  })

  it('is symmetric for the workspace panel', () => {
    const desired = sizes({ sidebarWidth: 400, rightPanelWidth: 256 })
    expect(railDragMax('rightPanelWidth', desired, BOTH, 1400)).toBe(1400 - CHAT_MIN_WIDTH - 400)
  })
})

describe('clampRail', () => {
  it('bounds a candidate at both ends', () => {
    const desired = sizes()
    expect(clampRail('sidebarWidth', 10, desired, BOTH, 1400)).toBe(PANEL_MINS.sidebarWidth)
    expect(clampRail('sidebarWidth', 9999, desired, BOTH, 1400)).toBe(1400 - CHAT_MIN_WIDTH - 256)
    expect(clampRail('sidebarWidth', 300, desired, BOTH, 1400)).toBe(300)
  })
})

describe('clampBottomHeight', () => {
  it('matches the clamp the drag already used', () => {
    const old = (h: number, vh: number): number => Math.max(120, Math.min(vh - 200, h))
    for (const [h, vh] of [[250, 900], [50, 900], [5000, 900], [250, 300], [120, 320]]) {
      expect(clampBottomHeight(h, vh)).toBe(old(h, vh))
    }
  })

  it('keeps the minimum even when the window cannot honour it', () => {
    expect(clampBottomHeight(250, 200)).toBe(PANEL_MINS.bottomPanelHeight)
  })
})

describe('mergePanelSizes', () => {
  const current = (): ReturnType<typeof usePanelSizesStore.getState> => usePanelSizesStore.getState()

  it('keeps a plausible stored size', () => {
    expect(mergePanelSizes({ sidebarWidth: 320 }, current()).sidebarWidth).toBe(320)
  })

  it('falls back to the default for anything we would not have written', () => {
    for (const bad of [NaN, null, undefined, -1, 0, 1e9, Infinity, '300', {}]) {
      expect(mergePanelSizes({ sidebarWidth: bad }, current()).sidebarWidth).toBe(PANEL_DEFAULTS.sidebarWidth)
    }
  })

  it('survives a blob that is not an object at all', () => {
    expect(mergePanelSizes(undefined, current())).toMatchObject(PANEL_DEFAULTS)
    expect(mergePanelSizes(null, current())).toMatchObject(PANEL_DEFAULTS)
  })

  it('ignores a stray key and keeps the actions', () => {
    const merged = mergePanelSizes({ sidebarWidth: 300, retired: 'gone' }, current())
    expect('retired' in merged).toBe(false)
    expect(typeof merged.setSize).toBe('function')
  })

  it('never yields a size that would render a zero-width panel', () => {
    // NaN survives every Math.min/max downstream and style={{ width: NaN }}
    // renders nothing, with no error to go on.
    const merged = mergePanelSizes({ sidebarWidth: NaN, rightPanelWidth: NaN, bottomPanelHeight: NaN }, current())
    for (const value of [merged.sidebarWidth, merged.rightPanelWidth, merged.bottomPanelHeight]) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
  })
})

describe('usePanelSizesStore', () => {
  it('starts at the widths the panels used to hardcode', () => {
    expect(PANEL_DEFAULTS.sidebarWidth).toBe(256) // w-64
    expect(PANEL_DEFAULTS.rightPanelWidth).toBe(256) // w-64
    expect(PANEL_DEFAULTS.bottomPanelHeight).toBe(250) // useState(250)
  })

  it('sets and resets one panel without touching the others', () => {
    usePanelSizesStore.getState().setSize('sidebarWidth', 333)
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(333)
    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(PANEL_DEFAULTS.rightPanelWidth)
    usePanelSizesStore.getState().resetSize('sidebarWidth')
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(PANEL_DEFAULTS.sidebarWidth)
  })

  it('persists under a key that starts with nyra', () => {
    usePanelSizesStore.getState().setSize('bottomPanelHeight', 321)
    const raw = localStorage.getItem('nyra-panel-sizes')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).state.bottomPanelHeight).toBe(321)
  })
})
