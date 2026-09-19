import React from 'react'
import { RotateCw } from 'lucide-react'

/**
 * Catches a render crash in the main view and shows it.
 *
 * Without this, a thrown render unmounts the whole tree and leaves a blank
 * window — no message, no stack, nothing to paste into a bug report. That is
 * exactly what a conditional hook in `WorkflowCanvas` did: clicking a flow took
 * the app down and the only symptom was white.
 *
 * Scoped to the view rather than the app root on purpose. The sidebar, the
 * titlebar and the mode toggle keep working, so you can switch away from the
 * broken view instead of restarting.
 */
export class ViewErrorBoundary extends React.Component<
  { children: React.ReactNode; label: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The component stack is the useful half and React does not put it on the
    // error, so log both where devtools and the dev console will show them.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack)
  }

  /** Remount the subtree. Worth a try when the cause was transient state. */
  private retry = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-8">
        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-sm font-semibold text-foreground">{this.props.label} crashed</h2>
          <p className="text-center text-xs text-muted-foreground">
            The rest of the app is still running — switch views, or try again.
          </p>
        </div>
        <pre className="max-h-[40vh] max-w-[680px] overflow-auto rounded-md border border-border bg-card px-3 py-2 text-left font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={this.retry}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90"
        >
          <RotateCw className="size-3" />
          Try again
        </button>
      </div>
    )
  }
}
