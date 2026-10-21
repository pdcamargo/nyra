/**
 * The claude.ai artifacts a conversation published.
 *
 * Like pull requests, nothing in the stream announces one, so it is recovered
 * from the call that made it: the CLI's `Artifact` tool on a publish, and the
 * Claude Docs MCP server, whose docs are artifacts too. The link is read out of
 * the *result* — a first publish only names a local file, and the URL it became
 * exists nowhere else.
 *
 * Only publishes count. `Artifact` also reads and lists, and both answer with
 * artifact links; a chat that read someone's page did not make it, and listing
 * your gallery would otherwise fill the card with every artifact you own.
 */
import type { Message } from '../store/sessions'

export type ChatArtifact = {
  /** The link as the tool reported it, and the dedupe key. */
  url: string
  title: string
  description?: string
}

const ARTIFACT_TOOL = 'Artifact'
const DOCS_TOOL = /^mcp__claude_ai_Claude_Docs__(batch|update|create)$/

/**
 * `claude.ai/code/artifact/<uuid>` or `claude.ai/artifact/<id>`, preview host
 * included. A republish can print both forms of the same artifact
 * (`… [same artifact: …]`), which is why a result contributes its first link
 * only.
 */
const ARTIFACT_URL = /https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** `docs/q3-report.html` → `q3-report`. */
function fileTitle(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.[^.]+$/, '') || base
}

type Found = { url: string; title?: string; description?: string; kind?: 'doc' }

function artifactOf(m: Message): Found | null {
  if (m.role !== 'tool_call' || m.isError || !m.result) return null
  const { input } = m
  if (m.tool_name === ARTIFACT_TOOL) {
    // `publish` is the default action, so an absent one is a publish.
    if ((str(input.action) ?? 'publish') !== 'publish') return null
    // A republish names its artifact in `url`; preferring it keeps one entry
    // even when the result prints the artifact's other link form.
    const url = (str(input.url)?.match(ARTIFACT_URL) ?? m.result.match(ARTIFACT_URL))?.[0]
    if (!url) return null
    const file = str(input.file_path)
    return { url, title: str(input.label) ?? (file ? fileTitle(file) : undefined), description: str(input.description) }
  }
  if (DOCS_TOOL.test(m.tool_name)) {
    const url = m.result.match(ARTIFACT_URL)?.[0]
    if (!url) return null
    const container = input.container as { create?: { name?: unknown } } | undefined
    return { url, title: str(container?.create?.name), kind: 'doc' }
  }
  return null
}

/**
 * Newest first, one entry per artifact. A republish moves the artifact to its
 * latest publish's place and takes whatever it says about it — but only what it
 * says: a doc edit carries no name, and must not unname the doc it edited.
 */
export function chatArtifacts(messages: readonly Message[]): ChatArtifact[] {
  const byUrl = new Map<string, ChatArtifact>()
  for (const m of messages) {
    const found = artifactOf(m)
    if (!found) continue
    const prev = byUrl.get(found.url)
    byUrl.delete(found.url)
    byUrl.set(found.url, {
      url: found.url,
      title: found.title ?? prev?.title ?? (found.kind === 'doc' ? 'Doc' : 'Artifact'),
      description: found.description ?? prev?.description
    })
  }
  return [...byUrl.values()].reverse()
}
