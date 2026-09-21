import { describe, expect, it } from 'vitest'
import {
  findCreatedPr,
  isPrCreatingCall,
  scanForPrs,
  type ScannableMessage,
  prLabel,
  prSlug,
  prStateFrom,
  sortPrs,
  spansRepos,
  type PullRequest
} from '@renderer/lib/pullRequests'

describe('isPrCreatingCall', () => {
  it('takes a bare gh pr create', () => {
    expect(isPrCreatingCall('Bash', { command: 'gh pr create --fill' })).toBe(true)
  })

  it('takes it mid-chain, which is how it is actually run', () => {
    expect(
      isPrCreatingCall('Bash', { command: 'git push -u origin HEAD && gh pr create --fill' })
    ).toBe(true)
  })

  it('takes an MCP server’s equivalent', () => {
    expect(isPrCreatingCall('mcp__github__create_pull_request', {})).toBe(true)
  })

  it('leaves the read-only gh commands alone', () => {
    for (const command of ['gh pr view 12', 'gh pr checkout 12', 'gh pr list', 'gh pr merge 12']) {
      expect(isPrCreatingCall('Bash', { command })).toBe(false)
    }
  })

  it('is not fooled by a PR-ish word in another command', () => {
    expect(isPrCreatingCall('Bash', { command: 'echo "gh pr created earlier"' })).toBe(false)
    expect(isPrCreatingCall('Bash', { command: 'git commit -m "create pr"' })).toBe(false)
  })

  it('ignores a Bash call with no command at all', () => {
    expect(isPrCreatingCall('Bash', {})).toBe(false)
  })
})

describe('findCreatedPr', () => {
  it('reads the URL gh prints', () => {
    const result =
      'Warning: 1 uncommitted change\n' +
      'Creating pull request for feat into main in pdcamargo/nyra\n\n' +
      'https://github.com/pdcamargo/nyra/pull/42\n'
    expect(findCreatedPr(result)).toEqual({
      url: 'https://github.com/pdcamargo/nyra/pull/42',
      owner: 'pdcamargo',
      repo: 'nyra',
      number: 42
    })
  })

  it('ignores the compose link git push prints', () => {
    // This is the near miss the whole matcher is shaped around: `git push`
    // suggests a URL that looks like a PR and is not one yet.
    const push =
      'remote: Create a pull request for ‘feat’ on GitHub by visiting:\n' +
      'remote:      https://github.com/pdcamargo/nyra/pull/new/feat\n' +
      'To github.com:pdcamargo/nyra.git\n'
    expect(findCreatedPr(push)).toBeNull()
  })

  it('prefers the real PR over one quoted in the body it just wrote', () => {
    const result =
      'Creating pull request for feat into main\n' +
      'body: supersedes https://github.com/pdcamargo/nyra/pull/7\n' +
      'https://github.com/pdcamargo/nyra/pull/9\n'
    expect(findCreatedPr(result)?.number).toBe(9)
  })

  it('takes the existing PR gh names when one is already open', () => {
    // A retry in the same chat lands here, and it dedupes onto the entry we
    // already have — so registering it is what keeps the chip from vanishing.
    const result =
      'a pull request for branch "feat" into branch "main" already exists:\n' +
      'https://github.com/pdcamargo/nyra/pull/42\n'
    expect(findCreatedPr(result)?.number).toBe(42)
  })

  it('reads html_url out of an MCP JSON result, not the API url beside it', () => {
    const result = JSON.stringify({
      url: 'https://api.github.com/repos/pdcamargo/nyra/pulls/42',
      html_url: 'https://github.com/pdcamargo/nyra/pull/42'
    })
    expect(findCreatedPr(result)).toMatchObject({ number: 42, repo: 'nyra' })
  })

  it('works against a GitHub Enterprise host', () => {
    expect(findCreatedPr('https://github.acme-corp.net/team/svc/pull/3')).toMatchObject({
      owner: 'team',
      repo: 'svc',
      number: 3
    })
  })

  it('answers null when the call printed no URL — gh pr create --web', () => {
    expect(findCreatedPr('Opening github.com in your browser.\n')).toBeNull()
    expect(findCreatedPr('')).toBeNull()
  })

  it('does not swallow the punctuation around a URL', () => {
    expect(findCreatedPr('Opened (https://github.com/o/r/pull/5).')?.url).toBe(
      'https://github.com/o/r/pull/5'
    )
  })
})


describe('scanForPrs', () => {
  const call = (over: Partial<ScannableMessage> = {}): ScannableMessage => ({
    role: 'tool_call',
    tool_name: 'Bash',
    input: { command: 'gh pr create --fill' },
    result: 'https://github.com/pdcamargo/nyra/pull/42\n',
    timestamp: 1_700_000_000_000,
    ...over
  })

  it('recovers a PR from a transcript the live path never watched', () => {
    expect(scanForPrs([call()])).toEqual([
      {
        url: 'https://github.com/pdcamargo/nyra/pull/42',
        owner: 'pdcamargo',
        repo: 'nyra',
        number: 42,
        createdAt: 1_700_000_000_000
      }
    ])
  })

  it('dates the PR from the message, not from when the scan ran', () => {
    const [pr] = scanForPrs([call({ timestamp: 1_600_000_000_000 })])
    expect(pr.createdAt).toBe(1_600_000_000_000)
  })

  it('anchors on the creating call, so a PR merely read is not this chat’s', () => {
    expect(
      scanForPrs([
        call({ input: { command: 'gh pr view 42' } }),
        call({ input: { command: 'gh pr checkout 42' } }),
        { role: 'assistant', result: 'see https://github.com/pdcamargo/nyra/pull/42' }
      ])
    ).toEqual([])
  })

  it('skips a call still awaiting its result', () => {
    expect(scanForPrs([call({ result: undefined })])).toEqual([])
  })

  it('yields one entry when a retry opened the same PR twice, keeping the first date', () => {
    const prs = scanForPrs([call(), call({ timestamp: 1_700_000_999_000 })])
    expect(prs).toHaveLength(1)
    expect(prs[0].createdAt).toBe(1_700_000_000_000)
  })

  it('keeps one entry per repo when a chat worked across two', () => {
    const prs = scanForPrs([
      call(),
      call({ result: 'https://github.com/pdcamargo/helix/pull/7' })
    ])
    expect(prs.map((p) => `${p.repo}#${p.number}`)).toEqual(['nyra#42', 'helix#7'])
  })

  it('ignores the compose link a git push printed, same as the live path', () => {
    expect(
      scanForPrs([
        call({
          input: { command: 'git push -u origin HEAD' },
          result: 'remote: https://github.com/pdcamargo/nyra/pull/new/feature-x'
        })
      ])
    ).toEqual([])
  })

  it('walks a transcript of ordinary messages without tripping', () => {
    expect(
      scanForPrs([
        { role: 'user' },
        { role: 'tool_call', tool_name: 'Read', input: { file_path: '/x' }, result: 'ok' },
        call()
      ])
    ).toHaveLength(1)
  })
})

describe('labels', () => {
  const pr = { url: 'u', owner: 'pdcamargo', repo: 'nyra', number: 42 }

  it('says just the number until a second repo makes that ambiguous', () => {
    expect(prLabel(pr, false)).toBe('#42')
    expect(prLabel(pr, true)).toBe('nyra#42')
  })

  it('spells the whole thing out for a tooltip', () => {
    expect(prSlug(pr)).toBe('pdcamargo/nyra#42')
  })

  it('needs the repo only when the chat spans repos', () => {
    const other = { url: 'v', owner: 'pdcamargo', repo: 'nyra-flows', number: 1 }
    expect(spansRepos([pr])).toBe(false)
    expect(spansRepos([pr, { ...pr, number: 43 }])).toBe(false)
    expect(spansRepos([pr, other])).toBe(true)
  })

  it('treats the same repo name under two owners as two repos', () => {
    const fork = { url: 'v', owner: 'someone-else', repo: 'nyra', number: 1 }
    expect(spansRepos([pr, fork])).toBe(true)
  })
})

describe('prStateFrom', () => {
  it('folds isDraft into the state, the way the chip reads it', () => {
    expect(prStateFrom('OPEN', false)).toBe('open')
    expect(prStateFrom('OPEN', true)).toBe('draft')
    expect(prStateFrom('MERGED', false)).toBe('merged')
    expect(prStateFrom('CLOSED', false)).toBe('closed')
  })

  it('stays undefined on anything it does not know, so the chip draws neutral', () => {
    expect(prStateFrom(undefined, undefined)).toBeUndefined()
    expect(prStateFrom('LOCKED', false)).toBeUndefined()
  })
})

describe('sortPrs', () => {
  it('puts the newest first without mutating the stored array', () => {
    const prs: PullRequest[] = [
      { url: 'a', owner: 'o', repo: 'r', number: 1, createdAt: 100 },
      { url: 'b', owner: 'o', repo: 'r', number: 2, createdAt: 300 },
      { url: 'c', owner: 'o', repo: 'r', number: 3, createdAt: 200 }
    ]
    expect(sortPrs(prs).map((p) => p.number)).toEqual([2, 3, 1])
    expect(prs.map((p) => p.number)).toEqual([1, 2, 3])
  })
})
