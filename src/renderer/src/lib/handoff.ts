import type { Provider, SpawnSettings } from '@shared/types'
import type { Message, Session, TextMessage } from '../store/sessions'
import { historyText, recapFor } from './historyText'
import { PROVIDER_LABEL, anchorFor } from './providers'

/**
 * What a chat's CLI is told of the conversation it has not seen.
 *
 * A chat that moved to another CLI hands over what the first one did. Short,
 * that is the prose itself — it costs less than asking anyone to shorten it.
 * Long, the CLI that was answering writes a handoff summary from inside its own
 * conversation, where it can see every tool call and file it touched, and the
 * new one gets that and the last exchange verbatim.
 */
export type HandoffPlan =
  | { kind: 'none' }
  | { kind: 'recap'; text: string; tokens: number; missed: number; from: Provider | null }
  | {
      kind: 'summary'
      from: Provider
      fromSessionId: string
      /** The messages the summary stands for. */
      earlier: Message[]
      /** The last exchange, kept word for word. */
      recent: Message[]
      tokens: number
      missed: number
    }

/** Past this, a summary is cheaper than the prose it replaces. */
export const SUMMARY_THRESHOLD = 4000

/** The messages at the end kept verbatim under a summary: the last exchange. */
const RECENT = 2

/**
 * Tokens, roughly: about 3.8 characters each across both CLIs' tokenisers for
 * English and code. Good enough to say "about 6k", which is all it is for.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8)
}

type PlanSource = Pick<Session, 'provider' | 'providerSessionIds' | 'providerSeenThrough' | 'needsRecap' | 'resumeFrom' | 'messages'>

const isProse = (m: Message): m is TextMessage => m.role === 'user' || m.role === 'assistant'

/** What the chat's CLI is about to be told, before anything is sent. */
export function planHandoff(session: PlanSource): HandoffPlan {
  const text = recapFor(session)
  if (!text) return { kind: 'none' }

  const seen = session.providerSeenThrough ?? {}
  const from = (Object.keys(seen) as Provider[]).find((p) => p !== session.provider) ?? null
  const mine = seen[session.provider]
  const start = mine ? session.messages.findIndex((m) => m.id === mine) + 1 : 0
  const missed = (from ? session.messages.slice(start) : session.messages).filter(isProse)
  const tokens = estimateTokens(text)

  // A fork's history, or a stranded one: nobody holds it to summarise from.
  const fromSessionId = from ? session.providerSessionIds[from] : undefined
  const forkOnly = session.needsRecap || (!!session.resumeFrom && !anchorFor(session, session.resumeFrom))
  if (!from || !fromSessionId || forkOnly || tokens <= SUMMARY_THRESHOLD || missed.length <= RECENT) {
    return { kind: 'recap', text, tokens, missed: missed.length, from }
  }
  return {
    kind: 'summary',
    from,
    fromSessionId,
    earlier: missed.slice(0, -RECENT),
    recent: missed.slice(-RECENT),
    tokens,
    missed: missed.length
  }
}

/** What the CLI handing over is asked. Its answer is the whole of the summary. */
export function summaryPrompt(to: Provider, count: number): string {
  return [
    `Another assistant (${PROVIDER_LABEL[to]}) is taking over this conversation. It has not seen the last ${count} messages of it.`,
    'Write the handoff it needs: what the user is after, what was decided and why, what was changed (files, commands, results) and where things stand, anything still open, and what the user asked to keep in mind.',
    'Be specific — names, paths, values, errors. Leave out the last exchange; it gets that verbatim.',
    'Under 400 words. Reply with the handoff only.'
  ].join(' ')
}

/** The handoff as the incoming CLI reads it, ahead of the prompt. */
export function handoffText(from: Provider, summary: string, earlier: number, recent: Message[]): string {
  const tail = historyText(recent, 'The last exchange, verbatim')
  return `[Handoff from ${PROVIDER_LABEL[from]}, summarising ${earlier} earlier messages you have not seen]\n${summary.trim()}\n\n${tail}`
}

/**
 * The plan as text, asking for the summary when it is one. A summary that
 * cannot be had — the CLI is gone, it timed out — falls back to the prose, so
 * the incoming CLI is never told less than it would have been before.
 */
export async function resolveHandoff(
  plan: HandoffPlan,
  ctx: { sid: string; cwd: string; settings: SpawnSettings }
): Promise<string> {
  if (plan.kind === 'none') return ''
  if (plan.kind === 'recap') return plan.text
  const settings: SpawnSettings = { ...ctx.settings, provider: plan.from, model: '', effort: '', planMode: false }
  try {
    const summary = await window.api.agent.sideAnswer({
      nyraSessionId: ctx.sid,
      cwd: ctx.cwd,
      sessionId: plan.fromSessionId,
      // Told who it is handing to: the chat's own CLI, before it was swapped
      // for the one writing the summary.
      prompt: summaryPrompt(ctx.settings.provider, plan.earlier.length + plan.recent.length),
      settings
    })
    if (summary.trim()) return handoffText(plan.from, summary, plan.earlier.length, plan.recent)
  } catch {
    // Falls through to the prose.
  }
  return historyText([...plan.earlier, ...plan.recent], `Earlier in this chat, with ${PROVIDER_LABEL[plan.from]}`)
}
