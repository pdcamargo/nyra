import React, { useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import Modal from './Modal'
import WorkspaceAvatar from './WorkspaceAvatar'
import { useUiStore } from '../store/ui'
import { configDirOf, findWorkspace, useWorkspacesStore } from '../store/workspaces'
import CodexAccountRow from './CodexAccountRow'
import { accountLabel, useAccountsStore } from '../store/accounts'
import { createWorkspace, openLogin } from '../lib/workspaces'
import { squareThumbnail } from '../utils/imageCompression'
import type { WorkspaceSignIn } from '../lib/tauri-api'
import { Select } from './settings/primitives'

/**
 * New workspace, and Edit workspace — one dialog, pre-filled for the second.
 *
 * A name is all a workspace needs; the picture is optional and, once picked,
 * is kept as a 128px square rather than as the file it came from. Creating one
 * makes its config dir, switches to it and opens the sign-in window for its
 * account — cancelling that leaves the workspace there, signed out.
 *
 * Or it can use the sign-in another workspace already has, for Claude, Codex
 * or both. Nothing is copied: it is pointed at that workspace's credential
 * store (see `workspaces.rs`), so it is signed in from the start and stays
 * signed in when the login refreshes.
 */
export default function WorkspaceDialog(): React.JSX.Element | null {
  const dialog = useUiStore((s) => s.workspaceDialog)
  const close = useUiStore((s) => s.setWorkspaceDialog)
  const editingId = dialog?.mode === 'edit' ? dialog.workspaceId : null
  const account = useAccountsStore((s) => (editingId ? s.byWorkspace[editingId] : undefined))
  const accounts = useAccountsStore((s) => s.byWorkspace)
  const workspaces = useWorkspacesStore((s) => s.workspaces)

  const [name, setName] = useState('')
  const [image, setImage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A new workspace's choices: a workspace id to borrow from, or '' for its own.
  const [claudeFrom, setClaudeFrom] = useState('')
  const [codexFrom, setCodexFrom] = useState('')
  // An existing one's: where its sign-ins already come from.
  const [shared, setShared] = useState<WorkspaceSignIn | null>(null)

  // Fresh on every open: the last edit's picture must not leak into a new one.
  useEffect(() => {
    if (!dialog) return
    const editing = dialog.mode === 'edit' ? findWorkspace(dialog.workspaceId) : null
    setName(editing?.name ?? '')
    setImage(editing?.image)
    setError(null)
    setBusy(false)
    setClaudeFrom('')
    setCodexFrom('')
    setShared(null)
    if (dialog.mode === 'edit') {
      void window.api.workspace.signIn(dialog.workspaceId).then(setShared).catch(() => undefined)
    } else {
      // Who each one is signed in as, so the list can say it — and offer only
      // the ones that have a Claude sign-in to share.
      for (const w of useWorkspacesStore.getState().workspaces) void useAccountsStore.getState().refresh(w.id)
    }
  }, [dialog])

  if (!dialog) return null

  const editing = dialog.mode === 'edit'
  const signedInAs = accountLabel(account)
  const trimmed = name.trim()
  const nameOf = (id: string | null): string => findWorkspace(id)?.name ?? 'another workspace'
  const claudeLenders = workspaces.filter((w) => accountLabel(accounts[w.id]))
  const headline = editing
    ? [signedInAs && `Signed in as ${signedInAs}`, shared?.claude && `shares ${nameOf(shared.claude)}'s sign-in`]
        .filter(Boolean)
        .join(' · ') || 'Its own Claude account, settings and chats.'
    : 'Its own Claude account, settings and chats.'

  const pickImage = async (): Promise<void> => {
    setError(null)
    const path = await window.api.dialog.pickImage()
    if (!path) return
    const read = await window.api.fs.readImage(path)
    if (!read.base64 || !read.mediaType) {
      setError(read.error ?? 'That picture could not be read.')
      return
    }
    try {
      setImage(await squareThumbnail(read.base64, read.mediaType))
    } catch {
      setError('That picture could not be read.')
    }
  }

  const save = async (): Promise<void> => {
    if (!trimmed || busy) return
    if (editing) {
      useWorkspacesStore.getState().update(dialog.workspaceId, { name: trimmed, image })
      close(null)
      return
    }
    setBusy(true)
    try {
      const created = await createWorkspace(trimmed, image, {
        ...(claudeFrom ? { claude: claudeFrom } : {}),
        ...(codexFrom ? { codex: codexFrom } : {})
      })
      close(null)
      if (claudeFrom) void useAccountsStore.getState().refresh(created.id)
      else openLogin(created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={() => close(null)}
      title={editing ? 'Edit workspace' : 'New workspace'}
      className="w-[440px] max-w-[92vw]"
    >
      <div className="border-b border-border/55 px-5 py-3">
        <h2 className="text-[14px] font-semibold text-foreground">{editing ? 'Edit workspace' : 'New workspace'}</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{headline}</p>
      </div>

      <form
        className="flex items-start gap-4 px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {image || trimmed ? (
          <WorkspaceAvatar
            workspace={{ name: trimmed, image }}
            className="size-16 rounded-xl bg-rail-selected text-[22px] text-foreground"
          />
        ) : (
          <span className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-border-strong text-muted-foreground">
            <ImageIcon className="size-5" />
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <label className="block">
            <span className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Work, Personal, a client…"
              className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:border-border-strong"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-[10px] uppercase tracking-widest text-muted-foreground">Image</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void pickImage()}
                className="rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent"
              >
                {image ? 'Replace…' : 'Choose image…'}
              </button>
              {image && (
                <button
                  type="button"
                  onClick={() => setImage(undefined)}
                  className="rounded-md px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Optional. Cropped to a square. Without one, the rail shows the initials.
            </p>
          </div>
        </div>
        {/* Enter submits from the name field. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>

      {/* A new workspace's sign-ins: its own, or one another workspace has. */}
      {!editing && (
        <div className="flex flex-col gap-2.5 border-t border-border/55 px-5 py-3">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Sign-in</span>
          <SignInChoice
            label="Claude"
            value={claudeFrom}
            onChange={setClaudeFrom}
            options={claudeLenders.map((w) => ({
              value: w.id,
              label: `Same as ${w.name} — ${accountLabel(accounts[w.id])}`
            }))}
            note={claudeFrom ? 'Signed in already. Its settings, skills and chats stay its own.' : undefined}
          />
          <SignInChoice
            label="Codex"
            value={codexFrom}
            onChange={setCodexFrom}
            options={workspaces.map((w) => ({ value: w.id, label: `Same as ${w.name}` }))}
            note={codexFrom ? `Shares ${nameOf(codexFrom)}'s Codex chats and settings too.` : undefined}
          />
        </div>
      )}

      {/* Its Codex account, beside its Claude one. Only once it exists: a new
          workspace has no home for Codex to sign in under yet. One that uses
          another's says so instead: its Sign out would be the lender's. */}
      {editing &&
        (shared?.codex ? (
          <div className="flex min-w-0 items-center gap-3 border-t border-border/55 px-5 py-3">
            <div className="min-w-0 flex-1">
              <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">Codex</span>
              <span className="block truncate text-xs text-foreground/80">
                Uses {nameOf(shared.codex)}'s sign-in. Sign in or out from there.
              </span>
            </div>
          </div>
        ) : (
          <CodexAccountRow configDir={configDirOf(dialog.workspaceId)} />
        ))}

      <div className="flex items-center justify-between gap-3 border-t border-border/55 bg-muted/40 px-4 py-2.5">
        <span className="min-w-0 truncate text-xs text-danger">{error ?? ''}</span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => close(null)}
            className="rounded-md px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!trimmed || busy}
            className="rounded-md bg-info/90 px-4 py-1.5 text-xs font-medium text-info-foreground transition-colors hover:bg-info disabled:opacity-50"
          >
            {editing ? 'Save' : busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** One CLI's sign-in for a new workspace: its own, or another workspace's. */
function SignInChoice({
  label,
  value,
  onChange,
  options,
  note
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  note?: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-foreground/80">{label}</span>
        <Select
          value={value}
          onChange={onChange}
          options={[{ value: '', label: 'Sign in separately' }, ...options]}
          className="w-[220px] truncate"
        />
      </div>
      {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
    </div>
  )
}
