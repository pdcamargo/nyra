import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { Style } from '../registry/define'
import { iconData } from '../registry/icons'
import { NODES, type RenderableKind } from '../registry/nodes'
import { PROPS } from '../registry/props'
import { propNamesFor } from '../registry/shapes'
import type { PropName } from '../registry/types'
import type { Theme } from '../theme/types'
import type { ResolvedArtboard, ResolvedNode } from './types'

/**
 * The only stage that knows React exists.
 *
 * Note what is absent: any branch on `node.type` in the style pass. Which
 * properties a node has comes from `propNamesFor`, and the emitter for each
 * comes from its record. A branch here would be invisible to the generated
 * vocabulary and to the validator, so the provenance test asserts that every
 * CSS key this produces is attributable to a record or to a declared `derive`.
 */
export type Provenance = Record<string, PropName | 'derive'>

export function styleWithProvenance(
  node: ResolvedNode,
  childStyles: readonly Style[],
  theme: Theme
): { style: Style; by: Provenance } {
  const style: Style = {}
  const by: Provenance = {}

  const def = NODES[node.type]
  if (def.derive) {
    for (const [k, v] of Object.entries(def.derive(childStyles))) {
      style[k] = v
      by[k] = 'derive'
    }
  }

  const bag = node as unknown as Record<string, unknown>
  for (const name of propNamesFor(node.type)) {
    const value = bag[name]
    if (value === undefined) continue
    // The registry is the authority on what this property means. The emitter
    // has no opinion about which property it is looking at.
    for (const [k, v] of Object.entries(PROPS[name].css(value as never, theme))) {
      style[k] = v
      by[k] = name
    }
  }

  return { style, by }
}

export const styleOf = (node: ResolvedNode, childStyles: readonly Style[], theme: Theme): Style =>
  styleWithProvenance(node, childStyles, theme).style

/**
 * Lucide ships structured node data, so the whole set is available without
 * importing 2108 React components — and the output is plain SVG, which matters
 * because this tree has to survive being serialised to static HTML later.
 */
function iconSvg(id: string, name: string, style: Style): ReactElement {
  const data = iconData(name)
  if (!data) {
    // A missing icon is a hole in the design, not a crash. It draws as a box so
    // the reviewer sees exactly where and what.
    return (
      <span
        key={id}
        data-node={id}
        style={{ ...(style as CSSProperties), display: 'inline-block', outline: '1px dashed currentColor' }}
        title={`unknown icon "${name}"`}
      />
    )
  }
  return (
    <svg
      key={id}
      data-node={id}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style as CSSProperties}
      aria-hidden="true"
    >
      {data.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}

/** One renderer per node kind. The only place node kind is dispatched on. */
const RENDERERS: Record<
  RenderableKind,
  (node: ResolvedNode, style: Style, children: ReactNode) => ReactElement
> = {
  box: (node, style, children) => (
    <div key={node.id} data-node={node.id} style={style as CSSProperties}>
      {children}
    </div>
  ),
  text: (node, style, children) => {
    const v = (node as { value?: unknown }).value
    return (
      <div key={node.id} data-node={node.id} style={{ whiteSpace: 'pre-wrap', ...(style as CSSProperties) }}>
        {children ?? String(v ?? '')}
      </div>
    )
  },
  icon: (node, style) => iconSvg(node.id, String((node as { name?: unknown }).name ?? ''), style),
  image: (node, style) => (
    <img
      key={node.id}
      data-node={node.id}
      src={String((node as { src?: unknown }).src ?? '')}
      alt=""
      style={style as CSSProperties}
    />
  )
}

/**
 * Styles computed bottom-up, once. `derive` needs its children's styles, so a
 * separate pass is the honest way to get them — recomputing inside the render
 * walk would do the same work twice and hide that dependency.
 */
export type StyledNode = {
  node: ResolvedNode
  style: Style
  children: StyledNode[]
  /** Inline runs, when a property on this node implies them. */
  spans?: { text: string; style: Style }[]
}

export function styleTree(node: ResolvedNode, theme: Theme): StyledNode {
  const children = node.type === 'box' ? node.children.map((c) => styleTree(c, theme)) : []
  const style = styleOf(
    node,
    children.map((c) => c.style),
    theme
  )

  // Asked of the registry, not of the node kind: a property that styles parts
  // of its own value says so, and the emitter finds it the same way for every
  // node it will ever render.
  const bag = node as unknown as Record<string, unknown>
  let spans: { text: string; style: Style }[] | undefined
  for (const name of propNamesFor(node.type)) {
    const def = PROPS[name]
    if (def.spans && bag[name] !== undefined) spans ??= def.spans(bag[name] as never, theme)
  }

  return { node, style, children, spans }
}

export function renderStyled(styled: StyledNode): ReactElement {
  const kids = styled.children.map((c) => renderStyled(c))
  return RENDERERS[styled.node.type](
    styled.node,
    styled.style,
    styled.spans
      ? styled.spans.map((s, i) => (
          <span key={i} style={s.style as CSSProperties}>
            {s.text}
          </span>
        ))
      : kids.length > 0
        ? kids
        : undefined
  )
}

export const renderNode = (node: ResolvedNode, theme: Theme): ReactElement =>
  renderStyled(styleTree(node, theme))

/**
 * The reset. Inside an artboard nothing inherits from the host page, which is
 * what makes the headless render and the in-app render agree — and what stops
 * a design depending on Nyra's own stylesheet.
 */
export const ARTBOARD_RESET = [
  '*{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit;background:none;}',
  'img{display:block;max-width:100%;}',
  'svg{display:block;flex-shrink:0;}'
].join('')

export function renderArtboard(artboard: ResolvedArtboard, theme: Theme): ReactElement {
  const base = theme.font.body
  const auto = artboard.size.height === 'auto'

  /**
   * The root fills its artboard unless it says otherwise.
   *
   * Without this, an artboard is 1280x840 and its root box is content-height,
   * so every full-height layout needs an explicit `height: "full"` — and
   * forgetting produces silent dead space that is invisible in the document and
   * only appears in the render. Defaults go under the node's own style, so an
   * explicit width or height still wins.
   */
  const tree = styleTree(artboard.root, theme)
  const filled: StyledNode = {
    ...tree,
    style: { width: '100%', ...(auto ? {} : { height: '100%' }), ...tree.style }
  }

  return (
    <div
      data-artboard={artboard.id}
      style={{
        width: artboard.size.width,
        height: auto ? 'auto' : artboard.size.height,
        overflow: auto ? 'visible' : 'hidden',
        position: 'relative',
        background: artboard.background ?? '#FFFFFF',
        fontFamily: base.family,
        fontSize: base.size,
        fontWeight: base.weight,
        lineHeight: base.lineHeight,
        color: '#111216'
      }}
    >
      <style>{ARTBOARD_RESET}</style>
      {renderStyled(filled)}
    </div>
  )
}
