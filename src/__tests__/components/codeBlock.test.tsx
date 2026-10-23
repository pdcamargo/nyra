import type React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

/** Controls carry real tooltips now, and Radix needs the provider App mounts at
 *  the root. A slice of the tree has to supply its own. */
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
import userEvent from '@testing-library/user-event'
import MarkdownRenderer from '../../renderer/src/components/MarkdownRenderer'
import { useSettingsStore } from '@renderer/store/settings'

const LONG =
  'rcodesign notary-submit --api-key-file key.json --staple Nyra.dmg --and-more-flags-to-push-well-past-the-column'

/**
 * The toggle lands on the <pre> itself before shiki resolves and on the wrapper
 * as a `[&>pre]:` variant afterwards, so these assert on the rendered markup
 * rather than on one element — the block behaves the same either way.
 */
const wraps = (el: HTMLElement): boolean => el.innerHTML.includes('whitespace-pre-wrap')
const scrolls = (el: HTMLElement): boolean => el.innerHTML.includes('overflow-x-auto')

describe('code block wrap toggle', () => {
  beforeEach(() => useSettingsStore.setState({ codeWrap: false }))

  it('scrolls long lines by default and wraps once toggled', async () => {
    const user = userEvent.setup()
    const { container } = render(<MarkdownRenderer>{'```bash\n' + LONG + '\n```'}</MarkdownRenderer>)

    expect(scrolls(container)).toBe(true)
    expect(wraps(container)).toBe(false)

    await user.click(screen.getByLabelText('Wrap long lines'))

    expect(wraps(container)).toBe(true)
    expect(scrolls(container)).toBe(false)
  })

  it('goes back to scrolling when toggled off', async () => {
    const user = userEvent.setup()
    const { container } = render(<MarkdownRenderer>{'```bash\n' + LONG + '\n```'}</MarkdownRenderer>)

    await user.click(screen.getByLabelText('Wrap long lines'))
    await user.click(screen.getByLabelText('Stop wrapping long lines'))

    expect(scrolls(container)).toBe(true)
    expect(wraps(container)).toBe(false)
  })

  it('is one preference: toggling a block wraps every block', async () => {
    const user = userEvent.setup()
    render(<MarkdownRenderer>{'```bash\na\n```\n\n```bash\nb\n```'}</MarkdownRenderer>)

    await user.click(screen.getAllByLabelText('Wrap long lines')[0])
    expect(screen.getAllByLabelText('Stop wrapping long lines')).toHaveLength(2)
    expect(useSettingsStore.getState().codeWrap).toBe(true)
  })

  it('survives the block remounting, as it does when scrolled back into view', async () => {
    const user = userEvent.setup()
    const first = render(<MarkdownRenderer>{'```bash\n' + LONG + '\n```'}</MarkdownRenderer>)
    await user.click(screen.getByLabelText('Wrap long lines'))
    first.unmount()

    const { container } = render(<MarkdownRenderer>{'```bash\n' + LONG + '\n```'}</MarkdownRenderer>)
    expect(wraps(container)).toBe(true)
  })

  it('sits to the left of Copy', () => {
    const { container } = render(<MarkdownRenderer>{'```bash\na\n```'}</MarkdownRenderer>)
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons[0].getAttribute('aria-label')).toBe('Wrap long lines')
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy code')
  })
})
