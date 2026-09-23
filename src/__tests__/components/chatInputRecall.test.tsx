import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import ChatInput from '@renderer/components/ChatInput'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore } from '@renderer/store/sessions'

/**
 * Up and Down in the real composer.
 *
 * The rules themselves are unit-tested in `promptHistory.test.ts`; what this
 * covers is the wiring — that the keys reach the composer at all, that open
 * autocomplete keeps them, that the caret can still move inside a multi-line
 * draft, and that editing ends the walk.
 *
 * The editor is the real CodeMirror view, so the assertions read the document
 * out of it rather than out of any React state.
 */

const PROMPTS = ['first prompt', 'third prompt']

const content = (): HTMLElement => {
  const el = document.querySelector('.cm-content')
  if (!el) throw new Error('the composer has no editor')
  return el as HTMLElement
}

const view = (): EditorView => {
  const found = EditorView.findFromDOM(content())
  if (!found) throw new Error('no EditorView behind the composer')
  return found
}

const doc = (): string => view().state.doc.toString()

const press = (key: string, init: Record<string, unknown> = {}): void => {
  fireEvent.keyDown(content(), { key, ...init })
}

/** Put text in the box the way the sidebar's insert action does. */
const prefill = (text: string): void => {
  useSessionsStore.getState().setPendingAction({ type: 'insert', text })
}

const seedChat = (prompts: string[]): string => {
  const id = useSessionsStore.getState().createSession('/tmp/nyra-test')
  for (const text of prompts) {
    useSessionsStore.getState().addMessage(id, {
      id: crypto.randomUUID(),
      role: 'user',
      text
    })
  }
  return id
}

const renderComposer = (): void => {
  render(
    <TooltipProvider>
      <ChatInput cwd="/tmp/nyra-test" isLoading={false} sendMessage={async () => {}} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
  // The shared stub answers these with an empty array, which the composer reads
  // as a scoped list. Overridden here so the shape matches what it expects.
  const scoped = (): Promise<{ global: unknown[]; project: unknown[] }> =>
    Promise.resolve({ global: [], project: [] })
  ;(window.api as unknown as { agents: unknown }).agents = { list: scoped }
  ;(window.api as unknown as { skills: unknown }).skills = {
    list: scoped,
    write: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    bundledNames: async () => [],
    restoreBundled: async () => ({ success: true })
  }
  ;(window.api as unknown as { commands: unknown }).commands = {
    list: scoped,
    delete: async () => ({ success: true })
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('prompt recall in the composer', () => {
  it('walks back from the newest prompt and forward to the draft', async () => {
    seedChat(PROMPTS)
    renderComposer()
    prefill('half a thought')
    await waitFor(() => expect(doc()).toBe('half a thought'))

    press('ArrowUp')
    expect(doc()).toBe('third prompt')
    press('ArrowUp')
    expect(doc()).toBe('first prompt')
    // The oldest is the end of the road, not a wrap to the newest.
    press('ArrowUp')
    expect(doc()).toBe('first prompt')

    press('ArrowDown')
    expect(doc()).toBe('third prompt')
    press('ArrowDown')
    expect(doc()).toBe('half a thought')
    // Out of the history and back in the draft: Down has nowhere to go.
    press('ArrowDown')
    expect(doc()).toBe('half a thought')
  })

  it('lets the open slash autocomplete keep the arrows', async () => {
    seedChat(PROMPTS)
    renderComposer()
    prefill('/')
    await waitFor(() => expect(doc()).toBe('/'))

    press('ArrowUp')
    expect(doc()).toBe('/')
    press('ArrowDown')
    expect(doc()).toBe('/')
  })

  it('leaves the arrow to the editor when the caret has somewhere to go', async () => {
    seedChat(PROMPTS)
    renderComposer()
    const end = doc().length
    view().dispatch({
      changes: { from: end, insert: 'over two lines\nsecond line' },
      selection: { anchor: end + 'over two lines\nsecond line'.length }
    })
    await waitFor(() => expect(doc()).toContain('second line'))

    press('ArrowUp')
    expect(doc()).toBe('over two lines\nsecond line')
  })

  it('starts the walk over from the newest once you edit a recalled prompt', async () => {
    seedChat(PROMPTS)
    renderComposer()
    await waitFor(() => expect(doc()).toBe(''))

    press('ArrowUp')
    expect(doc()).toBe('third prompt')
    press('ArrowUp')
    expect(doc()).toBe('first prompt')

    // Typing into a recalled prompt ends the walk, so the next Up is "what did
    // I send last" again rather than the one before it.
    view().dispatch({ changes: { from: 0, insert: 'x' } })
    await waitFor(() => expect(doc()).toBe('xfirst prompt'))
    press('ArrowUp')
    expect(doc()).toBe('third prompt')
  })
})
