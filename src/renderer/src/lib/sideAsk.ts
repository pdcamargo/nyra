import { cwdForSession, newMessageId, providerSessionId, useSessionsStore } from '../store/sessions'
import { capabilitiesOf } from './providers'
import { useSideQuestionsStore, type SideQuote, type SideThread } from '../store/sideQuestions'
import type { SideEvent } from './tauri-api'
import { spawnSettingsForSession } from './spawnSettings'
import { sidePrompt } from './sideQuestions'

/**
 * Running side threads: the store holds what the sheet shows, this is what
 * talks to the backend. One process per thread, ended whenever its thread is
 * replaced, closed or added to the chat.
 */

/** Open the sheet on a fresh thread, asking `question` right away when there is one. */
export function openSideQuestion(sessionId: string, opts: { quote?: SideQuote; question?: string } = {}): void {
  // Every way in — `/btw`, Ask on a selection, the palette — comes through here.
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
  if (!capabilitiesOf(session).sideQuestions) return
  const thread: SideThread = { id: newMessageId(), quote: opts.quote, turns: [] }
  const previous = useSideQuestionsStore.getState().start(sessionId, thread)
  if (previous) void window.api.claude.sideClose(previous.id)
  if (opts.question?.trim()) askSide(sessionId, opts.question)
}

export function askSide(sessionId: string, question: string): void {
  const store = useSideQuestionsStore.getState()
  const thread = store.open[sessionId]
  if (!thread || !question.trim()) return
  const first = thread.turns.length === 0
  const turnId = newMessageId()
  store.addTurn(sessionId, { id: turnId, question: question.trim(), answer: '', status: 'streaming' })

  const sessions = useSessionsStore.getState()
  const session = sessions.sessions.find((s) => s.id === sessionId)
  window.api.claude
    .sideAsk({
      sideId: thread.id,
      nyraSessionId: sessionId,
      cwd: cwdForSession(sessions, sessionId),
      // Nothing to fork before the chat's first reply: the thread starts blank.
      sessionId: providerSessionId(session),
      // Only the first message needs telling what this is; the process remembers.
      prompt: first ? sidePrompt(question, thread.quote) : question.trim(),
      settings: spawnSettingsForSession(sessionId)
    })
    .catch((err: unknown) => {
      useSideQuestionsStore.getState().patchTurn(thread.id, turnId, { status: 'error', error: String(err) })
    })
}

export function closeSide(sessionId: string): void {
  const thread = useSideQuestionsStore.getState().close(sessionId)
  if (thread) void window.api.claude.sideClose(thread.id)
}

/** Add the thread to the chat: it waits in the composer for the next send. */
export function keepSide(sessionId: string): void {
  const thread = useSideQuestionsStore.getState().keep(sessionId)
  if (thread) void window.api.claude.sideClose(thread.id)
}

/** The thread's turn still waiting on an answer. */
function streamingTurn(sideId: string): { threadId: string; turnId: string; answer: string } | null {
  for (const thread of Object.values(useSideQuestionsStore.getState().open)) {
    if (thread?.id !== sideId) continue
    const turn = [...thread.turns].reverse().find((t) => t.status === 'streaming')
    return turn ? { threadId: thread.id, turnId: turn.id, answer: turn.answer } : null
  }
  return null
}

export function applySideEvent(event: SideEvent): void {
  const at = streamingTurn(event.sideId)
  if (!at) return
  const store = useSideQuestionsStore.getState()
  switch (event.type) {
    case 'delta':
      store.patchTurn(at.threadId, at.turnId, { activity: undefined })
      store.appendAnswer(at.threadId, at.turnId, event.text)
      break
    case 'block':
      if (at.answer.trim()) store.appendAnswer(at.threadId, at.turnId, '\n\n')
      break
    case 'tool':
      store.patchTurn(at.threadId, at.turnId, { activity: event.name })
      break
    case 'done':
      store.patchTurn(
        at.threadId,
        at.turnId,
        event.isError
          ? { status: 'error', error: event.result || 'The side question failed.', activity: undefined }
          : { status: 'done', activity: undefined }
      )
      break
    case 'exit':
      store.patchTurn(at.threadId, at.turnId, {
        status: 'error',
        error: 'The side question stopped before it answered.',
        activity: undefined
      })
      break
  }
}
