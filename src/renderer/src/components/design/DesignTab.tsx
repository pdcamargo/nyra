import { useCallback, useEffect, useState } from 'react'
import { Check, Frame, Pencil, RotateCw, Trash2, X } from 'lucide-react'
import { IconButton } from '../ui/icon-button'
import { useSessionsStore } from '../../store/sessions'
import { usePanelTabsStore } from '../../store/panelTabs'
import type { DesignPanelTab } from '../../store/panelTabs'
import type { DesignEntry, SystemEntry } from '../../lib/api-types'
import DesignFileView from './DesignFileView'
import { DesignPicker } from './DesignPicker'
import SystemTab from './SystemTab'

/**
 * The chat's design tab: a design system, or a single draft.
 *
 * One tab per chat either way. A chat working on a system and a couple of
 * drafts flips between them in the picker rather than growing a tab for each.
 */
export default function DesignTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: DesignPanelTab
}): React.ReactElement {
  if (tab.systemId) return <SystemTab sessionId={sessionId} tab={tab} />
  return <DraftTab sessionId={sessionId} tab={tab} />
}

/** The project's design systems, kept current. */
export function useProjectSystems(cwd: string | null): SystemEntry[] {
  const [systems, setSystems] = useState<SystemEntry[]>([])
  useEffect(() => {
    let cancelled = false
    const load = (): void =>
      void window.api.designSystem.list(cwd ?? undefined).then((l) => {
        if (!cancelled) setSystems(l)
      })
    load()
    const stop = window.api.design.onChanged(load)
    return () => {
      cancelled = true
      stop()
    }
  }, [cwd])
  return systems
}

/** One draft: a single `.nyui.json` on the built-in theme. */
function DraftTab({ sessionId, tab }: { sessionId: string; tab: DesignPanelTab }): React.ReactElement {
  const cwd = useSessionsStore((s) => s.sessions.find((session) => session.id === sessionId)?.cwd ?? null)
  const pickDesign = usePanelTabsStore((s) => s.setDesignTabDesign)
  const openSystem = usePanelTabsStore((s) => s.openSystemTab)
  const systems = useProjectSystems(cwd)

  const [designs, setDesigns] = useState<DesignEntry[] | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [reloads, setReloads] = useState(0)

  /**
   * This project's designs, plus the one the tab was opened on.
   *
   * A chip can name a design filed under another project — one registered
   * while a different chat was on screen, or simply one from elsewhere. Listing
   * only this project's left it out, and the follow effect below then fell back
   * to the first design here and wrote that over the tab: you clicked one
   * design and got shown another.
   */
  const refreshList = useCallback(async () => {
    const list = await window.api.design.list(cwd ?? undefined)
    if (tab.designId !== null && !list.some((d) => d.id === tab.designId)) {
      const wanted = (await window.api.design.list()).find((d) => d.id === tab.designId)
      if (wanted) list.unshift(wanted)
    }
    setDesigns(list)
    return list
  }, [cwd, tab.designId])

  useEffect(() => {
    void refreshList()
    // The index announces its own changes, so a design Claude registers
    // appears without anyone reloading.
    return window.api.design.onChanged(() => void refreshList())
  }, [refreshList])

  // Follow the tab's design, so the panel survives a reload showing what it was.
  useEffect(() => {
    if (!designs) return
    const entry = designs.find((d) => d.id === tab.designId) ?? designs[0]
    if (entry && entry.id !== tab.designId) pickDesign(sessionId, tab.id, entry.id)
  }, [designs, tab.designId, tab.id, sessionId, pickDesign])

  const current = (designs ?? []).find((d) => d.id === tab.designId) ?? null

  /**
   * Stop showing a design. The file is left alone.
   *
   * An index entry is a pointer, and deleting someone's document because they
   * tidied a list is not a trade worth making — so this forgets, and says so.
   */
  const forget = useCallback(async () => {
    if (current === null) return
    await window.api.design.forget(current.id, false)
    const left = await refreshList()
    pickDesign(sessionId, tab.id, left[0]?.id ?? null)
  }, [current, refreshList, pickDesign, sessionId, tab.id])

  /**
   * Renaming changes the index entry, never the file.
   *
   * Which is why it cannot break a chip: a chip resolves by path and looks the
   * name up, so every chip pointing at this design simply starts reading the
   * new one. `nyra:designs-changed` is what tells them to.
   */
  const commitRename = useCallback(async () => {
    const name = draftName.trim()
    if (current === null || name.length === 0 || name === current.name) {
      setRenaming(false)
      return
    }
    await window.api.design.rename(current.id, name)
    await refreshList()
    setRenaming(false)
  }, [current, draftName, refreshList])

  if (designs !== null && designs.length === 0 && systems.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Frame className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No designs in this project</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Ask Claude to design something — a settings page, an empty state — and it will show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* One row, two modes. Renaming replaces the picker in place rather than
          opening a second bar under it — the thing being renamed is the thing
          the picker names, so it should be the thing you type over. */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {renaming && current !== null ? (
          <>
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="min-w-0 flex-1 rounded-sm bg-accent/60 px-1.5 py-0.5 text-xs outline-none"
            />
            <IconButton label="Rename" onClick={() => void commitRename()}>
              <Check className="size-3" />
            </IconButton>
            <IconButton label="Cancel" onClick={() => setRenaming(false)}>
              <X className="size-3" />
            </IconButton>
          </>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <DesignPicker
                label={current?.name ?? 'Designs'}
                systems={systems}
                drafts={designs ?? []}
                current={current?.id ?? null}
                onSystem={(id) => openSystem(sessionId, id)}
                onDraft={(id) => pickDesign(sessionId, tab.id, id)}
              />
            </div>
            <IconButton label="Reload this design" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw className="size-3" />
            </IconButton>
            {current !== null && (
              <>
                <IconButton
                  label="Rename this design"
                  onClick={() => {
                    setDraftName(current.name)
                    setRenaming(true)
                  }}
                >
                  <Pencil className="size-3" />
                </IconButton>
                <IconButton label="Remove from Nyra — the file stays on disk" onClick={() => void forget()}>
                  <Trash2 className="size-3" />
                </IconButton>
              </>
            )}
          </>
        )}
      </div>

      {current !== null ? (
        <DesignFileView
          key={`${current.path}:${reloads}`}
          sessionId={sessionId}
          path={current.path} name={current.name} focus={tab.artboardId} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {designs === null ? 'Loading…' : 'Pick a design or a design system above.'}
        </div>
      )}
    </div>
  )
}
