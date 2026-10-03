/**
 * Rendering a design, from the renderer.
 *
 * The pipeline lives here rather than in the sidecar for one reason: the
 * sidecar would need React and a copy of the vocabulary, and a second copy is a
 * second thing to drift. So the renderer compiles the document and emits the
 * HTML, and the sidecar is handed a finished string plus a content hash.
 *
 * The same pipeline serves the live panel, which renders React directly and
 * never rasterises at all.
 */
import { rasterRequest, type Issue } from '@nyra/design'
import { loadDesign } from './designLoad'

export type RenderedArtboard = {
  id: string
  name: string
  width: number
  height: number
  png: string
  cached: boolean
}

export type RenderResult = {
  design: { path: string; name: string }
  artboards: RenderedArtboard[]
  /** Lints and errors, verbatim — this text is what the model reads to fix
   *  its own document, so it is never summarised away. */
  issues: Issue[]
  /** Set when the file is an older format and was rendered from its upgraded
   *  copy. The file on disk is unchanged until something upgrades it. */
  format: { from: number; to: number; notes: string[] } | null
}

/**
 * Why a render failed, in terms someone can act on.
 *
 * The first render on a machine launches a headless Chromium, and a user with
 * no Chrome who declined the download gets the sidecar's probe error — which
 * reads like a crash and says nothing about what to do. Everything else passes
 * through untouched; inventing friendlier text for an error nobody predicted
 * only hides it.
 */
export function renderFailure(artboardId: string, error: string | undefined): string {
  const raw = error ?? 'the browser did not answer'
  const missingBrowser = /chromium|chrome|browser is not installed|executable doesn't exist|install/i.test(raw)
  if (missingBrowser) {
    return (
      `Rendering "${artboardId}" needs a browser, and this machine has none Nyra can use.\n\n` +
      `Open the Browser panel once and let it install Chromium — the design renderer uses the same one. ` +
      `The design itself is fine and is saved; only the picture is missing.\n\n(${raw})`
    )
  }
  return `Could not render "${artboardId}": ${raw}`
}

/** Everything the validator objected to, flattened for a tool result. */
export function describeIssues(issues: Issue[]): string {
  return issues
    .map((i) => {
      // The file first: inside a design system the same scope name can only
      // be found by knowing which file to open.
      const where = i.at ? `${i.at.file ? `${i.at.file} · ` : ''}${i.at.scope}#${i.at.id}` : i.path?.join('.')
      const at = where ? ` @ ${where}` : ''
      return `${i.severity}: ${i.code}: ${i.message}${at}`
    })
    .join('\n')
}

export async function renderDesign(
  path: string,
  only?: string,
  scale = 2
): Promise<RenderResult> {
  // The whole file, streamed, compiled off the main thread. The reasons it
  // could not be drawn are passed through verbatim — "missing", "newer" and
  // "did not compile" are different problems and the model can act on each.
  const loaded = await loadDesign(path)
  switch (loaded.kind) {
    case 'missing':
      throw new Error(`could not read ${path}: missing`)
    case 'cancelled':
      throw new Error(`reading ${path} was cancelled`)
    case 'error':
    case 'newer':
      throw new Error(loaded.message)
    case 'invalid': {
      const detail = loaded.issues.length > 0 ? `\n${describeIssues(loaded.issues)}` : ''
      throw new Error(loaded.issues.length > 0 ? `${path} did not compile${detail}` : loaded.message)
    }
  }
  const compiled = loaded
  const { doc, theme, issues } = compiled
  const targets = only ? doc.artboards.filter((a) => a.id === only) : doc.artboards
  if (targets.length === 0) {
    throw new Error(
      `no artboard "${only}" — this design has: ${doc.artboards.map((a) => a.id).join(', ')}`
    )
  }

  const artboards: RenderedArtboard[] = []
  for (const artboard of targets) {
    const request = rasterRequest(artboard, theme, scale)
    const raster = await window.api.design.raster(request as unknown as Record<string, unknown>)
    if (!raster?.ok || !raster.path) {
      throw new Error(renderFailure(artboard.id, raster?.error))
    }
    artboards.push({
      id: artboard.id,
      name: artboard.name,
      width: raster.width ?? artboard.size.width,
      height: raster.height ?? 0,
      png: raster.path,
      cached: Boolean(raster.cached)
    })
  }

  const format = compiled.upgrade
    ? { from: compiled.upgrade.from, to: compiled.upgrade.to, notes: compiled.upgrade.notes }
    : null
  return { design: { path, name: doc.name }, artboards, issues, format }
}
