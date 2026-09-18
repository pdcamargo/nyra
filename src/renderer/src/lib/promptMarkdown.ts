import {
  findAttachmentRefs,
  findCommand,
  findFileMentions,
  findUltrathink,
  mentionLabel
} from './composerDecorations'

/**
 * The composer's own syntax, kept in the message it was sent as.
 *
 * `composerDecorations` draws a slash command, `ultrathink`, an @-mention and an
 * attachment marker as chips while you type; the bubble they landed in showed
 * the raw characters instead, so the same message was typeset two different ways
 * either side of pressing Enter. This is the other half of that module: the
 * finders are shared and only the drawing differs — CodeMirror widgets in the
 * composer, React elements here.
 *
 * A remark plugin rather than a pass over the rendered DOM, because the tree is
 * where the context is: `code`, a fenced block and a link's label are all text
 * that means itself, and by the time it is HTML they are hard to tell apart.
 */

/** Only as much of mdast as this needs. */
type Node = {
  type: string
  value?: string
  children?: Node[]
  position?: { start?: { offset?: number } }
  data?: Record<string, unknown>
}

/**
 * Text that means itself.
 *
 * Code is quoted verbatim, and a link's label belongs to the link — a chip
 * inside an `<a>` would be a button inside a link.
 */
const OPAQUE = new Set([
  'code',
  'inlineCode',
  'html',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition'
])

/**
 * A chip, as a node `mdast-util-to-hast` hands straight to React.
 *
 * `hName` and `hProperties` are that library's escape hatch for node types it
 * has never heard of: it turns this into an element with the tag and props
 * given, which `MarkdownRenderer` then maps to a component.
 */
function chip(hName: string, hProperties: Record<string, string>, label: string): Node {
  return { type: 'nyraChip', data: { hName, hProperties }, children: [{ type: 'text', value: label }] }
}

type Found = { from: number; to: number; rank: number; node: Node }

/**
 * Everything worth drawing in one run of text, in order and without overlaps.
 *
 * Rank breaks the ties: `@ultrathink` is one mention, not a mention with a
 * rainbow buried in it, and the outermost match is the one that was meant.
 */
function chipsIn(value: string, atStart: boolean): Found[] {
  const found: Found[] = []

  // Only the first run of the message can hold a command — `# /clear` is a
  // heading, and the CLI reads it that way too.
  if (atStart) {
    const command = findCommand(value)
    if (command) {
      found.push({
        ...command,
        rank: 0,
        node: chip('nyra-command', {}, value.slice(command.from, command.to))
      })
    }
  }

  for (const ref of findAttachmentRefs(value)) {
    found.push({
      from: ref.from,
      to: ref.to,
      rank: 1,
      node: chip(
        'nyra-attach-chip',
        { kind: ref.kind.toLowerCase(), target: ref.target },
        mentionLabel(ref.target)
      )
    })
  }

  for (const mention of findFileMentions(value)) {
    found.push({
      from: mention.from,
      to: mention.to,
      rank: 2,
      node: chip('nyra-file-chip', { path: mention.path }, mentionLabel(mention.path))
    })
  }

  for (const span of findUltrathink(value)) {
    found.push({
      ...span,
      rank: 3,
      node: chip('nyra-ultrathink', {}, value.slice(span.from, span.to))
    })
  }

  found.sort((a, b) => a.from - b.from || a.rank - b.rank)

  const kept: Found[] = []
  let end = 0
  for (const one of found) {
    if (one.from < end) continue
    kept.push(one)
    end = one.to
  }
  return kept
}

/**
 * A line break you typed is a line break you meant.
 *
 * Markdown folds a lone newline into a space; the composer does not, because it
 * is a text editor and the lines stay where you put them. Without this a
 * three-line message came back as one paragraph the moment it was sent. Hard
 * breaks rather than `white-space: pre-wrap` on the bubble, so the rest of the
 * markdown — lists, quotes, tables — still gets to lay itself out.
 */
function lines(value: string): Node[] {
  const out: Node[] = []
  value.split('\n').forEach((part, i) => {
    if (i > 0) out.push({ type: 'break' })
    if (part) out.push({ type: 'text', value: part })
  })
  return out
}

/** The nodes this run of text becomes, or null if it is already what it should be. */
function replace(node: Node): Node[] | null {
  const value = node.value ?? ''
  const chips = chipsIn(value, node.position?.start?.offset === 0)
  if (chips.length === 0 && !value.includes('\n')) return null

  const out: Node[] = []
  let at = 0
  for (const one of chips) {
    if (one.from > at) out.push(...lines(value.slice(at, one.from)))
    out.push(one.node)
    at = one.to
  }
  if (at < value.length) out.push(...lines(value.slice(at)))
  return out
}

function walk(parent: Node): void {
  const children = parent.children
  if (!children) return

  const next: Node[] = []
  let changed = false

  for (const child of children) {
    if (child.type === 'text') {
      const replaced = replace(child)
      if (replaced) {
        next.push(...replaced)
        changed = true
        continue
      }
    } else if (!OPAQUE.has(child.type)) {
      walk(child)
    }
    next.push(child)
  }

  if (changed) parent.children = next
}

/**
 * Draw a sent prompt the way the composer drew it.
 *
 * Opt-in: `MarkdownRenderer` also renders Claude's replies, plan cards and the
 * memory preview, and none of those were typed into the composer.
 */
export function remarkPromptDecorations(): (tree: unknown) => void {
  return (tree) => walk(tree as Node)
}
