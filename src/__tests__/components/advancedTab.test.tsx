import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import AdvancedTab from '../../renderer/src/components/settings/AdvancedTab'
import { useSettingsStore } from '../../renderer/src/store/settings'
import { DEFAULT_SETTINGS } from '../../shared/types'

describe('AdvancedTab', () => {
  afterEach(() => vi.restoreAllMocks())

  it('says which install chats run on, and names the stale one beside it', async () => {
    useSettingsStore.setState(DEFAULT_SETTINGS)
    const checkBinary = vi.spyOn(window.api.claude, 'checkBinary').mockResolvedValue({
      found: true,
      path: '/opt/homebrew/bin/claude',
      version: '2.1.280 (Claude Code)',
      installs: [
        { path: '/Users/x/.local/bin/claude', version: '2.1.99 (Claude Code)' },
        { path: '/opt/homebrew/bin/claude', version: '2.1.280 (Claude Code)' }
      ]
    })

    render(<AdvancedTab />)

    expect(await screen.findByText('/opt/homebrew/bin/claude')).toBeInTheDocument()
    expect(screen.getByText(/Also installed/)).toHaveTextContent(
      '/Users/x/.local/bin/claude · 2.1.99 (Claude Code)'
    )
    expect(checkBinary).toHaveBeenCalledWith('claude')
  })
})
