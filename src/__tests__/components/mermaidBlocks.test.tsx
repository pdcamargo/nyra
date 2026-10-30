import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownRendererBare from '@renderer/components/MarkdownRenderer'
import { TooltipProvider } from '@renderer/components/ui/tooltip'

const MarkdownRenderer = ({ children }: { children: string }): React.JSX.Element => (
  <TooltipProvider>
    <MarkdownRendererBare>{children}</MarkdownRendererBare>
  </TooltipProvider>
)

// jsdom has no layout, so mermaid itself cannot draw here. What matters is when
// the renderer asks it to, and what it shows when it cannot.
const parse = vi.fn()
const renderSvg = vi.fn()
vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), parse: (...a: unknown[]) => parse(...a), render: (...a: unknown[]) => renderSvg(...a) }
}))

beforeEach(() => {
  vi.clearAllMocks()
  parse.mockResolvedValue({ diagramType: 'flowchart' })
  renderSvg.mockResolvedValue({ svg: '<svg data-testid="diagram" viewBox="0 0 10 10"></svg>' })
})

describe('```mermaid fences', () => {
  it('draws a finished fence as its diagram', async () => {
    render(<MarkdownRenderer>{'```mermaid\nflowchart TD\n  A --> B\n```'}</MarkdownRenderer>)
    expect(await screen.findByTestId('diagram')).toBeInTheDocument()
    expect(renderSvg).toHaveBeenCalledWith(expect.any(String), 'flowchart TD\n  A --> B')
  })

  it('leaves a fence still streaming in as source', async () => {
    render(<MarkdownRenderer>{'Here:\n\n```mermaid\nflowchart TD\n  A --> B'}</MarkdownRenderer>)
    expect(screen.getByText('mermaid')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(renderSvg).not.toHaveBeenCalled()
    expect(screen.queryByTestId('diagram')).toBeNull()
  })

  it('falls back to labelled source when the diagram does not parse', async () => {
    parse.mockResolvedValue(false)
    render(<MarkdownRenderer>{'```mermaid\nflowchart TD\n  A[Load (x)] --> B\n```'}</MarkdownRenderer>)
    expect(await screen.findByText(/couldn.t draw this diagram/)).toBeInTheDocument()
    expect(renderSvg).not.toHaveBeenCalled()
  })
})
