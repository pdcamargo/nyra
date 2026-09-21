import { describe, it, expect, beforeEach } from 'vitest'
import { backfillPrs } from '@renderer/lib/prSync'
import { useSessionsStore, type Message } from '@renderer/store/sessions'

const session = (id: string) => useSessionsStore.getState().sessions.find((s) => s.id === id)!

function resetStore(): void {
  useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
}

/** A `gh pr create` and the URL it printed, as the transcript stores them. */
function prCall(number: number, repo = 'nyra', at = 1_700_000_000_000): Message {
  return {
    id: `m${number}`,
    role: 'tool_call',
    tool_id: `t${number}`,
    tool_name: 'Bash',
    input: { command: 'git push -u origin HEAD && gh pr create --fill' },
    result: `https://github.com/pdcamargo/${repo}/pull/${number}\n`,
    timestamp: at
  }
}

describe('backfillPrs', () => {
  beforeEach(resetStore)

  it('finds a PR in a chat that predates live detection', () => {
    const id = useSessionsStore.getState().createSession('/tmp/test')
    useSessionsStore.getState().addMessage(id, prCall(42))
    expect(session(id).pullRequests).toBeUndefined()

    backfillPrs(id)

    expect(session(id).pullRequests).toEqual([
      {
        url: 'https://github.com/pdcamargo/nyra/pull/42',
        owner: 'pdcamargo',
        repo: 'nyra',
        number: 42,
        createdAt: 1_700_000_000_000
      }
    ])
  })

  it('leaves the session object alone when there is nothing to find', () => {
    const id = useSessionsStore.getState().createSession('/tmp/test')
    useSessionsStore.getState().addMessage(id, {
      id: 'm1',
      role: 'tool_call',
      tool_id: 't1',
      tool_name: 'Bash',
      input: { command: 'npm test' },
      result: 'ok'
    })
    const before = session(id)

    backfillPrs(id)

    // Identity, not just equality: a scan that writes would re-render the chat
    // on every open, which is the reason only unknown URLs are handed on.
    expect(session(id)).toBe(before)
  })

  it('is safe to re-run — a second open adds nothing and keeps the first date', () => {
    const id = useSessionsStore.getState().createSession('/tmp/test')
    useSessionsStore.getState().addMessage(id, prCall(42))
    backfillPrs(id)
    const afterFirst = session(id)

    backfillPrs(id)

    expect(session(id)).toBe(afterFirst)
    expect(session(id).pullRequests).toHaveLength(1)
    expect(session(id).pullRequests![0].createdAt).toBe(1_700_000_000_000)
  })

  it('does not disturb a PR the live path already recorded with its state', () => {
    const id = useSessionsStore.getState().createSession('/tmp/test')
    useSessionsStore.getState().addMessage(id, prCall(42))
    useSessionsStore.getState().addPullRequest(id, {
      url: 'https://github.com/pdcamargo/nyra/pull/42',
      owner: 'pdcamargo',
      repo: 'nyra',
      number: 42,
      state: 'merged',
      title: 'Add the thing',
      createdAt: 1_600_000_000_000,
      checkedAt: 1_600_000_000_000
    })

    backfillPrs(id)

    expect(session(id).pullRequests).toHaveLength(1)
    expect(session(id).pullRequests![0].state).toBe('merged')
    expect(session(id).pullRequests![0].title).toBe('Add the thing')
  })

  it('recovers one PR per repo when a chat worked across two', () => {
    const id = useSessionsStore.getState().createSession('/tmp/test')
    useSessionsStore.getState().addMessage(id, prCall(42))
    useSessionsStore.getState().addMessage(id, prCall(7, 'helix'))

    backfillPrs(id)

    expect(session(id).pullRequests!.map((pr) => `${pr.repo}#${pr.number}`)).toEqual([
      'nyra#42',
      'helix#7'
    ])
  })

  it('shrugs at a session id that is not there', () => {
    expect(() => backfillPrs('nope')).not.toThrow()
  })
})
