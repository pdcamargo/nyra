import { z } from 'zod'
import { colorLit } from './registry/scalars'
import { boxProps, iconProps, imageProps, textProps, useProps } from './registry/shapes'
import type { PropsFor } from './registry/types'

export const SCHEMA_VERSION = 2

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
export type BoxNode = { type: 'box'; id: string; children?: Child[] } & PropsFor<'box'>
export type TextNode = { type: 'text'; id: string } & PropsFor<'text'>
export type IconNode = { type: 'icon'; id: string } & PropsFor<'icon'>
export type ImageNode = { type: 'image'; id: string } & PropsFor<'image'>
export type UseNode = {
  id: string
  use: string
  props?: Record<string, unknown>
  /**
   * Content for the component's slots, authored here in the caller. Kept out
   * of `props` because props hold values and these are nodes — and because
   * `props` is an unchecked record, so nodes inside it would skip validation.
   */
  slots?: Record<string, Child[]>
} & PropsFor<'use'>

export type DocNode = BoxNode | TextNode | IconNode | ImageNode | UseNode

/**
 * Where a component puts what its caller passed: `{ "slot": "body" }` among a
 * box's children. Not a node — it has no id and draws nothing; component
 * resolution replaces it with the caller's nodes, so the emitter never sees one.
 */
export type SlotRef = { slot: string }

/** What a box's `children` (and a slot's content) may hold. */
export type Child = DocNode | SlotRef

type NodeSchema = z.ZodType<DocNode, DocNode>

/**
 * Every node is strict. In a hand-authored format a dropped key is worse than
 * an error: `"paddign": 16` would otherwise parse clean and render nothing.
 *
 * `children` is a getter rather than `z.lazy` so the object keeps a readable
 * raw shape — `z.discriminatedUnion` inspects member shapes at construction
 * time via property descriptors, without invoking getters, so this is TDZ-safe.
 */
const slotNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'slot names are alphanumeric')

export const slotRefSchema = z.strictObject({ slot: slotNameSchema })

type ChildSchema = z.ZodType<Child, Child>

export const boxNode = z.strictObject({
  type: z.literal('box'),
  id: idSchema,
  ...boxProps.shape,
  get children(): z.ZodOptional<z.ZodArray<ChildSchema>> {
    return z.array(childSchema).optional()
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
  get slots(): z.ZodOptional<z.ZodRecord<typeof slotNameSchema, z.ZodArray<ChildSchema>>> {
    return z.record(slotNameSchema, z.array(childSchema)).optional()
  },
  ...useProps.shape
})

export const typedNode = z.discriminatedUnion('type', [boxNode, textNode, iconNode, imageNode])

export const nodeSchema: NodeSchema = z.union([typedNode, useNode], {
  error: () =>
    'expected a node: { type: "box" | "text" | "icon" | "image", … } or { use: "<Component>", … }'
}) as unknown as NodeSchema

/**
 * A box's child, or a slot's content: a node, or a slot reference. Its own
 * union rather than a member of `nodeSchema`, because a slot reference is only
 * meaningful in these two places — an artboard root that is a slot is nothing.
 */
export const childSchema: ChildSchema = z.union([nodeSchema, slotRefSchema], {
  error: () => 'expected a node, or { "slot": "<name>" } inside a component'
}) as unknown as ChildSchema

export const isUseNode = (n: DocNode): n is UseNode => 'use' in n
export const isSlotRef = (c: Child): c is SlotRef => 'slot' in c && !('id' in c)

/**
 * The authored nodes directly under `n`: a box's children, and an instance's
 * slot content (authored in the caller, so it belongs to the caller's tree).
 * Slot references are left out — they are not nodes. Use `containersOf` when
 * the position inside the real array matters.
 */
export const childrenOf = (n: DocNode): DocNode[] =>
  containersOf(n).flatMap(({ items }) => items.filter((c): c is DocNode => !isSlotRef(c)))

/** Every array under `n` that holds children, with the slot it belongs to. */
export function containersOf(n: DocNode): { slot: string | null; items: Child[] }[] {
  if (isUseNode(n)) return Object.entries(n.slots ?? {}).map(([slot, items]) => ({ slot, items }))
  return n.type === 'box' ? [{ slot: null, items: n.children ?? [] }] : []
}

/**
 * A component's declared props. A `slot` holds nodes rather than a value, has
 * no default (an unfilled slot is simply empty) and is filled through the
 * instance's `slots`, never its `props`.
 *
 * Any prop may carry a one-line `description`, shown beside it in the props
 * table of the component's page in a design system. It draws nothing.
 */
const propDescription = { description: z.string().optional() }

export const componentPropSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), default: z.string().optional(), ...propDescription }),
  z.strictObject({ type: z.literal('number'), default: z.number().optional(), ...propDescription }),
  z.strictObject({ type: z.literal('boolean'), default: z.boolean().optional(), ...propDescription }),
  z.strictObject({
    type: z.literal('enum'),
    of: z.array(z.string()).min(1),
    default: z.string().optional(),
    ...propDescription
  }),
  z.strictObject({ type: z.literal('slot'), ...propDescription })
])
export type ComponentProp = z.infer<typeof componentPropSchema>

export const componentSchema = z.strictObject({
  /** One or two sentences: what it is for. Shown on its page in the system. */
  description: z.string().optional(),
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
  /**
   * Draw this artboard in one of the theme's modes — `"dark"` — whatever the
   * viewer is set to. For a screen that is always dark; most artboards leave
   * it off and follow the toggle.
   */
  mode: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, 'mode names are alphanumeric').optional(),
  root: nodeSchema
})
export type Artboard = z.infer<typeof artboardSchema>

/**
 * What a file says about itself, for the system's pages and nav. All of it is
 * optional and none of it draws anything.
 */
export const metaSchema = z.strictObject({
  /** The nav group: "Inputs", "Navigation". */
  group: z.string().optional(),
  /** Position within the group; lower first, then by name. */
  order: z.number().optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'ready']).optional(),
  usage: z
    .strictObject({ do: z.array(z.string()).optional(), dont: z.array(z.string()).optional() })
    .optional()
})
export type DesignMeta = z.infer<typeof metaSchema>

/**
 * `schema: 1` in every file. The loader migrates or refuses; it never renders
 * a file it does not understand.
 */
export const documentSchema = z.strictObject({
  schema: z.number().int().min(1),
  name: z.string().min(1),
  /**
   * The built-in theme a standalone draft draws with. Inside a design system
   * the system's tokens decide, and this is ignored (with a warning).
   */
  theme: z.string().default('default'),
  meta: metaSchema.optional(),
  components: z.record(componentNameSchema, componentSchema).optional(),
  artboards: z.array(artboardSchema).min(1)
})

export type DesignDocument = z.infer<typeof documentSchema>
