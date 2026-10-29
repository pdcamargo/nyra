import React, { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronUp, CircleCheck, CircleMinus, KeyRound, LoaderCircle, Minus, TriangleAlert } from 'lucide-react'
import type { ToolCallMessage } from '../store/sessions'
import { parseSecretResult, secretsOf, whereSaved, type SecretLine } from '../lib/secretRequest'

/**
 * A `nyra_secret` call in the transcript: what was asked for and what became of
 * each, never a value. The call's input is labels and names, and its result is
 * the lines Rust wrote, so there is nothing here to leak.
 *
 * One secret folds to a line. Several are a card, one row each, because "2 of
 * 3 saved" alone does not say which one is missing.
 */
export default function SecretCard({ message }: { message: ToolCallMessage }): React.JSX.Element {
  const secrets = useMemo(() => secretsOf(message.input), [message.input])
  const { lines, notes } = useMemo(() => parseSecretResult(message.result), [message.result])
  const [open, setOpen] = useState(true)
  const save = message.input.save === 'file' ? 'file' : 'env'
  const labelOf = (name: string): string => secrets.find((s) => s.name === name)?.label ?? name

  if (message.result === undefined) {
    return (
      <div className="my-1 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-c-md">
        <KeyRound className="size-3.5 shrink-0 text-info" />
        <span className="font-medium text-foreground">Secret</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {secrets.length === 1 ? secrets[0].label : `${secrets.length} secrets`}
        </span>
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" />
        <span className="shrink-0 text-c-sm text-info">Waiting for you</span>
      </div>
    )
  }

  // Refused before it asked anything: a bad name, no folder for a .env.
  if (message.isError || message.denied || lines.length === 0) {
    return (
      <div className="flex items-start gap-2 py-1 text-c-md">
        <KeyRound className="mt-[0.3em] size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          Secret request failed{message.result ? `: ${message.result.split('\n')[0]}` : ''}
        </span>
      </div>
    )
  }

  const outcome = (line: SecretLine): string => {
    switch (line.status) {
      case 'saved': {
        const where = whereSaved(line.path ?? '', save)
        return where === 'a private file' ? 'Saved to a private file for 24 hours' : `Saved to ${where}`
      }
      case 'skipped':
        return 'Skipped'
      case 'cancelled':
        return 'Cancelled'
      default:
        return 'No answer after 10 minutes'
    }
  }
  // The rest of the notes are instructions to Claude. This one is the user's
  // business too.
  const unignored = notes.some((n) => n.includes('not in .gitignore'))
  const envName = lines.find((l) => l.status === 'saved')?.path?.split(/[\\/]/).pop() ?? '.env'

  if (lines.length === 1) {
    const line = lines[0]
    const saved = line.status === 'saved'
    return (
      <div className="py-1 text-c-md">
        <div className="flex items-center gap-2">
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-foreground">{labelOf(line.name)}</span>
          <span className="text-muted-foreground">·</span>
          {saved ? (
            <Check className="size-3.5 shrink-0 text-success" />
          ) : (
            <Minus className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-muted-foreground">{outcome(line)}</span>
        </div>
        {unignored && <GitignoreWarning file={envName} />}
      </div>
    )
  }

  const savedCount = lines.filter((l) => l.status === 'saved').length
  const rest = lines.length - savedCount
  const restWord = lines.find((l) => l.status !== 'saved')?.status ?? 'skipped'
  const summary = [
    savedCount > 0 ? `${savedCount} saved` : '',
    rest > 0 ? `${rest} ${restWord === 'no answer' ? 'unanswered' : restWord}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border bg-muted/40 text-c-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-start"
      >
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">Secrets</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        {open ? (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/55 px-3 py-2">
          {lines.map((line) => (
            <div key={line.name} className="flex items-center gap-2">
              {line.status === 'saved' ? (
                <CircleCheck className="size-3.5 shrink-0 text-success" />
              ) : (
                <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="text-foreground">{labelOf(line.name)}</span>
              <span className="rounded-sm bg-accent px-1.5 py-0.5 font-mono text-c-xs text-muted-foreground">
                {line.name}
              </span>
              <span className="flex-1" />
              <span className="text-c-sm text-muted-foreground">{outcome(line)}</span>
            </div>
          ))}
          {unignored && <GitignoreWarning file={envName} />}
        </div>
      )}
    </div>
  )
}

function GitignoreWarning({ file }: { file: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 pt-1 text-c-sm text-warning">
      <TriangleAlert className="size-3.5 shrink-0" />
      <span>{file} isn’t in .gitignore</span>
    </div>
  )
}
