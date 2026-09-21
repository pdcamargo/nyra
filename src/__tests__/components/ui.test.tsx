import { describe, expect, it } from 'vitest'
import { NEW_TAB_CHOICES } from '@renderer/components/workspace/tabs'
import { COMMANDS_BY_ID } from '@renderer/commands/registry'
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

describe('what the panel offers to create', () => {
  /**
   * A design is never on this list, and must never be.
   *
   * A blank design tab has no answer to "which design?" — a chat can be working
   * with ten — so offering one from a menu asks the user to go and find a file,
   * which is the opposite of the point. Designs are opened by something that
   * already knows which one: a chip in the transcript, "Open in Design" on a
   * file, or Claude itself.
   *
   * This guards both places at once: the "+" menu and the empty panel's landing
   * are built from this one list.
   */
  it('never offers a design', () => {
    expect(NEW_TAB_CHOICES.map((c) => c.kind)).toEqual(['browser', 'file'])
    expect(NEW_TAB_CHOICES.some((c) => c.label.toLowerCase().includes('design'))).toBe(false)
  })

  it('offers nothing the command palette cannot also run', () => {
    for (const choice of NEW_TAB_CHOICES) {
      expect(COMMANDS_BY_ID.has(choice.command)).toBe(true)
    }
  })
})
