import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from '../../renderer/src/components/ui/button'
import { Badge } from '../../renderer/src/components/ui/badge'

/**
 * A smoke test over the shadcn layer, and over the test setup that makes one
 * possible: until now vitest had no React plugin, so no test could import a
 * .tsx file at all. This is the canary for that, not a test of shadcn itself.
 */
describe('shadcn primitives', () => {
  it('renders a button through cn() and the cva variants', () => {
    render(<Button variant="outline">Merge</Button>)
    const button = screen.getByRole('button', { name: 'Merge' })
    expect(button).toBeInTheDocument()
    // cn() resolved the variant into real classes rather than leaving a token behind.
    expect(button.className).toContain('border-border')
  })

  it('renders a badge', () => {
    render(<Badge>worktree</Badge>)
    expect(screen.getByText('worktree')).toBeInTheDocument()
  })

  it('applies theme tokens rather than raw palette classes', () => {
    render(<Button>Send</Button>)
    expect(screen.getByRole('button').className).toContain('bg-primary')
  })
})
