import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { type EditorState, type Range, RangeSet, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

/**
 * GFM tables, drawn as tables in the markdown file preview.
 *
 * `livePreview` works line by line — it hides a marker or styles a line — and a
 * table is the one construct that cannot be read that way: a row of pipes is
 * not a row of a table until it is laid out against the rows around it. So the
 * whole table is replaced by a widget that draws it, until the selection is
 * inside it, when its source comes back like any other line's.
 *
 * A state field rather than part of `livePreview`: CodeMirror only accepts a
 * block-replacing decoration from state, never from a view plugin.
 */

export type Align = 'left' | 'center' | 'right' | null

export type ParsedTable = { head: string[]; align: Align[]; rows: string[][] }

/** A row's cells: the outer pipes dropped, split on the ones not escaped. */
export function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null
}

/** The table a source block holds, or null when it is not one. */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const head = splitRow(lines[0])
  const delimiter = splitRow(lines[1])
  if (!delimiter.every((c) => /^:?-+:?$/.test(c))) return null
  const width = head.length
  const fit = (cells: string[]): string[] =>
    cells.length >= width ? cells.slice(0, width) : [...cells, ...Array(width - cells.length).fill('')]
  return {
    head,
    align: fit(delimiter).map(alignOf),
    rows: lines.slice(2).map((l) => fit(splitRow(l)))
  }
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A cell's inline markdown, as HTML: code, bold, italic, strikethrough, and a
 * link's text. Escaped first, so nothing in the file becomes markup.
 */
export function inlineHtml(text: string): string {
  const codes: string[] = []
  // Code first, and set aside, so nothing inside it is read as emphasis.
  let out = escape(text).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '<span class="cm-md-table-link">$1</span>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a: string, b: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table'
    const table = parseTable(this.source)
    if (!table) {
      wrap.textContent = this.source
      return wrap
    }
    const cell = (tag: 'th' | 'td', text: string, align: Align): string =>
      `<${tag}${align ? ` style="text-align:${align}"` : ''}>${inlineHtml(text)}</${tag}>`
    wrap.innerHTML =
      `<table><thead><tr>${table.head.map((h, i) => cell('th', h, table.align[i])).join('')}</tr></thead>` +
      `<tbody>${table.rows
        .map((row) => `<tr>${row.map((c, i) => cell('td', c, table.align[i])).join('')}</tr>`)
        .join('')}</tbody></table>`
    return wrap
  }

  // Selecting text in the table is the browser's; CodeMirror stays out of it.
  ignoreEvent(): boolean {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  // The whole document, not the viewport: a block widget changes the height of
  // everything under it, and a file preview is not long enough for that to cost.
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  const decorations: Range<Decoration>[] = []
  const { selection, doc } = state
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const from = doc.lineAt(node.from).from
      const to = doc.lineAt(node.to).to
      const editing = selection.ranges.some((r) => r.from <= to && r.to >= from)
      if (!editing) {
        decorations.push(
          Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }).range(from, to)
        )
      }
      return false
    }
  })
  return RangeSet.of(decorations, true)
}

export const tablePreview = StateField.define<DecorationSet>({
  create: build,
  update(decorations, tr) {
    // A parse that finishes later arrives as a transaction of its own, with a
    // new tree and nothing else changed — the table it finds is drawn then.
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state)
    return decorations
  },
  provide: (field) => EditorView.decorations.from(field)
})
