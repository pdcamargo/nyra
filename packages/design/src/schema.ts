import { z } from 'zod'
import { colorLit } from './registry/scalars'
import { boxProps, iconProps, imageProps, textProps, useProps } from './registry/shapes'
import type { PropsFor } from './registry/types'

export const SCHEMA_VERSION = 1

/**
 * `/` is reserved: a resolved node id is `artboard#instancePath/innerId`, and
 * an authored id containing `/` would make that address ambiguous.
 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'ids are alphanumeric with - and _, and may not contain /')

const componentNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'component names are PascalCase')

/**
 * Node types are written out rather than inferred from the schemas, because the
 * recursion through `children` is otherwise circular. They are not a second
 * source of truth: the property half comes from `PropsFor<K>`, and the type
 * tests assert `z.infer<typeof boxProps>` equals `PropsFor<'box'>`, so a drift
 * between these and the schemas is a build error.
 */
export type BoxNode = { type: 'box'; id: string; children?: DocNode[] } & PropsFor<'box'>
export type TextNode = { type: 'text'; id: string } & PropsFor<'text'>
export type IconNode = { type: 'icon'; id: string } & PropsFor<'icon'>
export type ImageNode = { type: 'image'; id: string } & PropsFor<'image'>
export type UseNode = {
  id: string
  use: string
  props?: Record<string, unknown>
} & PropsFor<'use'>

export type DocNode = BoxNode | TextNode | IconNode | ImageNode | UseNode

type NodeSchema = z.ZodType<DocNode, DocNode>

/**
 * Every node is strict. In a hand-authored format a dropped key is worse than
 * an error: `"paddign": 16` would otherwise parse clean and render nothing.
 *
 * `children` is a getter rather than `z.lazy` so the object keeps a readable
 * raw shape — `z.discriminatedUnion` inspects member shapes at construction
 * time via property descriptors, without invoking getters, so this is TDZ-safe.
 */
export const boxNode = z.strictObject({
  type: z.literal('box'),
  id: idSchema,
  ...boxProps.shape,
  get children(): z.ZodOptional<z.ZodArray<NodeSchema>> {
    return z.array(nodeSchema).optional()
  }
})

export const textNode = z.strictObject({
  type: z.literal('text'),
  id: idSchema,
  ...textProps.shape
})

export const iconNode = z.strictObject({
  type: z.literal('icon'),
  id: idSchema,
  ...iconProps.shape
})

export const imageNode = z.strictObject({
  type: z.literal('image'),
  id: idSchema,
  ...imageProps.shape
})

/**
 * A component instance. It carries no `type`, per the format in the spec's
 * worked example — and `z.discriminatedUnion` checks for the discriminator key
 * at *construction* and throws when a member lacks it. So the four real node
 * types keep their `No matching discriminator` diagnostic inside a discriminated
 * union, and `use` sits beside them in an outer one.
 */
export const useNode = z.strictObject({
  id: idSchema,
  use: componentNameSchema,
  props: z.record(z.string(), z.unknown()).optional(),
  ...useProps.shape
})

export const typedNode = z.discriminatedUnion('type', [boxNode, textNode, iconNode, imageNode])

export const nodeSchema: NodeSchema = z.union([typedNode, useNode], {
  error: () =>
    'expected a node: { type: "box" | "text" | "icon" | "image", … } or { use: "<Component>", … }'
}) as unknown as NodeSchema

export const isUseNode = (n: DocNode): n is UseNode => 'use' in n
export const childrenOf = (n: DocNode): DocNode[] =>
  !isUseNode(n) && n.type === 'box' ? (n.children ?? []) : []

/** A component's declared props. A `slot` member lands here when slots do. */
export const componentPropSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), default: z.string().optional() }),
  z.strictObject({ type: z.literal('number'), default: z.number().optional() }),
  z.strictObject({ type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal('enum'),
    of: z.array(z.string()).min(1),
    default: z.string().optional()
  })
])
export type ComponentProp = z.infer<typeof componentPropSchema>

export const componentSchema = z.strictObject({
  props: z.record(z.string(), componentPropSchema).optional(),
  root: nodeSchema
})
export type ComponentDef = z.infer<typeof componentSchema>

export const artboardSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1),
  size: z.strictObject({
    width: z.number().int().min(64).max(4096),
    /**
     * `auto` grows to fit. A fixed height means guessing a number and
     * re-guessing it after every edit, which is most of the fiddling in a
     * document that is mostly lists of content.
     */
    height: z.union([z.number().int().min(64).max(8192), z.literal('auto')])
  }),
  background: colorLit.optional(),
  /**
   * Where this artboard sits on the infinite canvas.
   *
   * There is no canvas yet, and this is here anyway — it is the one thing about
   * the canvas that is cheap now and expensive later. Positions have to live in
   * the document, because the alternative is a sidecar file keyed by artboard
   * id, which is a second source of truth that drifts the first time someone
   * renames or deletes an artboard outside the app.
   *
   * Absent means "not placed yet"; a canvas lays those out in a flow and writes
   * the result back as a patch, so nothing has to guess twice.
   */
  position: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  root: nodeSchema
})
export type Artboard = z.infer<typeof artboardSchema>

/**
 * `schema: 1` in every file. The loader migrates or refuses; it never renders
 * a file it does not understand.
 */
export const documentSchema = z.strictObject({
  schema: z.number().int().min(1),
  name: z.string().min(1),
  theme: z.string().default('default'),
  components: z.record(componentNameSchema, componentSchema).optional(),
  artboards: z.array(artboardSchema).min(1)
})

export type DesignDocument = z.infer<typeof documentSchema>
