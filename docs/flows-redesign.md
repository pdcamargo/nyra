# Flows — redesign spec

Mockups in `design-exports/`. Animated prototype: `design-exports/edge-animation.html`.

Flows is the workflow canvas: a graph where each node is a headless Claude run, a
shell command, or a routing decision, and the edges decide what runs next. It
arrived in the first commit and has never been used. `~/.nyra/workflows` is empty
and no execution has ever been recorded. This pass decides what it should be
before any of it is rebuilt.

## Decisions

**Flows belong to a project, with an escape hatch.** Today they are a single flat
pool in `~/.nyra/workflows/*.json` with no owner, which is why the tab feels like
it belongs to nobody. Most bundled templates assume a repo: "PR Review Pipeline"
is meaningless without one. The rail lists each project's flows under it and the
header breadcrumb reads `project / flow`.

A flow can also be scoped to nothing, and some should be. `Lead Research` takes a
company and a product; `Iterative Refiner` improves a draft you paste in. Neither
touches a codebase. Installed templates also arrive unowned. Those live in an ANY
PROJECT section and pick a working directory at run time, which is what
`recentCwds` records. A project-scoped flow defaults to its project and does not
ask, so the per-trigger `cwd` folds into the flow's own scope.

**A flow runs top to bottom.** The canvas pane is 900×868 after the sidebar and
inspector. Vertically the reference flow is 660×642 and fits whole; horizontally
it is 1500×246 and hangs 600px off the edge. Long chains scale better vertically
too. Twelve steps is 1392px tall against 3120px wide. It also scrolls the same
direction as the transcript. This reverses the current code, which uses
`Position.Left`/`Position.Right` throughout.

**Three node shapes, by what the node does to the run.**

| Group | Types | Shape |
| --- | --- | --- |
| Does work | `prompt`, `script`, `subworkflow` | 200×62 card: icon, label, meta line |
| Routes | `condition`, `parallel`, `join` | compact pill |
| Waits | `humanReview` | card with Approve/Reject inside it |
| Repeats | `loop` | container, see below |

A uniform card makes control flow invisible. You cannot tell a fan-out from a
Claude run without reading the label, so the shape carries it instead.

`humanReview` is the only node that stops the run and needs an answer, so the
answer lives in the node. That also differentiates it without spending a colour.

**Edges are orthogonal elbows.** A fan-out spans 460px horizontally against 54px
of drop, nearly 9:1, and a bezier flattens into a horizontal sweep that crowds the
row below. An elbow makes the branch point a place on the canvas, so you read one
split into three rather than three separate curves.

**A loop is a container that encloses its body.** Containment expresses the cycle,
so nothing has to draw a return edge. There isn't one to draw (see Constraints).
`maxIterations` shows as `3 / 5` in the header, `condition` in the footer. A box
holding a single column also makes the no-branching rule self-evident. Nesting
works. Two levels deep stays legible by insetting 20px and dimming the surface one
step per level.

Containers cost nesting on the canvas: positions relative to a parent,
hit-testing inside a box, and dragging a node in or out to change the body.

**Colour means run status.** Nyra's palette is achromatic. Every grey is
`oklch(… 0 0)`, and only `success`, `warning`, `destructive` and `info` carry
chroma. The idle canvas is entirely grey, so anything coloured is the run talking.

| Status | Treatment |
| --- | --- |
| `idle` | neutral border, faint dot |
| `running` | info border and soft bloom, info dot, meta shows elapsed |
| `done` | neutral border, success dot, meta shows duration and tokens |
| `failed` | destructive border and fill tint, destructive dot |
| `skipped` | 40% opacity, no colour |
| `awaiting_review` | warning border, gate buttons become live |

Done shows as a dot so a finished flow is not eight glowing green boxes. Skipped
uses opacity because it is nothing to act on.

**The active edge animates as a travelling pulse.** One lit segment runs the
length of the edge the execution is currently crossing, and only that one. If
every edge animated, motion would stop meaning anything.

React Flow's built-in `animated: true` gives marching dashes for free, but its
dash pitch is in pixels, so short edges strobe and long ones crawl. A custom edge
with `pathLength="1"` makes the dash values fractions of the path, so a 40px edge
and a 400px edge traverse in the same time. Under `prefers-reduced-motion` the
flow line goes solid instead of moving.

The loop cannot animate its return, so the container border lights and the
iteration badge ticks instead.

## The rail has two modes

A segmented Chat / Flow toggle sits on the wordmark row, right-aligned. Stacking
wordmark, toggle and tabs would put three bars of chrome above any content; on one
row it reads as a header and costs nothing. The wordmark is 32px and the toggle
96px, so a 240px rail holds both with room.

A toggle rather than a dropdown on the wordmark: the Codex pattern switches
products, so each entry carries a description line. Chat and Flow are two views of
one project's work, switched several times an hour. Nobody has ever run a flow, and
a menu would hide the alternative behind a click. Two views is a toggle; a third
would make it a menu.

Flow mode drops the tabs and lists projects with their flows nested, mirroring
Chat mode, so no separate project switcher is needed. A RUNNING section pins above
the project list while something executes, so a live run surfaces whatever project
it belongs to. Scheduled flows show what wakes them inline: `every 15m`, `Fri
9:00`, `on tag push`. Triggers are the most capable thing Flows has and they are
currently buried in a per-flow dialog.

The ANY PROJECT section sits below the projects. It is not the counterpart of
Chat mode's Recents: Recents holds chats that have not been filed yet, whereas an
unscoped flow is often deliberately unscoped. It also catches every flow
installed from Templates or the marketplace, which has to land somewhere before
you file it. Rows there show the directory the flow last ran in.

The toggle needs a registered command with a chord, and each mode remembers where
it was, so switching back lands on the chat you left rather than a reset rail.

## Empty is the state that matters

It is what the app shows today, and the feature's whole problem is that nobody
knows what it does. So the empty canvas is the pitch rather than a shrug.

One line says what a flow is. Under it, four of the bundled templates with a
silhouette of their graph, so you can see the shape before you read the name: a
straight chain, a three-way fan-out, a loop with a body. Then the node count and
what drives it (`8 nodes · 3 in parallel`, `4 nodes · cron`). Starting blank is
offered last, because a blank canvas teaches nothing.

With nothing selected there is no inspector, which gives the empty state the full
1200px. The header keeps only the word Flows; a breadcrumb and a Run button with
nothing to run are noise.

## The inspector has two modes

At rest it is node config: label, prompt with `{{vars.*}}` interpolation, model,
allowed-tools chips, and the capture-output row with its `{{vars.name}}` hint.

During a run it becomes the run: live streaming output, the four-bucket token
breakdown, and a timeline of every node with its duration. The timeline is what
keeps a flow navigable once it is taller than one screen.

On failure it shows the error and what to do about it. The mockup shows a node
blocked because `Bash` was not in its `allowedTools`; the panel offers "Add Bash
to allowed tools" beside "Retry this node" and "Retry the whole run".

## Constraints found in the engine

The drawing has to respect these.

**A loop has no return edge.** The Iterative Refiner template wires
`loop --body--> refine`, `refine -> score`, and `loop --exit--> finalize`. Nothing
connects `score` back to `loop`. `run_loop_body` recurses down the chain and
returns when it runs out of outgoing edges. Any return line we draw renders
execution semantics rather than data. It cannot be selected, deleted or
reconnected, and drawing it like a normal edge invites people to try.

**A loop body cannot branch.** `run_loop_body` takes the first outgoing edge and
ignores the rest. Wire two edges out of a body node and the second is silently
dropped. The container shape should make that obvious; the editor should refuse
the second edge rather than accept it and drop it.

**`condition` and `loop` have two outputs each.** `condition` has `yes` and `no`;
`loop` has `body` and `exit`. Every other type has one. Nothing in the current
node component accounts for this.

**A loop body used to run three node types out of eight.** `run_loop_body`
matched on `Prompt`, `Script` and `Condition` and fell through to
`_ => Ok(prev_output.clone())` for the rest, so a `humanReview` never paused, a
`subworkflow` never ran and a nested `loop` never looped, with no error and
nothing in the log.

`execute_one` now holds what each node type does, and both the graph walk and
the body walk call it. The duplication was the defect. Two functions had to agree
about eight node types and did not.

`parallel` and `join` remain the exception, which `needs_graph` states outright.
A body is a single chain, so there is no fan-out for either to split or rejoin.
They fail the node with a message naming the fix instead of passing the previous
output through. `NEEDS_THE_GRAPH` in `flowLayout.ts` mirrors that list so the
canvas can warn before a run rather than after, and a Rust test asserts the list,
because the two copies have to agree.

### Fan-out inside a loop body

A loop body can already fan out, through a `subworkflow` node rather than a
`parallel` node. `run_child_workflow` builds a fresh `Collectors` and `Visited`
per call, so the child runs a full graph walk with `parallel` and `join` working
normally, and its join state belongs to that one invocation. A body that needs
three reviewers per iteration is one `subworkflow` node pointing at a flow that
forks and joins.

That per-call state is also why the direct version is harder than it looks.
Today's collectors are keyed by node id for the whole execution, so a `join` sat
directly in a body would see arrivals from every iteration at once. Supporting it
means replacing the linear walk with a bounded sub-graph traversal that follows
every outgoing edge, stops at the loop node, never escapes the set of nodes
belonging to the body, and scopes collector state per iteration.

The cost is that rewrite plus per-iteration collectors. The gain is one node
fewer than a route that already works. Not planned. The engine names the
`subworkflow` route in its failure message, and the container footer says the
same before a run starts.

## Scale

Twenty nodes over sixteen rows is about 2,050px tall. The pane shows 868, so
fit-to-screen lands at 38%, where nothing is readable. A flow that size needs a
minimap, collapsible containers, or both. This pass does not solve it.

## What shipped

- `Sidebar.tsx`: the Flows tab became a Chat/Flow toggle on the wordmark row,
  reusing `panel.canvas`. `FlowsList` groups by running, then project, then any
  project, and shows a failed run in red so it reads from another tab.
- `WorkflowCanvas.tsx`: handles top and bottom; three node components in place of
  eight variations; loop as a container with nested children; `FlowPulseEdge` for
  the travelling segment; a run status chip in the header; the right panel
  becomes the run when nothing is selected.
- `flowLayout.ts`: measured top-to-bottom layout, loop containment, and the
  node-type sizes the layout needs before React Flow has measured anything.
- `flowRun.ts`: durations, token counts, and the error-to-fix guess.
- `engine.rs`: `execute_one`, so a loop body runs every node type the graph walk
  does; `needs_graph` for the two it cannot.
- `workflow-types.ts`: flows gained `projectId`.
- `nodeDragThreshold={4}`: React Flow drags after 1px by default, so an ordinary
  click nudged the node instead of selecting it.

## Teaching Claude to write a flow

Claude has no idea the flow format exists, so "make me a flow that does X" gets
a guess. The schema is about 40 lines, which is too much to carry in the system
prompt of every chat for something used occasionally, so it is a skill instead:
it loads only when someone asks.

The skill lives at `.agents/skills/write-a-flow/SKILL.md` in this repo and is
compiled into the binary with `include_str!`, so the copy we develop against and
the copy we ship cannot drift. Cargo tracks the dependency, so editing the skill
rebuilds the binary.

`managed_skills.rs` installs it into `~/.claude/skills` on launch and keeps it
current. Writing into someone's home directory makes this a sync problem rather
than a copy, and three rules decide it:

1. A file we wrote, still hashing to what we wrote, is ours to overwrite. That
   is how a new version ships.
2. A file anyone edited is theirs from then on. Shipping someone a stale skill
   is better than eating their edits.
3. A deletion is an answer. We record it and stop, rather than resurrecting the
   file every launch.

Rules 2 and 3 would each be a one-way door, so the Skills tab offers a row per
affected skill — **Install** for a deleted one, **Reset** for an edited one —
calling a restore that takes a single name. Per skill, not all of them, so
putting back a deleted skill cannot overwrite a different one someone customised.

Rule 2 is also the one that can surprise: updates stop, silently and forever.
Nothing else in the app records that, so the badge on a bundled skill reads
`NYRA` when it is still kept current and `NYRA · YOURS` once it has been
adopted. A badge that said the same thing in both states would hide the only
fact worth knowing.

State lives in `~/.nyra/managed-skills.json` as a status and a hash per skill.
Losing that file is not a problem: a skill identical to what we ship is reclaimed
as managed, and anything else is adopted.

## Not done

- `store.rs` still keeps every flow in one flat `~/.nyra/workflows`. Scoping is
  carried on the flow (`projectId`) rather than by directory, which is enough for
  the rail and leaves the on-disk format alone.
- The marketplace points at `pdcamargo/nyra-flows-marketplace`, which does not
  exist. Either create it or drop the marketplace view.
- Twenty nodes still needs a minimap plus collapsible containers. The minimap is
  there; collapsing is not.
- Only `write-a-flow` is bundled. If a second skill ever ships, `BUNDLED` takes
  it without further change.
- There is no uninstall path. Renaming a bundled skill would strand the old
  directory in `~/.claude/skills` forever, so a rename needs that first.

## Still open

- Whether a flow can be run from a chat, and what that looks like in the transcript.
- Whether a project with zero flows shows differently from zero flows anywhere.
- Migration for existing flows. There are none, so this is free right now.
