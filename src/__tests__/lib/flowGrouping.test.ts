import { describe, it, expect } from 'vitest'
import {
  groupFlowsByProject,
  triggerSummary,
  shortPath,
  flowMeta,
  flowComposition
} from '../../renderer/src/lib/flowGrouping'
import type { WorkflowDefinition } from '../../shared/workflow-types'

const wf = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id: 'w',
  name: 'W',
  nodes: [],
  edges: [],
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('groupFlowsByProject', () => {
  it('files a scoped flow under its project', () => {
    const { byProject, loose } = groupFlowsByProject([wf({ id: 'a', projectId: 'p1' })])
    expect(byProject.get('p1')?.map((w) => w.id)).toEqual(['a'])
    expect(loose).toHaveLength(0)
  })

  it('treats a missing and an explicitly null project the same', () => {
    const { loose } = groupFlowsByProject([wf({ id: 'a' }), wf({ id: 'b', projectId: null })])
    expect(loose.map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('keeps an installed template out of every project until it is filed', () => {
    const { byProject, loose } = groupFlowsByProject([wf({ id: 'tpl', marketplaceId: 'x' })])
    expect(byProject.size).toBe(0)
    expect(loose).toHaveLength(1)
  })

  it('preserves backend order within a project', () => {
    const { byProject } = groupFlowsByProject([
      wf({ id: 'b', projectId: 'p' }),
      wf({ id: 'a', projectId: 'p' })
    ])
    expect(byProject.get('p')?.map((w) => w.id)).toEqual(['b', 'a'])
  })
})

describe('triggerSummary', () => {
  const trig = (over: Record<string, unknown>) =>
    ({ id: 't', enabled: true, cwd: '/x', ...over }) as never

  it('says nothing when a flow has no triggers', () => {
    expect(triggerSummary(wf())).toBeNull()
  })

  it('ignores a disabled trigger — a schedule you turned off is not a schedule', () => {
    expect(
      triggerSummary(wf({ triggers: [trig({ type: 'cron', schedule: '*/15 * * * *', enabled: false })] }))
    ).toBeNull()
  })

  it('shows a cron schedule', () => {
    expect(triggerSummary(wf({ triggers: [trig({ type: 'cron', schedule: '0 9 * * 5' })] }))).toBe(
      '0 9 * * 5'
    )
  })

  it('names the watched path for a file watcher', () => {
    expect(
      triggerSummary(wf({ triggers: [trig({ type: 'fileWatcher', paths: ['src/**/*.rs'] })] }))
    ).toBe('on src/**/*.rs')
  })

  it('counts the extras rather than listing them', () => {
    expect(
      triggerSummary(
        wf({
          triggers: [
            trig({ type: 'cron', schedule: '@daily' }),
            trig({ type: 'webhook', token: 'k' }),
            trig({ type: 'webhook', token: 'j' })
          ]
        })
      )
    ).toBe('@daily +2')
  })
})

describe('shortPath', () => {
  it('tildes the home directory', () => {
    expect(shortPath('/Users/me/dev', '/Users/me')).toBe('~/dev')
  })

  it('elides the middle of a deep path', () => {
    expect(shortPath('/Users/me/dev/ts/nyra', '/Users/me')).toBe('…/ts/nyra')
  })

  it('leaves a path outside home alone', () => {
    expect(shortPath('/tmp/x', '/Users/me')).toBe('/tmp/x')
  })
})

describe('flowMeta', () => {
  it('reports progress while running, over any trigger', () => {
    const f = wf({ triggers: [{ id: 't', type: 'cron', enabled: true, schedule: '@daily', cwd: '/x' }] })
    expect(flowMeta(f, { running: { done: 4, total: 8 } })).toBe('4 of 8')
  })

  it('prefers a trigger to a timestamp', () => {
    const f = wf({
      triggers: [{ id: 't', type: 'cron', enabled: true, schedule: '@daily', cwd: '/x' }],
      recentCwds: ['/Users/me/clients']
    })
    expect(flowMeta(f, { home: '/Users/me' })).toBe('@daily')
  })

  it('falls back to where an unscoped flow last ran', () => {
    expect(flowMeta(wf({ recentCwds: ['/Users/me/clients'] }), { home: '/Users/me' })).toBe(
      'last ran in ~/clients'
    )
  })

  it('says so when a flow has never run', () => {
    expect(flowMeta(wf(), {})).toBe('never run')
  })

  it('shows a failure over a schedule, since that is what you want from another tab', () => {
    const f = wf({ triggers: [{ id: 't', type: 'cron', enabled: true, schedule: '@daily', cwd: '/x' }] })
    expect(flowMeta(f, { ended: 'failed' })).toBe('failed')
    expect(flowMeta(f, { ended: 'aborted' })).toBe('stopped')
  })

  it('still puts a live run ahead of the failure before it', () => {
    expect(flowMeta(wf(), { running: { done: 1, total: 3 }, ended: 'failed' })).toBe('1 of 3')
  })
})

describe('flowComposition', () => {
  const wf = (nodes: unknown[]): WorkflowDefinition =>
    ({ id: 'w', name: 'n', nodes, edges: [], createdAt: 0, updatedAt: 0 }) as unknown as WorkflowDefinition

  const node = (type: string): unknown => ({
    id: Math.random().toString(),
    label: 'n',
    position: { x: 0, y: 0 },
    data: { type }
  })

  it('counts the kinds the hover card shows', () => {
    expect(
      flowComposition(wf([node('prompt'), node('prompt'), node('script'), node('parallel')]))
    ).toEqual({ nodes: 4, prompts: 2, scripts: 1, subflows: 0 })
  })

  it('counts sub-flows separately, since they run another graph', () => {
    expect(flowComposition(wf([node('subworkflow')])).subflows).toBe(1)
  })

  it('reports an empty flow as zero rather than throwing', () => {
    expect(flowComposition(wf([]))).toEqual({ nodes: 0, prompts: 0, scripts: 0, subflows: 0 })
  })

  it('does not count routing nodes as work', () => {
    const c = flowComposition(wf([node('parallel'), node('join'), node('loop'), node('condition')]))
    expect(c).toEqual({ nodes: 4, prompts: 0, scripts: 0, subflows: 0 })
  })
})
