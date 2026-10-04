import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  defaultTheme,
  rasterRequest,
  serializeDocument,
  type Issue,
  type ResolvedArtboard,
  type ResolvedDocument,
  type Theme,
  type Upgrade
} from '@nyra/design'
import { ClipboardCopy, FileDown, MessageCirclePlus, MessageSquare, MessageSquareText } from 'lucide-react'
import { cn } from 'cn'
import { useUiStore } from '../../store/ui'
import { useFileStamp } from '../../hooks/useFileStamp'
import DesignCanvas, { nextSelection, type SelectMode } from './DesignCanvas'
import ExportPdfDialog from './ExportPdfDialog'
import { Button } from '../ui/button'
import { useDesignExportStore } from '../../store/designExport'
import { useDesignActivityStore } from '../../store/designActivity'
import { loadDesign, type DesignLoadPhase } from '../../lib/designLoad'
import { NewerFormatNotice, OpeningCard, UpgradeBanner } from './DesignNotices'
import { basename } from '../../lib/paths'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import {
  commentBody,
  describeTarget,
  feedbackBody,
  targetTag,
  type CommentAnchor,
  type DesignComment,
  type Hit
} from '../../lib/designComments'
import { sendToChat } from '../../lib/messageContext'
import { useDesignComments } from './comments/useDesignComments'
import CommentLayer, { type Highlight } from './comments/CommentLayer'
import CommentComposer from './comments/CommentComposer'
import CommentsBar, { CommentsPanel } from './comments/CommentsBar'

type Loaded = { doc: ResolvedDocument; theme: Theme; issues: Issue[] }

// Stable, so the empty canvas never re-renders for a fresh [] or a new callback.
const NO_ARTBOARDS: ResolvedArtboard[] = []
const NO_SELECTION: string[] = []
const NO_COMMENTS: DesignComment[] = []
const ignore = (): void => {}

/** A right-click, described: what it landed on and how to name it. */
type Target = { hit: Hit; at: { x: number; y: number }; artboard: ResolvedArtboard; described: ReturnType<typeof describeTarget> }

/**
 * One design file on the canvas: read, compiled, drawn, and kept current.
 *
 * Shared by a single draft and by a file inside a design system — the file is
 * what is on screen either way, and only the header around it differs. A file
 * in a system compiles with the system's components and theme; `loadDesign`
 * finds that out from the path.
 *
 * Rendering happens here rather than through the rasteriser: the renderer
 * already has React and the pipeline, so the panel draws live and instantly and
 * never waits on a headless browser. The PNGs exist for Claude's eyes and for
 * chat; this is for yours.
 */
/** The design menu's rows: the app's menu, at the sizes the canvas's own text uses. */
const MENU_ROW = 'rounded-[4px] text-[12.5px] leading-[1.5]'
const MENU_ROW_TWO = `${MENU_ROW} items-start`
/** A hint stays muted when its row is highlighted: it is the row's second line, not its label. */
const MENU_HINT = 'text-[11.5px] leading-[1.4] font-medium text-muted-foreground!'

export default function DesignFileView({
  sessionId,
  path,
  name,
  mode,
  focus,
  upgradeLabel = 'Upgrade file',
  onUpgradeAll,
  openCommentsAt
}: {
  /** The chat whose panel this is: feedback and comments are sent to it. */
  sessionId: string
  /** Absolute. Watched before it exists, so a file Claude is about to write
   *  appears the moment it is written. */
  path: string
  /** What the design is called, for exports. */
  name: string
  /** For a file in a system: the theme mode to draw in. */
  mode?: string
  /** Frame this artboard rather than fitting everything. */
  focus: string | null
  /** A system upgrades every file at once; a draft just this one. */
  upgradeLabel?: string
  onUpgradeAll?: () => Promise<void>
  /** Changes when something outside — the system header's count — asks for
   *  the comment list. */
  openCommentsAt?: number
}): React.ReactElement {
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
  /** Which file `loaded` came from, so a reload keeps it on screen while a
   *  switch to another design does not show the old one under the new name. */
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unwritten, setUnwritten] = useState(false)
  /** How far an open has got. Shown only once it has taken long enough to
   *  notice, so a small design never flashes a progress card. */
  const [phase, setPhase] = useState<DesignLoadPhase | null>(null)
  const [slow, setSlow] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [newer, setNewer] = useState<string | null>(null)
  const [upgrade, setUpgrade] = useState<Upgrade | null>(null)
  /** Paths whose upgrade banner was waved away this session. */
  const [notNow, setNotNow] = useState<ReadonlySet<string>>(() => new Set())
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const select = useCallback(
    (id: string | null, how: SelectMode = 'replace') => setSelected((current) => nextSelection(current, id, how)),
    []
  )
  const [exporting, setExporting] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const { scope, rel, comments } = useDesignComments(path)
  /** The last right-click on an artboard; the menu reads it. */
  const [target, setTarget] = useState<Target | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [composer, setComposer] = useState<{ kind: 'feedback' | 'comment'; target: Target } | null>(null)
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const [showComments, setShowComments] = useState(true)
  /** The comment list, docked beside the canvas. */
  const [listing, setListing] = useState(false)
  useEffect(() => {
    if (openCommentsAt) setListing(true)
  }, [openCommentsAt])
  /** An artboard the comments list asked to frame, until a chip asks for another. */
  const [framed, setFramed] = useState<string | null>(null)
  useEffect(() => setFramed(null), [focus])

  useEffect(() => {
    // A newer open supersedes an older one: switching designs mid-read must
    // not let the first file land on top of the second.
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setStopped(false)
    setPhase(null)
    const noticed = setTimeout(() => setSlow(true), 250)

    void loadDesign(path, { signal: controller.signal, onPhase: setPhase, mode }).then((result) => {
      clearTimeout(noticed)
      if (inflight.current !== controller) return
      inflight.current = null
      setSlow(false)
      setPhase(null)
      switch (result.kind) {
        case 'cancelled':
          setStopped(true)
          return
        case 'missing':
          // `create` registers a design before its file is written, so a missing
          // file is usually one about to arrive. If it really is gone, it simply
          // never arrives.
          setUnwritten(true)
          setError(null)
          setNewer(null)
          setLoaded(null)
          return
        case 'newer':
          setNewer(result.message)
          setError(null)
          setUnwritten(false)
          setLoaded(null)
          return
        case 'error':
        case 'invalid':
          setError(
            result.kind === 'invalid' && result.issues.length > 0
              ? result.issues
                  .slice(0, 6)
                  .map((i) => `${i.code}: ${i.message}`)
                  .join('\n')
              : result.message
          )
          setNewer(null)
          setUnwritten(false)
          setLoaded(null)
          return
        case 'ok':
          setError(null)
          setNewer(null)
          setUnwritten(false)
          setLoaded({ doc: result.doc, theme: result.theme, issues: result.issues })
          setLoadedPath(path)
          setUpgrade(result.upgrade)
          setUpgradeError(null)
      }
    })
    return () => clearTimeout(noticed)
    // `stamp` is a dependency, not a value: it changes when the file does, and
    // re-running this is the reload. `attempt` is "open it again".
  }, [path, mode, stamp, attempt])

  // An open still running when the view goes away is a read nobody wants.
  useEffect(() => () => inflight.current?.abort(), [])

  // On screen is looked at: what the miniature flags as changed is changed
  // since you last saw it, and you are seeing it now.
  useEffect(() => {
    if (loaded !== null && loadedPath === path) {
      useDesignActivityStore.getState().acknowledge(path, { doc: loaded.doc, theme: loaded.theme })
    }
  }, [loaded, loadedPath, path])

  /**
   * One artboard as a PNG on the clipboard.
   *
   * Rasterised rather than read off the canvas: the live artboard is a shadow
   * root under a transform, so anything captured from it would carry the
   * viewport's zoom. The rasteriser already produces the picture at 2x, and
   * the cache makes a second copy of the same artboard free.
   *
   * The clipboard write starts synchronously, with the picture as a promise.
   * WebKit only lets a page write the clipboard during the click that asked
   * for it, and the rasteriser's round-trip outlasts that: awaiting it first
   * and writing after was refused, silently, every time.
   */
  const copyPng = useCallback(
    (artboardId: string) => {
      if (loaded === null) return
      const artboard = loaded.doc.artboards.find((a) => a.id === artboardId)
      if (!artboard) return
      const png = (async (): Promise<Blob> => {
        const request = rasterRequest(artboard, loaded.theme, 2)
        const raster = await window.api.design.raster(request as unknown as Record<string, unknown>)
        if (!raster?.ok || !raster.path) throw new Error(raster?.error ?? 'rasterising the artboard failed')
        const image = await window.api.fs.readImage(raster.path)
        if (!image?.base64) throw new Error(`could not read ${raster.path}`)
        const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))
        return new Blob([bytes], { type: 'image/png' })
      })()
      navigator.clipboard
        .write([new ClipboardItem({ 'image/png': png })])
        .catch((err) => console.error('[design] copy as PNG failed:', err))
    },
    [loaded]
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
      // The trailing space matters: a mention under the caret stays editable
      // text by design, so without it the reference lands as a raw path and
      // only becomes a chip once you type past it.
      useUiStore.getState().prefillInput(`@${path}#${artboardId} `)
    },
    [path]
  )

  /**
   * Hand the chosen pages to the export, in the dialog's order.
   *
   * The dialog closes before the save dialog opens: two modals stacked is one
   * too many, and the notice takes over from here.
   */
  const exportPdf = useCallback(
    (ids: string[], openWhenDone: boolean) => {
      if (loaded === null) return
      const byId = new Map(loaded.doc.artboards.map((a) => [a.id, a]))
      const artboards = ids.flatMap((id) => byId.get(id) ?? [])
      setExporting(false)
      void useDesignExportStore.getState().exportPdf({
        artboards,
        theme: loaded.theme,
        designName: name,
        designPath: path,
        openWhenDone
      })
    },
    [loaded, name, path]
  )

  const byArtboard = useMemo(() => {
    const map = new Map<string, DesignComment[]>()
    for (const c of comments) map.set(c.artboardId, [...(map.get(c.artboardId) ?? []), c])
    return map
  }, [comments])

  const onCanvasMenu = useCallback(
    (hit: Hit, at: { x: number; y: number }) => {
      const artboard = loaded?.doc.artboards.find((a) => a.id === hit.artboardId)
      if (!artboard) return
      setTarget({ hit, at, artboard, described: describeTarget(artboard, hit.resolvedId) })
    },
    [loaded]
  )

  /** Feedback on the artboard: your words and the design chip, visible. */
  const sendFeedback = useCallback(
    async (t: Target, text: string) => {
      sendToChat({
        sessionId,
        text,
        context: [
          {
            kind: 'design-feedback',
            label: t.artboard.name,
            body: feedbackBody(path, t.artboard.id, t.artboard.name),
            ref: { path, artboard: t.artboard.id }
          }
        ]
      })
      setComposer(null)
    },
    [path, sessionId]
  )

  /**
   * A comment: saved first, so it has a number and an id to resolve by, then
   * sent. The bubble shows the pin and your words; the anchor goes to Claude.
   */
  const sendComment = useCallback(
    async (t: Target, text: string) => {
      if (!scope) throw new Error('Still reading this design’s comments. Try again in a moment.')
      const anchor: CommentAnchor = {
        resolvedId: t.hit.resolvedId,
        ...t.described,
        offset: t.hit.offset,
        point: t.hit.point,
        bounds: t.hit.bounds
      }
      const res = await window.api.comments.add(scope, {
        text,
        file: path,
        ...(rel ? { rel } : {}),
        artboardId: t.artboard.id,
        artboardName: t.artboard.name,
        anchor
      })
      if (!res.ok || !res.comment) throw new Error(res.error ?? 'Could not save the comment.')
      const c = res.comment
      sendToChat({
        sessionId,
        text,
        context: [
          {
            kind: 'design-comment',
            label: `Comment on ${anchor.label} · ${t.artboard.name}`,
            body: commentBody(c),
            ref: { path, artboard: t.artboard.id, commentId: c.id, pin: c.n, target: anchor.label, artboardName: t.artboard.name }
          }
        ]
      })
      setComposer(null)
    },
    [path, rel, scope, sessionId]
  )

  const resolveComment = useCallback(
    (c: DesignComment) => {
      if (scope) void window.api.comments.update(scope, c.id, { status: 'resolved', by: 'you' })
    },
    [scope]
  )

  /**
   * Reopening only says the last round did not settle it. Nothing is sent:
   * what to do instead is a reply, written in the card, and that is what goes
   * to Claude.
   */
  const reopenComment = useCallback(
    (c: DesignComment) => {
      if (scope) void window.api.comments.update(scope, c.id, { status: 'open' })
    },
    [scope]
  )

  /** Write back on a comment: added to its thread, then sent with all of it. */
  const replyComment = useCallback(
    async (c: DesignComment, text: string) => {
      if (!scope) throw new Error('Still reading this design’s comments. Try again in a moment.')
      const res = await window.api.comments.update(scope, c.id, { reply: { text, by: 'you' } })
      if (!res.ok || !res.comment) throw new Error(res.error ?? 'Could not save the reply.')
      sendToChat({
        sessionId,
        text,
        context: [
          {
            kind: 'design-comment',
            label: `Reply on comment ${c.n} on ${c.anchor.label} · ${c.artboardName}`,
            body: commentBody(res.comment),
            ref: {
              path: c.file,
              artboard: c.artboardId,
              commentId: c.id,
              pin: c.n,
              target: c.anchor.label,
              artboardName: c.artboardName,
              round: 'reply'
            }
          }
        ]
      })
    },
    [scope, sessionId]
  )

  const deleteComment = useCallback(
    (c: DesignComment) => {
      if (!scope) return
      setActiveComment(null)
      void window.api.comments.delete(scope, c.id)
    },
    [scope]
  )

  /** What the menu or composer is about, outlined on its artboard. */
  const highlight = useMemo((): { artboardId: string; value: Highlight } | null => {
    if (composer) {
      const t = composer.target
      return composer.kind === 'feedback'
        ? { artboardId: t.artboard.id, value: { bounds: null, tag: null, pin: null } }
        : // No tag: the composer's header names the target, and the pin would sit on it.
          {
            artboardId: t.artboard.id,
            value: { bounds: t.hit.bounds, tag: null, pin: t.hit.point, n: comments.reduce((m, c) => Math.max(m, c.n), 0) + 1 }
          }
    }
    if (menuOpen && target) {
      return { artboardId: target.artboard.id, value: { bounds: target.hit.bounds, tag: targetTag(target.described), pin: null } }
    }
    return null
  }, [comments, composer, menuOpen, target])

  const overlay = useCallback(
    (artboard: ResolvedArtboard, zoom: number) => (
      <CommentLayer
        artboard={artboard}
        zoom={zoom}
        comments={showComments ? (byArtboard.get(artboard.id) ?? NO_COMMENTS) : NO_COMMENTS}
        activeId={activeComment}
        onActive={setActiveComment}
        highlight={highlight?.artboardId === artboard.id ? highlight.value : null}
        onResolve={resolveComment}
        onReopen={reopenComment}
        onReply={replyComment}
        onDelete={deleteComment}
      />
    ),
    [activeComment, byArtboard, deleteComment, highlight, reopenComment, replyComment, resolveComment, showComments]
  )

  /**
   * Write the upgraded document over the file, after Rust backs the original
   * up. Nothing else to do on success: the file's stamp changes, the poll
   * reloads it, and a current file has no banner.
   */
  const upgradeFile = useCallback(async () => {
    if (upgrade === null) return
    setUpgrading(true)
    setUpgradeError(null)
    try {
      if (onUpgradeAll) {
        await onUpgradeAll()
      } else {
        const res = await window.api.design.writeUpgraded(path, serializeDocument(upgrade.doc), upgrade.from)
        if (!res.ok) setUpgradeError(res.error ?? 'Could not write the file.')
      }
    } catch (e) {
      setUpgradeError(e instanceof Error ? e.message : String(e))
    } finally {
      setUpgrading(false)
    }
  }, [onUpgradeAll, path, upgrade])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {upgrade !== null && loadedPath === path && !notNow.has(path) && (
        <UpgradeBanner
          busy={upgrading}
          error={upgradeError}
          label={upgradeLabel}
          onUpgrade={() => void upgradeFile()}
          onDismiss={() => setNotNow((prev) => new Set(prev).add(path))}
        />
      )}

      {slow && phase !== null && (loaded === null || loadedPath !== path) && (
        <OpeningCard fileName={basename(path)} phase={phase} onCancel={() => inflight.current?.abort()} />
      )}
      {slow && phase !== null && loaded !== null && loadedPath === path && (
        // A reload keeps the last good version up; this only says it is coming.
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-design-accent" />
      )}

      {newer !== null ? (
        <NewerFormatNotice message={newer} />
      ) : stopped && loaded === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs">
          <p className="text-muted-foreground">Stopped opening this design.</p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Open it again
          </Button>
        </div>
      ) : error !== null ? (
        <pre className="m-2 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      ) : unwritten || loaded === null || loadedPath !== path ? (
        // The canvas with nothing on it yet, rather than a message about it:
        // the first artboard lands where you are already looking, and nothing
        // jumps when it does.
        <DesignCanvas artboards={NO_ARTBOARDS} theme={defaultTheme} selected={NO_SELECTION} onSelect={ignore} />
      ) : (
        <>
          {/* The comment list docks beside the canvas, so the canvas narrows
              instead of hiding the artboard you framed under the list. */}
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              <ContextMenu onOpenChange={setMenuOpen}>
                <ContextMenuTrigger asChild>
                  <div className="flex min-h-0 flex-1 flex-col">
                    <DesignCanvas
                      artboards={loaded.doc.artboards}
                      theme={loaded.theme}
                      selected={selected}
                      onSelect={select}
                      focus={framed ?? focus}
                      onContextMenu={onCanvasMenu}
                      overlay={overlay}
                    />
                  </div>
                </ContextMenuTrigger>
                {/* Focus stays where it was: the composer takes it next, and a
                    menu handing it back to the canvas would take it first. */}
                <ContextMenuContent className="w-[290px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                  {target && (
                    <>
                      <ContextMenuItem className={MENU_ROW_TWO} onSelect={() => setComposer({ kind: 'feedback', target })}>
                        <MessageSquareText className="mt-0.5 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span>Give feedback on this design…</span>
                          <span className={MENU_HINT}>The whole artboard, not one element</span>
                        </span>
                      </ContextMenuItem>
                      <ContextMenuItem className={MENU_ROW_TWO} onSelect={() => setComposer({ kind: 'comment', target })}>
                        <MessageCirclePlus className="mt-0.5 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span>Comment here…</span>
                          <span className={cn(MENU_HINT, 'truncate')}>
                            {target.hit.resolvedId ? `Pinned to “${target.described.label}”` : 'Pinned to this spot'}
                          </span>
                        </span>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem className={MENU_ROW} onSelect={() => copyPng(target.artboard.id)}>
                        <ClipboardCopy className="text-muted-foreground" />
                        Copy as PNG
                      </ContextMenuItem>
                      <ContextMenuItem className={MENU_ROW} onSelect={() => reference(target.artboard.id)}>
                        <MessageSquare className="text-muted-foreground" />
                        Reference in chat
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem className={MENU_ROW} onSelect={() => setExporting(true)}>
                        <FileDown className="text-muted-foreground" />
                        {selected.length > 1 ? `Export ${selected.length} artboards as PDF…` : 'Export as PDF…'}
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
              {!listing && (
                <CommentsBar comments={comments} shown={showComments} onShown={setShowComments} onList={() => setListing(true)} />
              )}
            </div>
            {listing && comments.length > 0 && (
              <CommentsPanel
                comments={comments}
                activeId={activeComment}
                onClose={() => setListing(false)}
                onPick={(c) => {
                  setShowComments(true)
                  setFramed(c.artboardId)
                  setActiveComment(c.id)
                }}
              />
            )}
          </div>
          {composer && (
            <CommentComposer
              key={`${composer.kind}:${composer.target.at.x},${composer.target.at.y}`}
              kind={composer.kind}
              target={
                composer.kind === 'feedback'
                  ? composer.target.artboard.name
                  : `${composer.target.described.label} · ${composer.target.artboard.name}`
              }
              at={composer.target.at}
              onSend={(text) =>
                composer.kind === 'feedback' ? sendFeedback(composer.target, text) : sendComment(composer.target, text)
              }
              onCancel={() => setComposer(null)}
            />
          )}
          {/* Only once there is more than one: a single artboard has the menu,
              and a bar for one thing is a bar in the way. */}
          {selected.length > 1 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-10 z-30 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-popover py-1 pr-1 pl-3 text-xs shadow-panel">
                <span>
                  <span className="font-medium tabular-nums">{selected.length}</span> artboards selected
                </span>
                <span className="h-4 w-px bg-border" />
                <Button variant="ghost" size="sm" onClick={() => select(null)}>
                  Clear
                </Button>
                <Button size="sm" onClick={() => setExporting(true)}>
                  <FileDown />
                  Export as PDF
                </Button>
              </div>
            </div>
          )}
          <ExportPdfDialog
            open={exporting}
            onOpenChange={setExporting}
            artboards={loaded.doc.artboards}
            theme={loaded.theme}
            picked={selected}
            onExport={exportPdf}
          />
        </>
      )}
    </div>
  )
}
