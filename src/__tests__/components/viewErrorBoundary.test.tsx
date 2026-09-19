import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ViewErrorBoundary } from '@renderer/components/ViewErrorBoundary'

function Boom({ explode }: { explode: boolean }): React.JSX.Element {
  if (explode) throw new Error('kaboom from the canvas')
  return <div>all good</div>
}

describe('ViewErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('passes children through when nothing throws', () => {
    render(
      <ViewErrorBoundary label="Flows">
        <Boom explode={false} />
      </ViewErrorBoundary>
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
  })

  it('shows the error instead of a blank view', () => {
    // React logs the caught error; silence it so the run stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ViewErrorBoundary label="Flows">
        <Boom explode />
      </ViewErrorBoundary>
    )

    expect(screen.getByText('Flows crashed')).toBeInTheDocument()
    // The message has to be on screen — a boundary that renders an empty box is
    // the white screen again, just with a border.
    expect(screen.getByText(/kaboom from the canvas/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('remounts the subtree on Try again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let explode = true
    function Flaky(): React.JSX.Element {
      if (explode) throw new Error('transient')
      return <div>recovered</div>
    }

    render(
      <ViewErrorBoundary label="Flows">
        <Flaky />
      </ViewErrorBoundary>
    )
    expect(screen.getByText('Flows crashed')).toBeInTheDocument()

    explode = false
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })
})
