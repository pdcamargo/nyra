import type { Address } from '../ids'
import type { LiteralPropsFor } from '../registry/types'

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
  root: ResolvedNode
}

export type ResolvedDocument = {
  name: string
  theme: string
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
