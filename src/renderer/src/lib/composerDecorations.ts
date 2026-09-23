import { RangeSet, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { argumentHint, isKnownCommand } from './slashCommands'
import {
  designArtboardName,
  designNameFromPath,
  isDesignPath,
  openDesignInPanel,
  openFileInPanel,
  splitDesignRef
} from './openFile'

/**
 * Nyra's own composer decorations, on top of plain markdown.
 *
 * These mark things the CLI treats specially — a slash command, the `ultrathink`
 * keyword — so the composer shows you what Claude is going to see rather than
 * leaving them as undifferentiated text.
 *
 * The finders below are shared: `promptMarkdown` draws the same four things in
 * the message once it has been sent, so a draft and the bubble it becomes agree
 * on what counts as a mention. Only the drawing is separate — CodeMirror widgets
 * here, React elements there, one set of classes in index.css.
 */


/**
 * A command only counts at the very start of the message, which is where the CLI
 * reads it.
 *
 * The colon is not decoration: `.claude/commands/git/sync.md` is `/git:sync`,
 * and a command a plugin contributes is namespaced the same way. Without it the
 * name stopped at the colon and the whole thing read as a path — which is what
 * made `/claude-api prompt-audit` look like an unrecognised command. The match
 * still stops at the command itself: `prompt-audit` is its argument.
 */
const COMMAND_AT_START = /^\/([a-z][a-z0-9:_-]*)/

/** Matched case-insensitively and on a word boundary, the way the CLI triggers it. */
const ULTRATHINK = /\bultrathink\b/gi

export type Span = { from: number; to: number }

/**
 * The leading slash command, if the message opens with one we know.
 *
 * Unknown slashes are left as plain text rather than styled optimistically —
 * `/usr/local/bin` is a path, not a command.
 */
export function findCommand(text: string): Span | null {
  const m = COMMAND_AT_START.exec(text)
  if (!m || !isKnownCommand(m[1])) return null
  return { from: 0, to: m[0].length }
}

/**
 * `@`-mentions of files and folders.
 *
 * The `@` has to start a word, so an email address or a decorator is left alone.
 */
const FILE_MENTION = /(^|\s)@([^\s@]+)/g

export type FileMention = Span & { path: string }

export function findFileMentions(text: string): FileMention[] {
  FILE_MENTION.lastIndex = 0
  const found: FileMention[] = []
  let hit: RegExpExecArray | null
  while ((hit = FILE_MENTION.exec(text)) !== null) {
    const from = hit.index + hit[1].length
    found.push({ from, to: from + 1 + hit[2].length, path: hit[2] })
  }
  return found
}

/** The part of a path worth showing — a chip has no room for the rest. */
export function mentionLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base || trimmed
}


/**
 * An attachment, referred to in the sentence it belongs to.
 *
 * Attaching a file used to append `[Image: /tmp/…]` after the whole message, so
 * a prompt about two screenshots had to say which was which in prose. The
 * reference now goes in at the caret, and the chip shows the file's name over
 * the top — you write "in this screen [shot.png] the sidebar…" and Claude reads
 * the path exactly where you meant it.
 *
 * The marker *is* the payload: `[Image: path]` is already the form the CLI
 * expects, so nothing has to be translated on the way out.
 */
const ATTACHMENT_REF = /\[(Image|File): ([^\]\n]+)\]/g

export type AttachmentRef = Span & { kind: 'Image' | 'File'; target: string }

export function findAttachmentRefs(text: string): AttachmentRef[] {
  ATTACHMENT_REF.lastIndex = 0
  const found: AttachmentRef[] = []
  let hit: RegExpExecArray | null
  while ((hit = ATTACHMENT_REF.exec(text)) !== null) {
    found.push({
      from: hit.index,
      to: hit.index + hit[0].length,
      kind: hit[1] as 'Image' | 'File',
      target: hit[2]
    })
  }
  return found
}

/** The text to drop at the caret when something is attached. */
export function attachmentMarker(kind: 'Image' | 'File', target: string): string {
  return `[${kind}: ${target}]`
}

/**
 * Take an attachment's marker back out of the draft.
 *
 * Removing something from the strip used to leave its `[Image: /tmp/…]` behind,
 * pointing at a file that is no longer going to be sent. Whitespace on one side
 * of the marker goes with it, so the sentence it sat in does not end up with a
 * double space.
 *
 * Only this direction is reconciled. The reverse — deleting the chip and having
 * the file unstage itself — is not safe to infer here: the file picker stages
 * attachments without writing a marker at all, and stashing a draft clears the
 * text while keeping the attachments, so "no marker" does not mean "not wanted".
 */
export function removeAttachmentRef(
  text: string,
  kind: 'Image' | 'File',
  target: string
): string {
  const marker = attachmentMarker(kind, target)
  const at = text.indexOf(marker)
  if (at === -1) return text
  let from = at
  let to = at + marker.length
  if (text[to] === ' ') to += 1
  else if (from > 0 && text[from - 1] === ' ') from -= 1
  return text.slice(0, from) + text.slice(to)
}

/** Every `ultrathink`, case-insensitive and whole-word. */
export function findUltrathink(text: string): Span[] {
  ULTRATHINK.lastIndex = 0
  const spans: Span[] = []
  let hit: RegExpExecArray | null
  while ((hit = ULTRATHINK.exec(text)) !== null) {
    spans.push({ from: hit.index, to: hit.index + hit[0].length })
  }
  return spans
}


/** The attachment chip. Orange, to separate "I brought this" from "@ this repo file". */
class AttachmentChipWidget extends WidgetType {
  constructor(
    private readonly kind: 'Image' | 'File',
    private readonly target: string
  ) {
    super()
  }
  eq(other: AttachmentChipWidget): boolean {
    return other.kind === this.kind && other.target === this.target
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'nyra-attach-chip'
    const icon = document.createElement('span')
    icon.className = `nyra-attach-chip-icon nyra-attach-chip-icon-${this.kind.toLowerCase()}`
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)
    el.appendChild(document.createTextNode(mentionLabel(this.target)))
    el.title = this.target
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

/**
 * A design mention, in the composer.
 *
 * The third place a design reference is drawn — the composer decorates live
 * text, `promptMarkdown` decorates a sent message, and `MarkdownRenderer`
 * decorates Claude's reply. They are genuinely separate renderers, and this one
 * was missed: a referenced design chipped blue, with a filename and a dangling
 * `#general`, next to the pink chip Claude posts for the same design.
 *
 * The label is resolved after mount because a widget's `toDOM` is synchronous
 * and the design's real name lives in the index. Until it answers, the filename
 * gives a readable stand-in, so the chip never flashes empty.
 */
class DesignChipWidget extends WidgetType {
  constructor(private readonly ref: string) {
    super()
  }
  eq(other: DesignChipWidget): boolean {
    return other.ref === this.ref
  }
  toDOM(): HTMLElement {
    const { path, artboard } = splitDesignRef(this.ref)
    const el = document.createElement('span')
    el.className = 'nyra-design-chip'
    const icon = document.createElement('span')
    icon.className = 'nyra-design-chip-icon'
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)

    const label = document.createTextNode(designNameFromPath(path))
    el.appendChild(label)
    el.title = this.ref
    el.setAttribute('role', 'button')
    el.tabIndex = 0

    void (async () => {
      const designs = await window.api.design.list()
      const design = designs.find((d) => d.path === path)?.name ?? designNameFromPath(path)
      const board = artboard === null ? null : await designArtboardName(path, artboard)
      label.textContent = board === null ? design : `${design} — ${board}`
    })()

    const open = (): void => void openDesignInPanel(this.ref)
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      open()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

class FileChipWidget extends WidgetType {
  constructor(private readonly path: string) {
    super()
  }
  eq(other: FileChipWidget): boolean {
    return other.path === this.path
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'nyra-file-chip'
    const icon = document.createElement('span')
    icon.className = 'nyra-file-chip-icon'
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)
    el.appendChild(document.createTextNode(mentionLabel(this.path)))
    el.title = this.path
    el.setAttribute('role', 'button')
    el.tabIndex = 0
    const open = (): void => openFileInPanel(this.path)
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      open()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

/**
 * What a command takes, drawn after it until you start typing it.
 *
 * `/model` then a caret gives no clue that it wants a model name; the CLI does
 * say so, as `<model>`, and this puts it where you are about to type. Only while
 * nothing follows the command but a space, and only with the caret at the end:
 * a hint over an argument you have written would be in the way of it.
 */
export function commandHintAt(
  text: string,
  caret: number
): { at: number; hint: string } | null {
  const command = findCommand(text)
  if (!command) return null
  const rest = text.slice(command.to)
  if (rest !== '' && rest !== ' ') return null
  if (caret !== text.length) return null
  const hint = argumentHint(text.slice(1, command.to))
  return hint ? { at: text.length, hint } : null
}

class CommandHintWidget extends WidgetType {
  constructor(
    private readonly hint: string,
    private readonly spaced: boolean
  ) {
    super()
  }
  eq(other: CommandHintWidget): boolean {
    return other.hint === this.hint && other.spaced === this.spaced
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'nyra-command-hint'
    el.setAttribute('aria-hidden', 'true')
    el.textContent = this.spaced ? this.hint : ` ${this.hint}`
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

class CommandIconWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'nyra-command-icon'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

const commandMark = Decoration.mark({ class: 'nyra-command' })
const commandIcon = Decoration.widget({ widget: new CommandIconWidget(), side: -1 })
const rainbow = Decoration.mark({ class: 'nyra-ultrathink' })

/**
 * Does a cursor or selection reach this span?
 *
 * The rule used to be line granularity, which is why a pasted attachment stayed
 * raw markdown until you broke the line: the marker goes in at the caret, so its
 * line was always the line being edited. Touching an edge still counts — while
 * you type `@src/comp` the caret sits at the end of the mention, and a
 * strict-interior test would collapse it to a chip mid-word.
 */
export function spanTouched(
  span: Span,
  ranges: readonly { from: number; to: number }[]
): boolean {
  return ranges.some((r) => r.from <= span.to && r.to >= span.from)
}

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const text = view.state.doc.toString()
  const ranges = view.state.selection.ranges

  const command = findCommand(text)
  if (command) {
    decorations.push(commandIcon.range(command.from))
    decorations.push(commandMark.range(command.from, command.to))
  }

  // Side 1, so it sits after the caret rather than pushing it along.
  const hint = ranges.length === 1 && ranges[0].empty ? commandHintAt(text, ranges[0].head) : null
  if (hint) {
    const widget = new CommandHintWidget(hint.hint, text.endsWith(' '))
    decorations.push(Decoration.widget({ widget, side: 1 }).range(hint.at))
  }

  for (const span of findUltrathink(text)) {
    decorations.push(rainbow.range(span.from, span.to))
  }

  for (const mention of findFileMentions(text)) {
    // Collapsed to a chip, unless the caret is actually in it — then it is the
    // path you are typing, so it stays text you can edit.
    if (spanTouched(mention, ranges)) continue
    const widget = isDesignPath(mention.path)
      ? new DesignChipWidget(mention.path)
      : new FileChipWidget(mention.path)
    decorations.push(Decoration.replace({ widget }).range(mention.from, mention.to))
  }

  return RangeSet.of(decorations, true)
}

/**
 * The attachment chips, always.
 *
 * Unlike an @-mention there is nothing here anyone wants to hand-edit — the
 * payload is a temp path like `/var/folders/…/nyra-image-8f2.png` — so it is a
 * chip from the moment you paste, with no line break needed to reveal it and no
 * flicker as the caret passes. Kept in its own set so it can also be handed to
 * `atomicRanges`, which is what makes Backspace delete the whole thing rather
 * than walking into the middle of a path it cannot see.
 */
function buildAttachments(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  for (const ref of findAttachmentRefs(view.state.doc.toString())) {
    decorations.push(
      Decoration.replace({ widget: new AttachmentChipWidget(ref.kind, ref.target) }).range(
        ref.from,
        ref.to
      )
    )
  }
  return RangeSet.of(decorations, true)
}

class ComposerDecorations {
  decorations: DecorationSet
  attachments: DecorationSet
  /** Both sets, so CodeMirror draws chips and mentions in one pass. */
  all: DecorationSet

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view)
    this.attachments = buildAttachments(view)
    this.all = RangeSet.join([this.decorations, this.attachments])
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return
    this.decorations = buildDecorations(update.view)
    // Only the document can change these; the caret moving over one does not.
    if (update.docChanged) this.attachments = buildAttachments(update.view)
    this.all = RangeSet.join([this.decorations, this.attachments])
  }
}

export const composerDecorations = ViewPlugin.fromClass(ComposerDecorations, {
  decorations: (plugin) => plugin.all,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.attachments ?? Decoration.none)
})
