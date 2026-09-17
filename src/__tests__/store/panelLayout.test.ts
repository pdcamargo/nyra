import { describe, expect, it, beforeEach } from 'vitest'
import { handleBinding, recomputeLayout, usePanelLayoutStore } from '@renderer/store/panelLayout'
import { CHAT_MIN_WIDTH, PANEL_DEFAULTS, PANEL_MINS, usePanelSizesStore } from '@renderer/store/panelSizes'
import { useUiStore } from '@renderer/store/ui'

function windowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  recomputeLayout()
}

beforeEach(() => {
  usePanelSizesStore.setState(PANEL_DEFAULTS)
  useUiStore.setState({ projectsPanelOpen: true, rightPanelOpen: true })
  windowSize(1400, 900)
})

describe('usePanelLayoutStore', () => {
  it('starts from the persisted sizes when the window has room', () => {
    expect(usePanelLayoutStore.getState()).toEqual({
      sidebarWidth: 256,
      rightPanelWidth: 256,
      bottomPanelHeight: 250
    })
  })

  it('follows a drag', () => {
    usePanelSizesStore.getState().setSize('sidebarWidth', 400)
    expect(usePanelLayoutStore.getState().sidebarWidth).toBe(400)
  })

  it('reports 0 for a closed rail and frees the space for the other', () => {
    usePanelSizesStore.setState({ sidebarWidth: 400, rightPanelWidth: 400 })
    windowSize(900, 900)
    expect(usePanelLayoutStore.getState()).toMatchObject({ sidebarWidth: 340, rightPanelWidth: 200 })

    useUiStore.setState({ rightPanelOpen: false })
    expect(usePanelLayoutStore.getState()).toMatchObject({ sidebarWidth: 400, rightPanelWidth: 0 })
  })

  it('gives the rails back when the window grows again', () => {
    usePanelSizesStore.setState({ sidebarWidth: 400, rightPanelWidth: 400 })
    windowSize(900, 900)
    expect(usePanelLayoutStore.getState().sidebarWidth).toBe(340)

    windowSize(1600, 900)
    expect(usePanelLayoutStore.getState()).toMatchObject({ sidebarWidth: 400, rightPanelWidth: 400 })
    // The point of the whole exercise: the narrow window left no trace.
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(400)
  })

  it('keeps the conversation its floor however the rails are dragged', () => {
    usePanelSizesStore.setState({ sidebarWidth: 2000, rightPanelWidth: 2000 })
    windowSize(1000, 900)
    const { sidebarWidth, rightPanelWidth } = usePanelLayoutStore.getState()
    expect(1000 - sidebarWidth - rightPanelWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH)
  })

  it('clamps the bottom dock to the window height', () => {
    usePanelSizesStore.getState().setSize('bottomPanelHeight', 5000)
    expect(usePanelLayoutStore.getState().bottomPanelHeight).toBe(900 - 200)
    windowSize(1400, 400)
    expect(usePanelLayoutStore.getState().bottomPanelHeight).toBe(200)
  })
})

describe('handleBinding', () => {
  it('reads the size on screen, not the one in the store', () => {
    usePanelSizesStore.setState({ sidebarWidth: 400, rightPanelWidth: 400 })
    windowSize(900, 900)
    expect(handleBinding('sidebarWidth').getSize()).toBe(340)
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(400)
  })

  it('stops a rail drag at the space the other rail is using', () => {
    usePanelSizesStore.setState({ rightPanelWidth: 400 })
    expect(handleBinding('sidebarWidth').clamp(9999)).toBe(1400 - CHAT_MIN_WIDTH - 400)
    expect(handleBinding('sidebarWidth').clamp(-50)).toBe(PANEL_MINS.sidebarWidth)
  })

  it('lets a rail have the whole budget once the other is closed', () => {
    useUiStore.setState({ rightPanelOpen: false })
    expect(handleBinding('sidebarWidth').clamp(9999)).toBe(1400 - CHAT_MIN_WIDTH)
  })

  it('bounds the bottom dock the way the old inline drag did', () => {
    expect(handleBinding('bottomPanelHeight').clamp(9999)).toBe(900 - 200)
    expect(handleBinding('bottomPanelHeight').clamp(1)).toBe(PANEL_MINS.bottomPanelHeight)
  })
})
