Read docs/nyra-design-spec.md first. It has the decisions, the v0 vocabulary,
the extension pattern and a worked example. Do not re-litigate what is settled
there.

This is the spike. Build `packages/@nyra/design` and nothing else. No sidecar,
no rasters, no screenshots, no canvas, no tabs, no MCP tools, no skill, no
storage, no chat integration. All of that is planned. None of it answers the
question the spike exists for: whether Claude drafts UI worth giving feedback
on.

Branch before you start. `npm test` and `npm run check` stay green throughout.

PREREQUISITE: the repo has no npm workspaces (`workspaces: null` in the root
manifest). Add one for `packages/*`, confirm the existing build, vitest and tsc
paths are unaffected, and get that green before writing any of the library.

BUILD, in one package. Do not split into core/dom/viewer yet. That split is
right eventually and premature while the schema still changes weekly.

- `schema.ts` — Zod, the v0 vocabulary from the spec. Four node types plus `use`.
  The three value forms and nothing else: literal, `{ prop }`, `{ match, cases }`.
- The property registry. One `defineProp` record per property, carrying the Zod
  schema, the CSS emitter, and which node types it applies to. The composed
  document schema, the TS types and the CSS pass all derive from the registry.
  Same for `defineNode`. This is the load-bearing pattern in the spec; if you find
  yourself branching on `node.type` inside the style pass, stop and fix the
  registry instead.
- The pipeline as four pure stages: validate, resolve components, resolve tokens,
  emit React. Only the last knows React exists.
- A default theme, self-contained in the package. Scale-shaped ramps, not the
  app's role tokens, and no dependency on Nyra's stylesheet. See the spec.
- `dev/` — a bare vite page that loads a `.nyui` from disk and renders it. Plain
  local dev server, not Tauri. This is a harness for looking at output, so spend
  no time on it beyond that.

Stable node IDs, and mutations expressed as patches against the document, from
the start. There is no inspector in this spike, and both are still required:
they cannot be retrofitted cheaply.

Table-driven tests over the registry: every registered property validates its
own examples and emits CSS. Snapshot the rendered output of the worked example
in the spec.

WHEN IT RUNS, before you report back: write eight designs yourself against the
schema, covering login, settings, a data table, pricing, a dashboard, an empty
state, a mobile screen, and something text-dense. Render them. Then tell me two things
separately: which properties you wished existed, and where the schema fought
you. The first list is additive and expected. The second is the one I care
about, so do not soften it. If components do not compose, if the value forms are
wrong, or if layout is a fight, the schema is wrong and I would rather know now.
