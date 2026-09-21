import { useCallback, useEffect, useState } from 'react'
import { compile, rasterRequest, type Issue, type ResolvedDocument, type Theme } from '@nyra/design'
import {
  Check,
  ClipboardCopy,
  Frame,
  MessageSquare,
  Pencil,
  RotateCw,
  Trash2,
  X
} from 'lucide-react'
import { IconButton } from '../ui/icon-button'
import { useSessionsStore } from '../../store/sessions'
import { useUiStore } from '../../store/ui'
import { useFileStamp } from '../../hooks/useFileStamp'
import { useWorkspaceStore } from '../../store/workspace'
import type { DesignWorkspaceTab } from '../../store/workspace'
import type { DesignEntry } from '../../lib/api-types'
import DesignCanvas from './DesignCanvas'

type Loaded = { doc: ResolvedDocument; theme: Theme; issues: Issue[] }

/**
 * The designs in this project, and the one on screen.
 *
 * Rendering happens here rather than through the rasteriser: the renderer
 * already has React and the pipeline, so the panel draws live and instantly and
 * never waits on a headless browser. The PNGs exist for Claude's eyes and for
 * chat; this is for yours.
 */
export default function DesignTab({
  sessionId,
  tab
}: {
  sessionId: string
  tab: DesignWorkspaceTab
}): React.ReactElement {
  const cwd = useSessionsStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.cwd ?? null
  )
  const pickDesign = useWorkspaceStore((s) => s.setDesignTabDesign)

  const [designs, setDesigns] = useState<DesignEntry[] | null>(null)
  const [path, setPath] = useState<string | null>(null)
  /**
   * Re-read when the document changes on disk.
   *
   * Claude revises a design by rewriting the file, and without this you are
   * looking at the previous version while it tells you what it changed —
   * which makes a conversation with a designer impossible to follow. Polled by
   * the same hook the file preview uses, for the same reasons written there.
   */
  const stamp = useFileStamp(path)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ artboardId: string; at: { x: number; y: number } } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')

  const refreshList = useCallback(async () => {
    const list = await window.api.design.list(cwd ?? undefined)
    setDesigns(list)
    return list
  }, [cwd])

  useEffect(() => {
    void refreshList()
    // The index announces its own changes, so a design Claude registers
    // appears without anyone reloading.
    return window.api.design.onChanged(() => void refreshList())
  }, [refreshList])

  const open = useCallback(
    async (entry: DesignEntry) => {
      setError(null)
      const read = await window.api.fs.readTextFile(entry.path)
      if (read.kind !== 'text') {
        // A design whose file is gone is a real state — the index is a pointer,
        // not a copy — so it is reported rather than silently dropped.
        setError(
          read.kind === 'missing'
            ? `${entry.path} is no longer there. The index still points at it.`
            : `Could not read ${entry.path} (${read.kind}).`
        )
        setLoaded(null)
        return
      }
      setPath(entry.path)
      try {
        setLoaded(compile(JSON.parse(read.content)))
      } catch (e) {
        const issues = (e as { issues?: Issue[] }).issues ?? []
        setError(
          issues.length > 0
            ? issues
                .slice(0, 6)
                .map((i) => `${i.code}: ${i.message}`)
                .join('\n')
            : e instanceof Error
              ? e.message
              : String(e)
        )
        setLoaded(null)
      }
    },
    []
  )

  // Follow the tab's design, so the panel survives a reload showing what it was.
  useEffect(() => {
    if (!designs) return
    const entry = designs.find((d) => d.id === tab.designId) ?? designs[0]
    if (!entry) {
      setLoaded(null)
      return
    }
    if (entry.id !== tab.designId) pickDesign(sessionId, tab.id, entry.id)
    void open(entry)
    // `stamp` is a dependency, not a value: it changes when the file does, and
    // re-running this is the reload.
  }, [designs, tab.designId, tab.id, sessionId, open, pickDesign, stamp])

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
   * One artboard as a PNG on the clipboard.
   *
   * Rasterised rather than read off the canvas: the live artboard is a shadow
   * root under a transform, so anything captured from it would carry the
   * viewport's zoom. The rasteriser already produces the picture at 2x, and
   * the cache makes a second copy of the same artboard free.
   */
  const copyPng = useCallback(
    async (artboardId: string) => {
      if (current === null || loaded === null) return
      const artboard = loaded.doc.artboards.find((a) => a.id === artboardId)
      if (!artboard) return
      const request = rasterRequest(artboard, loaded.theme, 2)
      const raster = await window.api.design.raster(request as unknown as Record<string, unknown>)
      if (!raster?.ok || !raster.path) return
      const image = await window.api.fs.readImage(raster.path)
      if (!image?.base64 || !image.mediaType) return
      const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))
      await navigator.clipboard.write([
        new ClipboardItem({ [image.mediaType]: new Blob([bytes], { type: image.mediaType }) })
      ])
    },
    [current, loaded]
  )

  /**
   * Put a reference to this artboard in the composer.
   *
   * The same `@path` shape the file menu uses, with the artboard as a
   * fragment — so it chips in the composer exactly like a mention, and Claude
   * receives a pointer to the panel rather than a description of it.
   */
  const reference = useCallback(
    (artboardId: string) => {
      if (current === null) return
      // The trailing space matters: a mention under the caret stays editable
      // text by design, so without it the reference lands as a raw path and
      // only becomes a chip once you type past it.
      useUiStore.getState().prefillInput(`@${current.path}#${artboardId} `)
    },
    [current]
  )

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

  const reload = useCallback(async () => {
    const list = await refreshList()
    const entry = list.find((d) => d.id === tab.designId)
    if (entry) void open(entry)
  }, [refreshList, open, tab.designId])

  if (designs !== null && designs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Frame className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No designs in this project</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Ask Claude to design something — a settings page, an empty state — and it will show up
          here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
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
            <select
              value={tab.designId ?? ''}
              onChange={(e) => pickDesign(sessionId, tab.id, e.target.value)}
              className="min-w-0 flex-1 truncate bg-transparent text-xs outline-none"
            >
              {(designs ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <IconButton label="Reload this design" onClick={() => void reload()}>
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
                <IconButton
                  label="Remove from Nyra — the file stays on disk"
                  onClick={() => void forget()}
                >
                  <Trash2 className="size-3" />
                </IconButton>
              </>
            )}
          </>
        )}
      </div>

      {error !== null ? (
        <pre className="m-2 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      ) : loaded ? (
        <>
        <DesignCanvas
          artboards={loaded.doc.artboards}
          theme={loaded.theme}
          selected={selected}
          onSelect={setSelected}
          focus={tab.artboardId}
          onContextMenu={(artboardId, at) => setMenu({ artboardId, at })}
        />
        {menu !== null && (
          <>
            {/* A click anywhere else dismisses it, the way a menu should. */}
            <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} />
            <div
              className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-xs shadow-md"
              style={{ left: menu.at.x, top: menu.at.y }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                onClick={() => {
                  void copyPng(menu.artboardId)
                  setMenu(null)
                }}
              >
                <ClipboardCopy className="size-3.5" />
                Copy as PNG
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                onClick={() => {
                  reference(menu.artboardId)
                  setMenu(null)
                }}
              >
                <MessageSquare className="size-3.5" />
                Reference in chat
              </button>
            </div>
          </>
        )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  )
}
