import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { Field, SectionLabel, SectionNote, TextField } from './primitives'

type BinaryCheck = Awaited<ReturnType<typeof window.api.claude.checkBinary>>

/**
 * Which CLI Nyra is actually running, and what else is installed.
 *
 * Two installs is an ordinary state — an old native one and a Homebrew one
 * someone updated — and nothing on screen used to say which of them chats ran
 * on. One user's picker sat on Opus 4.8 through every update because Nyra was
 * spawning the copy she had not updated. Shown under the field so a stale
 * second install is one glance away rather than a trip to the debug log.
 */
function useBinaryCheck(path: string): BinaryCheck | null {
  const [check, setCheck] = useState<BinaryCheck | null>(null)
  useEffect(() => {
    let cancelled = false
    // Typed into a field, so wait for the typing to stop.
    const timer = setTimeout(() => {
      window.api.claude
        .checkBinary(path)
        .then((result) => {
          if (!cancelled) setCheck(result ?? null)
        })
        .catch(() => {
          if (!cancelled) setCheck(null)
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [path])
  return check
}

function BinaryStatus({ check }: { check: BinaryCheck | null }): React.JSX.Element | null {
  if (!check) return null
  const others = (check.installs ?? []).filter((i) => i.path !== check.path)
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
      <p className="truncate" title={check.path}>
        {check.found ? (
          <>
            Using <span className="font-mono text-foreground">{check.path}</span> · {check.version}
          </>
        ) : (
          <span className="text-danger">
            No working CLI at <span className="font-mono">{check.path}</span>
          </span>
        )}
      </p>
      {others.map((i) => (
        <p key={i.path} className="truncate" title={i.path}>
          Also installed: <span className="font-mono">{i.path}</span> ·{' '}
          {i.version ?? 'does not run'}
        </p>
      ))}
    </div>
  )
}

export default function AdvancedTab(): React.JSX.Element {
  const claudeBinaryPath = useSettingsStore((s) => s.claudeBinaryPath)
  const update = useSettingsStore((s) => s.updateSettings)
  const reset = useSettingsStore((s) => s.resetSettings)
  const [confirming, setConfirming] = useState(false)
  const check = useBinaryCheck(claudeBinaryPath)

  return (
    <>
      <SectionLabel>Claude CLI</SectionLabel>
      <Field label="Binary path">
        <TextField value={claudeBinaryPath} onChange={(v) => update({ claudeBinaryPath: v })} mono />
        <BinaryStatus check={check} />
      </Field>
      <SectionNote>
        Leave as <span className="font-mono">claude</span> to use the newest install Nyra finds. A
        full path always wins.
      </SectionNote>

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
