import { defineNode, type NodeKind, type NodeDef, type Style } from './define'

/**
 * Node types carry only what is genuinely per-node. Which properties each one
 * accepts is NOT listed here — it comes from `appliesTo` on the property
 * records, so the relation has one source and cannot disagree with itself.
 */
export const NODES = {
  box: defineNode('box', {
    children: 'many',
    doc: 'The only container. Everything that holds other things is a box.',
    /**
     * The one thing a flat property registry cannot express: a style on the
     * parent caused by a child's property. A box with an absolutely positioned
     * child becomes a positioning context. Declared here so it stays part of
     * the registry — an `if` in the emitter would be invisible to the skill,
     * the validator and the provenance test.
     *
     * Applied before the node's own properties, so an explicit `position` wins.
     */
    derive: (childStyles: readonly Style[]): Style =>
      childStyles.some((s) => s.position === 'absolute') ? { position: 'relative' } : {}
  }),
  text: defineNode('text', { children: 'none', doc: 'A run of text.' }),
  icon: defineNode('icon', { children: 'none', doc: 'A lucide icon, drawn as an inline SVG.' }),
  image: defineNode('image', { children: 'none', doc: 'A raster image.' }),
  use: defineNode('use', { children: 'none', doc: 'An instance of a component — a call, not a copy.' })
} as const satisfies Record<NodeKind, NodeDef>

export const RENDERABLE_KINDS = ['box', 'text', 'icon', 'image'] as const
export type RenderableKind = (typeof RENDERABLE_KINDS)[number]
