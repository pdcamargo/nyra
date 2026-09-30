import React, { useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import Modal from './Modal'
import WorkspaceAvatar from './WorkspaceAvatar'
import { useUiStore } from '../store/ui'
import { findWorkspace, useWorkspacesStore } from '../store/workspaces'
import { accountLabel, useAccountsStore } from '../store/accounts'
import { createWorkspace, openLogin } from '../lib/workspaces'
import { squareThumbnail } from '../utils/imageCompression'

/**
 * New workspace, and Edit workspace — one dialog, pre-filled for the second.
 *
 * A name is all a workspace needs; the picture is optional and, once picked,
 * is kept as a 128px square rather than as the file it came from. Creating one
 * makes its config dir, switches to it and opens the sign-in window for its
 * account — cancelling that leaves the workspace there, signed out.
 */
export default function WorkspaceDialog(): React.JSX.Element | null {
  const dialog = useUiStore((s) => s.workspaceDialog)
  const close = useUiStore((s) => s.setWorkspaceDialog)
  const editingId = dialog?.mode === 'edit' ? dialog.workspaceId : null
  const account = useAccountsStore((s) => (editingId ? s.byWorkspace[editingId] : undefined))

  const [name, setName] = useState('')
  const [image, setImage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Fresh on every open: the last edit's picture must not leak into a new one.
  useEffect(() => {
    if (!dialog) return
    const editing = dialog.mode === 'edit' ? findWorkspace(dialog.workspaceId) : null
    setName(editing?.name ?? '')
    setImage(editing?.image)
    setError(null)
    setBusy(false)
  }, [dialog])

  if (!dialog) return null

  const editing = dialog.mode === 'edit'
  const signedInAs = accountLabel(account)
  const trimmed = name.trim()

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
      const created = await createWorkspace(trimmed, image)
      close(null)
      openLogin(created.id)
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
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {editing && signedInAs ? `Signed in as ${signedInAs}` : 'Its own Claude account, settings and chats.'}
        </p>
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
