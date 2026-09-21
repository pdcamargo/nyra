import type { Style } from './define'
import { PROPS } from './props'
import type { ResolvedRun } from '../text'
import type { Theme } from '../theme/types'

/**
 * A run's style, built from the same property records as everything else.
 *
 * `font` and `color` go through `PROPS.font.css` and `PROPS.color.css` rather
 * than a second implementation, so a change to either emitter reaches runs too
 * and the provenance story holds inside a paragraph as well as outside one.
 */
export function runStyle(run: ResolvedRun, theme: Theme): Style {
  return {
    ...(run.font !== undefined ? PROPS.font.css(run.font as never, theme) : {}),
    ...(run.color !== undefined ? PROPS.color.css(run.color as never, theme) : {}),
    ...(run.weight !== undefined ? { fontWeight: run.weight } : {}),
    ...(run.transform !== undefined
      ? PROPS.textTransform.css(run.transform as never, theme)
      : {})
  }
}
