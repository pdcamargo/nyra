/**
 * Keeping a PR chip's colour honest.
 *
 * The number is recovered once, from the transcript. The state is not in the
 * transcript at all and changes without Nyra being told: you merge the PR on
 * github.com and the chip here would sit there saying "open" forever. So it is
 * re-asked — but only on the two occasions anyone is looking at it (the PR is
 * new, or you opened the chat), and only for PRs whose state can still move.
 *
 * Deliberately not polled. A background timer per PR per chat would be a `gh`
 * subprocess and a network round trip every few seconds to keep a colour fresh
 * that nobody is currently reading.
 */
import { useSessionsStore } from '../store/sessions'
import { prStateFrom, type PullRequest } from './pullRequests'

/** How long a state is trusted before opening the chat re-asks. */
export const PR_STATE_STALE_MS = 60_000

/** Merged is the end of the story. Closed is not — a closed PR can reopen. */
function terminal(pr: PullRequest): boolean {
  return pr.state === 'merged'
}

/**
 * Ask `gh` about one PR and store what it says.
 *
 * `checkedAt` is written even when the answer is an error, which is what stops
 * a machine with no `gh` from re-running a failing subprocess on every glance
 * at the chat.
 */
export async function syncPrState(sessionId: string, url: string): Promise<void> {
  const reply = await window.api.pr.state(url)
  const { updatePullRequest } = useSessionsStore.getState()
  if (reply.error) {
    updatePullRequest(sessionId, url, { checkedAt: Date.now() })
    return
  }
  const state = prStateFrom(reply.state, reply.isDraft)
  updatePullRequest(sessionId, url, {
    checkedAt: Date.now(),
    ...(reply.title ? { title: reply.title } : {}),
    // An unrecognised state is left absent rather than written as a guess — the
    // chip has a neutral form for exactly this.
    ...(state ? { state } : {})
  })
}

/**
 * Refresh whatever has gone stale in one chat, fire and forget.
 *
 * Called when a chat becomes the one you are looking at. Chats are switched
 * constantly, hence the staleness window — flipping between two chats should
 * not shell out once per flip.
 */
export function syncStalePrs(sessionId: string): void {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
  const now = Date.now()
  for (const pr of session?.pullRequests ?? []) {
    if (terminal(pr)) continue
    if (pr.checkedAt && now - pr.checkedAt < PR_STATE_STALE_MS) continue
    void syncPrState(sessionId, pr.url)
  }
}
