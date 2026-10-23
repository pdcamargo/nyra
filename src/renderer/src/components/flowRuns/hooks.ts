import { useEffect, useMemo, useState } from 'react'
import type { WorkflowDefinition } from '../../../../shared/workflow-types'
import { chatRuns, useFlowRunsStore, type FlowRun } from '../../store/flowRuns'
import { runFromRecord } from '../../lib/flowRuns'

/** One run: live from the store, or rebuilt from its record once it is over
 *  and the app has restarted since. Null while loading, or when there is
 *  nothing — a run the app was quit during never wrote a record. */
export function useFlowRun(executionId: string | null | undefined): FlowRun | null {
  const live = useFlowRunsStore((s) => (executionId ? s.runs[executionId] : undefined))
  const [loaded, setLoaded] = useState<FlowRun | null>(null)

  useEffect(() => {
    if (live || !executionId) return
    let gone = false
    void (async () => {
      const record = await window.api.workflow.getExecution(executionId).catch(() => null)
      if (!record || gone) return
      const wf = (await window.api.workflow.load(record.workflowId).catch(() => null)) as WorkflowDefinition | null
      if (!gone) setLoaded(runFromRecord(record, wf))
    })()
    return () => {
      gone = true
    }
  }, [executionId, live])

  return live ?? (loaded?.executionId === executionId ? loaded : null)
}

/**
 * A chat's runs, newest first — the live ones, and after a restart the ones
 * its records say it had. Read off disk once per chat per window.
 */
export function useChatRuns(chatId: string | null | undefined): FlowRun[] {
  const runs = useFlowRunsStore((s) => s.runs)
  const loaded = useFlowRunsStore((s) => (chatId ? s.historyLoaded[chatId] === true : true))

  useEffect(() => {
    if (!chatId || loaded) return
    let gone = false
    void (async () => {
      const records = (await window.api.workflow.listExecutions().catch(() => [])).filter((r) => r.chatId === chatId)
      const flows = new Map<string, WorkflowDefinition | null>()
      for (const r of records) {
        if (!flows.has(r.workflowId)) {
          flows.set(r.workflowId, (await window.api.workflow.load(r.workflowId).catch(() => null)) as WorkflowDefinition | null)
        }
      }
      if (!gone) {
        useFlowRunsStore.getState().addHistory(
          chatId,
          records.map((r) => runFromRecord(r, flows.get(r.workflowId) ?? null))
        )
      }
    })()
    return () => {
      gone = true
    }
  }, [chatId, loaded])

  return useMemo(() => chatRuns(runs, chatId), [runs, chatId])
}
