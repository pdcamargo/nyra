import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MarkdownRenderer from '../../renderer/src/components/MarkdownRenderer'

const openDesignInPanel = vi.fn()
const openFileInPanel = vi.fn()

vi.mock('../../renderer/src/lib/openFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../renderer/src/lib/openFile')>()
  return {
    ...actual,
    openDesignInPanel: (p: string) => openDesignInPanel(p),
    openFileInPanel: (p: string) => openFileInPanel(p)
  }
})

const DESIGN = '/Users/me/.nyra/designs/files/vpn-settings-d_ac7eca37b7.nyui.json'

beforeEach(() => {
  window.api.design = {
    ...(window.api.design ?? {}),
    list: vi.fn().mockResolvedValue([{ id: 'd_1', name: 'VPN Settings', path: DESIGN, project: '/p', updatedAt: '' }]),
    // A chip follows a rename, so it subscribes; the unsubscribe is what the
    // effect returns.
    onChanged: vi.fn().mockReturnValue(() => {})
  } as never
})

/**
 * A design path reaches the renderer by two different routes, and the first fix
 * for this only covered one of them — the chip stayed blue in Claude's reply
 * while working in a message the user wrote. Both are asserted here so the next
 * change cannot fix half of it again.
 */
describe('a design path is a design chip, by either route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders as a design chip in an assistant reply', async () => {
    // Claude's replies go through the plain inline-code branch.
    render(<MarkdownRenderer>{`The document is at \`${DESIGN}\``}</MarkdownRenderer>)

    const chip = screen.getByRole('button')
    expect(chip).toHaveClass('nyra-design-chip')
    expect(chip.querySelector('.nyra-design-chip-icon')).not.toBeNull()

    await userEvent.click(chip)
    expect(openDesignInPanel).toHaveBeenCalledWith(DESIGN)
    expect(openFileInPanel).not.toHaveBeenCalled()
  })

  it('renders as a design chip in a message you wrote', async () => {
    // The prompt route, where `remarkPromptDecorations` invents its own tag.
    render(<MarkdownRenderer prompt>{`look at @${DESIGN}`}</MarkdownRenderer>)

    const chip = screen.getByRole('button')
    expect(chip).toHaveClass('nyra-design-chip')

    await userEvent.click(chip)
    expect(openDesignInPanel).toHaveBeenCalled()
    expect(openFileInPanel).not.toHaveBeenCalled()
  })

  /**
   * Where a design's file lives is the index's business. A chip that prints
   * `/Users/…/designs/files/vpn-settings-d_ac7eca37b7.nyui.json` shows a
   * location nobody chose and an id nobody asked for, and wraps onto two lines
   * doing it.
   */
  it('shows the name, never the path', async () => {
    render(<MarkdownRenderer>{`The document is at \`${DESIGN}\``}</MarkdownRenderer>)

    // Readable immediately, from the filename, so it never renders empty...
    const chip = screen.getByRole('button')
    expect(chip.textContent).not.toContain('/Users/')
    expect(chip.textContent).not.toContain('d_ac7eca37b7')
    expect(chip.textContent).not.toContain('.nyui.json')

    // ...then the index supplies what the design was actually called.
    expect(await screen.findByText('VPN Settings')).toBeInTheDocument()
  })

  it('falls back to the filename when the index has never seen it', async () => {
    window.api.design.list = vi.fn().mockResolvedValue([])
    render(<MarkdownRenderer>{`at \`${DESIGN}\``}</MarkdownRenderer>)
    expect(await screen.findByText('Vpn settings')).toBeInTheDocument()
  })

  it('leaves an ordinary file path alone', async () => {
    render(<MarkdownRenderer>{'see `/Users/me/src/App.tsx`'}</MarkdownRenderer>)

    const code = screen.getByText('/Users/me/src/App.tsx')
    expect(code).not.toHaveClass('nyra-design-chip')

    await userEvent.click(code)
    expect(openFileInPanel).toHaveBeenCalledWith('/Users/me/src/App.tsx')
    expect(openDesignInPanel).not.toHaveBeenCalled()
  })
})
