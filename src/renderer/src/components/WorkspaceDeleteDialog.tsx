import React, { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useUiStore } from '../store/ui'
import { useRunningStore } from '../store/running'
import { useSessionsStore } from '../store/sessions'
import { useTerminalsStore } from '../store/terminals'
import { DEFAULT_WORKSPACE_ID, useWorkspacesStore } from '../store/workspaces'
import { accountLabel, useAccountsStore } from '../store/accounts'
import { deleteWorkspace, planDelete } from '../lib/workspaceDelete'

const count = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Deleting a workspace: what moves, what closes, what is gone.
 *
 * Nothing is asked twice and nothing is left implied. Its projects and chats
 * move to a workspace you pick, with their history; its terminals close; its
 * account is signed out and its Claude data deleted. While any of its chats is
 * mid-turn the button stays off and says why — a turn is never cancelled to
 * make room for this.
 */
export default function WorkspaceDeleteDialog(): React.JSX.Element | null {
  const workspaceId = useUiStore((s) => s.workspaceDeleteId)
  const close = useUiStore((s) => s.setWorkspaceDeleteId)
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const account = useAccountsStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  // Subscribed, so the counts — and whether the button is on — follow a turn
  // finishing or a terminal closing while the dialog is open.
  useRunningStore((s) => s.running)
  useSessionsStore((s) => s.sessions)
  useTerminalsStore((s) => s.byProject)

  const [targetId, setTargetId] = useState(DEFAULT_WORKSPACE_ID)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    setTargetId(DEFAULT_WORKSPACE_ID)
    setBusy(false)
    setError(null)
    setWarning(null)
  }, [workspaceId])

  if (!workspace || workspace.id === DEFAULT_WORKSPACE_ID) return null

  const plan = planDelete(workspace.id)
  const targets = workspaces.filter((w) => w.id !== workspace.id)
  const target = targets.find((w) => w.id === targetId) ?? targets[0]
  const email = account?.email ?? accountLabel(account)
  const blocked = plan.running > 0
  const done = warning !== null

  const run = async (): Promise<void> => {
    if (!target || blocked || busy) return
    setBusy(true)
    setError(null)
    const outcome = await deleteWorkspace(workspace.id, target.id)
    setBusy(false)
    if (!outcome.ok) {
      setError(outcome.error)
      return
    }
    if (outcome.warning) setWarning(outcome.warning)
    else close(null)
  }

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) close(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {done ? `“${workspace.name}” was deleted` : `Delete “${workspace.name}”?`}
          </AlertDialogTitle>
          {done ? (
            <AlertDialogDescription>{warning}</AlertDialogDescription>
          ) : (
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{email ? `Signed in as ${email}.` : 'Not signed in.'}</p>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span>
                    Its {count(plan.projects, 'project')} and {count(plan.chats, 'chat')} move to
                  </span>
                  <Select value={target?.id} onValueChange={setTargetId} disabled={busy}>
                    <SelectTrigger aria-label="Move them to" className="h-7 min-w-0 max-w-[180px] px-2 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span>with their history.</span>
                </div>
                {plan.terminals > 0 && (
                  <p>{count(plan.terminals, 'open terminal')} started under it will be closed.</p>
                )}
                <p>
                  Its account is signed out, and its Claude data — login, settings, skills and
                  transcripts — is deleted.
                </p>
                {blocked && (
                  <p className="text-danger">
                    {count(plan.running, 'chat')} {plan.running === 1 ? 'is' : 'are'} still running. Stop
                    {plan.running === 1 ? ' it' : ' them'}, or let {plan.running === 1 ? 'it' : 'them'} finish,
                    to delete this workspace.
                  </p>
                )}
                {error && <p className="text-danger">{error}</p>}
              </div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {done ? (
            <AlertDialogAction onClick={() => close(null)}>Close</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={blocked || busy || !target}
                onClick={(e) => {
                  // Stays open until every step has run, and says how it went.
                  e.preventDefault()
                  void run()
                }}
              >
                {busy ? 'Deleting…' : 'Delete workspace'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
