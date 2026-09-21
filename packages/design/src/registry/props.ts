import { z } from 'zod'
import { defineProp, type Style } from './define'
import { hasIcon, suggestIcon } from './icons'
import {
  aspectLit,
  borderLit,
  colorLit,
  gapLit,
  gradientLit,
  srcLit,
  fontLit,
  insetLit,
  lengthCss,
  lengthLit,
  radiusLit,
  resolved,
  shadowLit,
  spaceLit,
  spacingCss,
  asNumber,
  spaceCss,
  spacingLit
} from './scalars'
import { isRun, type ResolvedRun, type TextRun } from '../text'
import { runStyle } from './runs'
import type { BorderToken, FontBundle } from '../theme/types'

const ALIGN = ['start', 'center', 'end', 'stretch', 'baseline'] as const
const JUSTIFY = ['start', 'center', 'end', 'between', 'around'] as const

const flexAlign: Record<(typeof ALIGN)[number], string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline'
}
const flexJustify: Record<(typeof JUSTIFY)[number], string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around'
}

/**
 * The property registry. One record per property; the key is the name.
 *
 * Never annotate this binding. `const PROPS: Record<string, PropDef>` collapses
 * every `z.infer` to `unknown` — Zod 4 defaults ZodType's Output to `unknown`,
 * not `any` — and `Value<unknown>` then accepts any JSON at all with no
 * diagnostic. `as const satisfies` in that order keeps the literal types and
 * still checks the shape.
 */
export const PROPS = {
  // ---------------------------------------------------------------- layout
  layout: defineProp({
    schema: z.enum(['stack', 'grid', 'none']),
    css: (v) => ({ display: v === 'stack' ? 'flex' : v === 'grid' ? 'grid' : 'block' }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'How this box arranges its children. `stack` is flex, `grid` is a simple column grid, `none` is normal flow.',
    examples: ['stack', 'grid', 'none'],
    invalid: ['flex', 'absolute', 1]
  }),
  direction: defineProp({
    schema: z.enum(['row', 'column']),
    css: (v) => ({ flexDirection: v }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'Stack axis. Only meaningful with `layout: "stack"`.',
    examples: ['row', 'column'],
    invalid: ['horizontal', 'row-reverse']
  }),
  gap: defineProp({
    schema: gapLit,
    css: (v): Style => {
      const g = resolved(v, 'gap')
      return Array.isArray(g)
        ? { rowGap: spaceCss(g[0] as number | string, 'gap'), columnGap: spaceCss(g[1] as number | string, 'gap') }
        : { gap: spaceCss(g as number | string, 'gap') }
    },
    appliesTo: ['box'],
    category: 'layout',
    tokens: ['space'],
    doc: 'Space between children. One value for both axes, or [row, column] — a wrapping grid usually wants them different. A percentage resolves against the container in that axis.',
    examples: ['$space.2', '$space.6', 0, ['$space.6', '$space.4'], '4%'],
    invalid: [-1, '8px', '$radius.md', ['$space.1', '$space.1', '$space.1']]
  }),
  align: defineProp({
    schema: z.enum(ALIGN),
    css: (v) => ({ alignItems: flexAlign[v] }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'Cross-axis alignment of children.',
    examples: ['center', 'start', 'stretch'],
    invalid: ['middle', 'space-between']
  }),
  alignSelf: defineProp({
    schema: z.enum([...ALIGN, 'auto']),
    css: (v) => ({ alignSelf: v === 'auto' ? 'auto' : flexAlign[v] }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'layout',
    outer: true,
    doc: 'Overrides the parent stack\'s `align` for this one child. Without it, one child differing means a wrapper box that exists for nothing.',
    examples: ['center', 'end', 'stretch'],
    invalid: ['middle', 'space-between']
  }),
  justify: defineProp({
    schema: z.enum(JUSTIFY),
    css: (v) => ({ justifyContent: flexJustify[v] }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'Main-axis distribution of children.',
    examples: ['between', 'center', 'end'],
    invalid: ['space-between', 'stretch']
  }),
  wrap: defineProp({
    schema: z.boolean(),
    css: (v) => ({ flexWrap: v ? 'wrap' : 'nowrap' }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'Allow children to wrap onto more lines.',
    examples: [true, false],
    invalid: ['wrap', 1]
  }),
  columns: defineProp({
    schema: z.number().int().min(1).max(12),
    css: (v) => ({ gridTemplateColumns: `repeat(${v}, minmax(0, 1fr))` }),
    appliesTo: ['box'],
    category: 'layout',
    doc: 'Equal columns, with `layout: "grid"`.',
    examples: [2, 3, 12],
    invalid: [0, 13, 2.5]
  }),
  padding: defineProp({
    schema: spacingLit,
    css: (v) => ({ padding: spacingCss(resolved(v, 'padding') as number | string | (number | string)[]) }),
    appliesTo: ['box', 'text', 'icon', 'image'],
    category: 'layout',
    tokens: ['space'],
    doc: 'Inner space. One value, or [block, inline], or [top, right, bottom, left]. A percentage is allowed but CSS resolves it against the container width on every side, including top and bottom.',
    examples: ['$space.4', ['$space.2', '$space.4'], 0, '5%'],
    invalid: ['16px', ['$space.2', '$space.2', '$space.2']]
  }),

  // ------------------------------------------------------------------ size
  width: defineProp({
    schema: lengthLit,
    css: (v) => ({ width: lengthCss(resolved(v, 'width') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Width in px, a percentage like "60%", or "full" (100%) or "fit" (fit-content).',
    examples: [240, 'full', 'fit', '60%'],
    invalid: [-4, 'auto', '120%']
  }),
  height: defineProp({
    schema: lengthLit,
    css: (v) => ({ height: lengthCss(resolved(v, 'height') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Height in px, a percentage, or "full" or "fit". The percentage form is how anything proportional gets expressed.',
    examples: [48, 'full', '75%'],
    invalid: ['auto', '100vh']
  }),
  minWidth: defineProp({
    schema: lengthLit,
    css: (v) => ({ minWidth: lengthCss(resolved(v, 'minWidth') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Lower bound on width.',
    examples: [0, 120, '25%'],
    invalid: ['none', 'auto']
  }),
  maxWidth: defineProp({
    schema: lengthLit,
    css: (v) => ({ maxWidth: lengthCss(resolved(v, 'maxWidth') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Upper bound on width. The usual way to hold a text column readable.',
    examples: [560, 'full', '80%'],
    invalid: ['65ch', 'auto']
  }),
  minHeight: defineProp({
    schema: lengthLit,
    css: (v) => ({ minHeight: lengthCss(resolved(v, 'minHeight') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Lower bound on height. The usual way to hold a row or an empty panel from collapsing.',
    examples: [0, 120, '50%'],
    invalid: ['none', 'auto']
  }),
  maxHeight: defineProp({
    schema: lengthLit,
    css: (v) => ({ maxHeight: lengthCss(resolved(v, 'maxHeight') as number | string) }),
    appliesTo: ['box', 'text', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Upper bound on height. Pair it with overflow to cap a scrolling region.',
    examples: [320, 'full', '75%'],
    invalid: ['none', 'auto']
  }),
  grow: defineProp({
    schema: z.number().min(0).max(100),
    css: (v) => ({ flexGrow: v }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Share of leftover space this takes along the stack axis.',
    examples: [0, 1, 2],
    invalid: [-1, 'auto']
  }),
  shrink: defineProp({
    schema: z.number().min(0).max(100),
    css: (v) => ({ flexShrink: v }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Whether this may shrink below its content size. 0 pins it.',
    examples: [0, 1],
    invalid: [-1]
  }),
  aspectRatio: defineProp({
    schema: aspectLit,
    css: (v) => {
      const a = resolved(v, 'aspectRatio')
      return { aspectRatio: Array.isArray(a) ? `${a[0]} / ${a[1]}` : String(a) }
    },
    appliesTo: ['box', 'image'],
    category: 'size',
    doc: 'Locks the height to the width. A number, or [w, h] which reads better — [16, 9].',
    examples: [[16, 9], [1, 1], 1.5],
    invalid: [0, [16, 0], '16/9']
  }),
  span: defineProp({
    schema: z.number().int().min(1).max(12),
    css: (v) => ({ gridColumn: `span ${v}` }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'size',
    outer: true,
    doc: 'Columns this child covers inside a grid box.',
    examples: [1, 2, 6],
    invalid: [0, 13]
  }),

  // -------------------------------------------------------------- position
  position: defineProp({
    schema: z.enum(['relative', 'absolute']),
    css: (v) => ({ position: v }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'position',
    outer: true,
    doc: 'Absolute pins to the nearest box ancestor, which becomes a positioning context automatically.',
    examples: ['absolute', 'relative'],
    invalid: ['fixed', 'sticky']
  }),
  inset: defineProp({
    schema: insetLit,
    css: (v) => {
      const o = resolved(v, 'inset') as Record<string, number | string | undefined>
      const out: Record<string, string> = {}
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const x = o[side]
        if (x !== undefined) out[side] = spaceCss(x, 'inset')
      }
      return out
    },
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'position',
    tokens: ['space'],
    outer: true,
    doc: 'Offsets from the positioning context, for absolutely positioned nodes. A percentage resolves against that context.',
    examples: [{ top: 0, right: 0 }, { bottom: '$space.2', left: '$space.2' }, { top: '50%' }],
    invalid: [{ top: 0, middle: 4 }, 0]
  }),
  zIndex: defineProp({
    schema: z.number().int().min(-50).max(50),
    css: (v) => ({ zIndex: v }),
    appliesTo: ['box', 'text', 'icon', 'image', 'use'],
    category: 'position',
    outer: true,
    doc: 'Stacking order among overlapping siblings.',
    examples: [1, -1, 10],
    invalid: [1.5, 500]
  }),

  // --------------------------------------------------------------- surface
  background: defineProp({
    schema: colorLit,
    css: (v) => ({ backgroundColor: resolved(v, 'background') as string }),
    appliesTo: ['box', 'text', 'image'],
    category: 'surface',
    tokens: ['color'],
    doc: 'Fill colour.',
    examples: ['$color.surface', '$color.accent', 'transparent'],
    invalid: ['rebeccapurple', '$space.2', 123]
  }),
  color: defineProp({
    schema: colorLit,
    css: (v) => ({ color: resolved(v, 'color') as string }),
    appliesTo: ['text', 'icon'],
    category: 'surface',
    tokens: ['color'],
    doc: 'Foreground colour of glyphs or strokes.',
    examples: ['$color.text', '$color.onAccent'],
    invalid: ['$color', 'blue']
  }),
  border: defineProp({
    schema: borderLit,
    css: (v) => {
      const b = resolved(v, 'border') as BorderToken
      return { border: `${b.width}px ${b.style} ${b.color}` }
    },
    appliesTo: ['box', 'text', 'image'],
    category: 'surface',
    tokens: ['border', 'color'],
    doc: 'A border token, or an inline { width, color, style }.',
    examples: ['$border.hairline', { width: 2, color: '$color.accent', style: 'solid' }],
    invalid: ['1px solid red', { width: 1, color: '$color.accent' }]
  }),
  radius: defineProp({
    schema: radiusLit,
    css: (v) => ({ borderRadius: `${asNumber(v, 'radius')}px` }),
    appliesTo: ['box', 'image'],
    category: 'surface',
    tokens: ['radius'],
    doc: 'Corner rounding.',
    examples: ['$radius.md', '$radius.full', 0],
    invalid: ['8px', -2]
  }),
  shadow: defineProp({
    schema: shadowLit,
    css: (v) => ({ boxShadow: resolved(v, 'shadow') as string }),
    appliesTo: ['box', 'image'],
    category: 'surface',
    tokens: ['shadow'],
    doc: 'Elevation. Lifts a surface off the one behind it.',
    examples: ['$shadow.sm', '$shadow.lg', 'none'],
    invalid: ['0 1px 2px black', '$shadow']
  }),
  gradient: defineProp({
    schema: gradientLit,
    css: (v) => {
      const g = resolved(v, 'gradient') as { from: string; to: string; angle?: number }
      return { backgroundImage: `linear-gradient(${g.angle ?? 180}deg, ${g.from}, ${g.to})` }
    },
    appliesTo: ['box'],
    category: 'surface',
    tokens: ['color'],
    doc: 'A two-stop linear gradient over the background. Every marketing page has one and there is no approximating it.',
    examples: [
      { from: '$color.violet.600', to: '$color.violet.800' },
      { from: '$color.surface', to: '$color.bg', angle: 160 }
    ],
    invalid: [{ from: '$color.accent' }, 'linear-gradient(red, blue)']
  }),
  opacity: defineProp({
    schema: z.number().min(0).max(1),
    css: (v) => ({ opacity: v }),
    appliesTo: ['box', 'text', 'icon', 'image'],
    category: 'surface',
    doc: 'Whole-node transparency.',
    examples: [1, 0.6, 0],
    invalid: [2, -0.5, '60%']
  }),
  overflow: defineProp({
    schema: z.enum(['visible', 'hidden', 'scroll']),
    css: (v) => ({ overflow: v }),
    appliesTo: ['box'],
    category: 'surface',
    doc: 'What happens to content past the edge. `hidden` is also how a radius clips children.',
    examples: ['hidden', 'visible', 'scroll'],
    invalid: ['auto', 'clip']
  }),

  // ------------------------------------------------------------ typography
  font: defineProp({
    schema: fontLit,
    css: (v) => {
      const f = resolved(v, 'font') as FontBundle
      return {
        fontFamily: f.family,
        fontSize: `${f.size}px`,
        fontWeight: f.weight,
        lineHeight: String(f.lineHeight),
        ...(f.letterSpacing !== undefined ? { letterSpacing: `${f.letterSpacing}px` } : {})
      }
    },
    appliesTo: ['text'],
    category: 'typography',
    tokens: ['font'],
    doc: 'A named bundle of family, size, weight and line height.',
    examples: ['$font.h1', '$font.body'],
    invalid: ['14px', { size: 14 }]
  }),
  textAlign: defineProp({
    schema: z.enum(['left', 'center', 'right']),
    css: (v) => ({ textAlign: v }),
    appliesTo: ['text'],
    category: 'typography',
    doc: 'Horizontal alignment of the text inside its own box.',
    examples: ['left', 'center'],
    invalid: ['justify', 'start']
  }),
  letterSpacing: defineProp({
    schema: z.number().min(-4).max(16),
    css: (v) => ({ letterSpacing: `${v}px` }),
    appliesTo: ['text'],
    category: 'typography',
    doc: 'Tracking, in px, on top of whatever the font bundle sets.',
    examples: [0, 0.4, -0.3],
    invalid: [-10, '0.4em']
  }),
  textTransform: defineProp({
    schema: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']),
    css: (v) => ({ textTransform: v }),
    appliesTo: ['text'],
    category: 'typography',
    doc: 'Casing. Writing "PRICING" in literal capitals is styling encoded as content, and it would be wrong in the implementation too.',
    examples: ['uppercase', 'capitalize', 'none'],
    invalid: ['upper', 'title-case']
  }),
  maxLines: defineProp({
    schema: z.number().int().min(1).max(20),
    css: (v) => ({
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: v,
      overflow: 'hidden'
    }),
    appliesTo: ['text'],
    category: 'typography',
    doc: 'Clamp to this many lines and ellipsise.',
    examples: [1, 2, 3],
    invalid: [0, 1.5]
  }),

  // --------------------------------------------------------------- content
  value: defineProp({
    schema: z.string(),
    css: () => ({}),
    appliesTo: ['text'],
    required: true,
    list: true,
    category: 'content',
    tokens: ['color', 'font'],
    /**
     * Runs carry their own colour and font, and those must resolve — but the
     * run's *text* must not, or a label reading "$space.2" gets rewritten into
     * a number. Only this record knows which of its own fields are content.
     */
    resolve: (v, deep) => {
      if (!Array.isArray(v)) return v
      return v.map((part) =>
        isRun(part)
          ? {
              ...(part as TextRun),
              text: (part as TextRun).text,
              font: (part as TextRun).font === undefined ? undefined : deep((part as TextRun).font),
              color: (part as TextRun).color === undefined ? undefined : deep((part as TextRun).color)
            }
          : part
      )
    },
    spans: (v, theme) =>
      Array.isArray(v)
        ? (v as ResolvedRun[]).map((run) => ({ text: run.text, style: runStyle(run, theme) }))
        : undefined,
    doc: 'The text itself. An array mixes plain strings with { text, font?, color?, weight?, transform? } runs, so one word can differ without leaving the paragraph.',
    examples: ['General', 'Save changes'],
    invalid: [42, null]
  }),
  name: defineProp({
    schema: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected a kebab-case lucide icon name')
      .superRefine((v, ctx) => {
        if (hasIcon(v)) return
        const near = suggestIcon(v)
        ctx.addIssue({
          code: 'custom',
          message: `no lucide icon "${v}"${near ? ` — did you mean "${near}"?` : ''}`
        })
      }),
    css: () => ({}),
    appliesTo: ['icon'],
    required: true,
    category: 'content',
    doc: 'A lucide icon name, kebab-case — "chevron-right", "search". Brand marks are not in lucide.',
    examples: ['search', 'chevron-right', 'circle-check'],
    invalid: ['ChevronRight', 'chevron_right', '', 'github', 'not-a-real-icon']
  }),
  size: defineProp({
    schema: z.number().min(8).max(128),
    css: (v) => ({ width: `${v}px`, height: `${v}px`, flexShrink: 0 }),
    appliesTo: ['icon'],
    category: 'size',
    doc: 'Icon edge length in px.',
    examples: [16, 20, 24],
    invalid: [4, 200]
  }),
  src: defineProp({
    schema: srcLit,
    css: () => ({}),
    appliesTo: ['image'],
    required: true,
    category: 'content',
    doc: 'Image URL, data URI, or a path starting with / or ./',
    examples: ['https://example.com/avatar.png', './avatar.png'],
    invalid: ['', 42, 'avatar.png', 'not a url']
  }),
  fit: defineProp({
    schema: z.enum(['cover', 'contain', 'fill']),
    css: (v) => ({ objectFit: v }),
    appliesTo: ['image'],
    category: 'content',
    doc: 'How the image fills its box.',
    examples: ['cover', 'contain'],
    invalid: ['scale-down', 'none']
  })
} as const

/**
 * The shape check lives in __typetests__, deliberately not as a `satisfies`
 * clause here. `satisfies Record<string, PropDefLike>` contextually types every
 * defineProp call above with PropDefLike's `required: boolean`, which gives the
 * const type parameter an inference candidate and widens it straight back to
 * `boolean` — undoing the one thing it exists to do, with no error anywhere.
 */
