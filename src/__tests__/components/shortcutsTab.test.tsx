import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShortcutsTab from '../../renderer/src/components/settings/ShortcutsTab'
import { useShortcutsStore, chordFor } from '../../renderer/src/store/shortcuts'
import { resetPlatformCache } from '../../renderer/src/lib/keys'

// jsdom's user agent is not a Mac one, so without this the suite would exercise
// the Ctrl branch while the assertions talk about ⌘. Pin it instead of guessing.
const realUserAgent = navigator.userAgent
const setPlatform = (ua: string): void => {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
  resetPlatformCache()
}

beforeAll(() => setPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'))
afterAll(() => setPlatform(realUserAgent))

const overrides = (): Record<string, string | null> => useShortcutsStore.getState().overrides
const rowFor = (label: string): HTMLElement =>
  screen.getByRole('button', { name: `Shortcut for ${label}` })

describe('ShortcutsTab', () => {
  beforeEach(() => useShortcutsStore.setState({ overrides: {}, recording: false }))

  it('lists every group, composer keys included', () => {
    render(<ShortcutsTab />)
    for (const group of ['General', 'Session', 'Panels', 'View', 'Composer']) {
      expect(screen.getByText(group)).toBeInTheDocument()
    }
    expect(screen.getByText('Bold')).toBeInTheDocument()
  })

  it('captures a new chord and persists it', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    expect(screen.getByText('Press keys…')).toBeInTheDocument()
    expect(useShortcutsStore.getState().recording).toBe(true)

    await user.keyboard('{Meta>}{Shift>}y{/Shift}{/Meta}')

    expect(chordFor('session.new', overrides())).toBe('mod+shift+y')
    // The dispatcher has to come back up, or every other shortcut stays dead.
    expect(useShortcutsStore.getState().recording).toBe(false)
  })

  it('cancels on Escape without changing anything', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    await user.keyboard('{Escape}')

    expect(overrides()).toEqual({})
    expect(useShortcutsStore.getState().recording).toBe(false)
  })

  it('clears a binding on Backspace', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    await user.keyboard('{Backspace}')

    expect(chordFor('session.new', overrides())).toBeNull()
    expect(rowFor('New chat')).toHaveTextContent('Not set')
  })

  it('surfaces a conflict rather than silently shadowing', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    await user.keyboard('{Meta>}k{/Meta}') // already the command palette

    // Names the occupant, and writes nothing until you say so.
    expect(screen.getByText(/is already/)).toHaveTextContent('Command palette')
    expect(overrides()).toEqual({})
  })

  it('frees the previous owner when you replace it', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    await user.keyboard('{Meta>}k{/Meta}')
    await user.click(screen.getByRole('button', { name: 'Replace' }))

    expect(chordFor('session.new', overrides())).toBe('mod+k')
    expect(chordFor('palette.open', overrides())).toBeNull()
  })

  it('warns instead of blocking when the chord belongs to a composer key', async () => {
    const user = userEvent.setup()
    render(<ShortcutsTab />)

    await user.click(rowFor('New chat'))
    await user.keyboard('{Meta>}b{/Meta}') // ⌘B bolds text

    expect(screen.getByText(/is already/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use it anyway' }))
    expect(chordFor('session.new', overrides())).toBe('mod+b')
  })

  it('resets one binding and then all of them', async () => {
    const user = userEvent.setup()
    useShortcutsStore.setState({ overrides: { 'session.new': 'mod+shift+y' } })
    render(<ShortcutsTab />)

    await user.click(screen.getByTitle('Reset to default'))
    expect(chordFor('session.new', overrides())).toBe('mod+n')
    expect(overrides()).toEqual({})

    useShortcutsStore.setState({ overrides: { 'panel.left': null, 'session.new': 'mod+shift+y' } })
    await user.click(screen.getByRole('button', { name: /reset all shortcuts/i }))
    expect(overrides()).toEqual({})
  })
})
