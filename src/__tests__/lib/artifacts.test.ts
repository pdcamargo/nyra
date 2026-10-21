import { describe, expect, it } from 'vitest'
import { chatArtifacts } from '@renderer/lib/artifacts'
import type { Message } from '@renderer/store/sessions'

let n = 0
const call = (tool_name: string, input: Record<string, unknown>, result?: string, isError = false): Message => ({
  id: `m${++n}`,
  role: 'tool_call',
  tool_id: `t${n}`,
  tool_name,
  input,
  result,
  isError
})

const A = 'https://claude.ai/code/artifact/0b5f6c1e-aaaa-bbbb-cccc-123456789abc'
const B = 'https://claude.ai/artifact/q3Report'

describe('chatArtifacts', () => {
  it('reads a publish, named after its file', () => {
    const got = chatArtifacts([
      call('Artifact', { file_path: 'out/q3-report.html', description: 'Numbers' }, `Published ${A}`)
    ])
    expect(got).toEqual([{ url: A, title: 'q3-report', description: 'Numbers' }])
  })

  it('ignores reads, lists, failures and calls still running', () => {
    expect(
      chatArtifacts([
        call('Artifact', { action: 'read', url: A }, `<html>${A}</html>`),
        call('Artifact', { action: 'list' }, `${A}\n${B}`),
        call('Artifact', { file_path: 'x.html' }, `failed ${A}`, true),
        call('Artifact', { file_path: 'y.html' })
      ])
    ).toEqual([])
  })

  it('keeps one entry per artifact, at its latest publish, using the url it was given', () => {
    const got = chatArtifacts([
      call('Artifact', { file_path: 'a.html' }, `Published ${A}`),
      call('Artifact', { file_path: 'b.html' }, `Published ${B}`),
      call('Artifact', { file_path: 'a-v2.html', url: A }, `Updated ${B} [same artifact: ${A}]`)
    ])
    expect(got.map((a) => [a.url, a.title])).toEqual([
      [A, 'a-v2'],
      [B, 'b']
    ])
  })

  it('reads Claude Docs, and an edit does not unname the doc', () => {
    const got = chatArtifacts([
      call('mcp__claude_ai_Claude_Docs__batch', { container: { kind: 'project', create: { name: 'Plan' } } }, `Created ${B}`),
      call('mcp__claude_ai_Claude_Docs__update', { ref: { object: 'node', id: 'x' } }, `Saved ${B}`)
    ])
    expect(got).toEqual([{ url: B, title: 'Plan', description: undefined }])
  })
})
