import { describe, expect, it, vi, beforeEach } from 'vitest'
import { handleAppRequest } from '@renderer/lib/appControl'
import { useUiStore } from '@renderer/store/ui'
import { useSettingsStore } from '@renderer/store/settings'
import { useWorkflowStore } from '@renderer/store/workflow'
import {
  PANEL_DEFAULTS,
  PANEL_MINS,
  usePanelSizesStore
} from '@renderer/store/panelSizes'

const load = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useWorkflowStore.setState({ isCanvasOpen: false, currentWorkflow: null })
  ;(window as unknown as { api: unknown }).api = { workflow: { load } }
})

/**
 * The renderer half of the bridge. Rust owns flows and the updater; everything
 * here is state only this process can see, so these ops are the whole of what
 * "Claude can drive Nyra" actually means.
 */
describe('app control ops', () => {
  it('reports what is on screen', async () => {
    useUiStore.getState().setBottomPanelOpen(true)
    useUiStore.getState().setSummaryOpen(false)
    useSettingsStore.getState().updateSettings({ theme: 'light' })

    const state = (await handleAppRequest('state', {})) as Record<string, never>
    expect(state.panels).toMatchObject({ terminal: true, summary: false })
    expect(state.theme).toMatchObject({ preference: 'light', showing: 'light' })
    expect(state.view).toBe('chat')
  })

  it('resolves what "system" is actually showing, not just the preference', async () => {
    useSettingsStore.getState().updateSettings({ theme: 'system' })
    const state = (await handleAppRequest('state', {})) as { theme: Record<string, string> }
    expect(state.theme.preference).toBe('system')
    expect(['light', 'dark']).toContain(state.theme.showing)
  })

  it('runs a command with intent rather than flipping it', async () => {
    useUiStore.getState().setBottomPanelOpen(true)
    await handleAppRequest('run', { command: 'panel.bottom', on: true })
    expect(useUiStore.getState().bottomPanelOpen).toBe(true)
  })

  it('passes the denial through instead of running a closed command', async () => {
    const outcome = (await handleAppRequest('run', { command: 'session.abort' })) as {
      ok: boolean
      error: string
    }
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/stopping itself/i)
  })

  it('lists commands without their implementations', async () => {
    const commands = (await handleAppRequest('commands', {})) as { id: string }[]
    expect(commands.some((c) => c.id === 'panel.bottom')).toBe(true)
    expect(commands.some((c) => c.id === 'session.abort')).toBe(false)
    expect(commands.every((c) => !('run' in c))).toBe(true)
  })

  it('opens a flow by loading it and switching the view', async () => {
    load.mockResolvedValue({ id: 'wf-3', name: 'Digest', nodes: [], edges: [] })
    await handleAppRequest('open_flow', { id: 'wf-3' })
    expect(useWorkflowStore.getState().isCanvasOpen).toBe(true)
    expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-3')
  })

  it('says so when the flow is not there, rather than opening an empty canvas', async () => {
    load.mockResolvedValue(null)
    await expect(handleAppRequest('open_flow', { id: 'ghost' })).rejects.toThrow(/ghost/)
  })

  it('refuses an op it does not have', async () => {
    await expect(handleAppRequest('rm_rf', {})).rejects.toThrow(/unknown op/)
  })
})

describe('panels the model can size itself', () => {
  beforeEach(() => {
    usePanelSizesStore.getState().resetSize('rightPanelWidth')
    usePanelSizesStore.getState().resetSize('sidebarWidth')
  })

  it('reports each rail with its floor, so a resize can be chosen not guessed', async () => {
    const layout = (await handleAppRequest('layout', {})) as {
      panels: Record<string, { px: number; min: number; open: boolean }>
      defaults: Record<string, number>
    }
    expect(layout.panels.rightPanelWidth.px).toBe(PANEL_DEFAULTS.rightPanelWidth)
    expect(layout.panels.rightPanelWidth.min).toBe(PANEL_MINS.rightPanelWidth)
    expect(layout.defaults).toMatchObject(PANEL_DEFAULTS)
  })

  it('resizes a rail through the same store a drag uses', async () => {
    await handleAppRequest('resize', { panel: 'rightPanelWidth', px: 640 })
    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(640)
  })

  /**
   * The model gets no privilege the pointer does not have. Otherwise "make the
   * panel bigger" could leave the chat narrower than anyone could drag it back
   * from.
   */
  it('will not take a rail below the floor a drag enforces', async () => {
    await handleAppRequest('resize', { panel: 'rightPanelWidth', px: 10 })
    expect(usePanelSizesStore.getState().rightPanelWidth).toBe(PANEL_MINS.rightPanelWidth)
  })

  it('rounds, and refuses a size that is not a number', async () => {
    await handleAppRequest('resize', { panel: 'sidebarWidth', px: 300.6 })
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(301)
    await expect(handleAppRequest('resize', { panel: 'sidebarWidth' })).rejects.toThrow(/px/)
    await expect(
      handleAppRequest('resize', { panel: 'sidebarWidth', px: Number.NaN })
    ).rejects.toThrow(/px/)
  })

  it('resets one to its default', async () => {
    await handleAppRequest('resize', { panel: 'sidebarWidth', px: 400 })
    await handleAppRequest('resize', { panel: 'sidebarWidth', reset: true })
    expect(usePanelSizesStore.getState().sidebarWidth).toBe(PANEL_DEFAULTS.sidebarWidth)
  })

  it('names the panels it accepts rather than failing vaguely', async () => {
    await expect(handleAppRequest('resize', { panel: 'nope', px: 300 })).rejects.toThrow(
      /rightPanelWidth/
    )
  })
})
