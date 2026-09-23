---
name: design-first
description: Create a Pencil mockup before implementing any UI feature or enhancement. Design first, code second.
---

# Design First

Create a visual mockup in Pencil before writing any implementation code. This ensures alignment on
layout, spacing, and UX before committing to code.

## When to Use

- New UI features or components
- Redesigns or layout changes
- Feature enhancements that affect visual layout
- Any time you're unsure how something should look

## Before You Start

**A `.pen` document must already be open in Pen.app.** The MCP server attaches to whatever the editor
has open — it cannot create or open documents itself. Every tool call fails with
`A file needs to be open in the editor` until one is. If that happens, ask the user to open one; do
not try to work around it.

## Instructions

1. **Understand the current state**
   - Read the relevant component files to understand what exists today
   - If this is an enhancement, note existing structure, spacing, and patterns

2. **Load Pencil's own docs — they are required reading, not optional**
   - `get_app_state()` — the active document path, top-level nodes, current selection
   - `read_skill()` — SKILL.md, the canvas rules
   - `read_skill({ path: "execute.md" })` — the `execute` API
   - `read_skill({ path: "pen-schema.md" })` — the node schema
   - `read_skill({ path: "guide/web-app.md" })` — web-app layout conventions
   - Skip `get_style()`. Style archetypes are for work with no brand direction; Nyra has its own
     tokens, below.

3. **Build the mockup with `execute`**
   - `execute` runs a **JavaScript snippet**, not a list of operations. Use loops, helpers, and
     spreads for repeated UI rather than handwriting every node.
   - Declare cross-call values without `const`/`let` — each call has its own scope, so
     `cardId = Insert(...)` persists and `const cardId = ...` does not.
   - `FindEmptySpace({width, height, padding})` first when inserting at the document root. Never
     overlap root frames.
   - Screen frames go at the document root with `clip: true`. Keep the root clean — only screens and
     reusable components, never loose text or shapes.
   - Set `placeholder: true` on a root frame while you work on it, and clear it the moment that frame
     is done.
   - Name every node. The response maps names to ids for the next call.
   - Split the work across several small `execute` calls, one per section, so the user sees progress.
   - On failure, retry with `edits` + the returned `editId`. Never resend the whole snippet.

4. **Verify as you go**
   - **Verify with `Export`, not `TakeScreenshot`.** `Export([id], "png", "/tmp/mockup")` then `Read`
     the file. `TakeScreenshot` returns unreliably-rasterized frames — usually blank — and will send
     you debugging a layout that was never broken.
   - **A blank export usually means Pen.app's rasterizer went stale, not that your layout is
     broken.** It degrades over a long session: early frames export fine, later ones come back empty
     with perfectly valid geometry. Confirm with a `Get` visitor — if `ctx.bounds` are sane, the
     design is fine. Quit Pen.app (`osascript -e 'quit app "Pen"'`), reopen the `.pen` file with
     `open -a Pen <path>`, and re-export; the MCP connection survives it. Do this before rebuilding
     anything, and do not go chasing phantom layout bugs.
   - `ctx.bounds` reports a constant ~50px `y` offset for non-root nodes, so nested children are
     routinely flagged `fully clipped` when they render fine. Treat `problems` as a hint, not proof —
     confirm against an export before "fixing" anything.
   - For structure and sizing use a `Get` visitor:
     `Get(screen, (n, c) => c.problems && Print(n.name, c.problems))`
   - Check each section against: layout not collapsed, nothing clipped outside its frame, adequate
     contrast, consistent alignment and spacing.

5. **Review with user**
   - Present the screenshot(s) and explain the design decisions
   - Wait for feedback or approval before proceeding
   - Fix by updating existing nodes. Never delete and rebuild a frame to change it.

6. **Implement only after approval**
   - The mockup is the source of truth for spacing, color, and layout

## Pencil Gotchas

These cause hard errors or silent visual bugs. They are not CSS.

- **No** `margin`, **no** percentage or viewport sizes (`"100%"`, `"50vh"`, `calc()`), **no**
  `alignItems: "baseline" | "stretch"`.
- Text is invisible without an explicit `fill`. This includes emoji.
- `textGrowth` governs text sizing: `auto` never wraps and ignores width; `fixed-width` requires
  `width` and wraps; `fixed-width-height` requires both. Never guess text dimensions — let layout and
  wrapping size it.
- `layout` and `padding` exist only on `frame`. To pad a text node, wrap it in a frame.
- `x`/`y` are ignored inside a flex parent unless `layoutPosition: "absolute"`.
- A `fit_content` parent whose children are all `fill_container` collapses to zero. Break the cycle.
- Frames default to `horizontal` + `fit_content`, not vertical.
- Properties never cascade. Every node carries its own.
- Use `icon` nodes (`library: "lucide"`) for iconography — Nyra's UI already uses lucide, so names
  carry straight over. Never hand-draw logos or illustrations from paths.

## Design Tokens (Nyra defaults)

Define these once with `SetVariables` and reference them as `$name`. Use these unless the feature
calls for something else.

- **Backgrounds**: `#0A0A0A` (page), `#111111` (panels), `#ffffff06` (cards)
- **Borders**: `#1a1a1a`, `#ffffff0f`, `#1f1f1f`
- **Text**: `#ffffffcc` (primary), `#ffffff80` (secondary), `#ffffff4d` (muted), `#ffffff33` (labels)
- **Accents**: `#10B981` (success/active), `#3b82f6` (info/running), `#ef4444` (error), `#f59e0b` (warning)
- **Fonts**: `Inter Variable` (`--font-sans`, and `--font-content` for the conversation itself),
  `Fira Code Variable` (`--font-mono` — code, diffs, paths, stats). Verified against `index.css`;
  chat prose is sans, panel chrome and anything file-shaped is mono.
- **Font sizes**: 10px (labels), 11px (tabs/items), 12px (body), 14–16px (headings)
- **Corner radius**: 4px (buttons/tabs), 6px (cards)

## Style

- Show realistic sample data — real file paths, real branch names, never lorem ipsum.
- Don't wrap every element in its own card. Use a container only when it has a structural purpose.
- Be sparing with gradients, shadows, and rounded corners.
- Draw the real thing at its real size. Nyra's side panel is narrow; a mockup drawn at 900px wide
  proves nothing about how it reads at 380px.
