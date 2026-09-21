/**
 * The pull requests a conversation opened.
 *
 * Nothing in the headless CLI reports a PR, so this is recovered from the tool
 * call that made one: `gh pr create` prints the new PR's URL on stdout, and an
 * MCP `create_pull_request` answers with `html_url`. Both are read out of the
 * *result*, which is the only place the number exists — the call itself only
 * says "open a PR", not which one it became.
 *
 * Only PRs this chat *created* are tracked. A PR Claude merely read — a
 * `/pr-review`, a `gh pr checkout` — is not this conversation's work, and a chip
 * that appeared for one would make "this chat has a PR" mean nothing. That is
 * why detection is anchored on the creating call rather than on any PR URL
 * passing through the transcript: URLs pass through constantly.
 *
 * The URL is also the identity. A chat that works across several repos gets one
 * entry per repo with no extra bookkeeping, because `owner/repo` is in the URL —
 * which is the whole reason the URL is stored rather than a bare number.
 */

/** GitHub's own four states, which is also what `gh pr view --json` reports. */
export type PrState = 'open' | 'draft' | 'merged' | 'closed'

export type PullRequest = {
  /** Canonical web URL, and the dedupe key. */
  url: string
  owner: string
  repo: string
  number: number
  /** From `gh pr view`; absent until that answers, or if `gh` is not installed. */
  title?: string
  /** Absent means "not known yet" — the chip draws neutral rather than guessing
   *  at open, which would be a lie about a draft. */
  state?: PrState
  createdAt: number
  /** When the state was last asked for, so opening a chat does not shell out
   *  to `gh` once per glance. See `prSync.ts`. */
  checkedAt?: number
}

/**
 * `gh pr create`, however it was reached.
 *
 * Matched loosely on purpose: the command is usually one link in a chain
 * (`git push -u origin HEAD && gh pr create --fill`), sometimes wrapped in a
 * subshell, and the flags vary. `--web` opens a browser and prints no URL, so
 * that case registers nothing and needs no special handling.
 */
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/

/** An MCP server's equivalent — `mcp__github__create_pull_request` and friends. */
const MCP_PR_CREATE = /create_pull_request$/

export function isPrCreatingCall(toolName: string, input: Record<string, unknown>): boolean {
  if (MCP_PR_CREATE.test(toolName)) return true
  if (toolName !== 'Bash') return false
  const command = typeof input.command === 'string' ? input.command : ''
  return GH_PR_CREATE.test(command)
}

/**
 * A PR's web URL, anywhere in a blob of output.
 *
 * The host is not pinned to github.com so a GitHub Enterprise install works
 * unchanged — the path shape is what identifies a PR, and since this only ever
 * reads the result of a call we already know creates one, a false positive has
 * nowhere to come from.
 *
 * Two near misses this deliberately does not match. `git push` prints
 * `…/pull/new/<branch>` — a *compose* link, not a PR, and excluded for free
 * because `new` is not a number. The REST API's own `url` field is
 * `…/repos/o/r/pulls/123`, plural, so an MCP result carrying both fields yields
 * only the `html_url` a human can open.
 */
const PR_URL = /https?:\/\/[^\s/"'<>]+\/([^\s/"'<>]+)\/([^\s/"'<>]+)\/pull\/(\d+)/g

export type PrRef = Pick<PullRequest, 'url' | 'owner' | 'repo' | 'number'>

/**
 * The PR a creating call produced, or null.
 *
 * The *last* match wins. `gh` prints progress lines before the URL, and when a
 * PR already exists for the branch it says so with that PR's URL — which is
 * still the right thing to show: it is the PR for the work this chat pushed, and
 * on a retry it dedupes onto the entry we already have. Taking the first match
 * instead would pick up a URL quoted in the PR body Claude just wrote.
 */
export function findCreatedPr(result: string): PrRef | null {
  PR_URL.lastIndex = 0
  let last: PrRef | null = null
  let hit: RegExpExecArray | null
  while ((hit = PR_URL.exec(result)) !== null) {
    last = {
      url: hit[0],
      owner: hit[1],
      repo: hit[2],
      number: Number(hit[3])
    }
  }
  return last
}

/**
 * What a scan needs from a stored message.
 *
 * Structural rather than the store's own `Message`, because `sessions.ts`
 * imports `PullRequest` from this file — taking its type back would close the
 * loop. It also keeps this function testable with plain object literals.
 */
export type ScannableMessage = {
  role: string
  tool_name?: string
  input?: Record<string, unknown>
  result?: string
  timestamp?: number
}

/**
 * The PRs a transcript already contains.
 *
 * Live detection watches the event stream, which means it only ever sees chats
 * that ran after it shipped — and it holds the "this call is opening a PR" note
 * in memory, so a restart between the call and its result drops even a live one.
 * A stored `tool_call` keeps `tool_name`, `input` and `result` together, which
 * is everything the two matchers need, so both gaps close by reading the
 * transcript back.
 *
 * Safe to re-run: the same URL twice yields one entry, and the earliest wins, so
 * a retried `gh pr create` keeps the timestamp of the attempt that first opened
 * it. `createdAt` comes from the message rather than the clock, so a PR
 * recovered today is not dated today.
 */
export function scanForPrs(messages: readonly ScannableMessage[]): PullRequest[] {
  const found: PullRequest[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool_call' || !m.result) continue
    if (!isPrCreatingCall(m.tool_name ?? '', m.input ?? {})) continue
    const ref = findCreatedPr(m.result)
    if (!ref || seen.has(ref.url)) continue
    seen.add(ref.url)
    found.push({ ...ref, createdAt: m.timestamp ?? Date.now() })
  }
  return found
}

/** `owner/repo#123` — the unambiguous form, for a tooltip or a hover card. */
export function prSlug(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`
}

/**
 * What a chip says.
 *
 * `#123` reads fine while a chat has one repo's PRs, and stops reading fine the
 * moment it has two — which is the multi-repo case this was built for, so the
 * repo appears exactly when it disambiguates something.
 */
export function prLabel(pr: PrRef, withRepo: boolean): string {
  return withRepo ? `${pr.repo}#${pr.number}` : `#${pr.number}`
}

/** True when the chat's PRs span more than one repo, so labels need the repo. */
export function spansRepos(prs: readonly PrRef[]): boolean {
  if (prs.length < 2) return false
  const first = `${prs[0].owner}/${prs[0].repo}`
  return prs.some((pr) => `${pr.owner}/${pr.repo}` !== first)
}

/** `gh pr view --json state,isDraft` speaks in caps, and draft is a flag. */
export function prStateFrom(state: string | undefined, isDraft: boolean | undefined): PrState | undefined {
  switch ((state ?? '').toUpperCase()) {
    case 'OPEN':
      return isDraft ? 'draft' : 'open'
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return undefined
  }
}

/**
 * GitHub's palette, because the colour is load-bearing.
 *
 * Anyone who reads PRs all day already knows green/grey/purple/red, and a chip
 * that used its own scheme would make them read the number to learn what the
 * colour should have told them. Purple is *merged* specifically — worth stating,
 * because purple is also the obvious "PR-ish" brand colour, and using it for an
 * open PR would say the opposite of the truth.
 */
export const PR_STATE_CLASS: Record<PrState, string> = {
  open: 'text-success',
  draft: 'text-muted-foreground',
  merged: 'text-merged',
  closed: 'text-danger'
}

export const PR_STATE_LABEL: Record<PrState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

/** Newest first — a chat's most recent PR is the one it is about. */
export function sortPrs(prs: readonly PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => b.createdAt - a.createdAt)
}
