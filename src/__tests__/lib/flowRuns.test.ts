import { describe, expect, it } from 'vitest'
import {
  endNotice,
  flowQuery,
  outputFromTranscript,
  parseFlowCommand,
  pauseNotice,
  runHeadline
} from '../../renderer/src/lib/flowRuns'
import type { FlowRun } from '../../renderer/src/store/flowRuns'
import type { Message } from '../../renderer/src/store/sessions'
import type { WorkflowDefinition } from '../../shared/workflow-types'

const flow = (name: string, inputs: WorkflowDefinition['inputs'] = []): WorkflowDefinition => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  inputs,
  nodes: [],
  edges: [],
  createdAt: 0,
  updatedAt: 0
})

const flows = [
  flow('Retrospective', [{ key: 'week', label: 'Week' }]),
  flow('PR Review'),
  flow('PR Review Pipeline', [
    { key: 'branch', label: 'Branch' },
    { key: 'depth', label: 'Depth', defaultValue: 'quick' }
  ])
]

describe('/flow', () => {
  it('names the longest flow the text starts with', () => {
    const cmd = parseFlowCommand('/flow PR Review Pipeline branch=main', flows)
    expect(cmd?.kind === 'run' && cmd.flow.name).toBe('PR Review Pipeline')
  })

  it('reads key=value pairs, quoted values and defaults', () => {
    const cmd = parseFlowCommand('/flow pr review pipeline branch="feat/x y"', flows)
    expect(cmd).toMatchObject({ kind: 'run', inputs: { branch: 'feat/x y', depth: 'quick' }, missing: [] })
  })

  it('gives a lone input a bare value', () => {
    expect(parseFlowCommand('/flow Retrospective 2026-W43', flows)).toMatchObject({
      kind: 'run',
      inputs: { week: '2026-W43' },
      missing: []
    })
  })

  it('says which inputs are missing rather than running without them', () => {
    expect(parseFlowCommand('/flow Retrospective', flows)).toMatchObject({ kind: 'run', missing: ['week'] })
  })

  it('tells an unknown name and an empty command apart', () => {
    expect(parseFlowCommand('/flow Deploy', flows)).toEqual({ kind: 'unknown', name: 'Deploy' })
    expect(parseFlowCommand('/flow', flows)).toEqual({ kind: 'empty' })
    expect(parseFlowCommand('/flowers', flows)).toBeNull()
  })

  it('offers names only while the name is being typed', () => {
    expect(flowQuery('/flow ret', flows)).toBe('ret')
    expect(flowQuery('/flow ', flows)).toBe('')
    expect(flowQuery('/flow Retrospective week=', flows)).toBeNull()
    expect(flowQuery('/compact', flows)).toBeNull()
  })
})

const run = (partial: Partial<FlowRun> = {}): FlowRun => ({
  executionId: 'exec-1',
  workflowId: 'retro',
  workflowName: 'Retrospective',
  chatId: 'chat-1',
  cwd: '/repo',
  inputValues: {},
  triggeredBy: 'manual',
  startedAt: 0,
  steps: [
    { id: 'a', label: 'Collect sessions', type: 'script' },
    { id: 'b', label: 'Draft retrospective', type: 'prompt' },
    { id: 'c', label: 'Review with you', type: 'chat' },
    { id: 'd', label: 'Save to vault', type: 'script' }
  ],
  status: 'running',
  nodeStates: {},
  vars: {},
  waits: [],
  ...partial
})

describe('a run in one line', () => {
  it('says the step it is on and how far along', () => {
    const r = run({
      nodeStates: {
        a: { nodeId: 'a', status: 'done' },
        b: { nodeId: 'b', status: 'running', startedAt: 5 }
      }
    })
    expect(runHeadline(r)).toBe('Draft retrospective · 1 of 4')
  })

  it('says who it is waiting on', () => {
    const r = run({
      status: 'paused',
      waits: [{ kind: 'chat', nodeId: 'c', label: 'Review with you', input: 'draft' }]
    })
    expect(runHeadline(r)).toBe('Waiting for you at Review with you')
  })

  it('names the step a failure happened at', () => {
    expect(runHeadline(run({ status: 'failed', nodeStates: { d: { nodeId: 'd', status: 'failed' } } }))).toBe(
      'Failed at Save to vault'
    )
  })
})

describe('what Claude is told', () => {
  const wait = { kind: 'chat' as const, nodeId: 'c', label: 'Review with you', input: 'Wins: grid', message: null }

  it('on a pause: the work, and that the user decides when it carries on', () => {
    const text = pauseNotice(run(), { ...wait, output: 'final' })
    expect(text).toContain('Wins: grid')
    expect(text).toContain('run "exec-1"')
    expect(text).toContain("Don't continue before they say so")
  })

  it('on a pause taken from the transcript: no tool call to make', () => {
    expect(pauseNotice(run(), { ...wait, output: 'lastReply' })).not.toContain('nyra_flow')
  })

  it('at the end: how it went and what the last step produced', () => {
    const text = endNotice(
      run({
        status: 'done',
        nodeStates: { d: { nodeId: 'd', status: 'done', output: 'Saved 2026-W43.md', finishedAt: 9 } }
      })
    )
    expect(text).toContain('has finished')
    expect(text).toContain('"Save to vault"')
    expect(text).toContain('Saved 2026-W43.md')
  })
})

describe('output from the transcript', () => {
  const messages = [
    { id: 'm1', role: 'assistant', text: 'old draft' },
    { id: 'pause', role: 'user', text: '' },
    { id: 'm2', role: 'user', text: 'drop tooling' },
    { id: 'm3', role: 'assistant', text: 'new draft' }
  ] as Message[]

  it('is the last reply, or the last thing the user said, since the pause', () => {
    expect(outputFromTranscript(messages, 'lastReply', 'pause')).toBe('new draft')
    expect(outputFromTranscript(messages, 'user', 'pause')).toBe('drop tooling')
  })

  it('is nothing when nothing was said since', () => {
    expect(outputFromTranscript(messages, 'lastReply', 'm3')).toBeNull()
  })
})
