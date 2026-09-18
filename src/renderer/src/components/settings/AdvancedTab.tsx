import React, { useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { Field, SectionLabel, SectionNote, TextField } from './primitives'

export default function AdvancedTab(): React.JSX.Element {
  const claudeBinaryPath = useSettingsStore((s) => s.claudeBinaryPath)
  const update = useSettingsStore((s) => s.updateSettings)
  const reset = useSettingsStore((s) => s.resetSettings)
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <SectionLabel>Claude CLI</SectionLabel>
      <Field label="Binary path">
        <TextField value={claudeBinaryPath} onChange={(v) => update({ claudeBinaryPath: v })} mono />
      </Field>

      <SectionLabel>Reset</SectionLabel>
      <SectionNote>
        Puts every setting back to its default. Keyboard shortcuts are stored separately and are
        reset from the Shortcuts pane.
      </SectionNote>
      {confirming ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              reset()
              setConfirming(false)
            }}
            className="rounded-lg bg-destructive px-3 py-1.5 text-xs text-destructive-foreground transition-colors hover:opacity-90"
          >
            Reset everything
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          Reset all settings…
        </button>
      )}
    </>
  )
}
