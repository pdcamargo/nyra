import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import SystemTab from '@renderer/components/settings/SystemTab'
import TitleBar from '@renderer/components/TitleBar'
import { useSettingsStore } from '@renderer/store/settings'
import { IDLE, useKeepAwakeStore } from '@renderer/store/keepAwake'
import { useUiStore } from '@renderer/store/ui'
import { setPlatformForTest } from '@renderer/lib/platform'
import type { SystemAccess } from '@renderer/lib/tauri-api'

const ROWS: SystemAccess[] = [
  { kind: 'controlInput', state: 'allowed', osName: 'Accessibility', action: null, asks: false },
  { kind: 'captureScreen', state: 'denied', osName: 'Screen & System Audio Recording', action: 'Open System Settings', asks: false },
  { kind: 'microphone', state: 'unasked', osName: 'Microphone', action: 'Allow', asks: true }
]

beforeEach(() => {
  setPlatformForTest('mac')
  useSettingsStore.getState().updateSettings({ keepAwake: false, keepAwakeOnlyOnAc: true })
  useKeepAwakeStore.getState().set(IDLE)
})

afterEach(() => {
  cleanup()
  setPlatformForTest(null)
  vi.restoreAllMocks()
})

describe('SystemTab — keep awake', () => {
  it('is off by default and shows only the switch', () => {
    render(<SystemTab />)
    expect(screen.getByText('Keep this Mac awake while Claude works')).toBeTruthy()
    expect(screen.queryByTestId('keep-awake-status')).toBeNull()
    expect(screen.queryByText('Keep the display on too')).toBeNull()
  })

  it('says what it is holding the Mac awake for', () => {
    useSettingsStore.getState().updateSettings({ keepAwake: true })
    useKeepAwakeStore.getState().set({ ...IDLE, holding: true, busy: true, chats: 2, monitors: 1, since: Date.now() })
    render(<SystemTab />)
    expect(screen.getByTestId('keep-awake-status').textContent).toContain(
      'Holding your Mac awake — 2 chats replying · 1 monitor running'
    )
  })

  it('explains a busy machine on battery rather than calling it idle', () => {
    useSettingsStore.getState().updateSettings({ keepAwake: true })
    useKeepAwakeStore.getState().set({ ...IDLE, busy: true, onBattery: true, chats: 1 })
    render(<SystemTab />)
    expect(screen.getByTestId('keep-awake-status').textContent).toContain('On battery')
  })
})

describe('SystemTab — access', () => {
  it('lists each grant with its state, and fixes through Rust', async () => {
    vi.spyOn(window.api.systemAccess, 'list').mockResolvedValue(ROWS)
    const fix = vi.spyOn(window.api.systemAccess, 'fix').mockResolvedValue(undefined)
    await act(async () => {
      render(<SystemTab />)
    })
    expect(screen.getByTestId('access-controlInput').textContent).toContain('Allowed')
    expect(screen.getByTestId('access-captureScreen').textContent).toContain('Not allowed')
    expect(screen.getByTestId('access-microphone').textContent).toContain('Not asked yet')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(fix).toHaveBeenCalledWith('microphone')
  })
})

describe('Awake chip', () => {
  const mount = (): void => {
    render(
      <TooltipProvider>
        <TitleBar />
      </TooltipProvider>
    )
  }

  it('is hidden while nothing is held', () => {
    mount()
    expect(screen.queryByTestId('awake-chip')).toBeNull()
  })

  it('shows while held, and opens Settings → System', () => {
    useKeepAwakeStore.getState().set({ ...IDLE, holding: true, busy: true, chats: 1 })
    mount()
    fireEvent.click(screen.getByTestId('awake-chip'))
    expect(useUiStore.getState().settingsOpen).toBe(true)
    expect(useUiStore.getState().settingsTab).toBe('system')
  })
})
