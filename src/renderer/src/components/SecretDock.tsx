import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CircleX, Eye, EyeOff, FileLock, KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { DockButton } from './QuestionDock'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSecretsStore, type SecretAsk } from '../store/secrets'
import { whereSaved } from '../lib/secretRequest'

/**
 * Claude asking for an API key or a token, as the top of the composer.
 *
 * The field is the point: pasted in the composer, a key is in the transcript
 * for good. Pasted here, it goes to Rust, into the project's `.env` or a private
 * file, and Claude hears only where. So the value lives in this component's
 * state and nowhere else, and is dropped the moment it is saved.
 *
 * Several secrets are one request, answered one at a time like a set of
 * questions. Each is saved as you go, so a failed write shows on its own field
 * and can be tried again without retyping the others.
 */
export default function SecretDock({
  sessionId,
  running
}: {
  sessionId: string
  /** Whether the turn is still going. One that ended took the request with it. */
  running: boolean
}): React.JSX.Element | null {
  const ask = useSecretsStore((s) => s.bySession[sessionId]?.[0] ?? null)

  // The tool call that asked is gone once the turn ends, stopped or failed.
  // Leaving the field up would take a key for nobody.
  useEffect(() => {
    if (ask && !running) {
      useSecretsStore.getState().settle(sessionId, ask.requestId, { outcome: 'cancelled', skipped: [] })
    }
  }, [ask, running, sessionId])

  if (!ask) return null
  return <SecretForm key={ask.requestId} sessionId={sessionId} ask={ask} />
}

function SecretForm({ sessionId, ask }: { sessionId: string; ask: SecretAsk }): React.JSX.Element {
  const { secrets } = ask
  const [page, setPage] = useState(0)
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [saved, setSaved] = useState<Set<number>>(new Set())
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field on every secret, so a paste lands here and not in the
  // composer below it, where it would be sent to Claude.
  useEffect(() => {
    if (!collapsed) inputRef.current?.focus()
  }, [page, collapsed])

  const multi = secrets.length > 1
  const last = page === secrets.length - 1
  const secret = secrets[page]
  const where = whereSaved(ask.target, ask.save)

  const finish = (skippedNow: Set<number>): void =>
    useSecretsStore.getState().settle(sessionId, ask.requestId, { outcome: 'done', skipped: [...skippedNow] })

  const goTo = (next: number): void => {
    setValue('')
    setReveal(false)
    setError(null)
    setPage(next)
  }

  const advance = (skippedNow: Set<number>): void => {
    if (last) finish(skippedNow)
    else goTo(page + 1)
  }

  const save = async (): Promise<void> => {
    if (saving) return
    // Nothing typed on a secret already saved: Next just moves on.
    if (!value.trim()) {
      if (saved.has(page)) advance(skipped)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.secrets.save(ask.requestId, page, value)
      setSaved((s) => new Set(s).add(page))
      const nextSkipped = new Set(skipped)
      nextSkipped.delete(page)
      setSkipped(nextSkipped)
      advance(nextSkipped)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const skip = (): void => {
    const next = new Set(skipped).add(page)
    setSkipped(next)
    advance(next)
  }

  const cancel = (): void =>
    useSecretsStore.getState().settle(sessionId, ask.requestId, { outcome: 'cancelled', skipped: [...skipped] })

  const progress = multi
    ? `${page + 1} of ${secrets.length}${saved.size > 0 ? ` · ${saved.size} saved` : ''}`
    : ''
  const canSave = value.trim().length > 0 || saved.has(page)
  const primary = error ? 'Try again' : multi && !last ? 'Next' : 'Save'

  if (collapsed) {
    return (
      <div className="pb-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center gap-2 pb-2 text-start"
        >
          <KeyRound className="size-3.5 shrink-0 text-info" />
          <span className="shrink-0 text-c-sm font-medium text-foreground/80">Secret</span>
          <span className="min-w-0 flex-1 truncate text-c-sm text-muted-foreground">{secret.label}</span>
          <span className="shrink-0 text-c-sm font-medium text-info">Enter</span>
          <ChevronUp className="size-3.5 shrink-0 text-info" />
        </button>
        <div className="h-px bg-separator" />
      </div>
    )
  }

  return (
    <div className="pb-2" role="group" aria-label={`Secret: ${secret.label}`}>
      <div className="flex items-center gap-2 pb-2">
        <KeyRound className="size-3.5 shrink-0 text-info" />
        <span className="text-c-sm font-medium text-foreground/80">Secret</span>
        <span className="ml-auto text-c-xs text-muted-foreground">{progress}</span>
        <DockButton onClick={cancel}>Cancel</DockButton>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Hide secret"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-c-md font-medium text-foreground">{secret.label}</span>
        {secret.label !== secret.name && (
          <span className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-c-xs text-muted-foreground">
            {secret.name}
          </span>
        )}
      </div>
      {secret.reason && (
        <p className="pt-0.5 text-c-sm leading-snug text-muted-foreground">
          <Linkified text={secret.reason} />
        </p>
      )}

      <form
        className="pt-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div
          className={`flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 transition-colors ${
            error ? 'border-danger' : 'border-input focus-within:border-primary'
          }`}
        >
          <Lock className="size-3.5 shrink-0 text-muted-foreground" />
          {/* Text masked by CSS rather than type="password": a password field
              makes the webview and password managers offer to save it. */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (error) setError(null)
            }}
            placeholder={
              saved.has(page) ? 'Saved. Paste again to replace it' : secret.placeholder || 'Paste the secret'
            }
            aria-label={secret.label}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            style={reveal ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)}
            className="min-w-0 flex-1 bg-transparent font-mono text-c-md text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  setReveal((v) => !v)
                  inputRef.current?.focus()
                }}
                aria-label={reveal ? 'Hide' : 'Show'}
                className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{reveal ? 'Hide' : 'Show'}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2 pt-2">
          {error ? (
            <>
              <CircleX className="size-3.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 text-c-sm text-danger">
                {error}. The key is still in the field.
              </span>
            </>
          ) : ask.save === 'file' ? (
            <>
              <FileLock className="size-3.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-c-sm text-muted-foreground">
                Saved to a private file Claude’s commands can read for 24 hours.
              </span>
            </>
          ) : (
            <>
              <ShieldCheck className="size-3.5 shrink-0 text-success" />
              <span className="min-w-0 flex-1 text-c-sm text-muted-foreground">
                Saved to {where}, not sent to Claude.
              </span>
            </>
          )}
          {multi && (
            <>
              <DockButton disabled={page === 0 || saving} onClick={() => goTo(page - 1)}>
                Previous
              </DockButton>
              <DockButton disabled={saving} onClick={skip}>
                Skip
              </DockButton>
            </>
          )}
          <DockButton solid disabled={!canSave || saving} onClick={() => void save()}>
            {primary}
          </DockButton>
        </div>
      </form>

      <div className="mt-2 h-px bg-separator" />
    </div>
  )
}

/** Links in the reason, where Claude says where to get the key. Bare domains
 *  too: "platform.openai.com/api-keys" is how a model writes them. */
const LINK = /(https?:\/\/[^\s)]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|dev|io|ai|org|net|app|co|cloud|sh)(?:\/[^\s)]*)?)/gi

function Linkified({ text }: { text: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(LINK)) {
    const raw = m[0].replace(/[.,;:!?]+$/, '')
    const start = m.index ?? 0
    parts.push(text.slice(at, start))
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    parts.push(
      <a
        key={start}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-info/80 underline underline-offset-2 transition-colors hover:text-info"
      >
        {raw}
      </a>
    )
    at = start + raw.length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}
