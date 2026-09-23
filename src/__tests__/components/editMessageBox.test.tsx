import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import EditMessageBox from '../../renderer/src/components/EditMessageBox'
import { TooltipProvider } from '../../renderer/src/components/ui/tooltip'

// Partial, so the real design helpers stay real — three separate renderers
// consult them and stubbing one out silently changed what this exercises.
vi.mock('../../renderer/src/lib/openFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderer/src/lib/openFile')>()),
  openFileInPanel: vi.fn(),
  openDesignInPanel: vi.fn()
}))

/**
 * Editing a sent message.
 *
 * It was the last surface in the conversation still drawing raw characters: a
 * plain textarea, so the markdown and the chips the composer had shown you
 * vanished the moment you clicked the pencil.
 */
function open(
  value: string,
  handlers: { onCancel?: () => void; onSave?: (...args: unknown[]) => void } = {}
) {
  const onChange = vi.fn()
  const { container } = render(
    <EditMessageBox
      value={value}
      onChange={onChange}
      onCancel={handlers.onCancel ?? vi.fn()}
      onSave={handlers.onSave ?? vi.fn()}
    />,
    // The attachment strip's remove buttons carry tooltips.
    { wrapper: TooltipProvider }
  )
  const content = container.querySelector('.cm-content') as HTMLElement
  return { container, content, onChange }
}

describe('editing a message', () => {
  it('opens in the composer’s editor, not a textarea', () => {
    const { container } = open('hello')
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('.cm-editor')).not.toBeNull()
  })

  it('chips an @-mention the way the composer does', () => {
    const { container } = open('look at @src/renderer/src/App.tsx again')
    expect(container.querySelector('.nyra-file-chip')?.textContent).toBe('App.tsx')
  })

  it('chips an attachment marker', () => {
    const { container } = open('in this [Image: /tmp/a.png] the sidebar is wrong')
    expect(container.querySelector('.nyra-attach-chip')?.textContent).toBe('a.png')
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    const { content } = open('hello', { onCancel })
    fireEvent.keyDown(content, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  // Editing a message is sending it again, so the key that sends in the
  // composer is the key that does it here.
  it('saves on Enter and breaks the line on Shift+Enter', () => {
    const onSave = vi.fn()
    const { content } = open('hello', { onSave })

    fireEvent.keyDown(content, { key: 'Enter', shiftKey: true })
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.keyDown(content, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('will not save an empty message, by key or by button', () => {
    const onSave = vi.fn()
    const { content } = open('   ', { onSave })

    fireEvent.keyDown(content, { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('Save')).toBeDisabled()
  })

  // It had no paste handler, so an image or a file pasted into an edit did
  // nothing — and the resend took text only, so there was nowhere to put one.
  it('stages a pasted file and sends it with the edit', async () => {
    const claude = window.api.claude as unknown as Record<string, unknown>
    claude.saveTempFile = vi.fn(async () => '/tmp/nyra-files/123-notes.txt')
    claude.processFile = vi.fn(async () => ({
      id: 'f1',
      name: '123-notes.txt',
      path: '/tmp/nyra-files/123-notes.txt',
      category: 'text',
      extractedText: 'hello'
    }))
    const onSave = vi.fn()
    const { content, onChange } = open('see this', { onSave })

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const pasted = fireEvent.paste(content, {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] }
    })
    // Claimed synchronously, or CodeMirror pastes the text form underneath.
    expect(pasted).toBe(false)

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument())
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('[File: notes.txt]'))

    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith(
      [],
      [expect.objectContaining({ name: 'notes.txt', path: '/tmp/nyra-files/123-notes.txt' })]
    )
  })

  it('starts from the message’s own attachments', () => {
    const onSave = vi.fn()
    render(
      <EditMessageBox
        value="again"
        images={[{ path: '/tmp/a.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
      { wrapper: TooltipProvider }
    )
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ path: '/tmp/a.png' })], [])
  })
})
