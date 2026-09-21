/**
 * Generates the skill Claude reads, from the registry.
 *
 * The spec's reason for this existing: "the skill is generated from the
 * registry at build time, so shipping a property without teaching it is not
 * possible." A test asserts every record appears here, so the failure mode is a
 * red build rather than a property Claude never learns about.
 *
 * Two budgets matter and they are different:
 *
 *   - The FRONTMATTER is always in context, for every turn of every session.
 *     It has to be short enough that carrying it costs nothing, and specific
 *     enough that Claude reaches for it without being told where designs live.
 *   - The BODY loads only when the skill fires, so it can afford to be complete.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CATEGORIES, NODE_KINDS, type NodeKind, type PropCategory } from '../src/registry/define'
import { NODES } from '../src/registry/nodes'
import { PROPS } from '../src/registry/props'
import { propNamesFor } from '../src/registry/shapes'
import type { PropName } from '../src/registry/types'
import { defaultTheme } from '../src/theme/default'
import { tokenPaths } from '../src/theme/resolve'
import { iconNames } from '../src/registry/icons'

const names = Object.keys(PROPS) as PropName[]

const j = (v: unknown): string => JSON.stringify(v)

function scaleLine(scale: keyof typeof defaultTheme): string {
  const all = tokenPaths(defaultTheme).filter((p) => p.startsWith(`$${scale}.`))
  return all.map((p) => p.replace(`$${scale}.`, '')).join(' ')
}

function propTable(category: PropCategory): string {
  const rows = names
    .filter((n) => PROPS[n].category === category)
    .map((n) => {
      const d = PROPS[n]
      const on = (d.appliesTo as readonly NodeKind[]).join(' ')
      const ex = d.examples.slice(0, 3).map(j).join(', ')
      return `| \`${n}\` | ${on} | ${ex} | ${d.doc} |`
    })
  if (rows.length === 0) return ''
  return [
    `### ${category}`,
    '',
    '| property | applies to | examples | |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

const outerProps = names.filter((n) => PROPS[n].outer)
const requiredByKind = NODE_KINDS.map((k) => {
  const req = propNamesFor(k).filter((n) => PROPS[n].required)
  return `\`${k}\`${req.length ? ` — requires ${req.map((r) => `\`${r}\``).join(', ')}` : ''}`
})

const body = `---
name: nyra-design
description: Draft a UI as a design document that Nyra renders to a picture — for any request to design, mock up, lay out, restyle or explore the look of a screen, page, panel, modal or component, and before implementing UI in code. Produces a .nyui.json file, not HTML or React.
---

# Designing in Nyra

You are drafting a **design document**: declarative JSON that Nyra renders to a
real picture. The user gives you feedback the way they would give it to a
designer, you revise, and once it is approved you implement it in real code
reading your own document — never by reverse-engineering a screenshot.

Write a \`.nyui.json\` file. Do not write HTML, React, CSS or Tailwind. The
vocabulary below is a subset of CSS on purpose: a design that can only be
expressed in ways CSS can express is a design that can actually be built, which
is what makes the user's approval mean something.

## The shape of a document

\`\`\`json
{
  "schema": 1,
  "name": "Settings",
  "theme": "default",
  "components": { "Button": { "props": { … }, "root": { … } } },
  "artboards": [
    { "id": "main", "name": "Settings — General",
      "size": { "width": 960, "height": 640 },
      "background": "$color.bg",
      "root": { … } }
  ]
}
\`\`\`

Every node needs a unique \`id\` within its artboard or component. Artboard
\`height\` may be \`"auto"\` to fit its content — prefer that for anything list-
shaped, and a fixed number for a screen with a real device size.

The artboard root fills its artboard automatically. You do not need
\`height: "full"\` on it.

## Node types

${requiredByKind.map((r) => `- ${r}`).join('\n')}

${NODE_KINDS.filter((k) => k !== 'use')
  .map((k) => `**\`${k}\`** — ${NODES[k].doc}`)
  .join('\n')}

\`box\` is the only container; everything that holds other things is a box.
\`use\` is a component instance: \`{ "id": "save", "use": "Button", "props": { … } }\`.

## Components

A component is a function, not a copy. Declare its props, then reference them.
**Each prop is an object with a \`type\`** — this is the shape a fresh session
gets wrong most often, so it is written out in full:

\`\`\`json
"components": {
  "Button": {
    "props": {
      "label":   { "type": "string" },
      "count":   { "type": "number", "default": 0 },
      "loading": { "type": "boolean", "default": false },
      "variant": { "type": "enum", "of": ["primary", "ghost"], "default": "primary" }
    },
    "root": {
      "id": "root",
      "type": "box",
      "layout": "stack", "direction": "row", "align": "center",
      "padding": ["$space.2", "$space.4"],
      "radius": "$radius.md",
      "background": {
        "match": { "prop": "variant" },
        "cases": { "primary": "$color.accent", "ghost": "$color.transparent" }
      },
      "children": [
        { "id": "label", "type": "text", "value": { "prop": "label" }, "font": "$font.button",
          "color": { "match": { "prop": "variant" },
                     "cases": { "primary": "$color.onAccent", "ghost": "$color.text" } } }
      ]
    }
  }
}
\`\`\`

Used as \`{ "id": "save", "use": "Button", "props": { "label": "Save changes" } }\`.
A prop with no \`default\` must be given by every instance. Component names are
PascalCase; node ids are unique within their artboard or component.

## Values

Every property takes one of exactly three forms, and there is no fourth:

| form | example |
| --- | --- |
| a literal | \`16\`, \`"center"\`, \`"$color.accent"\` |
| a prop reference | \`{ "prop": "label" }\` |
| a match | \`{ "match": { "prop": "variant" }, "cases": { "primary": "$color.accent", "ghost": "$color.transparent" } }\` |

\`null\` is a literal meaning **this property is not set here** — use it in a
\`match\` case when one variant should leave a property off entirely. That is how
a vertical divider works: it must set no \`height\` at all, because an explicit
cross-axis size defeats \`alignSelf: "stretch"\`.

There are no template strings, no expressions and no JavaScript. Mixed text is
an array — see \`value\` below.

## Tokens

Reference tokens, never raw values. \`$color.accent\`, not \`#6E56CF\`. A raw
literal where a token exists is reported back to you as a lint.

${(['color', 'space', 'radius', 'shadow', 'border', 'font'] as const)
  .map((s) => `**\`$${s}\`** — ${scaleLine(s)}`)
  .join('\n\n')}

Colour aliases (\`accent\`, \`bg\`, \`text\`, \`textMuted\`, \`border\`, \`surface\`,
\`danger\`…) are what you should normally reach for; the numbered ramps are
there when you need a specific step.

## Properties

${CATEGORIES.map(propTable).filter(Boolean).join('\n')}

### Layout in a parent

A \`use\` instance may carry only these, and they merge onto the component's
root: ${outerProps.map((n) => `\`${n}\``).join(', ')}. That is how you tell one
instance to fill a row while its sibling hugs its text. An instance cannot
override a component's appearance — no \`background\`, \`padding\` or \`font\`.

### Text with mixed styling

\`value\` takes a string, or an array mixing plain strings with runs:

\`\`\`json
{ "id": "note", "type": "text", "font": "$font.body",
  "value": ["Prices are ", { "text": "billed annually", "weight": 650 }, "."] }
\`\`\`

A run is \`{ "text": …, "font"?, "color"?, "weight"?, "transform"? }\`. Use this
for one emphasised word inside a sentence — three text nodes in a row would
break the line wrapping.

## Icons

\`icon\` takes a kebab-case lucide name. ${iconNames.length} are available.
Brand marks are **not** in lucide — there is no \`github\`. A name that does not
exist is a validation error, not a blank space.

Common: ${['search', 'plus', 'check', 'x', 'chevron-right', 'chevron-down', 'settings', 'circle-check', 'circle-alert', 'circle-x', 'trash-2', 'pencil', 'ellipsis', 'arrow-right', 'external-link', 'copy', 'calendar', 'user', 'bell', 'star']
  .map((n) => `\`${n}\``)
  .join(' ')}

## How to work

Designs are **named, not filed**. You never choose or remember a location — the
\`nyra_design\` tool owns that, so a design can move without anything breaking.

1. **Register it.** \`nyra_design action:"create", name:"Billing"\` returns the
   path to write to.
2. **Write the \`.nyui.json\`** to exactly that path. Ask about sizes you are
   unsure of rather than guessing a device.
3. **Build repeated things as components.** Two buttons differing only in colour
   are one component with a \`variant\` prop and a \`match\`, never two trees.
4. **Render it.** \`nyra_design action:"render", design:"Billing"\` gives one PNG
   per artboard, plus anything the validator objected to. If it did not compile,
   the errors come back instead — read them and fix the document.
5. **Look at the PNG yourself.** Never describe a design you have not seen —
   the validator catches broken documents, not ugly ones.
6. **Hand it over as a chip, not a picture.** Write the design's path in
   backticks and Nyra renders it as a chip that opens the live canvas:

   \`\`\`
   \`/the/path/render/gave/you.nyui.json\`
   \`\`\`

   **Point at one artboard** by adding its id as a fragment, which opens the
   canvas framed on it rather than on the whole document:

   \`\`\`
   \`/the/path.nyui.json#settings-protocol\`
   \`\`\`

   Use that whenever you changed one panel — "I reworked the Protocol screen"
   should land them on the Protocol screen.

   Do **not** post \`![name](path.png)\` by default. The chip is one line, it
   opens a canvas the user can zoom and pan, and it stays current when you
   revise the document. A screenshot is a dead copy of one moment.

   Post the PNG **only** when the user asks to see it in the conversation —
   "show me here", "put it in chat", "what does it look like" — or when you are
   pointing at one specific detail in a reply they will read later.

7. **Take feedback the way a designer would** and revise the document. The
   canvas follows the file, so a revision appears without them clicking
   anything — say what changed and let them look.

\`nyra_design action:"list"\` shows the designs already in this project, and
\`artboard:"<id>"\` renders just one of them.

## Things that will bite you

- \`align\` and \`justify\` work on \`layout: "stack"\` **and** \`layout: "grid"\`.
  \`direction\` and \`wrap\` are stack-only.
- A box with a \`radius\` and a child that paints to its edge needs
  \`overflow: "hidden"\`, or the child squares off the corners.
- A percentage in \`padding\` resolves against the container's **width** on every
  side, including top and bottom. Use a \`$space.*\` token unless you mean that.
- \`grid\` is \`columns\` plus child \`span\`, and nothing else. No areas, no
  auto-flow, no minmax.
`

/**
 * The bundled copy is the only copy.
 *
 * `managed_skills.rs` pulls this exact path in with `include_str!`, so the file
 * we develop against and the file Nyra installs cannot drift — which is the
 * same reason `write-a-flow` and `nyra-app` live there.
 */
const out = resolve(
  process.argv[2] ?? resolve(import.meta.dirname, '../../../.claude/skills/nyra-design/SKILL.md')
)
writeFileSync(out, body)
console.log(`wrote ${out} — ${body.length} chars, ${names.length} properties`)
