import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsModal from '../../renderer/src/components/settings/SettingsModal'
import { useUiStore } from '../../renderer/src/store/ui'
import { useSettingsStore } from '../../renderer/src/store/settings'
import { DEFAULT_SETTINGS } from '../../shared/types'

describe('SettingsModal', () => {
  beforeEach(() => {
    useUiStore.setState({ settingsOpen: true, settingsTab: 'general' })
    useSettingsStore.setState(DEFAULT_SETTINGS)
  })

  it('lays the panes out as a vertical tablist', () => {
    render(<SettingsModal onClose={() => {}} />)

    const list = screen.getByRole('tablist')
    expect(list).toHaveAttribute('aria-orientation', 'vertical')
    for (const label of ['General', 'Appearance', 'Model', 'Permissions', 'Shortcuts', 'MCP', 'Advanced', 'About']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
  })

  // The layout variants have to name the attribute Radix actually sets. Tailwind
  // compiles the short `data-vertical:` form to `[data-vertical]`, a boolean
  // attribute that is never present, so the nav laid out in a row while claiming
  // to be vertical. Asserting the class form is the cheapest guard against a
  // revert — jsdom does not run Tailwind, so the computed style proves nothing.
  it('styles the nav off the orientation attribute Radix emits', () => {
    render(<SettingsModal onClose={() => {}} />)
    const list = screen.getByRole('tablist')

    expect(list).toHaveAttribute('data-orientation', 'vertical')
    expect(list.className).toContain('group-data-[orientation=vertical]/tabs:flex-col')
    expect(list.className).not.toMatch(/group-data-vertical\/tabs:/)
  })

  // The rail has to run the full height of the dialog, or the divider beside it
  // stops partway down. A bare `h-full` from the caller cannot fix that: the
  // variant-scoped rule in tabs.tsx carries an extra ancestor condition, so it
  // outranks the unprefixed class on specificity no matter which `cn` keeps.
  it('sizes the vertical rail to the dialog rather than to its buttons', () => {
    render(<SettingsModal onClose={() => {}} />)
    const list = screen.getByRole('tablist')

    expect(list.className).toContain('group-data-[orientation=vertical]/tabs:h-full')
    expect(list.className).not.toContain('group-data-[orientation=vertical]/tabs:h-fit')
  })

  it('separates the nav entries with the shared hairline', () => {
    render(<SettingsModal onClose={() => {}} />)
    const tabs = screen.getAllByRole('tab')

    for (const tab of tabs) expect(tab.className).toContain('border-b-separator-subtle')
    // The last one drops the colour, not the border itself, so nothing shifts.
    expect(tabs[tabs.length - 1].className).toContain('last:border-b-transparent')
  })

  it('separates the rows with the shared hairline', () => {
    render(<SettingsModal onClose={() => {}} />)
    const row = screen.getByText('Notify when a turn finishes').closest('div')!
    expect(row.className).toContain('border-separator')
  })

  it('shows only the selected pane', async () => {
    const user = userEvent.setup()
    render(<SettingsModal onClose={() => {}} />)

    expect(screen.getByText('Notify when a turn finishes')).toBeInTheDocument()
    expect(screen.queryByText('Skip all prompts')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Permissions' }))
    expect(screen.getByText('Skip all prompts')).toBeInTheDocument()
    expect(useUiStore.getState().settingsTab).toBe('permissions')
  })

  it('deep-links to a pane through the store', () => {
    useUiStore.setState({ settingsTab: 'permissions' })
    render(<SettingsModal onClose={() => {}} />)

    expect(screen.getByRole('tab', { name: 'Permissions' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Skip all prompts')).toBeInTheDocument()
  })

  // The old PermissionsModal owned these two keys. Folding it in is only safe if
  // the wires came with it.
  it('still writes the permission settings after the fold-in', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ settingsTab: 'permissions' })
    render(<SettingsModal onClose={() => {}} />)

    await user.click(screen.getAllByRole('switch')[0])
    expect(useSettingsStore.getState().skipPermissions).toBe(true)
  })

  it('auto-approves a tool from the per-tool list', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ settingsTab: 'permissions' })
    render(<SettingsModal onClose={() => {}} />)

    await user.click(screen.getByText('Bash').closest('div')!.parentElement!.querySelector('[role="switch"]')!)
    expect(useSettingsStore.getState().autoApproveTools).toContain('Bash')
  })

  it('keeps the destructive reset behind a confirm, in Advanced', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ model: 'opus' })
    useUiStore.setState({ settingsTab: 'advanced' })
    render(<SettingsModal onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    expect(useSettingsStore.getState().model).toBe('opus')

    await user.click(screen.getByRole('button', { name: /reset everything/i }))
    expect(useSettingsStore.getState().model).toBe(DEFAULT_SETTINGS.model)
  })
})
