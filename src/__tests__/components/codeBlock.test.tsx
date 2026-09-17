import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MarkdownRenderer from '../../renderer/src/components/MarkdownRenderer'

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

  it('is per block, so toggling one does not move the other', async () => {
    const user = userEvent.setup()
    render(<MarkdownRenderer>{'```bash\na\n```\n\n```bash\nb\n```'}</MarkdownRenderer>)

    expect(screen.getAllByLabelText('Wrap long lines')).toHaveLength(2)
    await user.click(screen.getAllByLabelText('Wrap long lines')[0])
    expect(screen.getAllByLabelText('Wrap long lines')).toHaveLength(1)
    expect(screen.getAllByLabelText('Stop wrapping long lines')).toHaveLength(1)
  })

  it('sits to the left of Copy', () => {
    const { container } = render(<MarkdownRenderer>{'```bash\na\n```'}</MarkdownRenderer>)
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons[0].getAttribute('aria-label')).toBe('Wrap long lines')
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy code')
  })
})
