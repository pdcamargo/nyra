---
name: nyra-design
description: Draft a UI as a .nyui.json design document rendered by Nyra, not HTML or React. Use only when the nyra_design tool is available and the user asks to design, mock up, lay out, restyle, or explore a screen, page, panel, modal, or component.
---

# Designing in Nyra

You are drafting a **design document**: declarative JSON that Nyra renders to a
real picture. The user gives you feedback the way they would give it to a
designer, you revise, and once it is approved you implement it in real code
reading your own document — never by reverse-engineering a screenshot.

Write a `.nyui.json` file. Do not write HTML, React, CSS or Tailwind. The
vocabulary below is a subset of CSS on purpose: a design that can only be
expressed in ways CSS can express is a design that can actually be built, which
is what makes the user's approval mean something.

## The shape of a document

```json
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
```

Every node needs a unique `id` within its artboard or component. Artboard
`height` may be `"auto"` to fit its content — prefer that for anything list-
shaped, and a fixed number for a screen with a real device size.

The artboard root fills its artboard automatically. You do not need
`height: "full"` on it.

## Node types

- `box`
- `text` — requires `value`
- `icon` — requires `name`
- `image` — requires `src`
- `use`

**`box`** — The only container. Everything that holds other things is a box.
**`text`** — A run of text.
**`icon`** — A lucide icon, drawn as an inline SVG.
**`image`** — A raster image.

`box` is the only container; everything that holds other things is a box.
`use` is a component instance: `{ "id": "save", "use": "Button", "props": { … } }`.

## Components

A component is a function, not a copy. Declare its props, then reference them.
**Each prop is an object with a `type`** — this is the shape a fresh session
gets wrong most often, so it is written out in full:

```json
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
```

Used as `{ "id": "save", "use": "Button", "props": { "label": "Save changes" } }`.
A prop with no `default` must be given by every instance. Component names are
PascalCase; node ids are unique within their artboard or component.

## Values

Every property takes one of exactly three forms, and there is no fourth:

| form | example |
| --- | --- |
| a literal | `16`, `"center"`, `"$color.accent"` |
| a prop reference | `{ "prop": "label" }` |
| a match | `{ "match": { "prop": "variant" }, "cases": { "primary": "$color.accent", "ghost": "$color.transparent" } }` |

`null` is a literal meaning **this property is not set here** — use it in a
`match` case when one variant should leave a property off entirely. That is how
a vertical divider works: it must set no `height` at all, because an explicit
cross-axis size defeats `alignSelf: "stretch"`.

There are no template strings, no expressions and no JavaScript. Mixed text is
an array — see `value` below.

## Tokens

Reference tokens, never raw values. `$color.accent`, not `#6E56CF`. A raw
literal where a token exists is reported back to you as a lint.

**`$color`** — accent accentHover accentSubtle amber.100 amber.500 amber.600 amber.700 bg blue.100 blue.500 blue.600 blue.700 border borderStrong danger dangerSubtle gray.100 gray.200 gray.300 gray.400 gray.50 gray.500 gray.600 gray.700 gray.800 gray.900 gray.950 green.100 green.500 green.600 green.700 info infoSubtle onAccent onDanger red.100 red.500 red.600 red.700 success successSubtle surface surfaceSunken text textMuted textSubtle transparent violet.100 violet.200 violet.300 violet.400 violet.50 violet.500 violet.600 violet.700 violet.800 violet.900 warning warningSubtle

**`$space`** — 0 1 10 12 16 2 20 24 3 4 5 6 7 8 px xs

**`$radius`** — 2xl full lg md none sm xl

**`$shadow`** — lg md none sm xl

**`$border`** — accent danger dashed focus hairline strong

**`$font`** — body bodyStrong button caption display h1 h2 h3 h4 label lead mono monoSmall small smallStrong

Colour aliases (`accent`, `bg`, `text`, `textMuted`, `border`, `surface`,
`danger`…) are what you should normally reach for; the numbered ramps are
there when you need a specific step.

## Properties

### layout

| property | applies to | examples | |
| --- | --- | --- | --- |
| `layout` | box | "stack", "grid", "none" | How this box arranges its children. `stack` is flex, `grid` is a simple column grid, `none` is normal flow. |
| `direction` | box | "row", "column" | Stack axis. Only meaningful with `layout: "stack"`. |
| `gap` | box | "$space.2", "$space.6", 0 | Space between children. One value for both axes, or [row, column] — a wrapping grid usually wants them different. A percentage resolves against the container in that axis. |
| `align` | box | "center", "start", "stretch" | Cross-axis alignment of children. |
| `alignSelf` | box text icon image use | "center", "end", "stretch" | Overrides the parent stack's `align` for this one child. Without it, one child differing means a wrapper box that exists for nothing. |
| `justify` | box | "between", "center", "end" | Main-axis distribution of children. |
| `wrap` | box | true, false | Allow children to wrap onto more lines. |
| `columns` | box | 2, 3, 12 | Equal columns, with `layout: "grid"`. |
| `padding` | box text icon image | "$space.4", ["$space.2","$space.4"], 0 | Inner space. One value, or [block, inline], or [top, right, bottom, left]. A percentage is allowed but CSS resolves it against the container width on every side, including top and bottom. |

### size

| property | applies to | examples | |
| --- | --- | --- | --- |
| `width` | box text image use | 240, "full", "fit" | Width in px, a percentage like "60%", or "full" (100%) or "fit" (fit-content). |
| `height` | box text image use | 48, "full", "75%" | Height in px, a percentage, or "full" or "fit". The percentage form is how anything proportional gets expressed. |
| `minWidth` | box text image use | 0, 120, "25%" | Lower bound on width. |
| `maxWidth` | box text image use | 560, "full", "80%" | Upper bound on width. The usual way to hold a text column readable. |
| `minHeight` | box text image use | 0, 120, "50%" | Lower bound on height. The usual way to hold a row or an empty panel from collapsing. |
| `maxHeight` | box text image use | 320, "full", "75%" | Upper bound on height. Pair it with overflow to cap a scrolling region. |
| `grow` | box text icon image use | 0, 1, 2 | Share of leftover space this takes along the stack axis. |
| `shrink` | box text icon image use | 0, 1 | Whether this may shrink below its content size. 0 pins it. |
| `aspectRatio` | box image | [16,9], [1,1], 1.5 | Locks the height to the width. A number, or [w, h] which reads better — [16, 9]. |
| `span` | box text icon image use | 1, 2, 6 | Columns this child covers inside a grid box. |
| `size` | icon | 16, 20, 24 | Icon edge length in px. |

### position

| property | applies to | examples | |
| --- | --- | --- | --- |
| `position` | box text icon image use | "absolute", "relative" | Absolute pins to the nearest box ancestor, which becomes a positioning context automatically. |
| `inset` | box text icon image use | {"top":0,"right":0}, {"bottom":"$space.2","left":"$space.2"}, {"top":"50%"} | Offsets from the positioning context, for absolutely positioned nodes. A percentage resolves against that context. |
| `zIndex` | box text icon image use | 1, -1, 10 | Stacking order among overlapping siblings. |

### surface

| property | applies to | examples | |
| --- | --- | --- | --- |
| `background` | box text image | "$color.surface", "$color.accent", "transparent" | Fill colour. |
| `color` | text icon | "$color.text", "$color.onAccent" | Foreground colour of glyphs or strokes. |
| `border` | box text image | "$border.hairline", {"width":2,"color":"$color.accent","style":"solid"} | A border token, or an inline { width, color, style }. |
| `radius` | box image | "$radius.md", "$radius.full", 0 | Corner rounding. |
| `shadow` | box image | "$shadow.sm", "$shadow.lg", "none" | Elevation. Lifts a surface off the one behind it. |
| `gradient` | box | {"from":"$color.violet.600","to":"$color.violet.800"}, {"from":"$color.surface","to":"$color.bg","angle":160} | A two-stop linear gradient over the background. Every marketing page has one and there is no approximating it. |
| `opacity` | box text icon image | 1, 0.6, 0 | Whole-node transparency. |
| `overflow` | box | "hidden", "visible", "scroll" | What happens to content past the edge. `hidden` is also how a radius clips children. |

### typography

| property | applies to | examples | |
| --- | --- | --- | --- |
| `font` | text | "$font.h1", "$font.body" | A named bundle of family, size, weight and line height. |
| `textAlign` | text | "left", "center" | Horizontal alignment of the text inside its own box. |
| `letterSpacing` | text | 0, 0.4, -0.3 | Tracking, in px, on top of whatever the font bundle sets. |
| `textTransform` | text | "uppercase", "capitalize", "none" | Casing. Writing "PRICING" in literal capitals is styling encoded as content, and it would be wrong in the implementation too. |
| `maxLines` | text | 1, 2, 3 | Clamp to this many lines and ellipsise. |

### content

| property | applies to | examples | |
| --- | --- | --- | --- |
| `value` | text | "General", "Save changes" | The text itself. An array mixes plain strings with { text, font?, color?, weight?, transform? } runs, so one word can differ without leaving the paragraph. |
| `name` | icon | "search", "chevron-right", "circle-check" | A lucide icon name, kebab-case — "chevron-right", "search". Brand marks are not in lucide. |
| `src` | image | "https://example.com/avatar.png", "./avatar.png" | Image URL, data URI, or a path starting with / or ./ |
| `fit` | image | "cover", "contain" | How the image fills its box. |


### Layout in a parent

A `use` instance may carry only these, and they merge onto the component's
root: `alignSelf`, `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `grow`, `shrink`, `span`, `position`, `inset`, `zIndex`. That is how you tell one
instance to fill a row while its sibling hugs its text. An instance cannot
override a component's appearance — no `background`, `padding` or `font`.

### Text with mixed styling

`value` takes a string, or an array mixing plain strings with runs:

```json
{ "id": "note", "type": "text", "font": "$font.body",
  "value": ["Prices are ", { "text": "billed annually", "weight": 650 }, "."] }
```

A run is `{ "text": …, "font"?, "color"?, "weight"?, "transform"? }`. Use this
for one emphasised word inside a sentence — three text nodes in a row would
break the line wrapping.

## Icons

`icon` takes a kebab-case lucide name. 2108 are available.
Brand marks are **not** in lucide — there is no `github`. A name that does not
exist is a validation error, not a blank space.

Common: `search` `plus` `check` `x` `chevron-right` `chevron-down` `settings` `circle-check` `circle-alert` `circle-x` `trash-2` `pencil` `ellipsis` `arrow-right` `external-link` `copy` `calendar` `user` `bell` `star`

## How to work

Designs are **named, not filed**. You never choose or remember a location — the
`nyra_design` tool owns that, so a design can move without anything breaking.

1. **Register it.** `nyra_design action:"create", name:"Billing"` returns the
   path to write to.
2. **Write the `.nyui.json`** to exactly that path. Ask about sizes you are
   unsure of rather than guessing a device.
3. **Build repeated things as components.** Two buttons differing only in colour
   are one component with a `variant` prop and a `match`, never two trees.
4. **Render it.** `nyra_design action:"render", design:"Billing"` gives one PNG
   per artboard, plus anything the validator objected to. If it did not compile,
   the errors come back instead — read them and fix the document.
5. **Look at the PNG yourself.** Never describe a design you have not seen —
   the validator catches broken documents, not ugly ones.
6. **Hand it over as a chip, not a picture.** Write the design's path in
   backticks and Nyra renders it as a chip that opens the live canvas:

   ```
   `/the/path/render/gave/you.nyui.json`
   ```

   **Point at one artboard** by adding its id as a fragment, which opens the
   canvas framed on it rather than on the whole document:

   ```
   `/the/path.nyui.json#settings-protocol`
   ```

   Use that whenever you changed one panel — "I reworked the Protocol screen"
   should land them on the Protocol screen.

   Do **not** post `![name](path.png)` by default. The chip is one line, it
   opens a canvas the user can zoom and pan, and it stays current when you
   revise the document. A screenshot is a dead copy of one moment.

   Post the PNG **only** when the user asks to see it in the conversation —
   "show me here", "put it in chat", "what does it look like" — or when you are
   pointing at one specific detail in a reply they will read later.

7. **Take feedback the way a designer would** and revise the document. The
   canvas follows the file, so a revision appears without them clicking
   anything — say what changed and let them look.

`nyra_design action:"list"` shows the designs already in this project, and
`artboard:"<id>"` renders just one of them.

## Things that will bite you

- `align` and `justify` work on `layout: "stack"` **and** `layout: "grid"`.
  `direction` and `wrap` are stack-only.
- A box with a `radius` and a child that paints to its edge needs
  `overflow: "hidden"`, or the child squares off the corners.
- A percentage in `padding` resolves against the container's **width** on every
  side, including top and bottom. Use a `$space.*` token unless you mean that.
- `grid` is `columns` plus child `span`, and nothing else. No areas, no
  auto-flow, no minmax.
