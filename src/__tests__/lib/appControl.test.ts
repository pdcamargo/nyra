import { describe, expect, it, vi, beforeEach } from 'vitest'
import { handleAppRequest } from '@renderer/lib/appControl'
import { useUiStore } from '@renderer/store/ui'
import { useSettingsStore } from '@renderer/store/settings'
import { useWorkflowStore } from '@renderer/store/workflow'

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
