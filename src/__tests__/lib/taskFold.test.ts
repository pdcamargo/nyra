import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionsStore, type Task, type ToolCallMessage } from '../../renderer/src/store/sessions'
import { foldTasksAtTurnEnd } from '../../renderer/src/lib/taskFold'

const tasks = (n: number, done: number): Task[] =>
  Array.from({ length: n }, (_, i) => ({
    taskId: `nyra-task-${i}`,
    subject: `Step ${i + 1}`,
    description: '',
    status: i < done ? 'completed' : 'pending',
    createdByToolId: 'nyra-tasks'
  }))

const session = (id: string) => useSessionsStore.getState().sessions.find((s) => s.id === id)!

const checklists = (id: string): ToolCallMessage[] =>
  session(id).messages.filter(
    (m): m is ToolCallMessage => m.role === 'tool_call' && m.tool_name === 'TaskChecklist'
  )

describe('foldTasksAtTurnEnd', () => {
  let id: string

  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null, pendingAction: null })
    id = useSessionsStore.getState().createSession('/tmp/test')
  })

  // Unfinished work stays where you can watch it. The turn ending does not mean
  // the list is done — the next one carries on with it, ticking and adding
  // items — and a folded copy in the transcript is a snapshot that scrolls away
  // and stops updating.
  it('leaves an unfinished list pinned above the composer', () => {
    useSessionsStore.getState().setTasks(id, tasks(5, 3))

    foldTasksAtTurnEnd(id)

    expect(session(id).tasks).toHaveLength(5)
    expect(checklists(id)).toHaveLength(0)
  })

  it('leaves a list nothing has been done on', () => {
    useSessionsStore.getState().setTasks(id, tasks(4, 0))
    foldTasksAtTurnEnd(id)
    expect(session(id).tasks).toHaveLength(4)
    expect(checklists(id)).toHaveLength(0)
  })

  // Claude usually signs off with prose rather than restating the block with
  // every item ticked, so `foldOrSetTasks` never sees the transition. This is
  // what catches a finished list in that case.
  it('folds a finished list into the transcript and clears the strip', () => {
    useSessionsStore.getState().setTasks(id, tasks(3, 3))

    foldTasksAtTurnEnd(id)

    expect(session(id).tasks).toEqual([])
    const folded = checklists(id)
    expect(folded).toHaveLength(1)
    expect(folded[0].input.tasks as Task[]).toHaveLength(3)
  })

  it('folds once the last item is ticked, not before', () => {
    useSessionsStore.getState().setTasks(id, tasks(2, 1))
    foldTasksAtTurnEnd(id)
    expect(checklists(id)).toHaveLength(0)

    useSessionsStore.getState().setTasks(id, tasks(2, 2))
    foldTasksAtTurnEnd(id)
    expect(checklists(id)).toHaveLength(1)
    expect(session(id).tasks).toEqual([])
  })

  // Every turn ends, and most of them never had a checklist. Folding an empty
  // list would put a "0 of 0 done" chip after each one.
  it('does nothing when there is no list', () => {
    foldTasksAtTurnEnd(id)
    expect(checklists(id)).toHaveLength(0)
    expect(session(id).messages).toHaveLength(0)
  })

  // Three turn-end paths call this (result, error, child death) and an aborted
  // turn can hit more than one. The strip is empty after the first, so the rest
  // are no-ops rather than a second chip.
  it('leaves only one chip when a turn ends more than once', () => {
    useSessionsStore.getState().setTasks(id, tasks(4, 4))
    foldTasksAtTurnEnd(id)
    foldTasksAtTurnEnd(id)
    foldTasksAtTurnEnd(id)
    expect(checklists(id)).toHaveLength(1)
  })

  it('does not touch another session', () => {
    const other = useSessionsStore.getState().createSession('/tmp/other')
    useSessionsStore.getState().setTasks(id, tasks(2, 2))
    useSessionsStore.getState().setTasks(other, tasks(3, 3))

    foldTasksAtTurnEnd(id)

    expect(session(other).tasks).toHaveLength(3)
    expect(checklists(other)).toHaveLength(0)
  })
})
