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

## Design systems (format v2)

A design was one file. It is now also a **project**: a folder of files that
share one theme and one set of components. Single files stay, as drafts.

### Format versions and migrations

Every file kind carries `"schema"`; `FORMAT_VERSION` in
`packages/design/src/migrations/` is the current one. Backwards compatibility
is not a goal. A safe way forward is: each breaking change ships a step
`{ from, to, migrate(json) → { json, notes } }` that works on **raw JSON**,
because an old shape cannot type-check against the new schema. `upgrade()`
runs the chain.

- An old file opens upgraded in memory, with a banner. **Upgrade** backs the
  original up to `~/.nyra/designs/backups/` and writes the new version,
  pretty-printed. A system upgrades all its files in one go.
- A file newer than this Nyra is refused, never half-drawn.
- Claude's `render` says when a file is old; `action:"upgrade"` rewrites it.
  `npm run design:upgrade -- <paths>` does it without the app.
- The tests make a breaking change without a migration impossible to ship:
  every older version needs a step, and the examples must be current.

### No size limit

The old ceiling was the generic text read (1 MiB, 20,000 lines), which ships a
file across IPC as one JSON string. Designs no longer use it. `design_read`
streams raw bytes over a Tauri `Channel`, a Web Worker parses and compiles, the
tab shows progress once an open takes long enough to notice, and the canvas
only draws artboards near the viewport. What is left are memory, Chromium's
16k-pixel texture limit for PNGs, and Claude's own Read tool, which cannot read
a huge single-line file in pieces. That last one is why upgrades pretty-print
and the skill says to split big files.

### A system is a folder

```text
<root>/                      ~/.nyra/designs/systems/<slug>-<id>/  or  <repo>/design/
  nyra.design.json           name, id, description
  tokens.json                the theme, with modes (dark is an override, never an addition)
  components/*.nyui.json     a component family per file, with specimen artboards
  patterns/*.nyui.json       compositions
  screens/*.nyui.json        product screens
  guidelines/*.md            principles, voice, and brief.md
```

- **Registered in `~/.nyra/designs/systems.json`, not `index.json`.** The
  installed app and dev share both files, and an older build loads `index.json`
  leniently and drops fields it does not know on save. A system in there would
  be stripped within one render.
- **Membership is a path prefix**, canonicalised, and only those three
  folders, one level deep. Nothing is found by scanning the disk. `#` is not
  allowed in member file names, because a chip splits on the first `#`.
- **Moving a system** (Nyra's folder into the repo) is copy, verify, delete,
  and the old root goes into `previousRoots`, so chips that name it still open.
- **Worktrees.** A repo system is checked out in every worktree, and a worktree
  chat edits its own copy. `list`, `system_of` and the system prompt all give
  back a *view* of the entry with its root moved into the worktree
  (`git::linked_worktree` reads the `.git` file, so no git process). `files`
  takes the root the caller holds and refuses one whose manifest names another
  system.

### One namespace, slots, and the address of a node

Every component in every file is visible to every other file, through one
`Registry`. A name defined twice is an error naming both files. A container
declares a `{ "type": "slot" }` prop, places `{ "slot": "body" }` in its
children, and an instance fills it under `"slots"`. Slotted content resolves
in the caller's scope and stack, otherwise Card-in-Card reads as a cycle.
`Address` gained `file`, so an issue or a comment says which file to edit.

### What Claude knows, and how

- **Skills:** `nyra-design` is the vocabulary, generated from the registry;
  `nyra-design-system` is how to build and use a system. Both are managed by
  Nyra.
- **A pointer:** when the chat's project has a system, the system prompt gets
  one line naming it.
- **A digest:** `nyra_design action:"list", design:"<system>"` returns tokens,
  components with their props, the guidelines and what needs fixing. It is
  generated from the files every time, so it cannot drift.
- **A project skill**, for repo systems that opt in: the digest written to
  `.claude/skills/<slug>-design-system/`, so plain Claude Code and teammates
  get it too.

### Questionnaire

`action:"ask"` saves a questionnaire, opens it in the side panel and tells
Claude to end its turn. It does not block: a blocking call would hold the turn
for minutes and lose the answers on a restart. Answers save on every change, a
transcript chip reopens it, and Send posts them as the user's next message,
partial or not. The bubble shows one line; the full record goes to Claude.
State lives in `~/.nyra/designs/questionnaires/`.

`ask` with `kind:"system"` starts a new system's questionnaire, and Nyra adds
the brief around Claude's questions: the product, a logo and references (a
`files` question), where the system lives (only in a git repo) and, last,
anything else. Those are Nyra's, so every new system asks them the same way.
Files added to an answer are copied to `questionnaires/<id>/`, and Claude gets
the copies' paths.

**Choosing between drawings.** *Explore options* on an answer asks Claude to
draw directions, not describe them: it draws two or three artboards, then asks
a new, short questionnaire about that one decision, each option previewed as
its artboard (`"preview": { "artboard": "<path>#<id>" }`, drawn live). It never
adds the follow-up to the long questionnaire, which would bury it on a page
the user has already left. When Claude does add a round to one (`ask` with an
`id`), the tab and the chip open on the round's first question.

**One system per project unless the user says otherwise.** `kind:"system"`,
on `create` or `ask`, is refused for a project that already has one, and the
refusal names it so Claude can say so. The user may have forgotten it, and a
second system splits every component and token in two. `anyway:true` goes
through, once the user has asked for a second one.

### Feedback and comments

A right-click on an artboard offers **Give feedback on this design…** (the
whole artboard, visible as a chip in the bubble) and **Comment here…**, which
is pinned to an element, not to a point. The hit test reads `composedPath()`
through the shadow root to the nearest `data-node`, and the comment keeps that
node's resolved id, its authored address, the instance it sits in, and where
inside its box the pin goes. The artboard point is only a fallback. A point
goes stale as soon as Claude moves anything, and it cannot say which of three
overlapping things was meant.

- The anchor travels as hidden message context: the bubble shows the pin and
  your words, and Claude gets `<design_comment>` with the file, the node, where
  to edit it and where its component is defined.
- Pins are placed from the element's live box, so they follow edits. A comment
  whose node is gone is found again by its authored address, but only if that
  names exactly one node, so it never guesses which of several Buttons.
- A comment is a thread. Claude closes a round with `action:"resolve"` and a
  one-line note, which becomes a reply on the pin. The user answers in the
  card: the reply is saved to the thread, reopens the comment, and is sent with
  every round so far (`thread:` in `<design_comment>`), so each iteration stays
  with the element it was about. Reopen on its own sends nothing; it only
  says the last round did not settle it.
- Comments live in `~/.nyra/designs/comments/<scope>.json`, one file per
  system or draft, never in the repo. A system's comments match files by path
  inside the system, so a worktree and the main checkout show the same ones.

### Found on launch

A few seconds after startup, each sidebar project is asked, one at a time, what
design work it has: `git ls-files` (tracked, plus untracked files that are not
ignored) finds committed `nyra.design.json` folders, which become systems, and
loose `.nyui.json` files, which become drafts named by their own `"name"`.
After that they are in the Pinned Summary (*In this project*), the design
picker, the command palette and `action:"list"`, so Claude never searches for
them. A passive dev instance skips the launch pass, because it would file
designs into the lists the installed app reads.
