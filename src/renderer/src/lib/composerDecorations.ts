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

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const text = view.state.doc.toString()

  const command = findCommand(text)
  if (command) {
    decorations.push(commandIcon.range(command.from))
    decorations.push(commandMark.range(command.from, command.to))
  }

  for (const span of findUltrathink(text)) {
    decorations.push(rainbow.range(span.from, span.to))
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
      if (update.docChanged) this.decorations = buildDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
