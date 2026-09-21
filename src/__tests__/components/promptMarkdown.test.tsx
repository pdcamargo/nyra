import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MarkdownRenderer from '../../renderer/src/components/MarkdownRenderer'

const openFileInPanel = vi.fn()
vi.mock('../../renderer/src/lib/openFile', () => ({
  openFileInPanel: (path: string) => openFileInPanel(path),
  // A design path routes elsewhere; these tests are about ordinary files, so
  // the predicate answers no and the chip behaves the way it always did.
  isDesignPath: () => false,
  openDesignInPanel: () => Promise.resolve()
}))

/**
 * A sent message, drawn the way the composer drew it.
 *
 * The composer live-previews markdown and chips the CLI's own syntax; the
 * bubble showed the raw characters, so the message changed appearance the
 * moment you pressed Enter. These cover the second rendering, not the finders —
 * those are `composerChips`.
 */
function prompt(text: string): HTMLElement {
  const { container } = render(<MarkdownRenderer prompt>{text}</MarkdownRenderer>)
  return container
}

describe('a message you wrote', () => {
  it('renders a bullet list as a list', () => {
    const el = prompt('- first\n- second')
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.textContent).not.toContain('- first')
  })

  it('renders a blockquote as a quote', () => {
    const el = prompt('> quoted')
    expect(el.querySelector('blockquote')?.textContent).toContain('quoted')
  })

  // The composer is a text editor, so the lines stay where you put them.
  // Markdown would otherwise fold a lone newline into a space.
  it('keeps the line breaks you typed', () => {
    const el = prompt('one\ntwo')
    expect(el.querySelectorAll('br')).toHaveLength(1)
    expect(el.querySelectorAll('p')).toHaveLength(1)
  })

  it('chips a slash command at the start', () => {
    const el = prompt('/compact please')
    expect(el.querySelector('.nyra-command')?.textContent).toBe('/compact')
  })

  it('leaves a slash that is not a command alone', () => {
    const el = prompt('look in /usr/local/bin')
    expect(el.querySelector('.nyra-command')).toBeNull()
  })

  // The CLI reads the command off the very start of the message, and so does
  // this: inside a heading it is just a heading that begins with a slash.
  it('only chips a command at the very start', () => {
    expect(prompt('and then /compact').querySelector('.nyra-command')).toBeNull()
    expect(prompt('# /compact').querySelector('.nyra-command')).toBeNull()
  })

  it('gives ultrathink its rainbow', () => {
    const el = prompt('please ultrathink about this')
    expect(el.querySelector('.nyra-ultrathink')?.textContent).toBe('ultrathink')
  })

  it('collapses an @-mention to a chip that opens the file', () => {
    const el = prompt('see @src/renderer/src/App.tsx for this')
    const chip = el.querySelector('.nyra-file-chip')
    expect(chip?.textContent).toBe('App.tsx')
    expect(chip).toHaveAttribute('title', 'src/renderer/src/App.tsx')

    fireEvent.click(chip!)
    expect(openFileInPanel).toHaveBeenCalledWith('src/renderer/src/App.tsx')
  })

  it('collapses an attachment marker to its filename', () => {
    const el = prompt('in this [Image: /tmp/nyra-image-8f2.png] the sidebar is wrong')
    const chip = el.querySelector('.nyra-attach-chip')
    expect(chip?.textContent).toBe('nyra-image-8f2.png')
    expect(el.textContent).not.toContain('/tmp/')
  })

  // `@ultrathink` is one mention, not a mention with a rainbow inside it.
  it('takes the outermost match when two overlap', () => {
    const el = prompt('see @notes/ultrathink.md now')
    expect(el.querySelectorAll('.nyra-file-chip')).toHaveLength(1)
    expect(el.querySelector('.nyra-ultrathink')).toBeNull()
  })

  it('leaves code alone', () => {
    const el = prompt('run `grep @foo` or\n\n```\n@bar ultrathink\n```')
    expect(el.querySelector('.nyra-file-chip')).toBeNull()
    expect(el.querySelector('.nyra-ultrathink')).toBeNull()
    expect(el.textContent).toContain('@foo')
    expect(el.textContent).toContain('@bar')
  })

  it('leaves a link label alone', () => {
    const el = prompt('[@src/App.tsx](https://example.com)')
    expect(el.querySelector('.nyra-file-chip')).toBeNull()
    expect(screen.getByText('@src/App.tsx').tagName).toBe('A')
  })
})

describe('anything else', () => {
  // MarkdownRenderer also draws Claude's replies, plan cards and the memory
  // preview. None of those were typed into the composer.
  it('gets none of it without the prompt flag', () => {
    const { container } = render(
      <MarkdownRenderer>{'/compact @src/App.tsx ultrathink'}</MarkdownRenderer>
    )
    expect(container.querySelector('.nyra-file-chip')).toBeNull()
    expect(container.querySelector('.nyra-command')).toBeNull()
    expect(container.querySelector('.nyra-ultrathink')).toBeNull()
    expect(container.textContent).toContain('@src/App.tsx')
  })
})
