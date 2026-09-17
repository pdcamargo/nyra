import { RangeSet, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { BUILT_IN_COMMANDS } from '../data/commands'
import { useFilePreviewStore } from '../store/filePreview'

/**
 * Nyra's own composer decorations, on top of plain markdown.
 *
 * These mark things the CLI treats specially — a slash command, the `ultrathink`
 * keyword — so the composer shows you what Claude is going to see rather than
 * leaving them as undifferentiated text.
 */

const KNOWN_COMMANDS = new Set(BUILT_IN_COMMANDS.map((c) => c.name.slice(1).split(' ')[0]))

/** A command only counts at the very start of the message, which is where the CLI reads it. */
const COMMAND_AT_START = /^\/([a-z][\w-]*)/

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
  if (!m || !KNOWN_COMMANDS.has(m[1])) return null
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

class FileChipWidget extends WidgetType {
  constructor(private readonly path: string) {
    super()
  }
  eq(other: FileChipWidget): boolean {
    return other.path === this.path
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-file-chip'
    const icon = document.createElement('span')
    icon.className = 'cm-file-chip-icon'
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)
    el.appendChild(document.createTextNode(mentionLabel(this.path)))
    el.title = this.path
    el.setAttribute('role', 'button')
    el.tabIndex = 0
    const open = (): void => useFilePreviewStore.getState().open(this.path)
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

class CommandIconWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-command-icon'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

const commandMark = Decoration.mark({ class: 'cm-command' })
const commandIcon = Decoration.widget({ widget: new CommandIconWidget(), side: -1 })
const rainbow = Decoration.mark({ class: 'cm-ultrathink' })

/** Line numbers the selection touches — a mention there stays editable text. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>()
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number
    const last = view.state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) lines.add(n)
  }
  return lines
}

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const text = view.state.doc.toString()
  const active = activeLines(view)

  const command = findCommand(text)
  if (command) {
    decorations.push(commandIcon.range(command.from))
    decorations.push(commandMark.range(command.from, command.to))
  }

  for (const span of findUltrathink(text)) {
    decorations.push(rainbow.range(span.from, span.to))
  }

  for (const mention of findFileMentions(text)) {
    // Collapsed to a chip, unless you are on that line — then it is the path you
    // typed, so you can edit or delete it.
    if (active.has(view.state.doc.lineAt(mention.from).number)) continue
    decorations.push(
      Decoration.replace({ widget: new FileChipWidget(mention.path) }).range(
        mention.from,
        mention.to
      )
    )
  }

  return RangeSet.of(decorations, true)
}

export const composerDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
