/**
 * What a turn changed, as the transcript records it.
 *
 * Third of the fenced conventions, after `nyra-ask` and `nyra-tasks`, and for the
 * same reason: nothing in the headless CLI reports a turn's file changes, so the
 * model has to say it. The block is lifted out of the reply and drawn as a card
 * that links into the Changes tab.
 *
 * The numbers are a *snapshot*, written once when the work finished — not a live
 * query. That is deliberate. A card that re-read git on every render would show
 * today's repo under a message from an hour ago, which is not what a transcript
 * is for. What makes the snapshot safe is `base:`: the card records the SHA it
 * was true at, so clicking a row opens that diff rather than whatever happens to
 * be uncommitted now. Codex ships the version without this — their card keeps
 * offering "Review" after a commit and the pane opens empty (openai/codex#31157).
 *
 * Tolerant like the others: a block that will not parse reads as a plain list
 * rather than vanishing.
 */

export type ChangedEntry = {
  path: string
  insertions: number
  deletions: number
}

export type ChangeBlock = {
  /** Short SHA the counts were taken at. Empty when the model omitted it — the
   *  card still draws, it just cannot promise the diff still matches. */
  base: string
  files: ChangedEntry[]
}

const CHANGES_FENCE =
  /^[ \t]*```[ \t]*nyra-changes[ \t]*\n([\s\S]*?)(?:^[ \t]*```[ \t]*$|$(?![\s\S]))/gm

/** `base: 50cb2a4`, however much whitespace. */
const BASE = /^[ \t]*base[ \t]*:[ \t]*([0-9a-f]{4,40})[ \t]*$/i
/** `path | +12 -3`, with either dash and either order, and the counts optional. */
const ROW = /^[ \t]*(.+?)[ \t]*\|[ \t]*(.*)$/
const ADDED = /\+(\d+)/
const REMOVED = /[-−](\d+)/

/**
 * One row per path.
 *
 * A model that restates a path is correcting itself, so the later row wins. Two
 * rows for one file would otherwise draw twice and both click to the same diff,
 * which reads as a rendering bug rather than as the model's slip.
 */
export function dedupe(files: ChangedEntry[]): ChangedEntry[] {
  const byPath = new Map<string, ChangedEntry>()
  for (const f of files) byPath.set(f.path, f)
  return [...byPath.values()]
}

export function parseChangeBlock(body: string): ChangeBlock {
  let base = ''
  const files: ChangedEntry[] = []

  for (const line of body.split('\n')) {
    if (!line.trim()) continue

    const baseMatch = line.match(BASE)
    if (baseMatch) {
      base = baseMatch[1]
      continue
    }

    const row = line.match(ROW)
    if (!row) continue
    const path = row[1].trim()
    // A `base:` line that failed the SHA check must not become a file row.
    if (!path || /^base$/i.test(path)) continue

    files.push({
      path,
      insertions: Number(row[2].match(ADDED)?.[1] ?? 0),
      deletions: Number(row[2].match(REMOVED)?.[1] ?? 0)
    })
  }

  return { base, files: dedupe(files) }
}

/**
 * Split a reply into what the user reads and the changes behind it.
 *
 * `changes` is null when the reply had no block — distinct from a block that
 * parsed to nothing, which is a malformed block and should not draw an empty
 * card.
 */
export function extractChangeBlocks(reply: string): { text: string; changes: ChangeBlock | null } {
  let changes: ChangeBlock | null = null

  const text = reply.replace(CHANGES_FENCE, (_match, body: string) => {
    const parsed = parseChangeBlock(body)
    if (parsed.files.length === 0) return ''
    // Several blocks in one reply are merged rather than fighting: the last
    // `base` wins, since it is the most recent thing the model looked at.
    changes = changes
      ? {
          base: parsed.base || changes.base,
          files: dedupe([...changes.files, ...parsed.files])
        }
      : parsed
    return ''
  })

  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), changes }
}

/** Most-changed first, so a read-more cut hides trivia rather than a tail that
 *  happens to sort late. Mirrors `byChurn` in the changes store. */
export function byChurn(files: ChangedEntry[]): ChangedEntry[] {
  return [...files].sort((a, b) => {
    const churn = b.insertions + b.deletions - (a.insertions + a.deletions)
    return churn !== 0 ? churn : a.path.localeCompare(b.path)
  })
}

export function changeTotals(files: ChangedEntry[]): { insertions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      insertions: acc.insertions + f.insertions,
      deletions: acc.deletions + f.deletions
    }),
    { insertions: 0, deletions: 0 }
  )
}
