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
import { artboardHtml, compile, rasterRequest, type Issue } from '@nyra/design'

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
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
      const at = i.at ? ` @ ${i.at.scope}#${i.at.id}` : i.path ? ` @ ${i.path.join('.')}` : ''
      return `${i.severity}: ${i.code}: ${i.message}${at}`
    })
    .join('\n')
}

export async function renderDesign(
  path: string,
  only?: string,
  scale = 2
): Promise<RenderResult> {
  // `readTextFile` is bounded and reports why it could not read, which is
  // worth passing through verbatim — "missing" and "too large" are different
  // problems and the model can act on either.
  const read = await window.api.fs.readTextFile(path)
  if (read.kind !== 'text') {
    throw new Error(
      read.kind === 'error' ? `could not read ${path}: ${read.message}` : `could not read ${path}: ${read.kind}`
    )
  }
  if (read.truncated) {
    throw new Error(`${path} was truncated at ${read.returnedBytes} of ${read.totalBytes} bytes`)
  }
  const text = read.content

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${message(e)}`)
  }

  // A document that does not compile throws with its issues attached, because
  // the errors are the useful half of the answer.
  let compiled
  try {
    compiled = compile(parsed)
  } catch (e) {
    const issues = (e as { issues?: Issue[] }).issues ?? []
    const detail = issues.length > 0 ? `\n${describeIssues(issues)}` : ''
    throw new Error(`${path} did not compile${detail}`)
  }

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

  return { design: { path, name: doc.name }, artboards, issues }
}
