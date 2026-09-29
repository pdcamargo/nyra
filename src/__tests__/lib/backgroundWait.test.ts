import { describe, expect, it } from 'vitest'
import { waitingLabel, waitingOn } from '../../renderer/src/lib/backgroundWait'
import type { BgProcess } from '../../renderer/src/store/processes'

const proc = (partial: Partial<BgProcess>): BgProcess => ({
  shellId: 'toolu_1',
  kind: 'shell',
  taskId: 'b1',
  description: null,
  command: 'npm test',
  outputFile: null,
  startedAt: 0,
  endedAt: null,
  pid: 1,
  status: 'running',
  exitCode: null,
  lastOutput: null,
  lastOutputAt: null,
  ports: [],
  ...partial
})

describe('waitingOn', () => {
  it('names each kind of background task by what the registry knows', () => {
    const tasks = waitingOn(
      [
        { taskId: 'b1', description: 'Run the e2e suite', kind: 'local_bash' },
        { taskId: 'm1', description: 'CI on #5515', kind: 'local_bash' },
        // Progress has replaced the roster's kind with the subagent's type.
        { taskId: 'a1', description: 'Map the CLI', kind: 'Explore' }
      ],
      [proc({ taskId: 'b1' }), proc({ taskId: 'm1', shellId: 'toolu_2', kind: 'monitor' })]
    )
    expect(tasks.map((t) => [t.taskId, t.kind])).toEqual([
      ['b1', 'shell'],
      ['m1', 'monitor'],
      ['a1', 'agent']
    ])
  })

  it('leaves out a server, which will not report back and already has a port pill', () => {
    const tasks = waitingOn(
      [{ taskId: 'b1', description: 'Start the server on 4202', kind: 'local_bash' }],
      [proc({ taskId: 'b1', ports: [4202] })]
    )
    expect(tasks).toEqual([])
  })

  it('falls back to what the shell runs when the roster has no description', () => {
    const [task] = waitingOn([{ taskId: 'b1', description: '' }], [proc({ command: 'sleep 30' })])
    expect(task.description).toBe('sleep 30')
  })
})

describe('waitingLabel', () => {
  it('names one task, counts several, and watches a monitor', () => {
    expect(waitingLabel([{ taskId: 'b1', description: 'Run the e2e suite', kind: 'shell' }])).toBe(
      'Waiting on Run the e2e suite'
    )
    expect(waitingLabel([{ taskId: 'm1', description: 'CI on #5515', kind: 'monitor' }])).toBe(
      'Watching CI on #5515'
    )
    expect(
      waitingLabel([
        { taskId: 'b1', description: 'x', kind: 'shell' },
        { taskId: 'a1', description: 'y', kind: 'agent' }
      ])
    ).toBe('Waiting on 2 background tasks')
  })
})
