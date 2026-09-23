import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import ChatInput from '@renderer/components/ChatInput'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { useSessionsStore } from '@renderer/store/sessions'

/**
 * Picking from the `@` menu.
 *
 * The browsing itself lives in the backend (`fs_ops::list_files`) and is tested
 * there. What is covered here is what the composer does with the answer — the
 * part that decides whether choosing `../api.v2/` leaves you looking at the
 * folder or thrown out of the mention with a space after it.
 */

const ENTRIES: { path: string; type: 'file' | 'folder' }[] = []

// jsdom has no layout, so CodeMirror cannot say where a caret is on screen and
// throws when the popup asks. Zero is the anchor the composer already falls back
// to when it has nothing to go on.
;(EditorView.prototype as unknown as { coordsAtPos: () => null }).coordsAtPos = () => null

const content = (): HTMLElement => document.querySelector('.cm-content') as HTMLElement

const doc = (): string => {
  const view = EditorView.findFromDOM(content())
  if (!view) throw new Error('no EditorView behind the composer')
  return view.state.doc.toString()
}

/**
 * Type `@..` into the box and pick the one row the stub offers.
 *
 * Typed rather than assigned: the popup reads the query from the caret, and a
 * value set behind the editor's back leaves the caret where it was.
 */
const pickMention = async (): Promise<void> => {
  render(
    <TooltipProvider>
      <ChatInput cwd="/tmp/nyra-test" isLoading={false} sendMessage={async () => {}} />
    </TooltipProvider>
  )
  await act(async () => {
    useSessionsStore.getState().setPendingAction({ type: 'insert', text: '@' })
  })
  await waitFor(() => expect(doc()).toBe('@'))
  await act(async () => {
    const view = EditorView.findFromDOM(content())
    if (!view) throw new Error('no EditorView behind the composer')
    const end = view.state.doc.length
    // The caret goes with the typing, which is where the popup reads its query
    // from — an insert behind a caret left at 0 would open nothing.
    view.dispatch({
      changes: { from: end, insert: '..' },
      selection: { anchor: end + 2 }
    })
  })
  await waitFor(() => expect(doc()).toBe('@..'))
  const row = await screen.findByText(ENTRIES[0].path)
  await act(async () => {
    fireEvent.mouseDown(row)
  })
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
  ;(window.api as unknown as { agents: unknown }).agents = {
    list: () => Promise.resolve({ global: [], project: [] })
  }
  ;(window.api as unknown as { fs: { listFiles: unknown } }).fs.listFiles = (
    _cwd: string,
    query: string
  ) => {
    // Whatever the backend would have answered for this query; the query itself
    // is asserted below.
    expect(query).toBe('..')
    return Promise.resolve(ENTRIES)
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  ENTRIES.length = 0
})

describe('@-mentions', () => {
  // The report: from one project folder, reaching for the sibling next door.
  it('keeps a chosen folder open so you can drill into it', async () => {
    ENTRIES.push({ path: '../api.v2/', type: 'folder' })
    await pickMention()
    expect(doc()).toBe('@../api.v2/')
  })

  it('closes the mention once a file is chosen', async () => {
    ENTRIES.push({ path: '../api.v2/routes.ts', type: 'file' })
    await pickMention()
    expect(doc()).toBe('@../api.v2/routes.ts ')
  })
})
