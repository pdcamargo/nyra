import type { Address } from '../ids'
import type { LiteralPropsFor } from '../registry/types'
import type { DesignMeta } from '../schema'
import type { Theme } from '../theme/types'

export type Severity = 'error' | 'warning'

export type Issue = {
  severity: Severity
  code: string
  message: string
  /** Where in the document, when it is known. */
  at?: Address
  path?: (string | number)[]
}

export const err = (code: string, message: string, at?: Address, path?: (string | number)[]): Issue => ({
  severity: 'error',
  code,
  message,
  at,
  path
})

export const warn = (code: string, message: string, at?: Address, path?: (string | number)[]): Issue => ({
  severity: 'warning',
  code,
  message,
  at,
  path
})

/**
 * A node once components and tokens are resolved. `origin` is the authored node
 * a patch can actually mutate — the resolved tree is derived and read-only.
 */
type Common = { id: string; origin: Address }

export type ResolvedBox = Common & { type: 'box'; children: ResolvedNode[] } & LiteralPropsFor<'box'>
export type ResolvedText = Common & { type: 'text' } & LiteralPropsFor<'text'>
export type ResolvedIcon = Common & { type: 'icon' } & LiteralPropsFor<'icon'>
export type ResolvedImage = Common & { type: 'image' } & LiteralPropsFor<'image'>

export type ResolvedNode = ResolvedBox | ResolvedText | ResolvedIcon | ResolvedImage

export type ResolvedArtboard = {
  id: string
  name: string
  size: { width: number; height: number | 'auto' }
  position?: { x: number; y: number }
  background?: string
  /** The mode this artboard pinned itself to, when it did. */
  mode?: string
  /**
   * The theme this artboard was resolved in, when it differs from the
   * document's — an artboard pinned to `"dark"`. Emitting reads it for the
   * base font and colours; everything else was resolved already.
   */
  theme?: Theme
  root: ResolvedNode
}

export type ResolvedDocument = {
  name: string
  theme: string
  /** The file's `meta`, passed through for the system's pages. */
  meta?: DesignMeta
  artboards: ResolvedArtboard[]
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly issues: Issue[]
  ) {
    super(message)
  }
}

export const errorsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'error')
export const warningsOf = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'warning')
