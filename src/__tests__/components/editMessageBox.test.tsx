import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import EditMessageBox from '../../renderer/src/components/EditMessageBox'

vi.mock('../../renderer/src/lib/openFile', () => ({ openFileInPanel: vi.fn() }))

/**
 * Editing a sent message.
 *
 * It was the last surface in the conversation still drawing raw characters: a
 * plain textarea, so the markdown and the chips the composer had shown you
 * vanished the moment you clicked the pencil.
 */
function open(value: string, handlers: { onCancel?: () => void; onSave?: () => void } = {}) {
  const onChange = vi.fn()
  const { container } = render(
    <EditMessageBox
      value={value}
      onChange={onChange}
      onCancel={handlers.onCancel ?? vi.fn()}
      onSave={handlers.onSave ?? vi.fn()}
    />
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
})
