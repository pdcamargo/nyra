import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdatesStore } from '../../renderer/src/store/updates'
import { useSettingsStore } from '../../renderer/src/store/settings'

const api = {
  install: vi.fn(),
  stage: vi.fn()
}

const phase = (): ReturnType<typeof useUpdatesStore.getState>['phase'] =>
  useUpdatesStore.getState().phase

describe('the updates store', () => {
  beforeEach(() => {
    api.install.mockReset().mockReturnValue(new Promise(() => {}))
    api.stage.mockReset().mockResolvedValue('0.7.0')
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api: Record<string, unknown> }).api,
      updates: api
    }
    useUpdatesStore.setState({ phase: { kind: 'idle' }, dismissed: null })
    useSettingsStore.setState({ autoUpdate: false })
  })

  it('offers a found release without downloading it when auto-update is off', () => {
    useUpdatesStore.getState().found('0.7.0')
    expect(phase()).toEqual({ kind: 'available', version: '0.7.0' })
    expect(api.stage).not.toHaveBeenCalled()
  })

  it('downloads quietly and waits for quit when auto-update is on', async () => {
    useSettingsStore.setState({ autoUpdate: true })
    useUpdatesStore.getState().found('0.7.0')
    expect(phase()).toMatchObject({ kind: 'downloading', mode: 'stage' })
    await vi.waitFor(() => expect(phase()).toEqual({ kind: 'ready', version: '0.7.0' }))
    expect(api.install).not.toHaveBeenCalled()
  })

  it('does not knock a staged release back to available on a second check', async () => {
    useSettingsStore.setState({ autoUpdate: true })
    useUpdatesStore.getState().found('0.7.0')
    await vi.waitFor(() => expect(phase().kind).toBe('ready'))
    useUpdatesStore.getState().found('0.7.0')
    expect(phase().kind).toBe('ready')
    expect(api.stage).toHaveBeenCalledOnce()
  })

  it('reports a failed install, and retrying installs again', async () => {
    api.install.mockRejectedValueOnce(new Error('offline'))
    useUpdatesStore.getState().found('0.7.0')
    await useUpdatesStore.getState().install()
    expect(phase()).toEqual({ kind: 'failed', version: '0.7.0', message: 'offline', mode: 'restart' })
    useUpdatesStore.getState().retry()
    expect(api.install).toHaveBeenCalledTimes(2)
  })

  it('retries a failed background download as a background download', async () => {
    useSettingsStore.setState({ autoUpdate: true })
    api.stage.mockRejectedValueOnce(new Error('offline'))
    useUpdatesStore.getState().found('0.7.0')
    await vi.waitFor(() => expect(phase()).toMatchObject({ kind: 'failed', mode: 'stage' }))
    useUpdatesStore.getState().retry()
    await vi.waitFor(() => expect(phase().kind).toBe('ready'))
    expect(api.install).not.toHaveBeenCalled()
  })

  it('tracks download progress', () => {
    useSettingsStore.setState({ autoUpdate: true })
    api.stage.mockReturnValue(new Promise(() => {}))
    useUpdatesStore.getState().found('0.7.0')
    useUpdatesStore.getState().progress({ version: '0.7.0', received: 10, total: 40 })
    expect(phase()).toMatchObject({ kind: 'downloading', received: 10, total: 40 })
  })

  it('remembers Later for this version only', () => {
    useUpdatesStore.getState().found('0.7.0')
    useUpdatesStore.getState().dismiss()
    expect(useUpdatesStore.getState().dismissed).toBe('0.7.0')
  })
})
