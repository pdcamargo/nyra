import React, { useState, useEffect, useRef } from 'react'
import Modal from './Modal'
import { CircleCheckBig, TriangleAlert } from 'lucide-react'
import { useSettingsStore } from '../store/settings'
import { useShortcutsStore, chordFor } from '../store/shortcuts'
import { COMMANDS_BY_ID, type CommandId } from '../commands/registry'
import { formatChord } from '../lib/keys'

type Step = 1 | 2
type CliStatus = 'checking' | 'found' | 'not-found'

export default function WelcomeModal(): React.JSX.Element | null {
  const onboardingComplete = useSettingsStore((s) => s.onboardingComplete)
  const [step, setStep] = useState<Step>(1)

  if (onboardingComplete) return null

  return (
    <Modal onClose={() => {}} title="Welcome to Nyra" className="max-w-md overflow-hidden">
        {/* Step dots */}
        <div className="flex justify-center gap-2 pt-5 pb-2">
          {([1, 2] as Step[]).map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step ? 'w-6 bg-info' : s < step ? 'w-1.5 bg-info/40' : 'w-1.5 bg-accent'
              }`}
            />
          ))}
        </div>

        <div className="p-6">
          {step === 1 && <StepCli onNext={() => setStep(2)} />}
          {step === 2 && <StepTips />}
        </div>
      </Modal>
  )
}

function StepCli({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<CliStatus>('checking')
  const [cliPath, setCliPath] = useState('')
  const [cliVersion, setCliVersion] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [verifying, setVerifying] = useState(false)
  const advancedRef = useRef(false)

  const checkBinary = async (path?: string): Promise<void> => {
    setStatus('checking')
    try {
      const result = await window.api.claude.checkBinary(path)
      if (result.found) {
        setStatus('found')
        setCliPath(result.path)
        setCliVersion(result.version ?? '')
      } else {
        setStatus('not-found')
        setCliPath(result.path)
      }
    } catch {
      setStatus('not-found')
    }
  }

  useEffect(() => {
    checkBinary()
  }, [])

  // Auto-advance after CLI is found
  useEffect(() => {
    if (status === 'found' && !advancedRef.current) {
      advancedRef.current = true
      const timer = setTimeout(onNext, 1200)
      return () => clearTimeout(timer)
    }
  }, [status, onNext])

  const handleVerifyCustom = async (): Promise<void> => {
    if (!customPath.trim()) return
    setVerifying(true)
    const result = await window.api.claude.checkBinary(customPath.trim())
    if (result.found) {
      useSettingsStore.getState().updateSettings({ claudeBinaryPath: customPath.trim() })
      setStatus('found')
      setCliPath(result.path)
      setCliVersion(result.version ?? '')
    } else {
      setStatus('not-found')
    }
    setVerifying(false)
  }

  return (
    <div className="text-center space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">Welcome to Nyra</h2>
        <p className="text-[12px] text-muted-foreground">Checking for Claude Code CLI…</p>
      </div>

      {status === 'checking' && (
        <div className="flex justify-center py-4">
          <div className="h-8 w-8 rounded-full border-2 border-info/30 border-t-blue-500 animate-spin" />
        </div>
      )}

      {status === 'found' && (
        <div className="rounded-xl border border-success/20 bg-success/6 p-4 space-y-2">
          <div className="flex justify-center">
            <CircleCheckBig className="size-8 text-success" />
          </div>
          <p className="text-[13px] font-medium text-success/80">Claude Code CLI found</p>
          <p className="text-[11px] text-muted-foreground font-mono truncate">{cliPath}</p>
          {cliVersion && <p className="text-[10px] text-muted-foreground/70">{cliVersion}</p>}
        </div>
      )}

      {status === 'not-found' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-warning/20 bg-warning/6 p-4 space-y-3">
            <div className="flex justify-center">
              <TriangleAlert className="size-7 text-warning" />
            </div>
            <p className="text-[13px] font-medium text-warning/80">Claude Code CLI not found</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Nyra requires the Claude Code CLI to work. Install it first, then come back.
            </p>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-accent hover:bg-secondary px-4 py-2 text-[12px] font-medium text-foreground/80 transition-colors"
            >
              Install Claude Code →
            </a>
          </div>

          <button
            onClick={() => checkBinary()}
            className="rounded-lg border border-border-strong px-4 py-2 text-[12px] font-medium text-foreground/80 hover:text-foreground/80 hover:bg-accent/50 transition-colors"
          >
            Check Again
          </button>

          <div className="pt-2 space-y-2">
            <p className="text-[10px] text-muted-foreground/70 uppercase tracking-wider font-medium">Or set custom path</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/path/to/claude"
                className="flex-1 rounded-md border border-border-strong bg-accent/50 px-3 py-1.5 text-[12px] text-foreground/80 font-mono placeholder-muted-foreground/70 outline-hidden focus:border-border-strong"
                onKeyDown={(e) => e.key === 'Enter' && handleVerifyCustom()}
              />
              <button
                onClick={handleVerifyCustom}
                disabled={!customPath.trim() || verifying}
                className="rounded-md bg-info/80 hover:bg-info px-3 py-1.5 text-[12px] font-medium text-info-foreground transition-colors disabled:opacity-30"
              >
                {verifying ? '…' : 'Verify'}
              </button>
            </div>
          </div>
        </div>
      )}

      {status === 'found' && (
        <button
          onClick={onNext}
          className="rounded-lg bg-info hover:bg-info/85 px-5 py-2 text-[13px] font-medium text-info-foreground transition-colors"
        >
          Continue
        </button>
      )}
    </div>
  )
}

/**
 * Four shortcuts worth knowing, read from the registry.
 *
 * This list used to be hardcoded, and had drifted: it told every new user that
 * ⌘K was "New session" long after ⌘K became the command palette.
 */
const TIP_COMMANDS: CommandId[] = ['palette.open', 'panel.bottom', 'session.new', 'app.settings']

function StepTips(): React.JSX.Element {
  const overrides = useShortcutsStore((s) => s.overrides)
  const tips = TIP_COMMANDS.map((id) => {
    const chord = chordFor(id, overrides)
    return { keys: chord ? formatChord(chord) : '—', label: COMMANDS_BY_ID.get(id)!.label }
  })

  return (
    <div className="text-center space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">You're all set</h2>
        <p className="text-[12px] text-muted-foreground">A few shortcuts to get you started.</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {tips.map((tip) => (
          <div key={tip.keys} className="rounded-xl border border-border/55 bg-muted/40 p-3 text-left">
            <kbd className="text-[12px] font-mono font-medium text-foreground/80 bg-accent/50 px-1.5 py-0.5 rounded-sm">
              {tip.keys}
            </kbd>
            <p className="text-[11px] text-muted-foreground mt-1.5">{tip.label}</p>
          </div>
        ))}
      </div>

      <button
        onClick={() => useSettingsStore.getState().updateSettings({ onboardingComplete: true })}
        className="rounded-lg bg-info hover:bg-info/85 px-6 py-2.5 text-[13px] font-semibold text-info-foreground transition-colors"
      >
        Get Started
      </button>
    </div>
  )
}
