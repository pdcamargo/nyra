---
name: nyra-design-system
description: Build, extend or use a Nyra design system — a folder of .nyui.json components, patterns and screens sharing one tokens.json. Use when the nyra_design tool is available and the user asks for a design system, UI kit, component library or brand foundations, to turn existing designs into one, or to design inside a project that already has one.
---

# Design systems in Nyra

A design system is a **folder**, not a file. Its documents use the same
vocabulary as any Nyra design (load `nyra-design` for that); what the folder
adds is one theme and one set of components that every file in it shares.

```text
<root>/
  nyra.design.json            name, id, description — Nyra writes it
  tokens.json                 the theme: colours, type, space, radius, shadows, borders, modes
  components/<family>.nyui.json   a component family + specimen artboards
  patterns/<name>.nyui.json       compositions of components (forms, nav shells, empty states)
  screens/<name>.nyui.json        product screens built from the system
  guidelines/<topic>.md           principles, voice, and brief.md — what was decided and why
```

- **One namespace.** Every component in every file is available to every other
  file. A screen uses `Button` without saying where it lives. Never redefine a
  component the system already has — a name defined twice is an error that
  names both files.
- **Files are found by folder.** Write a file into `components/`, `patterns/`
  or `screens/` and it is part of the system. There is nothing to register.
  File names must not contain `#`.
- **The theme is `tokens.json`.** Inside a system a document's `"theme"` is
  ignored; tokens decide.

## Finding the system

If the project has one, the system prompt names it. Read it before designing or
building UI:

`nyra_design action:"list", design:"<system name>"` returns the **digest**: its
tokens, every component with its props, the guidelines and the brief, and
anything that needs fixing. It is generated from the files every time, so it is
never stale. Use the system's components and tokens in code you write, too —
the digest is the reference.

## Creating one

1. **Check there isn't one already.** If the system prompt names a design
   system for this project, or `action:"list"` shows one, don't start another.
   Tell the user it exists, since they may have forgotten, and ask whether
   to build on it or make a second one. Nyra refuses `kind:"system"` for such
   a project until you pass `anyway:true`, which you only do once they have
   said so. To build on the one that exists, add `design:"<its name>"` to the
   `ask` below: the same brief, minus where it lives.
2. **Ask first**, with a questionnaire (below) started with `kind:"system"`.
   Nyra adds the brief to it: what the product is, a logo and references,
   where the system lives (in the repo's `design/`, committed so teammates and
   plain Claude Code get it, or in Nyra's folder; only offered in a git repo)
   and "anything else". Don't ask those yourself. Skip the questionnaire only
   when the user has already said what they want.
3. `nyra_design action:"create", kind:"system", name:"<Name>", location:"repo" | "nyra"`,
   with the location they chose (`nyra` when there was no choice), creates
   the folder, the manifest and a `tokens.json` seeded with the built-in
   theme, and tells you the root.
4. **Read before you write.** The files they added (the logo, screenshots,
   guidelines) and the codebase usually already hold the answers:
   Tailwind config, CSS variables, an existing component library, the drafts
   in `nyra_design action:"list"`. Carry them over rather than inventing.
5. **Foundations first**, in `tokens.json` (checklist below), then components,
   then patterns, then screens. Render as you go:
   `nyra_design action:"render", design:"<absolute path of the file>"`.
6. Write `guidelines/brief.md`: the decisions and the reasons, in a few short
   sections. It is part of the digest, so it is what the next session reads.

### tokens.json

```json
{
  "schema": 2,
  "baseMode": "light",
  "color": { "transparent": "transparent", "gray": { "50": "#FAFAFB", "900": "#1A1B21" },
             "bg": "$color.gray.50", "text": "$color.gray.900", "accent": "#6E56CF" },
  "space": { "1": 4, "2": 8, "4": 16 },
  "radius": { "sm": 4, "md": 8, "full": 9999 },
  "shadow": { "none": "none", "md": "0 2px 4px -1px rgb(17 18 22 / 0.08)" },
  "border": { "hairline": { "width": 1, "color": "$color.gray.200", "style": "solid" } },
  "font": { "body": { "family": "Inter, system-ui, sans-serif", "size": 14, "weight": 400, "lineHeight": 1.55 } },
  "modes": { "dark": { "color": { "bg": "$color.gray.900", "text": "$color.gray.50" } } }
}
```

- Ramps (`gray.50`…) hold raw values; **semantic aliases** (`bg`, `surface`,
  `text`, `textMuted`, `accent`, `danger`…) point at ramp steps. Designs use
  the aliases. A mode overrides aliases (and may override any existing token)
  but may **never add** one the base lacks.
- Required: `font.body` and `color.transparent`. Token names are letters and
  digits only: `brandPrimary`, not `brand-primary`.
- Check contrast: text-role colours need 4.5:1 on the surface. The digest's
  Checks section lists any that do not.

### Foundations checklist

Colour (ramps, semantic aliases, status colours, both modes) · Typography
(display → caption, a mono, sizes/weights/line heights) · Spacing scale ·
Radius · Elevation (shadows, or borders if the system is flat) · Borders ·
Icon size and stroke · Density (row heights, control sizes).

### Components

- One file per **family**: `button.nyui.json` holds Button, IconButton and
  ButtonGroup. Its artboards are the **specimens**: variants × states, laid out
  to be looked at. Name specimen artboards in lowercase (`button-specimens`) —
  an artboard id may not equal a component name.
- Give each component a `"description"`, and the file a `"meta"`:
  `group` (nav section), `order`, `status` (`draft` until the user approves it,
  then `ready`), `usage.do` / `usage.dont`.
- Containers take **slots** (see `nyra-design`): a Card, Modal or inspector
  group places `{ "slot": "body" }`; screens fill it under `"slots"`.

## Asking questions

Before laying a system out — and whenever a decision is the user's to make —
ask with a questionnaire rather than in prose. It opens in the side panel,
answers save as the user goes, and the transcript shows one line that reopens it.

`nyra_design action:"ask", kind:"system", name:"<System> design system", questions:[…]`

`kind:"system"` is for a new system only. Questions about a system that
exists, or about a single design, leave it out.

Then **end your turn**. The answers arrive as the user's next message, whenever
they send them. They may answer only some: anything unanswered, or marked
*Decide for me*, is yours to decide — say what you chose and why in
`guidelines/brief.md`. Do not explain any of this to the user; the
questionnaire does.

### Choosing between drawings

*Explore options* on an answer means: draw two or three directions as
artboards side by side in one file, render them, then ask a **new, short
questionnaire** about just that decision. Leave out `id`, so it doesn't add to
the long one, and name it after the decision ("Ornament — three
directions"). Make each direction an option whose preview is its artboard:
`"preview": { "artboard": "<absolute path>#<artboard id>" }`. The user picks
from the drawings, not from descriptions of them. Do the same whenever you
want the user to choose between designs you drew, during the work as much as
at the start.

To read where they are without waiting: `action:"answers", id:"<q_id>"`. To
reopen it when asked ("open the questionnaire again"): `action:"ask",
id:"<q_id>"` with no questions. Adding questions to one with `id` opens it on
the first new one; keep that for questions that belong with the rest, and use
a new questionnaire for a new decision.

Each question:

```json
{ "id": "accent", "section": "Color", "chip": "Accent",
  "question": "Which colour should lead?",
  "kind": "single",
  "options": [
    { "label": "Violet", "preview": { "palette": ["#EDE9FE", "#8B5CF6", "#6E56CF", "#5B44B0"] },
      "suggested": true, "why": "it's --accent in tailwind.config.ts" },
    { "label": "Blue", "preview": { "palette": ["#DBEAFE", "#3B82F6", "#2563EB", "#1D4ED8"] } }
  ] }
```

- `kind`: `single`, `multi` (pick any), `text`, `scale` (a slider:
  `"scale": { "min": 0, "max": 16, "unit": "px", "minLabel": "sharp", "maxLabel": "soft", "suggested": 8, "why": "…" }`;
  a radius in px is shown on real controls as it moves, and `"gradient": ["#DBEAFE", "#FEF3C7"]` draws
  a strip above a scale that runs between two colours, like cool to warm greys),
  `color` (`"suggested": "#6E56CF"`), or `files` (they add files; you get
  the paths of Nyra's copies, so read them).
- `section` groups questions in the rail; `chip` is a two-word label above one.
- An option's `preview` shows instead of telling: `{ "palette": [hex…] }`,
  `{ "swatch": hex }`, `{ "radius": 8 }`, `{ "density": "compact" | "comfortable" | "spacious" }`,
  `{ "type": { "size": 14, "weight": 400, "family": "Inter" } }`, or a drawn
  direction: `{ "artboard": "<absolute path>#<artboard id>" }`.
- **Suggest what the code already says**, with `suggested` and a short `why`,
  so most answers are a confirmation. Skip questions the code answers outright.
- Ask what you **found**, too: a contrast that fails, two drafts that disagree.
- 8–15 questions for a new system, in 4–7 sections. Fewer for a change.

### Question bank for a new system

Pick what the codebase does not already answer:

- **Product** — desktop, web, mobile; the feeling in three words. (What it
  is and who it is for is in the brief.)
- **Color** — the lead colour; neutrals cool or warm (scale); light, dark or both;
  what status colours do when they fail contrast as text.
- **Type** — the family; body size (options with `type` previews); how loud headings are.
- **Shape** — corner radius (scale with px); elevation by shadows or by borders.
- **Density** — compact, comfortable or spacious (`density` previews).
- **Components** — which to make solid first (`multi`).
- **Motion** — snappy, smooth or expressive.
- **Voice** — how labels speak; anything the product should never look like (`text`).

## Bringing existing designs in

Drafts the user already made are the starting point, not something to redraw.
Read them with `nyra_design action:"list"` and their files.

1. Move each component into the system **once**. Components that are identical
   in several drafts are merged without asking.
2. Where drafts **disagree** — same name, different look or different props —
   ask the user which one is the system's, showing both and how often each is
   used. Rewrite the screens to match their answer.
3. The drafts' artboards become `screens/<name>.nyui.json`, using the system's
   components and carrying no component definitions of their own.
4. Say what moved and what merged in one short summary.

## Comments

The user pins comments to elements on the canvas. Each arrives as a
`<design_comment>` in their message, naming the element, the file and node to
edit (`edit at`), and the component's definition (`defined`). A comment on a
component inside a screen is usually about that one use: change the instance
in the screen, and only change the component when the comment is about every
use of it. Ask if you can't tell.

After acting on one, render, then resolve it with a one-line note saying what
changed: `nyra_design action:"resolve", id:"<c_id>", note:"Changed the label
to Allow"`. The note is a reply on the pin, which the user reads and can
answer. A comment is a thread: when the user replies, their message carries
every round so far (`thread:`), newest last. Read the reply against what you
already tried, change what it asks, and resolve again with a new note.
`action:"comments", design:"<system name>"` lists every open comment on the
system with its thread; work through them when asked, resolving each as you go.

## Older files

If the digest or a render says a file is an older format, run
`nyra_design action:"upgrade", design:"<system name>"` (every file) or with a
file's path, before editing. Originals are kept.
