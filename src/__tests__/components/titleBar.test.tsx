import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import TitleBar from '@renderer/components/TitleBar'
import { setPlatformForTest, type Os } from '@renderer/lib/platform'

const mount = (os: Os): void => {
  setPlatformForTest(os)
  render(
    <TooltipProvider>
      <TitleBar />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  setPlatformForTest(null)
  vi.restoreAllMocks()
})

describe('TitleBar', () => {
  it('leaves the traffic lights their room on macOS and draws no buttons', () => {
    mount('mac')
    expect(screen.getByTestId('title-bar').className).toContain('pl-[78px]')
    expect(screen.queryByTestId('window-controls')).toBeNull()
  })

  // Undecorated on Windows: without these there is no way to close the window.
  it('draws its own window buttons on Windows, and no macOS inset', () => {
    mount('windows')
    expect(screen.getByTestId('title-bar').className).not.toContain('pl-[78px]')
    expect(screen.getByTestId('window-controls')).toBeTruthy()
  })

  it('sends each button to the window', () => {
    const minimize = vi.spyOn(window.api.appWindow, 'minimize')
    const close = vi.spyOn(window.api.appWindow, 'close')
    mount('windows')
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(minimize).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
