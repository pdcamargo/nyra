import { syntaxTree } from '@codemirror/language'
import { type Range, RangeSet } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/**
 * Obsidian-style live preview for the composer.
 *
 * Markdown syntax is hidden and the text rendered as what it means — until the
 * cursor lands on that line, when the markers come back so the line is editable
 * as the plain text it actually is. Nothing is transformed: the document stays
 * exactly the markdown that gets sent, and this only changes how it is drawn.
 */

/** Marker nodes worth hiding. ListMark stays: a bullet means something as a bullet. */
const HIDDEN_MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'StrongEmphasisMark',
  'CodeMark',
  'QuoteMark',
  'StrikethroughMark'
])

const hide = Decoration.replace({})

const headingLine = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-h${level}` })
)
const quoteLine = Decoration.line({ class: 'cm-md-quote' })
const codeInfo = Decoration.mark({ class: 'cm-md-codeinfo' })
const codeLine = Decoration.line({ class: 'cm-md-code' })

/** Line numbers the selection touches — those lines show their markers. */
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
  const active = activeLines(view)
  const { doc } = view.state

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name

        if (name.startsWith('ATXHeading')) {
          const level = Number(name.slice(-1))
          if (level >= 1 && level <= 6) {
            decorations.push(headingLine[level - 1].range(doc.lineAt(node.from).from))
          }
          return
        }

        if (name === 'Blockquote') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            decorations.push(quoteLine.range(doc.line(n).from))
          }
          return
        }

        if (name === 'FencedCode') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            decorations.push(codeLine.range(doc.line(n).from))
          }
          return
        }

        // The fence's backticks are hidden with the other marks, which would
        // otherwise leave the language sitting in the block as ordinary code.
        if (name === 'CodeInfo') {
          decorations.push(codeInfo.range(node.from, node.to))
          return
        }

        if (!HIDDEN_MARKS.has(name)) return
        if (active.has(doc.lineAt(node.from).number)) return
        if (node.to <= node.from) return

        // A heading's `#` run is followed by the space that separates it from the
        // text; leaving that behind would indent every heading by one.
        let end = node.to
        if (name === 'HeaderMark' && doc.sliceString(end, end + 1) === ' ') end += 1
        if (name === 'QuoteMark' && doc.sliceString(end, end + 1) === ' ') end += 1

        decorations.push(hide.range(node.from, end))
      }
    })
  }

  // Line and replace decorations have to arrive in document order.
  return RangeSet.of(decorations, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      // Selection matters as much as edits here: moving the caret onto a line is
      // what brings that line's markers back.
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
