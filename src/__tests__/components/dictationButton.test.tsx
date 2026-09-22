import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DictationButton from '@renderer/components/DictationButton'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useDictationStore } from '@renderer/store/dictation'
import { useSettingsStore } from '@renderer/store/settings'
import { useUiStore } from '@renderer/store/ui'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { DictationEvent, DictationStatus } from '@renderer/lib/tauri-api'

/** Icon-only controls carry real tooltips, and Radix needs the provider App
 *  mounts at the root. Rendering a slice of the tree has to supply it. */
const render = (): ReturnType<typeof rtlRender> =>
  rtlRender(
    <TooltipProvider>
      <DictationButton />
    </TooltipProvider>
  )

const CATALOGUE = [
  { id: 'turbo', file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Turbo', bytes: 574_041_195, note: '' },
  { id: 'base', file: 'ggml-base.bin', label: 'Base', bytes: 147_951_465, note: '' }
]

let listeners: ((e: DictationEvent) => void)[] = []
const dictation = {
  start: vi.fn().mockResolvedValue({ ok: true }),
  stop: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
  status: vi.fn(),
  modelDownload: vi.fn().mockResolvedValue({ ok: true }),
  modelCancel: vi.fn().mockResolvedValue(undefined),
  onEvent: (cb: (e: DictationEvent) => void) => {
    listeners.push(cb)
    return () => {
      listeners = listeners.filter((l) => l !== cb)
    }
  }
}

const fire = async (event: DictationEvent): Promise<void> => {
  await act(async () => {
    for (const l of [...listeners]) l(event)
  })
}

const status = (over: Partial<DictationStatus> = {}): DictationStatus => ({
  model: 'turbo',
  installed: true,
  downloading: false,
  bytes: 574_041_195,
  label: 'Turbo',
  catalogue: CATALOGUE,
  recording: false,
  devices: [],
  ...over
})

beforeEach(() => {
  listeners = []
  vi.clearAllMocks()
  dictation.status.mockResolvedValue(status())
  ;(window as unknown as { api: unknown }).api = {
    dictation,
    fs: { listFiles: vi.fn().mockResolvedValue([]) }
  }
  useSettingsStore.setState(DEFAULT_SETTINGS)
  useDictationStore.getState().reset()
  useUiStore.setState({ pendingInputPrefill: null })
})

afterEach(() => {
  useDictationStore.getState().reset()
})

describe('DictationButton', () => {
  it('offers the download before it offers the microphone', async () => {
    dictation.status.mockResolvedValue(status({ installed: false }))
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('button', { name: /dictate/i }))

    // The size is the whole point of asking rather than just downloading.
    expect(await screen.findByText(/547 MB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(dictation.start).not.toHaveBeenCalled()
  })

  it('cancelling the prompt starts nothing', async () => {
    dictation.status.mockResolvedValue(status({ installed: false }))
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: /dictate/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(dictation.modelDownload).not.toHaveBeenCalled()
    expect(dictation.start).not.toHaveBeenCalled()
  })

  it('records straight away once the model is there', async () => {
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('button', { name: /dictate/i }))

    await waitFor(() => expect(dictation.start).toHaveBeenCalledTimes(1))
    expect(dictation.start.mock.calls[0][0]).toMatchObject({ model: 'turbo' })
  })

  it('a second click stops rather than starting again', async () => {
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    await fire({ type: 'recording_started' })

    await userEvent.click(screen.getByRole('button', { name: /stop dictating/i }))

    expect(dictation.stop).toHaveBeenCalledTimes(1)
    expect(dictation.start).not.toHaveBeenCalled()
  })

  it('escape throws the recording away instead of transcribing it', async () => {
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    await fire({ type: 'recording_started' })

    await userEvent.keyboard('{Escape}')

    expect(dictation.cancel).toHaveBeenCalledTimes(1)
    expect(dictation.stop).not.toHaveBeenCalled()
  })

  it('a finished transcript lands in the composer', async () => {
    render()
    await fire({ type: 'transcript', text: '  refactor the ComposerBar  ' })

    expect(useUiStore.getState().pendingInputPrefill).toBe('refactor the ComposerBar')
    expect(useDictationStore.getState().phase).toBe('idle')
  })

  /**
   * The silence guard reports an empty transcript. Appending it would put a
   * stray space in the composer and make the feature look like it half-worked.
   */
  it('an empty transcript appends nothing', async () => {
    render()
    await fire({ type: 'transcript', text: '   ' })

    expect(useUiStore.getState().pendingInputPrefill).toBeNull()
  })

  it('shows recording with a fill and a foreground step, not a fill alone', async () => {
    render()
    await fire({ type: 'recording_started' })

    const button = screen.getByRole('button', { name: /stop dictating/i })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button.className).toContain('bg-danger/10')
    expect(button.className).toContain('text-danger')
    // The pill carries the state, so the composer needs no banner for it.
    expect(screen.getByText('Listening')).toBeInTheDocument()
  })

  /**
   * A microphone that is refused, muted, or simply the wrong device all feed
   * back exact silence. Without this the pill says "Listening" for as long as
   * you care to talk and then produces nothing, which is the failure this
   * feature is most likely to hit in the wild.
   */
  it('says so when the microphone is feeding it silence', async () => {
    render()
    await fire({ type: 'recording_started' })
    await fire({ type: 'no_signal', device: 'MacBook Pro Microphone' })

    expect(screen.getByText('No sound')).toBeInTheDocument()
    expect(screen.queryByText('Listening')).not.toBeInTheDocument()
  })

  it('ignores a no-signal event that arrives after recording stopped', async () => {
    render()
    await fire({ type: 'recording_started' })
    await fire({ type: 'transcript', text: 'hello' })
    await fire({ type: 'no_signal', device: 'MacBook Pro Microphone' })

    expect(useDictationStore.getState().silentDevice).toBeNull()
  })

  /**
   * Rust owns the microphone. If the renderer reloads mid-recording the store
   * resets but the capture thread does not, which would leave a hot mic with
   * nothing on screen reporting it.
   */
  it('adopts a recording Rust already had open', async () => {
    dictation.status.mockResolvedValue(status({ recording: true }))
    render()

    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'))
    expect(await screen.findByRole('button', { name: /stop dictating/i })).toBeInTheDocument()
  })

  it('is inert while transcribing', async () => {
    render()
    await fire({ type: 'recording_started' })
    await fire({ type: 'transcribing' })

    expect(screen.getByRole('button', { name: /transcribing/i })).toBeDisabled()
  })

  it('reports download progress on the button and will not record mid-download', async () => {
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    act(() => useDictationStore.getState().startDownload('turbo'))
    await fire({ type: 'model_progress', model: 'turbo', received: 50, total: 200 })

    const button = screen.getByRole('button', { name: /downloading.*25%/i })
    await userEvent.click(button)
    expect(dictation.start).not.toHaveBeenCalled()
  })

  /** A late event from a cancelled download must not revive the bar. */
  it('ignores progress for a model that is not the one downloading', async () => {
    render()
    act(() => useDictationStore.getState().startDownload('turbo'))
    await fire({ type: 'model_progress', model: 'base', received: 99, total: 100 })

    expect(useDictationStore.getState().received).toBe(0)
  })

  it('a ready model clears the download and re-reads status', async () => {
    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalledTimes(1))
    act(() => useDictationStore.getState().startDownload('turbo'))

    await fire({ type: 'model_ready', model: 'turbo' })

    expect(useDictationStore.getState().phase).toBe('idle')
    await waitFor(() => expect(dictation.status).toHaveBeenCalledTimes(2))
  })

  it('passes the project vocabulary when the setting is on', async () => {
    const listFiles = vi.fn().mockResolvedValue([{ path: 'src/ComposerBar.tsx', type: 'file' }])
    ;(window as unknown as { api: { fs: unknown } }).api.fs = { listFiles }
    const { useSessionsStore } = await import('@renderer/store/sessions')
    useSessionsStore.setState({
      sessions: [{ id: 's1', cwd: '/repo' }] as never,
      activeSessionId: 's1'
    })

    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: /dictate/i }))

    await waitFor(() => expect(dictation.start).toHaveBeenCalled())
    expect(dictation.start.mock.calls[0][0].vocabulary).toContain('ComposerBar')
  })

  it('dictates unbiased rather than failing when the file list cannot be read', async () => {
    ;(window as unknown as { api: { fs: unknown } }).api.fs = {
      listFiles: vi.fn().mockRejectedValue(new Error('nope'))
    }
    const { useSessionsStore } = await import('@renderer/store/sessions')
    useSessionsStore.setState({
      sessions: [{ id: 's1', cwd: '/repo' }] as never,
      activeSessionId: 's1'
    })

    render()
    await waitFor(() => expect(dictation.status).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: /dictate/i }))

    await waitFor(() => expect(dictation.start).toHaveBeenCalled())
    expect(dictation.start.mock.calls[0][0].vocabulary).toEqual([])
  })
})
