import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BrowserMenu from '@renderer/components/browser/BrowserMenu'
import DeviceBar from '@renderer/components/browser/DeviceBar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { DevicePreset, TabDevice } from '@renderer/lib/api-types'

/** Icon-only controls carry real tooltips, and Radix needs the provider App
 *  mounts at the root. Rendering a slice of the tree has to supply it. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

const DEVICES: DevicePreset[] = [
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800, deviceScaleFactor: null, mobile: false, hasTouch: false },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874, deviceScaleFactor: 3, mobile: true, hasTouch: true }
]

const responsive: TabDevice = {
  id: 'responsive', label: 'Responsive', width: 600, height: 800,
  deviceScaleFactor: 2, mobile: false, hasTouch: false, by: 'user'
}
const phone: TabDevice = {
  id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874,
  deviceScaleFactor: 3, mobile: true, hasTouch: true, by: 'user'
}

const bar = (over: Partial<React.ComponentProps<typeof DeviceBar>> = {}): React.ReactElement => (
  <DeviceBar
    device={phone}
    devices={DEVICES}
    zoom="fit"
    fitPercent={84}
    onZoom={vi.fn()}
    onDevice={vi.fn()}
    {...over}
  />
)

describe('BrowserMenu', () => {
  it('holds the mode toggle and nothing else', async () => {
    // Sizes deliberately do not live here. They used to, and because toggling a
    // checkbox item closes the menu, the list only existed if you thought to
    // reopen it — which read as being locked to whatever it turned on with.
    render(<BrowserMenu device={phone} remembered="iphone-16-pro" onPick={vi.fn()} />)
    await userEvent.click(screen.getByLabelText('Browser options'))
    expect(await screen.findByText('Device mode')).toBeTruthy()
    expect(screen.queryByText('Desktop')).toBeNull()
  })

  it('turns on into the remembered device, and off into responsive', async () => {
    const onPick = vi.fn()
    const { rerender } = render(
      <BrowserMenu device={responsive} remembered="iphone-16-pro" onPick={onPick} />
    )
    await userEvent.click(screen.getByLabelText('Browser options'))
    await userEvent.click(await screen.findByText('Device mode'))
    expect(onPick).toHaveBeenCalledWith({ id: 'iphone-16-pro' })

    onPick.mockClear()
    rerender(
      <TooltipProvider>
        <BrowserMenu device={phone} remembered="iphone-16-pro" onPick={onPick} />
      </TooltipProvider>
    )
    await userEvent.click(screen.getByLabelText('Browser options'))
    await userEvent.click(await screen.findByText('Device mode'))
    expect(onPick).toHaveBeenCalledWith({ id: 'responsive' })
  })
})

describe('DeviceBar', () => {
  it('shows the size, the pixel ratio and what fit works out to', () => {
    render(bar())
    expect(screen.getByLabelText('Width')).toHaveProperty('value', '402')
    expect(screen.getByLabelText('Height')).toHaveProperty('value', '874')
    expect(screen.getByText('@3x')).toBeTruthy()
    expect(screen.getByText('Fit (84%)')).toBeTruthy()
  })

  it('picks a device from the bar, beside the size it sets', async () => {
    // The regression this covers: the list was unreachable in practice.
    const onDevice = vi.fn()
    render(bar({ onDevice }))
    await userEvent.click(screen.getByLabelText('Device'))
    await userEvent.click(await screen.findByText('Desktop'))
    expect(onDevice).toHaveBeenCalledWith({ id: 'desktop' })
  })

  it('commits a typed width on Enter, not on every keystroke', async () => {
    // Committing per keystroke would relayout the page at 5, then 50, then 500.
    const onDevice = vi.fn()
    render(bar({ onDevice }))
    const width = screen.getByLabelText('Width')
    await userEvent.clear(width)
    await userEvent.type(width, '500')
    expect(onDevice).not.toHaveBeenCalled()
    await userEvent.type(width, '{Enter}')
    expect(onDevice).toHaveBeenCalledWith({ id: 'custom', width: 500, height: 874 })
  })

  it('reverts a half-typed size on Escape', async () => {
    const onDevice = vi.fn()
    render(bar({ onDevice }))
    const width = screen.getByLabelText('Width')
    await userEvent.clear(width)
    await userEvent.type(width, '9{Escape}')
    expect(onDevice).not.toHaveBeenCalled()
    expect(width).toHaveProperty('value', '402')
  })

  it('swaps the axes when rotated', async () => {
    const onDevice = vi.fn()
    render(bar({ onDevice }))
    await userEvent.click(screen.getByLabelText('Rotate'))
    expect(onDevice).toHaveBeenCalledWith({ id: 'custom', width: 874, height: 402 })
  })
})
