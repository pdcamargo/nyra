import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MarkdownRenderer from '@renderer/components/MarkdownRenderer'
import { useWorkflowStore } from '@renderer/store/workflow'

const load = vi.fn()
const install = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useWorkflowStore.setState({ isCanvasOpen: false, currentWorkflow: null })
  ;(window as unknown as { api: unknown }).api = {
    workflow: { load },
    updates: { install }
  }
})

/**
 * How Claude points at something it made. The markdown is ordinary — the work
 * is in surviving react-markdown's sanitiser and then not being a plain link.
 */
describe('nyra:// links in a reply', () => {
  it('renders a flow link as a chip, not an anchor', () => {
    render(<MarkdownRenderer>{'I made [Nightly digest](nyra://flow/wf-9).'}</MarkdownRenderer>)
    const chip = screen.getByRole('button', { name: /nightly digest/i })
    expect(chip).toHaveClass('nyra-file-chip')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('opens the flow it names', async () => {
    load.mockResolvedValue({ id: 'wf-9', name: 'Nightly digest', nodes: [], edges: [] })
    render(<MarkdownRenderer>{'[Nightly digest](nyra://flow/wf-9)'}</MarkdownRenderer>)
    await userEvent.click(screen.getByRole('button', { name: /nightly digest/i }))
    expect(load).toHaveBeenCalledWith('wf-9')
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().isCanvasOpen).toBe(true)
      expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-9')
    })
  })

  it('is reachable from the keyboard', async () => {
    load.mockResolvedValue({ id: 'wf-9', name: 'N', nodes: [], edges: [] })
    render(<MarkdownRenderer>{'[N](nyra://flow/wf-9)'}</MarkdownRenderer>)
    screen.getByRole('button').focus()
    await userEvent.keyboard('{Enter}')
    expect(load).toHaveBeenCalledWith('wf-9')
  })

  it('makes the update link the one place a reply can install', async () => {
    render(<MarkdownRenderer>{'[update and restart](nyra://update)'}</MarkdownRenderer>)
    await userEvent.click(screen.getByRole('button', { name: /update and restart/i }))
    expect(install).toHaveBeenCalledOnce()
  })

  it('renders an unknown nyra target as inert text rather than a dead chip', () => {
    // The scheme is one Claude types, so a typo has to fail visibly-harmlessly.
    render(<MarkdownRenderer>{'[do a thing](nyra://teleport/42)'}</MarkdownRenderer>)
    expect(screen.getByText('do a thing')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('leaves ordinary links alone', () => {
    render(<MarkdownRenderer>{'[docs](https://example.com)'}</MarkdownRenderer>)
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
  })

  it('still strips a javascript: href', () => {
    // Replacing urlTransform is the risk this covers: the default sanitiser has
    // to keep doing its job for every scheme that is not ours. It blanks the
    // href outright, which also costs the anchor its link role — so the label
    // survives and nothing about it is clickable.
    render(<MarkdownRenderer>{'[click](javascript:alert(1))'}</MarkdownRenderer>)
    expect(screen.getByText('click')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
