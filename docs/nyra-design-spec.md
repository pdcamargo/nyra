# @nyra/design — spec

A design tool whose author is Claude.

The loop: the user asks for a UI, Claude drafts it as a document, Nyra renders
it and shows the user a picture, the user gives feedback the way they would to a
designer, Claude revises. Once it is approved Claude implements it in real code,
reading its own document rather than reverse-engineering a screenshot the way it
would a Figma link.

There is no codegen in this. The document is the spec Claude implements *from*,
which is strictly better than a Figma export because nothing was inferred from
pixels.

## Decisions that are expensive to reverse

**HTML and CSS are the only thing that draws.** No Canvas2D, no WebGL, no layout
engine, no text shaping, no painter. Every pixel of every artboard comes from a
real browser laying out real DOM. The word "canvas" in this document means the
infinite surface, never the element.

That HTML runs in two places. Headless Chromium in the sidecar turns an artboard
into a PNG, which feeds Claude's screenshots, the chat preview and the
thumbnails. Nyra's own WebView renders the one artboard the user is working in,
inside a shadow DOM, so editing does not wait on a round trip. The two engines
differ slightly in font hinting and antialiasing. That is accepted: it never
changes a design decision.

**The vocabulary is a subset of CSS.** Codegen is out of scope, but the rule
survives it, because it is what stops the mock from lying. A design that can
only be expressed in ways CSS can express is a design Claude can actually build,
which is what makes the user's approval mean something. Anything the renderer
can do that CSS cannot is a bug.

**A component is a function with props, not an instance with overrides.** An
instance is a call: `{ "use": "Button", "props": { "variant": "primary" } }`. No
diffing against a master, no override reconciliation, no drift. Figma's model
buys freedom that costs years of sync bugs and produces instances no one can
name. Variants are props with conditional values, never parallel trees.

**Tokens are indirection.** Documents reference `$color.accent`, not `#6E56CF`.
One design renders in any theme, and a raw literal where a token exists is a
lint the engine reports back to Claude. This is the seam the eventual design
system feature hangs on.

**Storage resolves through an index, never a directory scan.**
`~/.nyra/designs/index.json` maps project path to `{ id, name, path }`. Default
location is app-managed, so nothing lands in someone's repo uninvited; "save to
repo" moves the file and updates one field. Do this and where designs live stays
a preference rather than becoming a migration.

**Four invariants keep an inspector unblocked**, even though v1 has none: node
IDs are stable and survive reload; hit testing returns a node ID in document
space; every mutation is a patch applied to the document, never a poke at render
state; and every visual property lives in the document, with nothing implicit in
renderer code.

**Interaction is reserved.** One optional key, `"on": { "click": { "navigate":
"<artboardId>" } }`, plus a closed action vocabulary when it lands. No
expressions, no JavaScript. A declarative document has nothing to sandbox, so a
prototype can render in chat without an iframe. Codex needs one because it runs
generated JavaScript.

## The extension pattern

Everything else scales through this.

**One record per property, and everything derives from it.**

```ts
defineProp('padding', {
  schema: spacing,                               // zod
  css: (v, t) => ({ padding: t.space(v) }),
  appliesTo: ['box', 'text', 'icon', 'image'],
  category: 'layout',
})
```

From that single declaration come the Zod schema, the inferred TS type, the CSS
emitter, the vocabulary section of the skill Claude reads, and later the
inspector's field list. Adding `letterSpacing` is one record, and it is
documented, validated and rendered the moment it exists. This is also the answer
to "Claude always knows the new shapes": the skill is generated from the
registry at build time, so shipping a property without teaching it is not
possible.

Node types work the same way:

```ts
defineNode('box', { props: [...], children: 'many', render: (n, kids) => … })
```

**The discipline: no property is handled by a branch in the renderer.** The
renderer walks the registry. A `if (node.type === 'text')` in the style pass
means the pattern has broken and something will be missing from the skill or the
validator.

**The pipeline is stages, each a pure function.**

```
document → validate → resolve components → resolve tokens → emit React/CSS
```

Features slot into stages rather than threading through everything: variants
land in component resolution, theming in token resolution, lints read between
any two, interaction becomes a stage of its own. Only the last stage knows about
React.

**Three value forms, and that is the entire expression language.** A literal
(`16`, `"#fff"`, `"$color.accent"`), a prop reference (`{ "prop": "label" }`),
and a match (`{ "match": { "prop": "variant" }, "cases": { … } }`). No template
strings, no parser, no escaping. Mixed text is an array of forms. A `$` prefix
marks a token path, so a token and a string are never ambiguous.

**Versioned documents.** `"schema": 1` in every file, with a migration list. The
loader migrates or refuses; it never renders a file it does not understand.

## v0 vocabulary

Four node types, plus `use` for a component instance:

- `box` — the only container. `layout: "stack" | "grid" | "none"`.
- `text` — value, font, color, align, `maxLines` for ellipsis.
- `icon` — a lucide name, size, color. Lucide ships structured node data
  (`[tag, attrs][]` on a 24px grid), so the whole set is available.
- `image` — src, fit, radius.

Roughly two dozen properties: `layout` `direction` `gap` `align` `justify`
`wrap` `padding` `width` `height` `minWidth` `maxWidth` `grow` `shrink`
`columns` `span` `position` `inset` `zIndex` `background` `color` `border`
`radius` `shadow` `opacity` `overflow` `font` `textAlign` `maxLines`.

Grid is the constrained slice only: `columns`, `gap`, child `span`. Areas,
auto-flow and minmax are deferred; that is where the surface explodes and
Claude's output gets subtly wrong. Absolute positioning is in, because a badge
on an avatar or a close button in a corner is not an edge case, and a box with
an absolutely positioned child becomes a positioning context automatically.

Theme scales: `color`, `space`, `radius`, `shadow`, `border`, and `font` as
named bundles of family, size, weight and line height.

The default theme ships inside the package and depends on nothing outside it.
Nyra's own tokens are the wrong shape to seed it from: they are shadcn role
tokens (`card`, `muted`, `border`, `ring`), achromatic apart from
`--destructive`, with one `--radius` and no spacing scale, where a design
vocabulary needs ramps. They are also unreachable from where rendering happens,
since the shadow DOM resets inherited style and the headless page never loads
the app's CSS. Where they do earn a place is later, as a named `nyra` theme
exported to JSON at build time, so Claude can mock a change to Nyra in Nyra's
own look.

## Worked example

```json
{
  "schema": 1,
  "name": "Settings",
  "theme": "default",
  "components": {
    "Button": {
      "props": {
        "label":   { "type": "string" },
        "variant": { "type": "enum", "of": ["primary", "ghost"], "default": "primary" }
      },
      "root": {
        "id": "root",
        "type": "box",
        "layout": "stack",
        "direction": "row",
        "align": "center",
        "gap": "$space.2",
        "padding": ["$space.2", "$space.4"],
        "radius": "$radius.md",
        "background": {
          "match": { "prop": "variant" },
          "cases": { "primary": "$color.accent", "ghost": "$color.transparent" }
        },
        "children": [
          {
            "id": "label",
            "type": "text",
            "value": { "prop": "label" },
            "font": "$font.button",
            "color": {
              "match": { "prop": "variant" },
              "cases": { "primary": "$color.onAccent", "ghost": "$color.text" }
            }
          }
        ]
      }
    }
  },
  "artboards": [
    {
      "id": "settings-general",
      "name": "Settings — General",
      "size": { "width": 960, "height": 640 },
      "background": "$color.bg",
      "root": {
        "id": "page",
        "type": "box",
        "layout": "stack",
        "direction": "column",
        "gap": "$space.6",
        "padding": "$space.8",
        "children": [
          { "id": "title", "type": "text", "value": "General", "font": "$font.h1" },
          {
            "id": "actions",
            "type": "box",
            "layout": "stack",
            "direction": "row",
            "gap": "$space.3",
            "children": [
              { "id": "save",   "use": "Button", "props": { "label": "Save changes" } },
              { "id": "cancel", "use": "Button", "props": { "label": "Cancel", "variant": "ghost" } }
            ]
          }
        ]
      }
    }
  ]
}
```

## v1 scope

In: the schema and validator, the HTML renderer, the sidecar render page, a
content-hashed raster cache, a `screenshot(artboardId)` tool, and PNGs in chat
through the existing image path.

Out, deliberately: the infinite canvas, LOD thumbnails, the live shadow-DOM
artboard, the `nyra-ui` chat block, an inspector, selection, interaction,
prototyping, codegen, and multi-theme rendering. Each of those sits on top
without changing anything beneath it.

Two integration details that are cheap now and painful later. The sidecar render
page needs a context that `adoptPage` does not claim (`sidecar/index.mjs:747`),
or it appears in the user's browser tab strip. And rasters go in
`$TMPDIR/nyra-designs-{pid}`, per the `{name}-{pid}` rule. A shared scratch
directory is the bug that broke attachments across two instances.

## Spike, and the gate

Before any of the integration work: a single package, a Zod schema, a
document-to-React renderer, and a bare vite page that loads a `.nyui` file.
Nothing else: no sidecar, no rasters, no tabs, no MCP, no skill.

Then hand a fresh Claude the schema and ask for eight to ten designs across a
difficulty spread: login, settings, a data table, pricing, a dashboard, an empty
state, a mobile screen, and something text-dense.

The gate is whether at least six of eight are designs you would give feedback on
the way you would to a designer, rather than designs you would laugh at, and
whether the gaps you find are additive (a missing property record) rather than
structural (the value forms are wrong, components do not compose, layout fights
you). Additive gaps are a morning's work. Structural gaps mean the schema is
wrong, and finding that out in a day instead of three weeks is the entire point
of the spike.
