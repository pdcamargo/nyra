import { useSessionsStore, type Task } from '../store/sessions'

/**
 * Move a checklist out of the strip above the composer and into the transcript.
 *
 * Two things end a list: Claude ticking the last box, and the turn simply being
 * over. Both want the same message in the same shape, so the construction lives
 * here rather than being written out at each call site — a second copy is how
 * the id scheme drifted last time.
 */
export function foldChecklistIntoTranscript(sid: string, tasks: Task[]): void {
  const store = useSessionsStore.getState()
  const stamp = Date.now()
  store.addMessage(sid, {
    id: `${stamp}-checklist`,
    role: 'tool_call',
    tool_id: `checklist-${stamp}`,
    tool_name: 'TaskChecklist',
    input: { tasks },
    result: 'done'
  })
  store.setTasks(sid, [])
}

/**
 * A finished list has nothing left to watch, so it goes into the transcript.
 *
 * Only a *finished* one. `foldOrSetTasks` folds on the transition into
 * all-complete, which needs Claude to restate the block with every item ticked;
 * it often signs off with prose instead, and this catches those.
 *
 * An unfinished list stays pinned above the composer on purpose. The work is
 * still going — the next turn will carry on with it, and items get added, ticked
 * and reworded as it does. Folding it into the transcript at the end of every
 * turn buried the one thing you are trying to follow: it scrolls away with the
 * history, and the version you can see is a snapshot that stops updating. Better
 * a list that outstays its welcome, which you can see, than a live one you
 * cannot find.
 */
export function foldTasksAtTurnEnd(sid: string): void {
  const tasks = useSessionsStore.getState().sessions.find((s) => s.id === sid)?.tasks ?? []
  if (tasks.length === 0) return
  if (!tasks.every((t) => t.status === 'completed')) return
  foldChecklistIntoTranscript(sid, tasks)
}
