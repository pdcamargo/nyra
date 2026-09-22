import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import QuickOpen from '../../renderer/src/components/QuickOpen'
import { useUiStore } from '../../renderer/src/store/ui'
import { useSessionsStore, type Session } from '../../renderer/src/store/sessions'

const FILES = [
  'src/renderer/src/components/CommandPalette.tsx',
  'src/renderer/src/lib/composerDecorations.ts',
  'src/renderer/src/components/ComposerBar.tsx',
  'README.md'
]

function seedSession(): void {
  const s: Session = {
    id: 's1',
    claudeSessionId: null,
    title: 'T',
    cwd: '/repo',
    createdAt: 0,
    messages: [],
    tasks: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  }
  useSessionsStore.setState({ sessions: [s], activeSessionId: 's1', projects: [] })
}

function stubFiles(paths: string[], isRepo = true): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api.fs.listProjectFiles = vi.fn().mockResolvedValue({
    paths,
    truncated: false,
    isRepo
  })
}

const items = (): HTMLElement[] => screen.queryAllByRole('option')

describe('QuickOpen', () => {
  beforeEach(() => {
    seedSession()
    useUiStore.setState({ quickOpenOpen: true })
    stubFiles(FILES)
  })

  it('lists the project on open, before anything is typed', async () => {
    render(<QuickOpen />)
    await waitFor(() => expect(items()).toHaveLength(FILES.length))
  })

  /**
   * The bug: rendered bare in the list rather than inside a `CommandGroup`,
   * cmdk marked every row `data-selected`. Nothing highlighted, hover did
   * nothing, and the arrows had no current row to move from — so the picker
   * looked inert even though it had found the files.
   *
   * Asserted structurally, on the group itself, because the symptom does not
   * reproduce here: under jsdom cmdk selects a single row with or without the
   * group, and only the real WebKit build marks all of them. A test on
   * `data-selected` would have passed throughout the bug and would guard
   * nothing. This one fails the moment the items leave the group.
   */
  it('renders the rows inside a group, which is what cmdk tracks selection through', async () => {
    render(<QuickOpen />)
    await waitFor(() => expect(items()).toHaveLength(FILES.length))

    // The dialog renders through a portal, so this looks at the document rather
    // than at the render container, which holds nothing.
    const group = document.querySelector('[cmdk-group]')
    expect(group).not.toBeNull()
    for (const row of items()) expect(group!.contains(row)).toBe(true)
  })

  it('reads the file list rather than searching for an empty string', async () => {
    // `fs_search_tree` treats an empty needle as "nothing matches", so asking it
    // for everything returned nothing and the picker opened empty in a repo.
    render(<QuickOpen />)
    await waitFor(() => expect(items()).toHaveLength(FILES.length))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).api.fs.listProjectFiles).toHaveBeenCalledWith('/repo', 20000)
  })

  it('blames git only when it is actually not a repository', async () => {
    stubFiles([], false)
    render(<QuickOpen />)
    await waitFor(() => expect(screen.getByText(/not a repository/i)).toBeInTheDocument())
  })

  it('does not blame git for a repository that is simply empty', async () => {
    stubFiles([], true)
    render(<QuickOpen />)
    await waitFor(() => expect(screen.getByText(/no files yet/i)).toBeInTheDocument())
    expect(screen.queryByText(/not a repository/i)).toBeNull()
  })
})
